// Panel: grafico de la semana de referencia (politica activa con base
// semana_referencia). 7 dias x 24 horas de sms_usage_stats y, encima del dia
// equivalente, lo que va llegando hoy. Datos de /admin/policies/:id/week.
(function () {
  "use strict";
  const { $, el, api, errorText, fmtNum, table } = CM;

  const SVG_NS = "http://www.w3.org/2000/svg";
  const HOUR_MS = 3_600_000;
  const DAY_MS = 86_400_000;
  const OFFSET_MS = -3 * HOUR_MS; // hora de Alaris (GMT-3), como el resto de la web
  const SERIES = [
    { key: "ref", label: "Semana de referencia (SMS enviados por hora)", color: "var(--s1)" },
    { key: "today", label: "Hoy (SMS recibidos por hora)", color: "var(--s4)" },
  ];
  const SOURCE = { alaris: "Alaris", local: "conteo local", sin_datos: "sin datos" };
  const WEEKDAYS = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"];
  const compact = new Intl.NumberFormat("es-AR", { notation: "compact", maximumFractionDigits: 1 });

  let policyId = null;
  let data = null;

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
  const pad = (n) => String(n).padStart(2, "0");
  const local = (ms) => new Date(ms + OFFSET_MS);
  const dayLabel = (ms) => {
    const d = local(ms);
    return `${WEEKDAYS[d.getUTCDay()]} ${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`;
  };

  function points() {
    const out = [];
    const refStart = new Date(data.today.refDay).getTime();
    const todayByHour = new Map(data.today.hours.map((h) => [h.hour, h.received]));
    data.days.forEach((d, di) => {
      const start = new Date(d.start).getTime();
      for (let h = 0; h < 24; h++) {
        out.push({
          i: di * 24 + h,
          at: start + h * HOUR_MS,
          day: di,
          hour: h,
          ref: d.hourly[h],
          today: start === refStart && todayByHour.has(h) ? todayByHour.get(h) : null,
        });
      }
    });
    return out;
  }

  function draw() {
    const box = $("home-week-chart");
    box.replaceChildren();
    const pts = points();
    const n = pts.length; // 168
    const width = Math.max(300, box.clientWidth);
    const height = 240;
    const m = { top: 14, right: 12, bottom: 28, left: 48 };
    const pw = width - m.left - m.right;
    const ph = height - m.top - m.bottom;
    const top = 4 * niceMax(Math.max(1, ...pts.map((p) => Math.max(p.ref, p.today ?? 0))) / 4);
    const x = (i) => m.left + (pw * (i + 0.5)) / n;
    const y = (v) => m.top + ph - (v / top) * ph;

    const svg = svgEl("svg", {
      viewBox: `0 0 ${width} ${height}`,
      height: String(height),
      role: "img",
      tabindex: "0",
      "aria-label": `Semana de referencia del ${dayLabel(new Date(data.days[0].start).getTime())}: ${fmtNum(data.total)} SMS, promedio ${fmtNum(data.dailyAverage)} por dia`,
    });

    // Dia equivalente a hoy: banda suave detras de los datos.
    const refIdx = data.days.findIndex((d) => d.start === data.today.refDay);
    if (refIdx >= 0) {
      svg.append(svgEl("rect", { x: m.left + (pw * refIdx * 24) / n, y: m.top, width: (pw * 24) / n, height: ph, fill: "var(--grid)", opacity: "0.5" }));
    }
    for (const t of [0, top / 4, top / 2, (3 * top) / 4, top]) {
      svg.append(svgEl("line", { x1: m.left, x2: m.left + pw, y1: y(t), y2: y(t), stroke: t === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1 }));
      const tl = svgEl("text", { x: m.left - 8, y: y(t) + 4, "text-anchor": "end", class: "tick" });
      tl.textContent = t >= 1000 ? compact.format(t) : String(Math.round(t));
      svg.append(tl);
    }
    // Separadores y nombre de cada dia (si no entra, solo el dia de la semana).
    const short = pw / 7 < 64;
    data.days.forEach((d, di) => {
      const x0 = m.left + (pw * di * 24) / n;
      if (di > 0) svg.append(svgEl("line", { x1: x0, x2: x0, y1: m.top, y2: m.top + ph, stroke: "var(--grid)", "stroke-width": 1 }));
      const tl = svgEl("text", { x: x0 + (pw * 12) / n, y: height - 8, "text-anchor": "middle", class: "tick" });
      const label = dayLabel(new Date(d.start).getTime());
      tl.textContent = short ? label.slice(0, 3) : label;
      svg.append(tl);
    });

    // Lineas: la semana entera; hoy solo las horas que ya pasaron.
    const pathOf = (key) => {
      let d = "";
      let pen = false;
      for (const p of pts) {
        if (p[key] === null) {
          pen = false;
          continue;
        }
        d += `${pen ? "L" : "M"}${x(p.i)},${y(p[key])}`;
        pen = true;
      }
      return d;
    };
    for (const s of SERIES) {
      const d = pathOf(s.key);
      if (d) svg.append(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
    const lastToday = [...pts].reverse().find((p) => p.today !== null);
    if (lastToday) {
      svg.append(svgEl("circle", { cx: x(lastToday.i), cy: y(lastToday.today), r: 4, fill: "var(--s4)", stroke: "var(--surface)", "stroke-width": 2 }));
    }

    // Hover: linea vertical + tooltip con la hora.
    const hover = svgEl("g", {});
    svg.append(hover);
    const tip = el("div", { class: "tooltip", role: "presentation" });
    box.append(svg, tip);
    function show(i) {
      const p = pts[i];
      if (!p) return hide();
      hover.replaceChildren(svgEl("line", { x1: x(i), x2: x(i), y1: m.top, y2: m.top + ph, stroke: "var(--axis)", "stroke-width": 1 }));
      tip.replaceChildren(el("div", { class: "tt-title" }, `${dayLabel(p.at)} ${pad(p.hour)}:00 · ${SOURCE[data.days[p.day].source]}`));
      for (const s of SERIES) {
        if (p[s.key] === null) continue;
        hover.append(svgEl("circle", { cx: x(i), cy: y(p[s.key]), r: 4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2 }));
        const row = el("div", { class: "tt-row" });
        const key = el("i", { class: "key" });
        key.style.background = s.color;
        row.append(key, el("b", null, fmtNum(p[s.key])), el("span", null, s.key === "ref" ? "referencia" : "hoy"));
        tip.append(row);
      }
      tip.style.display = "block";
      const left = (x(i) / width) * box.clientWidth;
      tip.style.left = `${Math.max(0, Math.min(left + 12, box.clientWidth - tip.offsetWidth))}px`;
      tip.style.top = "8px";
    }
    function hide() {
      hover.replaceChildren();
      tip.style.display = "none";
    }
    const hit = svgEl("rect", { x: m.left, y: m.top, width: pw, height: ph, fill: "transparent" });
    svg.append(hit);
    const indexAt = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * width;
      return Math.max(0, Math.min(n - 1, Math.floor(((px - m.left) * n) / pw)));
    };
    hit.addEventListener("mousemove", (e) => show(indexAt(e.clientX)));
    hit.addEventListener("touchstart", (e) => show(indexAt(e.touches[0].clientX)), { passive: true });
    hit.addEventListener("mouseleave", hide);
    let kb = lastToday ? lastToday.i : 0;
    svg.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      kb = Math.max(0, Math.min(n - 1, kb + (e.key === "ArrowRight" ? 1 : -1)));
      show(kb);
    });
    svg.addEventListener("blur", hide);
  }

  function render() {
    const card = $("home-week-card");
    card.hidden = false;
    const first = new Date(data.days[0].start).getTime();
    const last = new Date(data.days[6].start).getTime();
    $("home-week-desc").textContent =
      `Del ${dayLabel(first)} al ${dayLabel(last)}. Hoy se compara con el ${dayLabel(new Date(data.today.refDay).getTime())} (banda gris): ` +
      `a cada hora le toca el ${data.percentage}% de lo de esa hora, por la proporcion con link de hoy.`;
    $("home-week-legend").replaceChildren(
      ...SERIES.map((s) => {
        const i = el("i");
        i.style.background = s.color;
        const li = el("li");
        li.append(i, s.label);
        return li;
      })
    );
    const sources = new Set(data.days.map((d) => d.source));
    const sourceText = sources.size === 1 ? SOURCE[[...sources][0]] : "mixta (ver la tabla)";
    const errors = data.days.filter((d) => d.error).map((d) => `${d.day}: ${d.error}`);
    const facts = [
      ["Total de la semana", fmtNum(data.total)],
      ["Promedio por dia", fmtNum(data.dailyAverage)],
      ["Fuente", data.restConfigured ? sourceText : `${sourceText} (falta la REST API)`],
      ["Hoy: objetivo de clicks", `${fmtNum(data.today.target)} (proporcion con link ${Math.round(data.today.linkRatio * 1000) / 10}%)`],
      ["Hoy: elegidos / clickeados", `${fmtNum(data.today.approved)} / ${fmtNum(data.today.clicked)}`],
    ];
    const dl = $("home-week-facts");
    dl.replaceChildren(
      ...facts.map(([k, v]) => {
        const div = el("div");
        div.append(el("dt", null, k), el("dd", null, v));
        return div;
      })
    );
    $("home-week-error").hidden = errors.length === 0;
    $("home-week-error").textContent = errors.length ? `Alaris no respondio para ${errors.length} dia(s): ${errors[0]}` : "";
    $("home-week-refresh").disabled = !data.restConfigured;
    draw();
    table(
      $("home-week-table"),
      [
        { label: "Dia", render: (d) => dayLabel(new Date(d.start).getTime()) },
        { label: "Fuente", render: (d) => SOURCE[d.source] },
        { label: "Total", num: true, render: (d) => fmtNum(d.total) },
        ...Array.from({ length: 24 }, (_, h) => ({ label: pad(h), num: true, render: (d) => fmtNum(d.hourly[h]) })),
      ],
      data.days,
      "Sin datos"
    );
  }

  async function load(policy) {
    const card = $("home-week-card");
    const sel = policy && policy.rules.selection;
    if (!sel || sel.action !== "visitar" || sel.base !== "semana_referencia") {
      policyId = null;
      card.hidden = true;
      return;
    }
    policyId = policy.id;
    try {
      data = await api(`/admin/policies/${policy.id}/week`);
      render();
    } catch (err) {
      card.hidden = false;
      $("home-week-error").hidden = false;
      $("home-week-error").textContent = errorText(err);
    }
  }

  $("home-week-refresh").addEventListener("click", async () => {
    if (!policyId) return;
    const btn = $("home-week-refresh");
    btn.disabled = true;
    btn.textContent = "Pidiendo a Alaris…";
    try {
      await api(`/admin/policies/${policyId}/week/refresh`, { method: "POST" });
      data = await api(`/admin/policies/${policyId}/week`);
      render();
    } catch (err) {
      $("home-week-error").hidden = false;
      $("home-week-error").textContent = errorText(err);
    } finally {
      btn.textContent = "Volver a bajar de Alaris";
      btn.disabled = !(data && data.restConfigured);
    }
  });
  window.addEventListener("resize", () => {
    if (data && !$("home-week-card").hidden) draw();
  });

  CM.homeWeek = { load };
})();
