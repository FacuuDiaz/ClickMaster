// Reportes -> Cumplimiento: por dia y politica, objetivo contra SMS con un 200
// (/dashboard/compliance), y el avance por hora de una politica (grafico).
(function () {
  "use strict";
  const { $, el, api, errorText, showBanner, fmtNum, fmtDate, table } = CM;

  const BASE_LABEL = {
    ventana: "Por ventana",
    dia_vencido: "Dia vencido",
    semana_anterior: "Semana anterior",
    dia_anterior: "Dia anterior",
    semana_referencia: "Semana de referencia",
    por_defecto: "Regla por defecto",
    no_visitar: "No visitar",
    desconocida: "Politica borrada",
  };
  const STATE_LABEL = { en_curso: "en curso", esperando_cierre: "se elige al cerrar el dia", cerrado: "cerrado" };
  // Series del grafico (paleta validada en claro y oscuro: --s1 / --s4).
  const SERIES = [
    { key: "clicks", label: "SMS clickeados (200)", color: "var(--s1)" },
    { key: "selected", label: "Elegidos para visitar", color: "var(--s4)" },
  ];

  const pct = (v) => (v === null ? "—" : `${Math.round(v * 1000) / 10}%`);
  const dayFmt = new Intl.DateTimeFormat("es-AR", { weekday: "long", day: "2-digit", month: "2-digit" });

  let timer = null;
  let selected = null; // { day, policyId }

  // ---------- Tarjetas ----------

  function kvRow(dl, k, v) {
    dl.append(el("dt", null, k), el("dd", null, v));
  }

  function card(day, p) {
    const s = p.stats;
    const c = el("div", { class: "card cmp-card" });
    const head = el("div", { class: "cmp-head" });
    const title = el("div", { class: "title" });
    title.append(
      el("b", null, p.name),
      el("span", { class: "badge" }, BASE_LABEL[p.base] || p.base),
      el("span", { class: `badge ${p.state === "cerrado" ? "off" : "on"}` }, STATE_LABEL[p.state])
    );
    head.append(title);
    const big = el("div", { class: "cmp-big" });
    big.append(el("span", { class: "v" }, pct(p.compliance)), el("span", { class: "muted" }, "cumplimiento"));
    head.append(big);
    c.append(head);

    // Barra: SMS clickeados sobre el objetivo.
    const ratio = p.target > 0 ? Math.min(1, s.clickedSms / p.target) : 0;
    const bar = el("div", {
      class: "progress",
      role: "progressbar",
      "aria-label": `${fmtNum(s.clickedSms)} de ${fmtNum(p.target)} clickeados`,
      "aria-valuemin": "0",
      "aria-valuemax": String(p.target),
      "aria-valuenow": String(Math.min(s.clickedSms, p.target)),
    });
    const fill = el("div");
    fill.style.width = `${ratio * 100}%`;
    bar.append(fill);
    c.append(bar, el("div", { class: "muted" }, `${fmtNum(s.clickedSms)} de ${fmtNum(p.target)} SMS clickeados con 200`));

    const dl = el("dl", { class: "kv cmp-kv" });
    kvRow(dl, "Base", p.baseCount === null ? p.baseLabel : `${fmtNum(p.baseCount)} · ${p.baseLabel}`);
    kvRow(dl, "Objetivo", p.percentage === null ? fmtNum(p.target) : `${p.percentage}% → ${fmtNum(p.target)}`);
    kvRow(dl, "Elegidos", fmtNum(s.selected));
    kvRow(dl, "Visitados", fmtNum(s.visited));
    kvRow(dl, "Clicks (200)", s.clicks !== s.clickedSms ? `${fmtNum(s.clicks)} (en ${fmtNum(s.clickedSms)} SMS)` : fmtNum(s.clicks));
    kvRow(dl, "En cola", fmtNum(s.queued));
    c.append(dl);

    // Por que no se llega al 100%.
    const missing = Math.max(0, p.target - s.clickedSms);
    if (missing > 0 && p.base !== "no_visitar") {
      const parts = [];
      if (s.queued) parts.push(`${fmtNum(s.queued)} en cola`);
      if (s.held) parts.push(`${fmtNum(s.held)} todavia en seleccion`);
      if (s.capped) parts.push(`${fmtNum(s.capped)} recortados por el tope`);
      if (s.no200) parts.push(`${fmtNum(s.no200)} visitados sin 200 (error del sitio, timeout…)`);
      const notChosen = Math.max(0, p.target - s.selected - s.held);
      if (notChosen && p.state !== "esperando_cierre") parts.push(`${fmtNum(notChosen)} sin elegir`);
      c.append(el("p", { class: "cmp-gap" }, `Faltan ${fmtNum(missing)}${parts.length ? `: ${parts.join(" · ")}` : ""}.`));
    }

    if (p.projection) {
      const pr = p.projection;
      const text =
        pr.hoursNeeded === null
          ? `Hay ${fmtNum(pr.backlog)} en cola y el worker no visito nada en la ultima hora: asi no se llega (quedan ${pr.hoursLeft} h de visita hasta el cierre).`
          : pr.onTrack
            ? `Al ritmo actual (${fmtNum(pr.ratePerHour)} visitas/h) la cola de ${fmtNum(pr.backlog)} se termina en ~${pr.hoursNeeded} h; quedan ${pr.hoursLeft} h de visita hasta el cierre.`
            : `Al ritmo actual (${fmtNum(pr.ratePerHour)} visitas/h) la cola de ${fmtNum(pr.backlog)} tarda ~${pr.hoursNeeded} h y quedan ${pr.hoursLeft} h de visita hasta el cierre: no se llega.`;
      const box = el("div", { class: `info${pr.onTrack ? "" : " warn"}`, style: "margin:10px 0 0" });
      box.append(el("b", { class: "t" }, pr.onTrack ? "Va en tiempo" : "No se llega al cierre"), el("p", null, text));
      if (!pr.onTrack) box.append(el("p", null, "Opciones: mas sesiones de Chromium (Configuracion → Worker), ampliar el horario de visitas o bajar el porcentaje."));
      c.append(box);
    }

    const btn = el("button", { type: "button", class: "btn", style: "margin-top:10px" }, "Ver avance por hora");
    btn.addEventListener("click", () => loadChart(day, p));
    c.append(btn);
    return c;
  }

  function render(data) {
    const box = $("cmp-days-list");
    box.replaceChildren();
    for (const day of data.days) {
      const section = el("section", { class: "cmp-day" });
      const label = dayFmt.format(new Date(`${day.day}T12:00:00`));
      section.append(el("h2", { class: "cmp-day-title" }, `${day.isToday ? "Hoy · " : ""}${label}`));
      if (day.policies.length === 0) {
        section.append(el("div", { class: "empty" }, "Sin SMS con link ese dia"));
      } else {
        const grid = el("div", { class: "cmp-grid" });
        for (const p of day.policies) grid.append(card(day, p));
        section.append(grid);
      }
      box.append(section);
    }
    $("cmp-updated").textContent = `Actualizado ${fmtDate(data.generatedAt)} · worker: ${fmtNum(data.ratePerHour.visits)} visitas en la ultima hora`;
  }

  async function load() {
    clearTimeout(timer);
    try {
      render(await api("/dashboard/compliance", { params: { days: $("cmp-days").value } }));
      if (selected) {
        const { day, policy } = selected;
        await loadChart(day, policy, true);
      }
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
    if (CM.currentView() === "reportes" && CM.currentTab() === "cumplimiento") timer = setTimeout(load, 60_000);
  }

  // ---------- Grafico: acumulado por hora ----------

  const SVG_NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    return node;
  }
  function niceMax(v) {
    if (v <= 0) return 4;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / exp;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
  }
  const compact = new Intl.NumberFormat("es-AR", { notation: "compact", maximumFractionDigits: 1 });

  function drawChart(data) {
    const box = $("cmp-chart");
    box.replaceChildren();
    const from = new Date(data.from).getTime();
    const hours = data.buckets.length;
    const shown = Math.max(1, data.nowHour); // no se dibuja el futuro
    const points = [];
    let accSel = 0;
    let accClk = 0;
    for (let i = 0; i < shown; i++) {
      accSel += data.buckets[i].selected;
      accClk += data.buckets[i].clicks;
      points.push({ h: i, at: new Date(from + (i + 1) * 3_600_000), selected: accSel, clicks: accClk });
    }
    // Horas en hora de Alaris (como los dias): "08:00", o "17/11 08:00" si el grafico pasa de un dia.
    const pad = (n) => String(n).padStart(2, "0");
    const label = (d) => {
      const a = new Date(d.getTime() + data.offsetMinutes * 60_000);
      const hh = `${pad(a.getUTCHours())}:00`;
      return hours > 24 ? `${pad(a.getUTCDate())}/${pad(a.getUTCMonth() + 1)} ${hh}` : hh;
    };

    const width = Math.max(300, box.clientWidth);
    const height = 240;
    const m = { top: 12, right: 64, bottom: 26, left: 48 };
    const pw = width - m.left - m.right;
    const ph = height - m.top - m.bottom;
    const top = niceMax(Math.max(data.target, accSel, accClk));
    const x = (h) => m.left + (pw * (h + 1)) / hours;
    const y = (v) => m.top + ph - (v / top) * ph;

    const svg = svgEl("svg", {
      viewBox: `0 0 ${width} ${height}`,
      height: String(height),
      role: "img",
      tabindex: "0",
      "aria-label": `Avance acumulado de ${data.name}: ${fmtNum(accClk)} clickeados y ${fmtNum(accSel)} elegidos, objetivo ${fmtNum(data.target)}`,
    });
    for (const t of [0, top / 4, top / 2, (3 * top) / 4, top]) {
      svg.append(svgEl("line", { x1: m.left, x2: m.left + pw, y1: y(t), y2: y(t), stroke: t === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }));
      const tl = svgEl("text", { x: m.left - 8, y: y(t) + 4, "text-anchor": "end", class: "tick" });
      tl.textContent = t >= 1000 ? compact.format(t) : String(Math.round(t));
      svg.append(tl);
    }
    const every = Math.max(1, Math.ceil(hours / Math.max(2, Math.floor(pw / (hours > 24 ? 100 : 56)))));
    for (let h = 0; h < hours; h += every) {
      const tl = svgEl("text", { x: x(h) - pw / hours, y: height - 8, "text-anchor": "middle", class: "tick" });
      tl.textContent = label(new Date(from + h * 3_600_000));
      svg.append(tl);
    }
    // Objetivo: linea de referencia con su etiqueta.
    if (data.target > 0) {
      svg.append(svgEl("line", { x1: m.left, x2: m.left + pw, y1: y(data.target), y2: y(data.target), stroke: "var(--text-muted)", "stroke-width": 1.5, "stroke-dasharray": "4 4" }));
      const tl = svgEl("text", { x: m.left + pw + 6, y: y(data.target) + 4, class: "tick" });
      tl.textContent = `Objetivo ${compact.format(data.target)}`;
      svg.append(tl);
    }
    // Lineas acumuladas, arrancando en 0 al inicio del dia.
    const ends = [];
    for (const s of SERIES) {
      const d = [`M${m.left},${y(0)}`, ...points.map((p) => `L${x(p.h)},${y(p[s.key])}`)].join(" ");
      svg.append(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      const last = points[points.length - 1];
      ends.push({ s, yy: y(last[s.key]), v: last[s.key], xx: x(last.h) });
    }
    // Etiquetas directas al final de cada linea, sin pisarse.
    ends.sort((a, b) => a.yy - b.yy);
    for (let i = 1; i < ends.length; i++) if (ends[i].yy - ends[i - 1].yy < 14) ends[i].yy = ends[i - 1].yy + 14;
    for (const e of ends) {
      svg.append(svgEl("circle", { cx: e.xx, cy: y(e.v), r: 4, fill: e.s.color, stroke: "var(--surface)", "stroke-width": 2 }));
      const tl = svgEl("text", { x: Math.min(e.xx + 8, m.left + pw + 6), y: e.yy + 4, class: "tick cmp-end" });
      tl.textContent = compact.format(e.v);
      svg.append(tl);
    }

    // Hover: linea vertical + tooltip.
    const hover = svgEl("g", {});
    svg.append(hover);
    const tip = el("div", { class: "tooltip", role: "presentation" });
    box.append(svg, tip);
    function show(i) {
      const p = points[i];
      if (!p) return hide();
      hover.replaceChildren(svgEl("line", { x1: x(i), x2: x(i), y1: m.top, y2: m.top + ph, stroke: "var(--axis)", "stroke-width": 1 }));
      for (const s of SERIES) hover.append(svgEl("circle", { cx: x(i), cy: y(p[s.key]), r: 4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2 }));
      tip.replaceChildren(el("div", { class: "tt-title" }, `Hasta ${label(p.at)}`));
      for (const s of SERIES) {
        const row = el("div", { class: "tt-row" });
        const key = el("i", { class: "key" });
        key.style.background = s.color;
        row.append(key, el("b", null, fmtNum(p[s.key])), el("span", null, s.label));
        tip.append(row);
      }
      const goal = el("div", { class: "tt-row" });
      goal.append(el("i", { class: "key", style: "background:var(--text-muted)" }), el("b", null, fmtNum(data.target)), el("span", null, "Objetivo"));
      tip.append(goal);
      tip.style.display = "block";
      const left = (x(i) / width) * box.clientWidth;
      tip.style.left = `${Math.min(left + 12, box.clientWidth - tip.offsetWidth)}px`;
      tip.style.top = "8px";
    }
    function hide() {
      hover.replaceChildren();
      tip.style.display = "none";
    }
    const hit = svgEl("rect", { x: m.left, y: m.top, width: pw, height: ph, fill: "transparent" });
    svg.append(hit);
    hit.addEventListener("mousemove", (e) => {
      const rect = svg.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * width;
      show(Math.max(0, Math.min(points.length - 1, Math.round(((px - m.left) * hours) / pw) - 1)));
    });
    hit.addEventListener("mouseleave", hide);
    let kb = points.length - 1;
    svg.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      kb = Math.max(0, Math.min(points.length - 1, kb + (e.key === "ArrowRight" ? 1 : -1)));
      show(kb);
    });
    svg.addEventListener("blur", hide);

    // Tabla (vista accesible y para leer valores exactos).
    table(
      $("cmp-chart-table"),
      [
        { label: "Hasta", cls: "time", render: (p) => label(p.at) },
        { label: "Elegidos (acum.)", num: true, render: (p) => fmtNum(p.selected) },
        { label: "Clickeados con 200 (acum.)", num: true, render: (p) => fmtNum(p.clicks) },
      ],
      points.filter((p, i) => data.buckets[i].selected || data.buckets[i].clicks || i === points.length - 1),
      "Sin actividad todavia"
    );
  }

  async function loadChart(day, p, quiet) {
    selected = { day, policy: p };
    const card = $("cmp-chart-card");
    card.hidden = false;
    $("cmp-chart-title").textContent = `Avance por hora · ${p.name}`;
    $("cmp-chart-desc").textContent =
      `SMS del ${dayFmt.format(new Date(`${day.day}T12:00:00`))}. Acumulado desde las 00:00 hasta ` +
      (p.base === "dia_vencido" ? "el fin del dia siguiente (se visitan al otro dia)." : "el fin del dia.");
    $("cmp-legend").replaceChildren(
      ...SERIES.map((s) => {
        const li = el("li");
        const key = el("i");
        key.style.background = s.color;
        li.append(key, document.createTextNode(s.label));
        return li;
      }),
      (() => {
        const li = el("li");
        li.append(el("i", { class: "dash" }), document.createTextNode("Objetivo"));
        return li;
      })()
    );
    if (!quiet) card.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      const data = await api("/dashboard/compliance/hourly", { params: { day: day.day, policy: p.policyId === null ? "ninguna" : p.policyId } });
      drawChart(data);
    } catch (err) {
      $("cmp-chart").replaceChildren(el("div", { class: "empty" }, errorText(err)));
    }
  }

  $("cmp-days").addEventListener("change", load);
  $("cmp-refresh").addEventListener("click", load);
  window.addEventListener("resize", () => {
    if (selected && !$("cmp-chart-card").hidden) loadChart(selected.day, selected.policy, true);
  });

  // Los filtros de rango de Reportes no aplican aca (es por dia).
  CM.onTab("reportes", (tab) => {
    const filters = document.querySelector('[data-view="reportes"] .filters');
    if (filters) filters.hidden = tab === "cumplimiento";
    if (tab === "cumplimiento") load();
    else clearTimeout(timer);
  });
  CM.onLeave("reportes", () => clearTimeout(timer));
})();
