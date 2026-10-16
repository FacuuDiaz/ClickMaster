// Dashboard de ClickMaster. Sin dependencias: graficos en SVG a mano.
// Todos los textos que vienen de la base se insertan con textContent.
(function () {
  "use strict";

  const SERIES = [
    { key: "cargada", label: "Cargada", color: "var(--s1)" },
    { key: "sitio", label: "Error del sitio", color: "var(--s2)" },
    { key: "indeterminado", label: "Indeterminado", color: "var(--s3)" },
    { key: "tecnico", label: "Error tecnico", color: "var(--s4)" },
  ];
  const OUTCOME_GROUP = {
    cargada: "cargada",
    http_4xx: "sitio", http_5xx: "sitio", http_429_408: "sitio", certificado: "sitio", navegacion: "sitio",
    indeterminado: "indeterminado",
    timeout: "tecnico", dns: "tecnico", conexion: "tecnico", error_interno: "tecnico", reserva_vencida: "tecnico",
  };
  const SMS_STATUS = {
    pending: "Pendiente", processing: "En proceso", retry: "Reintento",
    success: "Verificado", failed: "Fallido", skipped: "Salteado",
  };
  const REFRESH_MS = 30000;

  const $ = (id) => document.getElementById(id);
  const state = {
    preset: "30m",
    from: null,
    to: null,
    tab: "checks",
    filter: "",
    cursors: [null], // pila de cursores: cursors[i] = cursor de la pagina i
    page: 0,
    nextCursor: null,
    timer: null,
  };

  // ---------- Formato ----------

  const nf = new Intl.NumberFormat("es-AR");
  const compact = new Intl.NumberFormat("es-AR", { notation: "compact", maximumFractionDigits: 1 });
  const fmtNum = (n) => (n === null || n === undefined ? "—" : n >= 10000 ? compact.format(n) : nf.format(n));
  const fmtPct = (r) => (r === null || r === undefined ? "—" : `${(r * 100).toFixed(r >= 0.995 || r === 0 ? 0 : 1)}%`);
  const fmtMs = (ms) => (ms === null || ms === undefined ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
  const fmtDuration = (s) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
  const dtTime = new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit" });
  const dtDayTime = new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const dtDay = new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit" });
  const dtFull = new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const fmtDate = (v) => (v ? dtFull.format(new Date(v)) : "—");

  function bucketLabel(t, stepS, spanMs) {
    const d = new Date(t);
    if (stepS >= 86400) return dtDay.format(d);
    return spanMs > 20 * 3600000 ? dtDayTime.format(d) : dtTime.format(d);
  }

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    return node;
  }

  // ---------- API ----------

  function token() {
    try {
      return sessionStorage.getItem("cm_token") || "";
    } catch {
      return "";
    }
  }

  function rangeParams() {
    const p = new URLSearchParams();
    if (state.preset === "custom") {
      p.set("from", state.from.toISOString());
      p.set("to", state.to.toISOString());
    } else {
      p.set("preset", state.preset);
    }
    return p;
  }

  async function api(path, params) {
    const headers = {};
    const t = token();
    if (t) headers.Authorization = `Bearer ${t}`;
    const res = await fetch(`${path}?${params.toString()}`, { headers });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) {
      const err = new Error("Hace falta el token de administrador");
      err.auth = true;
      throw err;
    }
    if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
    return body;
  }

  function showBanner(message, opts = {}) {
    $("banner-text").textContent = message;
    $("banner").className = `banner show${opts.error ? " error" : ""}`;
    $("token-form").className = `token-form${opts.auth ? " show" : ""}`;
  }
  function hideBanner() {
    $("banner").className = "banner";
  }

  // ---------- Escalas y ejes ----------

  function niceMax(v) {
    if (v <= 0) return 4;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / exp;
    const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nice * exp;
  }

  function yTicks(max) {
    const top = niceMax(max);
    return [0, top / 4, top / 2, (3 * top) / 4, top].map((v) => Math.round(v * 100) / 100);
  }

  function tickLabel(v, unit) {
    if (unit === "ms") return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} s` : `${v}`;
    return v >= 1000 ? compact.format(v) : String(v);
  }

  // Cuadro comun de los tres graficos: grilla, ejes, area de hover y tooltip.
  function frame(container, buckets, opts) {
    container.replaceChildren();
    const width = Math.max(280, container.clientWidth);
    const height = opts.height || 220;
    const m = { top: 8, right: 8, bottom: 26, left: 44 };
    const pw = width - m.left - m.right;
    const ph = height - m.top - m.bottom;
    const ticks = yTicks(opts.max);
    const top = ticks[ticks.length - 1];
    const y = (v) => m.top + ph - (v / top) * ph;
    const band = pw / Math.max(1, buckets.length);
    const x = (i) => m.left + band * i + band / 2;

    const svg = svgEl("svg", {
      viewBox: `0 0 ${width} ${height}`,
      height: String(height),
      role: "img",
      tabindex: "0",
      "aria-label": opts.ariaLabel,
    });
    for (const t of ticks) {
      svg.appendChild(svgEl("line", { x1: m.left, x2: width - m.right, y1: y(t), y2: y(t), stroke: t === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }));
      const label = svgEl("text", { x: m.left - 8, y: y(t) + 4, "text-anchor": "end", class: "tick" });
      label.textContent = tickLabel(t, opts.unit);
      svg.appendChild(label);
    }
    // ~6 etiquetas en X, sin pisarse.
    const every = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor(pw / 90))));
    buckets.forEach((b, i) => {
      if (i % every !== 0) return;
      const label = svgEl("text", { x: x(i), y: height - 8, "text-anchor": "middle", class: "tick" });
      label.textContent = bucketLabel(b.t, opts.stepS, opts.spanMs);
      svg.appendChild(label);
    });

    const marks = svgEl("g", {});
    svg.appendChild(marks);
    const hover = svgEl("g", {});
    svg.appendChild(hover);

    const tip = el("div", { class: "tooltip", role: "presentation" });
    container.append(svg, tip);

    let active = -1;
    function show(i) {
      if (i < 0 || i >= buckets.length) return hide();
      active = i;
      hover.replaceChildren();
      if (opts.crosshair) {
        hover.appendChild(svgEl("line", { x1: x(i), x2: x(i), y1: m.top, y2: m.top + ph, stroke: "var(--axis)", "stroke-width": 1 }));
      } else {
        hover.appendChild(svgEl("rect", { x: m.left + band * i, y: m.top, width: band, height: ph, fill: "var(--wash)" }));
      }
      if (opts.onHover) opts.onHover(hover, i);

      tip.replaceChildren(el("div", { class: "tt-title" }, opts.tipTitle(buckets[i])));
      for (const row of opts.tipRows(buckets[i])) {
        const line = el("div", { class: "tt-row" });
        const key = el("i", { class: "key" });
        key.style.background = row.color;
        line.append(key, el("b", null, row.value), el("span", null, row.label));
        tip.appendChild(line);
      }
      tip.style.display = "block";
      const scale = container.clientWidth / width;
      let left = x(i) * scale + 12;
      if (left + tip.offsetWidth > container.clientWidth) left = x(i) * scale - tip.offsetWidth - 12;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${m.top}px`;
    }
    function hide() {
      active = -1;
      hover.replaceChildren();
      tip.style.display = "none";
    }
    const indexAt = (evt) => {
      const rect = svg.getBoundingClientRect();
      const px = ((evt.clientX - rect.left) / rect.width) * width;
      return Math.floor((px - m.left) / band);
    };
    svg.addEventListener("pointermove", (e) => show(indexAt(e)));
    svg.addEventListener("pointerleave", hide);
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") show(Math.min(buckets.length - 1, active + 1));
      else if (e.key === "ArrowLeft") show(Math.max(0, active < 0 ? buckets.length - 1 : active - 1));
      else if (e.key === "Escape") hide();
      else return;
      e.preventDefault();
    });
    svg.addEventListener("focus", () => show(buckets.length - 1));

    return { marks, x, y, band, m, ph };
  }

  // Columna con extremo de datos redondeado (4px) y base recta.
  function columnPath(x0, w, yTop, yBase, rounded) {
    const h = yBase - yTop;
    const r = rounded ? Math.min(4, w / 2, h) : 0;
    return `M${x0},${yBase} V${yTop + r} Q${x0},${yTop} ${x0 + r},${yTop} H${x0 + w - r} Q${x0 + w},${yTop} ${x0 + w},${yTop + r} V${yBase} Z`;
  }

  function barWidth(band) {
    // <= 24px y siempre al menos 2px de aire entre columnas vecinas.
    return Math.max(1, Math.min(24, band * 0.7, band - 2));
  }

  // ---------- Graficos ----------

  function drawStacked(container, data) {
    const buckets = data.series.checks;
    const max = Math.max(1, ...buckets.map((b) => b.total));
    const f = frame(container, buckets, {
      max,
      stepS: data.range.stepSeconds,
      spanMs: new Date(data.range.to) - new Date(data.range.from),
      ariaLabel: "Verificaciones por resultado en el tiempo. Datos completos en la tabla de abajo.",
      tipTitle: (b) => bucketLabel(b.t, data.range.stepSeconds, Infinity),
      tipRows: (b) => [
        ...SERIES.slice().reverse().map((s) => ({ color: s.color, value: fmtNum(b[s.key]), label: s.label })),
        { color: "transparent", value: fmtNum(b.total), label: "Total" },
      ],
    });
    const w = barWidth(f.band);
    const GAP = 2;
    buckets.forEach((b, i) => {
      const x0 = f.x(i) - w / 2;
      // Alturas sobre el acumulado: el tope de la columna cae justo en el total.
      let cum = 0;
      const segments = [];
      for (const s of SERIES) {
        if (!b[s.key]) continue;
        const yBottom = f.y(cum);
        cum += b[s.key];
        segments.push({ color: s.color, yTop: f.y(cum), yBottom });
      }
      // Separacion de 2px del color de la superficie entre segmentos. Un
      // segmento que no llega a verse con su separacion no se dibuja (queda
      // en el tooltip y en la tabla) para no generar rayas.
      const drawn = segments
        .map((seg, j) => ({ ...seg, yBottom: j === 0 ? seg.yBottom : seg.yBottom - GAP }))
        .filter((seg) => seg.yBottom - seg.yTop >= 1);
      drawn.forEach((seg, j) => {
        f.marks.appendChild(svgEl("path", { d: columnPath(x0, w, seg.yTop, seg.yBottom, j === drawn.length - 1), fill: seg.color }));
      });
    });
  }

  function drawColumns(container, data, buckets, key, color, label, unit) {
    const max = Math.max(1, ...buckets.map((b) => b[key] || 0));
    const f = frame(container, buckets, {
      max,
      unit,
      stepS: data.range.stepSeconds,
      spanMs: new Date(data.range.to) - new Date(data.range.from),
      ariaLabel: `${label} en el tiempo. Datos completos en la tabla de abajo.`,
      tipTitle: (b) => bucketLabel(b.t, data.range.stepSeconds, Infinity),
      tipRows: (b) => [{ color, value: fmtNum(b[key]), label }],
    });
    const w = barWidth(f.band);
    buckets.forEach((b, i) => {
      if (!b[key]) return;
      f.marks.appendChild(svgEl("path", { d: columnPath(f.x(i) - w / 2, w, f.y(b[key]), f.y(0), true), fill: color }));
    });
  }

  function drawLine(container, data, buckets, key, color, label) {
    const values = buckets.map((b) => b[key]);
    const max = Math.max(1, ...values.filter((v) => v !== null));
    const f = frame(container, buckets, {
      max,
      unit: "ms",
      crosshair: true,
      stepS: data.range.stepSeconds,
      spanMs: new Date(data.range.to) - new Date(data.range.from),
      ariaLabel: `${label} en el tiempo. Datos completos en la tabla de abajo.`,
      tipTitle: (b) => bucketLabel(b.t, data.range.stepSeconds, Infinity),
      tipRows: (b) => [{ color, value: b[key] === null ? "sin datos" : fmtMs(b[key]), label }],
      onHover: (g, i) => {
        if (values[i] === null) return;
        g.appendChild(svgEl("circle", { cx: f.x(i), cy: f.y(values[i]), r: 5, fill: color, stroke: "var(--surface)", "stroke-width": 2 }));
      },
    });
    // La linea se corta donde no hubo cargas: no se inventa el tramo.
    let d = "";
    let open = false;
    values.forEach((v, i) => {
      if (v === null) {
        open = false;
        return;
      }
      d += `${open ? "L" : "M"}${f.x(i)},${f.y(v)} `;
      open = true;
    });
    if (d) {
      f.marks.appendChild(svgEl("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
    // Puntos sueltos (un bucket aislado entre huecos) no se verian como linea.
    values.forEach((v, i) => {
      const isolated = v !== null && (values[i - 1] ?? null) === null && (values[i + 1] ?? null) === null;
      if (isolated) f.marks.appendChild(svgEl("circle", { cx: f.x(i), cy: f.y(v), r: 4, fill: color, stroke: "var(--surface)", "stroke-width": 2 }));
    });
  }

  function dataTable(target, columns, rows) {
    const table = el("table");
    const head = el("tr");
    for (const c of columns) head.appendChild(el("th", null, c.label));
    table.appendChild(el("thead")).appendChild(head);
    const body = table.appendChild(el("tbody"));
    for (const r of rows) {
      const tr = el("tr");
      for (const c of columns) tr.appendChild(el("td", c.num ? { class: "num" } : { class: "time" }, c.value(r)));
      body.appendChild(tr);
    }
    target.replaceChildren(table);
  }

  // ---------- Render ----------

  let lastData = null;

  function renderCharts() {
    const data = lastData;
    if (!data) return;
    const step = data.range.stepSeconds;
    const when = (b) => bucketLabel(b.t, step, Infinity);
    const anyChecks = data.totals.checks > 0;
    const anySms = data.totals.sms > 0;

    if (anyChecks) drawStacked($("chart-checks"), data);
    else $("chart-checks").replaceChildren(el("div", { class: "empty" }, "Sin verificaciones en este rango"));
    if (anySms) drawColumns($("chart-ingest"), data, data.series.ingest, "sms", "var(--s1)", "SMS ingestados");
    else $("chart-ingest").replaceChildren(el("div", { class: "empty" }, "No entraron SMS en este rango"));
    if (data.totals.cargada > 0) drawLine($("chart-load"), data, data.series.checks, "avgLoadMs", "var(--s1)", "Tiempo de carga");
    else $("chart-load").replaceChildren(el("div", { class: "empty" }, "Sin paginas cargadas en este rango"));

    dataTable(
      $("table-checks"),
      [{ label: "Intervalo", value: when }, ...SERIES.map((s) => ({ label: s.label, num: true, value: (b) => nf.format(b[s.key]) })), { label: "Total", num: true, value: (b) => nf.format(b.total) }],
      data.series.checks
    );
    dataTable($("table-ingest"), [{ label: "Intervalo", value: when }, { label: "SMS", num: true, value: (b) => nf.format(b.sms) }], data.series.ingest);
    dataTable($("table-load"), [{ label: "Intervalo", value: when }, { label: "Carga promedio", num: true, value: (b) => fmtMs(b.avgLoadMs) }], data.series.checks);
  }

  function renderSummary(data) {
    const t = data.totals;
    $("k-rate").textContent = fmtPct(t.successRate);
    $("k-rate-sub").textContent = t.checks ? `${nf.format(t.cargada)} de ${nf.format(t.checks)} verificaciones` : "sin verificaciones en el rango";
    $("k-checks").textContent = fmtNum(t.checks);
    $("k-sitio").textContent = fmtNum(t.sitio);
    $("k-tecnico").textContent = fmtNum(t.tecnico);
    $("k-load").textContent = fmtMs(t.avgLoadMs);
    $("k-sms").textContent = fmtNum(t.sms);

    $("q-pending").textContent = fmtNum(data.queue.pending);
    $("q-processing").textContent = fmtNum(data.queue.processing);
    $("q-retry").textContent = fmtNum(data.queue.retry);
    $("q-lag").textContent = fmtDuration(data.queue.lagSeconds);

    const r = data.lastRun;
    const pill = $("r-status");
    if (!r) {
      pill.className = "pill";
      pill.textContent = "Sin corridas todavia";
      $("r-window").textContent = "";
      $("r-records").textContent = "—";
      $("r-error").textContent = "";
    } else {
      const ok = r.status === "success" || r.status === "partial";
      pill.className = `pill ${r.status === "running" ? "" : ok ? "ok" : "bad"}`;
      pill.textContent = { success: "Exitosa", partial: "Parcial", failed: "Fallida", running: "En curso" }[r.status] || r.status;
      $("r-window").textContent = `${dtTime.format(new Date(r.windowStart))}–${dtTime.format(new Date(r.windowEnd))} · ${dtDayTime.format(new Date(r.startedAt))}`;
      $("r-records").textContent = fmtNum(r.recordsReceived);
      $("r-error").textContent = r.errorMessage || "";
    }

    const from = new Date(data.range.from);
    const to = new Date(data.range.to);
    $("range-label").textContent = `${dtDayTime.format(from)} → ${dtDayTime.format(to)} · intervalos de ${fmtDuration(data.range.stepSeconds)}`;
    $("updated").textContent = `Actualizado ${dtFull.format(new Date(data.generatedAt))}`;
  }

  async function loadData() {
    $("app").classList.add("loading");
    try {
      const data = await api("/dashboard/data", rangeParams());
      hideBanner();
      lastData = data;
      renderSummary(data);
      renderCharts();
    } catch (err) {
      showBanner(err.message, { error: !err.auth, auth: err.auth });
    } finally {
      $("app").classList.remove("loading");
    }
  }

  // ---------- Tabla paginada ----------

  function setFilterOptions() {
    const sel = $("tbl-filter");
    sel.replaceChildren();
    if (state.tab === "checks") {
      sel.appendChild(el("option", { value: "" }, "Todos los resultados"));
      for (const s of SERIES) sel.appendChild(el("option", { value: s.key }, s.label));
    } else {
      sel.appendChild(el("option", { value: "" }, "Todos los estados"));
      for (const [k, v] of Object.entries(SMS_STATUS)) sel.appendChild(el("option", { value: k }, v));
    }
    sel.value = state.filter;
  }

  function outcomeTag(outcome) {
    const group = OUTCOME_GROUP[outcome] || "indeterminado";
    const series = SERIES.find((s) => s.key === group);
    const tag = el("span", { class: "tag" });
    const sw = el("i");
    sw.style.background = series.color;
    tag.append(sw, document.createTextNode(outcome || "sin clasificar"));
    return tag;
  }

  function renderChecksTable(items) {
    const table = el("table");
    const head = el("tr");
    for (const h of ["Fecha", "Resultado", "HTTP", "Carga", "Intento", "Link", "SMS"]) head.appendChild(el("th", null, h));
    table.appendChild(el("thead")).appendChild(head);
    const body = table.appendChild(el("tbody"));
    for (const c of items) {
      const tr = el("tr");
      tr.appendChild(el("td", { class: "time" }, fmtDate(c.checkedAt)));
      tr.appendChild(el("td")).appendChild(outcomeTag(c.outcome));
      tr.appendChild(el("td", { class: "num" }, c.httpStatus ?? "—"));
      tr.appendChild(el("td", { class: "num" }, fmtMs(c.responseTimeMs)));
      tr.appendChild(el("td", { class: "num" }, c.attempt ?? "—"));
      const link = tr.appendChild(el("td", { class: "link" }, c.link));
      if (c.finalUrl) link.appendChild(el("div", { class: "err" }, `→ ${c.finalUrl}`));
      if (c.error && c.outcome !== "cargada") link.appendChild(el("div", { class: "err" }, String(c.error).split("\n")[0].slice(0, 160)));
      tr.appendChild(el("td", { class: "num" }, c.smsContentId));
      body.appendChild(tr);
    }
    return table;
  }

  function renderSmsTable(items) {
    const table = el("table");
    const head = el("tr");
    for (const h of ["Ingreso", "Estado", "Resultado", "Intentos", "Cliente", "Texto", "Envio"]) head.appendChild(el("th", null, h));
    table.appendChild(el("thead")).appendChild(head);
    const body = table.appendChild(el("tbody"));
    for (const s of items) {
      const tr = el("tr");
      tr.appendChild(el("td", { class: "time" }, fmtDate(s.createdAt)));
      const status = SMS_STATUS[s.status] || s.status;
      tr.appendChild(el("td", null, s.skipReason ? `${status} (${s.skipReason.replace(/_/g, " ")})` : status));
      const res = tr.appendChild(el("td"));
      if (s.lastOutcome) res.appendChild(outcomeTag(s.lastOutcome));
      else res.textContent = "—";
      tr.appendChild(el("td", { class: "num" }, s.attempts));
      tr.appendChild(el("td", null, s.client || "—"));
      tr.appendChild(el("td", { class: "text" }, s.text || "—"));
      tr.appendChild(el("td", { class: "time" }, fmtDate(s.edrDate)));
      body.appendChild(tr);
    }
    return table;
  }

  async function loadTable() {
    const params = rangeParams();
    params.set("limit", "25");
    if (state.filter) params.set(state.tab === "checks" ? "group" : "status", state.filter);
    const cursor = state.cursors[state.page];
    if (cursor) params.set("cursor", cursor);
    try {
      const page = await api(state.tab === "checks" ? "/dashboard/checks" : "/dashboard/sms", params);
      state.nextCursor = page.nextCursor;
      const wrap = $("tbl");
      if (page.items.length === 0) {
        wrap.replaceChildren(el("div", { class: "empty" }, state.page === 0 ? "No hay registros en este rango" : "No hay mas registros"));
      } else {
        wrap.replaceChildren(state.tab === "checks" ? renderChecksTable(page.items) : renderSmsTable(page.items));
      }
      $("page-label").textContent = `Pagina ${state.page + 1}`;
      $("tbl-info").textContent = "Mas recientes primero · 25 por pagina";
      $("prev").disabled = state.page === 0;
      $("next").disabled = !page.nextCursor;
    } catch (err) {
      if (!err.auth) $("tbl").replaceChildren(el("div", { class: "empty" }, err.message));
    }
  }

  function resetPaging() {
    state.cursors = [null];
    state.page = 0;
  }

  // ---------- Controles ----------

  function toLocalInput(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function refreshAll() {
    loadData();
    // La pagina 1 se refresca sola; si el usuario esta mas atras no se le
    // mueve la tabla debajo de los ojos.
    if (state.page === 0) loadTable();
  }

  function schedule() {
    clearInterval(state.timer);
    state.timer = null;
    if ($("auto").checked && state.preset !== "custom") {
      state.timer = setInterval(() => {
        if (document.visibilityState === "visible") refreshAll();
      }, REFRESH_MS);
    }
  }

  $("presets").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-preset]");
    if (!btn) return;
    const preset = btn.dataset.preset;
    for (const b of $("presets").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b === btn));
    $("custom").classList.toggle("show", preset === "custom");
    if (preset === "custom") {
      const to = new Date();
      const from = new Date(to.getTime() - 3600000);
      if (!$("from").value) $("from").value = toLocalInput(from);
      if (!$("to").value) $("to").value = toLocalInput(to);
      $("from").focus();
      return;
    }
    state.preset = preset;
    resetPaging();
    refreshAll();
    schedule();
  });

  $("custom").addEventListener("submit", (e) => {
    e.preventDefault();
    const from = new Date($("from").value);
    const to = new Date($("to").value);
    if (!(to > from)) {
      showBanner("El fin del rango tiene que ser posterior al inicio", { error: true });
      return;
    }
    state.preset = "custom";
    state.from = from;
    state.to = to;
    resetPaging();
    refreshAll();
    schedule();
  });

  $("auto").addEventListener("change", schedule);

  for (const tab of document.querySelectorAll(".tabs button")) {
    tab.addEventListener("click", () => {
      state.tab = tab.dataset.tab;
      state.filter = "";
      for (const t of document.querySelectorAll(".tabs button")) t.setAttribute("aria-selected", String(t === tab));
      setFilterOptions();
      resetPaging();
      loadTable();
    });
  }

  $("tbl-filter").addEventListener("change", (e) => {
    state.filter = e.target.value;
    resetPaging();
    loadTable();
  });

  $("next").addEventListener("click", () => {
    if (!state.nextCursor) return;
    state.cursors[state.page + 1] = state.nextCursor;
    state.page++;
    loadTable();
  });
  $("prev").addEventListener("click", () => {
    if (state.page === 0) return;
    state.page--;
    loadTable();
  });

  $("token-form").addEventListener("submit", (e) => {
    e.preventDefault();
    try {
      sessionStorage.setItem("cm_token", $("token").value.trim());
    } catch {
      // Sin sessionStorage el token no se recuerda entre recargas.
    }
    refreshAll();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.timer) refreshAll();
  });

  let resizeTimer = null;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderCharts, 120);
  }).observe($("chart-checks"));

  // Leyenda (dos o mas series: siempre presente).
  for (const s of SERIES) {
    const li = el("li");
    const sw = el("i");
    sw.style.background = s.color;
    li.append(sw, document.createTextNode(s.label));
    $("legend-checks").appendChild(li);
  }

  setFilterOptions();
  refreshAll();
  schedule();
})();
