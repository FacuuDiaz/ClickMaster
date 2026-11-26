// Seccion Politicas: lista ordenable, editor y vista previa (/admin/policies).
(function () {
  "use strict";
  const { $, el, api, errorText, showBanner, hideBanner, fmtNum, fmtDate, table } = CM;

  const DAYS = ["Dom", "Lun", "Mar", "Mie", "Jue", "Vie", "Sab"];
  const MATCH_FIELDS = [
    ["clients", "Clientes"],
    ["senders", "Senders"],
    ["countries", "Paises"],
    ["networks", "Redes"],
    ["mccmnc", "MCC/MNC"],
    ["vendors", "Vendors"],
    ["domains", "Dominios del link"],
  ];
  const BASES = {
    ventana: "De cada ventana",
    dia_vencido: "Dia vencido (sobre los SMS de ayer)",
    semana_anterior: "Mismo dia de la semana anterior",
    dia_anterior: "Dia anterior (curva horaria de ayer)",
    semana_referencia: "Semana de referencia (por dia y hora)",
  };
  const BASE_HELP = {
    ventana: "Cuando la ventana llego completa se elige este % de todos sus SMS.",
    dia_vencido: "Cuando el dia cierra se elige este % de todos los SMS de ese dia, entre esos mismos SMS. Los de hoy no se visitan hasta manana.",
    semana_anterior: "Cuota del dia = este % del total del mismo dia de la semana anterior (o el promedio de N semanas). Se visita entre los SMS de hoy, repartida en el dia segun la estrategia. Sin datos de esa semana: este % de cada ventana.",
    dia_anterior: "A cada hora de hoy le toca este % de lo que mando el producto ayer en esa misma hora (sms_usage_stats de Alaris; si no responde, lo ingerido ayer), escalado por la proporcion de SMS con link de hoy. Se visita entre los SMS de hoy; lo que falte en una hora pasa a la siguiente.",
    semana_referencia: "Se baja de Alaris (sms_usage_stats) el trafico hora por hora de la semana elegida. A cada hora de hoy le toca este % de lo que hubo a esa hora el mismo dia de la semana de referencia (martes con martes), por la proporcion de SMS con link de hoy. El EDR se pide de a 1 hora (la ventana pasa a 60 min al activarla) y SOLO se guardan los SMS elegidos: el resto se descarta y queda contado por minuto. El Panel muestra el grafico de la semana.",
  };
  // Se completa con /admin/policies/strategies (etiquetas, descripcion y ejemplo).
  let strategies = null;
  const strategyLabel = (id) => (strategies && strategies.strategies.find((x) => x.id === id)?.label) || id;

  let policies = [];
  let defaultPercentage = null;
  let editing = null; // politica que se edita (null = nueva)
  let editorOpen = false;

  // ---------- Resumen en texto ----------

  function summary(p) {
    const r = p.rules;
    const lines = [];
    const m = MATCH_FIELDS.filter(([k]) => r.match[k].length).map(([k, label]) => `${label}: ${r.match[k].join(", ")}`);
    lines.push(m.length ? `Coincide con ${m.join(" · ")}` : "Coincide con todos los SMS con link");
    const sel = r.selection;
    const how = `estrategia ${strategyLabel(sel.strategy).toLowerCase()}`;
    if (sel.action === "no_visitar") lines.push("No se visitan");
    else if (sel.base === "ventana") lines.push(`Visita el ${sel.percentage}% de cada ventana, elegido sobre la ventana completa · ${how}`);
    else if (sel.base === "dia_vencido") lines.push(`Visita el ${sel.percentage}% del dia anterior, entre los SMS de ese dia (los de hoy se eligen manana) · ${how}`);
    else if (sel.base === "semana_referencia") lines.push(`Visita hoy el ${sel.percentage}% de la misma hora y dia de la semana del ${weekText(sel.weekStart)}, escalado por la proporcion con link; solo guarda los elegidos · ${how}`);
    else if (sel.base === "dia_anterior") lines.push(`Visita hoy el ${sel.percentage}% de lo que se mando ayer, hora por hora, escalado por la proporcion con link · ${how}`);
    else {
      const ref = sel.weeks > 1 ? `del promedio del mismo dia de las ultimas ${sel.weeks} semanas` : "del mismo dia de la semana anterior";
      lines.push(`Cuota del dia: ${sel.percentage}% del total ${ref}, repartida a lo largo de hoy · ${how}`);
    }
    const s = r.schedule;
    const allDays = s.days.length === 7;
    const ranges = s.ranges.map((x) => `${x.from}-${x.to}`).join(", ");
    if (!allDays || ranges) lines.push(`Horario: ${allDays ? "todos los dias" : s.days.map((d) => DAYS[d]).join(", ")}${ranges ? ` · ${ranges}` : " · todo el dia"}`);
    if (s.spread) lines.push("Clicks repartidos a lo largo de cada ventana (no todos juntos)");
    const l = r.limits;
    if (l.perHour !== null || l.perDay !== null) {
      lines.push(`Topes: ${[l.perHour !== null ? `${fmtNum(l.perHour)}/hora` : null, l.perDay !== null ? `${fmtNum(l.perDay)}/dia` : null].filter(Boolean).join(" · ")}`);
    }
    const v = r.visit;
    const vis = [];
    if (v.dwellMinMs !== null || v.dwellMaxMs !== null) vis.push(`permanencia ${v.dwellMinMs ?? v.dwellMaxMs}-${v.dwellMaxMs ?? v.dwellMinMs} ms`);
    if (v.timeoutMs !== null) vis.push(`timeout ${v.timeoutMs} ms`);
    if (v.maxAttempts !== null) vis.push(`${v.maxAttempts} intentos`);
    if (v.blockResources !== null) vis.push(v.blockResources ? "sin imagenes/fuentes" : "con imagenes/fuentes");
    if (vis.length) lines.push(`Visita: ${vis.join(" · ")}`);
    return lines;
  }

  // ---------- Lista ----------

  function renderList() {
    const list = $("pol-list");
    list.replaceChildren();
    policies.forEach((p) => {
      const card = el("div", { class: `card pol${p.enabled ? "" : " off"}` });
      // Interruptor: prender una apaga la que estaba (una sola activa).
      const sw = el("label", { class: "switch", title: p.enabled ? "Activa: apagarla deja la regla por defecto" : "Activarla (apaga la que este activa)" });
      const cb = el("input", { type: "checkbox", role: "switch", "aria-label": `Activar ${p.name}` });
      cb.checked = p.enabled;
      cb.addEventListener("change", () => {
        cb.checked = p.enabled; // el cambio se ve recien al confirmar
        toggle(p);
      });
      sw.append(cb, el("span", { class: "track" }));
      card.append(sw);
      const body = el("div");
      const title = el("div", { class: "title" });
      title.append(document.createTextNode(p.name), el("span", { class: `badge ${p.enabled ? "on" : "off"}` }, p.enabled ? "activa" : "inactiva"));
      body.append(title);
      const ul = el("ul");
      for (const line of summary(p)) ul.append(el("li", null, line));
      body.append(ul);
      body.append(el("div", { class: "muted", style: "margin-top:6px;font-size:12px" }, `Editada ${fmtDate(p.updatedAt)}${p.updatedBy ? ` por ${p.updatedBy}` : ""}`));
      card.append(body);

      const tools = el("div", { class: "tools" });
      const btn = (label, fn, opts = {}) => {
        const b = el("button", { type: "button", class: `btn${opts.cls ? ` ${opts.cls}` : ""}`, "aria-label": opts.aria || label }, label);
        b.disabled = Boolean(opts.disabled);
        b.addEventListener("click", fn);
        tools.append(b);
      };
      btn("Editar", () => openEditor(p));
      btn("Borrar", () => remove(p), { cls: "danger" });
      card.append(tools);
      list.append(card);
    });

    if (policies.length === 0) {
      const empty = el("div", { class: "card" });
      empty.append(
        el("h2", null, "No hay politicas"),
        el("p", { class: "desc" }, "Todos los SMS usan la regla por defecto. Podes crear una o cargar las 3 de fabrica: 20% de cada ventana (activa), 20% del dia vencido y 20% del mismo dia de la semana anterior (apagadas).")
      );
      const load = el("button", { type: "button", class: "btn primary" }, "Cargar las politicas de fabrica");
      load.addEventListener("click", loadDefaults);
      empty.append(load);
      list.append(empty);
    }

    const def = el("div", { class: "card pol" });
    const anyActive = policies.some((p) => p.enabled);
    def.append(el("span", { class: `badge ${anyActive ? "off" : "warn"}`, style: "align-self:start" }, anyActive ? "respaldo" : "en espera"));
    const body = el("div");
    body.append(el("div", { class: "title" }, "Por defecto"));
    const ul = el("ul");
    ul.append(el("li", null, anyActive
      ? `SMS con link que no coinciden con la politica activa: se visita el ${defaultPercentage}% de cada ventana, al azar.`
      : "No hay politica activa: el sistema esta en espera. No se piden SMS a Alaris ni se visita ningun link hasta que actives una."));
    const li = el("li");
    const a = el("a", { href: "#configuracion" }, "Cambiar en Configuracion");
    li.append(document.createTextNode("Es el valor de \"Porcentaje a visitar (por defecto)\". "), a);
    ul.append(li);
    body.append(ul);
    def.append(body);
    list.append(def);
  }

  async function load() {
    try {
      const [data, st] = await Promise.all([api("/admin/policies"), strategies ? strategies : api("/admin/policies/strategies")]);
      strategies = st;
      policies = data.policies;
      defaultPercentage = data.defaultPercentage;
      renderList();
      loadChanges();
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
  }

  async function loadDefaults() {
    // La primera de fabrica viene activa: es un cambio en ejecucion.
    const first = { name: "20% de cada ventana", rules: { selection: { action: "visitar", percentage: 20, base: "ventana", strategy: "intercalado" } } };
    const repeatMode = await confirmChange(active(), first, "Cargar las politicas de fabrica");
    if (!repeatMode) return;
    try {
      const data = await api("/admin/policies/defaults", { method: "POST", body: { repeatMode } });
      policies = data.policies;
      renderList();
      loadChanges();
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
  }

  // JSON con las claves ordenadas: para comparar reglas sin falsos cambios.
  function stable(v) {
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
    return JSON.stringify(v);
  }

  // ---------- Cambio de la politica activa (modal) ----------

  const active = () => policies.find((p) => p.enabled) || null;
  const nameOf = (p) => (p ? `"${p.name}"` : "la regla por defecto");

  function effectsOf(target) {
    const sel = target ? target.rules.selection : null;
    if (!target) return [`Todos los SMS de hoy pasan a la regla por defecto: ${defaultPercentage}% de cada ventana, al azar. Las ventanas que ya llegaron se vuelven a elegir con esa regla.`];
    if (sel.action === "no_visitar") return ["Los SMS que coinciden dejan de visitarse; lo que ya estaba en cola o clickeado queda como esta."];
    if (sel.base === "dia_vencido") {
      return [
        "Hoy no se elige nada mas con esta politica: manana, al cerrar el dia, se elige el " + sel.percentage + "% de TODOS los SMS de hoy (incluidos los que ya proceso la anterior).",
        "Lo que la politica anterior ya mando a la cola o clickeo hoy se mantiene.",
      ];
    }
    if (sel.base === "semana_referencia") {
      return [
        `Desde ahora solo se guardan los SMS elegidos: lo que no se elija se descarta (queda contado por minuto). La ventana de ingesta pasa a 1 hora.`,
        "Las ventanas de hoy que ya llegaron se vuelven a elegir con la referencia de la semana, pero solo entre lo ya guardado.",
      ];
    }
    if (sel.base === "dia_anterior") {
      return ["El objetivo de cada hora de hoy se recalcula con la curva de ayer y las ventanas de hoy que ya llegaron se vuelven a elegir, descontando lo ya aprobado."];
    }
    if (sel.base === "semana_anterior") {
      return ["La cuota del dia se recalcula con esta politica y las ventanas de hoy que ya llegaron se vuelven a elegir, descontando lo ya aprobado."];
    }
    return [`Las ventanas de hoy que ya llegaron se vuelven a elegir con esta politica (${sel.percentage}% de cada una, ${strategyLabel(sel.strategy).toLowerCase()}).`];
  }

  /**
   * Muestra el aviso de cambio en ejecucion. Devuelve el modo elegido para
   * los SMS ya clickeados ("igual" | "doble") o null si se cancela.
   */
  function confirmChange(from, to, verb) {
    const dialog = $("pol-change-dialog");
    $("pol-change-title").textContent = verb || "Cambiar la politica activa";
    const samePolicy = from && to && from.id !== undefined && from.id === to.id;
    const pctOf = (p) => p.rules.selection.percentage;
    $("pol-change-what").textContent = !samePolicy
      ? `De ${nameOf(from)} a ${nameOf(to)}.`
      : pctOf(from) !== pctOf(to)
        ? `Misma politica, porcentaje ${pctOf(from)}% → ${pctOf(to)}%.`
        : `Se cambian las reglas de ${nameOf(to)}.`;
    $("pol-change-effects").replaceChildren(...effectsOf(to).map((t) => el("li", null, t)));
    dialog.querySelector('input[value="igual"]').checked = true;
    return new Promise((resolve) => {
      const done = (value) => {
        $("pol-change-ok").removeEventListener("click", ok);
        $("pol-change-cancel").removeEventListener("click", cancel);
        dialog.removeEventListener("cancel", cancel);
        dialog.close();
        resolve(value);
      };
      const ok = () => done(dialog.querySelector('input[name="pol-repeat"]:checked').value);
      const cancel = (e) => {
        if (e) e.preventDefault();
        done(null);
      };
      $("pol-change-ok").addEventListener("click", ok);
      $("pol-change-cancel").addEventListener("click", cancel);
      dialog.addEventListener("cancel", cancel);
      dialog.showModal();
    });
  }

  async function toggle(p) {
    const target = p.enabled ? null : p;
    // Apagar no pregunta nada: los SMS ya clickeados cuentan igual.
    const repeatMode = p.enabled ? "igual" : await confirmChange(active(), target, `Activar "${p.name}"`);
    if (!repeatMode) return;
    try {
      const data = await api("/admin/policies/active", { method: "POST", body: { id: target ? target.id : null, repeatMode } });
      policies = data.policies;
      renderList();
      loadChanges();
      CM.refreshSideStatus();
      if (!target) showBanner("Sin politica activa: el sistema queda en espera (no se piden SMS a Alaris ni se visitan links).");
      if (data.windowChanged) showBanner("La ventana de ingesta paso a 1 hora (la semana de referencia elige sobre la hora entera).");
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
  }

  async function remove(p) {
    let repeatMode = "igual";
    if (p.enabled) {
      repeatMode = await confirmChange(p, null, `Borrar "${p.name}" (es la activa)`);
      if (!repeatMode) return;
    } else if (!confirm(`¿Borrar la politica "${p.name}"? Los SMS que ya la tenian conservan la referencia.`)) {
      return;
    }
    try {
      await api(`/admin/policies/${p.id}`, { method: "DELETE", params: { repeatMode } });
      if (editing && editing.id === p.id) closeEditor();
      await load();
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
  }

  // ---------- Cambios recientes ----------

  const CHANGE_STATUS = { pendiente: "Pendiente", aplicando: "Aplicando…", aplicado: "Aplicado", reemplazado: "Reemplazado", error: "Error" };
  let changesTimer = null;

  function changeResult(c) {
    if (c.error && c.status !== "aplicado") return `Error: ${c.error} (se reintenta solo)`;
    const r = c.result;
    if (!r) return "";
    const parts = [`${fmtNum(r.reassigned)} SMS de hoy re-asignados`, `${fmtNum(r.approved)} elegidos`];
    if (r.counted) parts.push(`${fmtNum(r.counted)} ya hechos que cuentan`);
    if (r.requeued) parts.push(`${fmtNum(r.requeued)} se vuelven a clickear`);
    return parts.join(" · ");
  }

  async function loadChanges() {
    clearTimeout(changesTimer);
    try {
      const { changes } = await api("/admin/policies/changes");
      table(
        $("pol-changes"),
        [
          { label: "Cuando", cls: "time", render: (c) => `${fmtDate(c.createdAt)}${c.actor ? ` · ${c.actor}` : ""}` },
          { label: "Cambio", cls: "text", render: (c) => `${c.fromName || "Por defecto"} → ${c.toName || "Por defecto"}` },
          { label: "Ya clickeados", render: (c) => (c.repeatMode === "doble" ? "otro click" : "cuentan igual") },
          { label: "Estado", render: (c) => CHANGE_STATUS[c.status] || c.status },
          { label: "Resultado", cls: "text", render: changeResult },
        ],
        changes,
        "Todavia no se cambio la politica activa"
      );
      // Mientras se aplica, se actualiza solo.
      if (changes.some((c) => c.status === "pendiente" || c.status === "aplicando") && CM.currentView() === "politicas") {
        changesTimer = setTimeout(loadChanges, 3000);
      }
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
  }

  // ---------- Semana de referencia ----------

  const WD = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"];
  const ymd = (d) => d.toISOString().slice(0, 10);
  /** "lun 16/11 al dom 22/11" a partir de "2026-11-16". */
  function weekText(start) {
    if (!start) return "(sin elegir)";
    const a = new Date(`${start}T12:00:00Z`);
    const b = new Date(a.getTime() + 6 * 86_400_000);
    const f = (d) => `${WD[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    return `${f(a)} al ${f(b)}`;
  }
  /** Lunes de la ultima semana completa (hora de Alaris, GMT-3). */
  function lastFullWeek() {
    const today = new Date(Date.now() - 3 * 3_600_000);
    const sinceMonday = (today.getUTCDay() + 6) % 7;
    return ymd(new Date(today.getTime() - (sinceMonday + 7) * 86_400_000));
  }
  function weekClosed(start) {
    const today = ymd(new Date(Date.now() - 3 * 3_600_000));
    return ymd(new Date(new Date(`${start}T12:00:00Z`).getTime() + 7 * 86_400_000)) <= today;
  }

  // ---------- Editor ----------

  const BLANK = {
    name: "",
    // Nueva = apagada: activarla cambia lo que corre (pasa por el aviso).
    enabled: false,
    rules: {
      match: Object.fromEntries(MATCH_FIELDS.map(([k]) => [k, []])),
      selection: { action: "visitar", percentage: 20, base: "ventana", weeks: 1, strategy: "intercalado" },
      schedule: { days: [0, 1, 2, 3, 4, 5, 6], ranges: [], spread: false },
      limits: { perHour: null, perDay: null },
      visit: { dwellMinMs: null, dwellMaxMs: null, blockResources: null, timeoutMs: null, maxAttempts: null },
    },
  };

  function field(label, control, hint) {
    const f = el("label", { class: "field" });
    f.append(document.createTextNode(label), control);
    if (hint) f.append(el("span", { class: "muted", style: "font-size:12px" }, hint));
    return f;
  }
  function numInput(id, value, attrs = {}) {
    const i = el("input", { type: "number", id, inputmode: "decimal", step: attrs.step || "1", min: attrs.min, max: attrs.max, placeholder: attrs.placeholder || "" });
    i.value = value === null || value === undefined ? "" : String(value);
    return i;
  }
  function fieldset(title, ...children) {
    const fs = el("fieldset");
    fs.append(el("legend", null, title), ...children);
    return fs;
  }

  function openEditor(policy) {
    editing = policy || null;
    editorOpen = true;
    const p = policy ? JSON.parse(JSON.stringify(policy)) : JSON.parse(JSON.stringify(BLANK));
    const r = p.rules;
    const box = $("pol-editor");
    box.replaceChildren();
    box.hidden = false;
    box.append(el("h2", null, policy ? `Editar: ${policy.name}` : "Nueva politica"));
    box.append(el("p", { class: "desc" }, "Los cambios aplican a los SMS que se ingesten desde que se guarda. Los que ya estan en la cola no cambian."));

    const form = el("form", { id: "pol-form", novalidate: true });
    const name = el("input", { type: "text", id: "pol-name", maxlength: "100", required: true });
    name.value = p.name;
    const enabled = el("input", { type: "checkbox", id: "pol-enabled", role: "switch" });
    enabled.checked = p.enabled;
    const enabledLabel = el("label", { class: "switch", style: "align-self:end;padding-bottom:8px" });
    enabledLabel.append(enabled, el("span", { class: "track" }), document.createTextNode("Activa (apaga la que este activa)"));
    form.append(el("div", { class: "fields", style: "margin-bottom:12px" }, null));
    form.lastChild.append(field("Nombre", name), enabledLabel);

    // Coincidencia
    const matchBox = el("div", { class: "fields" });
    for (const [k, label] of MATCH_FIELDS) {
      const ta = el("textarea", { id: `pol-m-${k}`, rows: "2", placeholder: k === "domains" ? "ejemplo.com\n*.ejemplo.com" : "uno por linea" });
      ta.value = r.match[k].join("\n");
      matchBox.append(field(label, ta, k === "domains" ? "*.dominio incluye subdominios" : null));
    }
    form.append(fieldset("Que SMS toma (vacio = todos)", matchBox));

    // Seleccion
    const sel = r.selection;
    const action = el("select", { id: "pol-action" });
    action.append(el("option", { value: "visitar" }, "Visitar un porcentaje"), el("option", { value: "no_visitar" }, "No visitar nunca"));
    action.value = sel.action;
    const value = numInput("pol-value", sel.percentage, { step: "any", min: "0", max: "100" });
    const base = el("select", { id: "pol-base" });
    for (const [k, label] of Object.entries(BASES)) base.append(el("option", { value: k }, label));
    base.value = sel.base;
    const weeks = el("select", { id: "pol-weeks" });
    for (const w of [1, 2, 3, 4]) weeks.append(el("option", { value: String(w) }, w === 1 ? "solo la semana anterior" : `promedio de ${w} semanas`));
    weeks.value = String(sel.weeks || 1);
    const strategy = el("select", { id: "pol-strategy" });
    for (const st of strategies ? strategies.strategies : [{ id: sel.strategy, label: sel.strategy }]) strategy.append(el("option", { value: st.id }, st.label));
    strategy.value = sel.strategy;

    const weekStart = el("input", { type: "date", id: "pol-week-start" });
    weekStart.value = sel.weekStart || lastFullWeek();
    weekStart.max = ymd(new Date(Date.now() - 3 * 3_600_000 - 7 * 86_400_000));

    const selBox = el("div", { class: "fields" });
    const fValue = field("Porcentaje", value);
    const fBase = field("Sobre que total", base);
    const fWeeks = field("Referencia", weeks);
    const fWeekStart = field("Primer dia de la semana de referencia", weekStart);
    const weekHint = el("span", { class: "muted", style: "font-size:12px" });
    fWeekStart.append(weekHint);
    const fStrategy = field("Estrategia (cuales)", strategy);
    selBox.append(field("Accion", action), fValue, fBase, fWeeks, fWeekStart, fStrategy);
    const selHelp = el("p", { class: "muted", style: "margin:8px 0 0" });
    const strips = el("div", { class: "strips", role: "radiogroup", "aria-label": "Estrategias" });

    function renderStrips() {
      strips.replaceChildren();
      if (!strategies) return;
      strips.append(el("p", { class: "muted", style: "margin:0 0 6px" }, `Ejemplo: ${strategies.n} SMS del periodo ordenados por hora, se eligen ${strategies.k} (20%). Toca una para elegirla.`));
      for (const st of strategies.strategies) {
        const row = el("button", { type: "button", class: "strip", role: "radio", "aria-checked": String(st.id === strategy.value), title: st.description });
        const cells = el("span", { class: "cells", "aria-hidden": "true" });
        const picked = new Set(st.picks);
        for (let i = 0; i < strategies.n; i++) cells.append(el("i", picked.has(i) ? { class: "on" } : null));
        row.append(el("b", null, st.label), cells, el("span", { class: "muted" }, st.description));
        row.addEventListener("click", () => {
          strategy.value = st.id;
          syncSel();
        });
        strips.append(row);
      }
    }

    const syncSel = () => {
      const visit = action.value === "visitar";
      for (const f of [fValue, fBase, fStrategy, strips]) f.hidden = !visit;
      fWeeks.hidden = !visit || base.value !== "semana_anterior";
      fWeekStart.hidden = !visit || base.value !== "semana_referencia";
      weekHint.textContent = !weekStart.value
        ? "Elegi una fecha"
        : weekClosed(weekStart.value)
          ? `Del ${weekText(weekStart.value)}`
          : `Del ${weekText(weekStart.value)}: la semana todavia no termino`;
      selHelp.textContent = visit ? BASE_HELP[base.value] : "Los SMS que coinciden quedan salteados (motivo: politica).";
      for (const b of strips.querySelectorAll(".strip")) b.setAttribute("aria-checked", String(b.querySelector("b").textContent === strategyLabel(strategy.value)));
    };
    [action, base, strategy, weekStart].forEach((x) => x.addEventListener("change", syncSel));
    renderStrips();
    form.append(fieldset("Cuantos y cuales visita", selBox, selHelp, strips));

    // Horario
    const dayBox = el("div", { class: "days" });
    DAYS.forEach((d, i) => {
      const cb = el("input", { type: "checkbox", value: String(i), "data-day": "1" });
      cb.checked = r.schedule.days.includes(i);
      const l = el("label");
      l.append(cb, document.createTextNode(d));
      dayBox.append(l);
    });
    const ranges = el("textarea", { id: "pol-ranges", rows: "2", placeholder: "08:00-13:00\n15:00-21:00" });
    ranges.value = r.schedule.ranges.map((x) => `${x.from}-${x.to}`).join("\n");
    const schedBox = el("div", { class: "fields" });
    const spread = el("input", { type: "checkbox", id: "pol-spread" });
    spread.checked = Boolean(r.schedule.spread);
    // Mismo armado que "Dias" (caja con su label adentro).
    const spreadLabel = el("div", { class: "days" });
    const spreadInner = el("label");
    spreadInner.append(spread, document.createTextNode("Repartir los clicks a lo largo de la ventana"));
    spreadLabel.append(spreadInner);
    schedBox.append(
      field("Dias", dayBox),
      field("Franjas (vacio = todo el dia)", ranges, "hora de Alaris; fuera de horario el SMS espera a la proxima franja"),
      field("Ritmo", spreadLabel, "Apagado: los elegidos de cada ventana salen todos juntos apenas se ingesta. Prendido: salen parejos durante la ventana siguiente (60 min con semana de referencia), sin contar el tiempo fuera de franja. No cambia la cantidad de pedidos a Alaris.")
    );
    form.append(fieldset("Cuando", schedBox));

    // Topes
    const perHour = numInput("pol-perhour", r.limits.perHour, { min: "0", placeholder: "sin tope" });
    const perDay = numInput("pol-perday", r.limits.perDay, { min: "0", placeholder: "sin tope" });
    const limBox = el("div", { class: "fields" });
    limBox.append(field("Maximo por hora", perHour, "aprobados por hora; el excedente queda salteado"), field("Maximo por dia", perDay));
    form.append(fieldset("Topes", limBox));

    // Visita
    const v = r.visit;
    const dwellMin = numInput("pol-dwellmin", v.dwellMinMs, { min: "0", placeholder: "0" });
    const dwellMax = numInput("pol-dwellmax", v.dwellMaxMs, { min: "0", placeholder: "0" });
    const timeout = numInput("pol-timeout", v.timeoutMs, { min: "1000", placeholder: "global" });
    const attempts = numInput("pol-attempts", v.maxAttempts, { min: "1", max: "20", placeholder: "global" });
    const block = el("select", { id: "pol-block" });
    block.append(el("option", { value: "" }, "Como la config global"), el("option", { value: "true" }, "Si, bloquear"), el("option", { value: "false" }, "No, cargar todo"));
    block.value = v.blockResources === null ? "" : String(v.blockResources);
    const visBox = el("div", { class: "fields" });
    visBox.append(
      field("Permanencia minima (ms)", dwellMin),
      field("Permanencia maxima (ms)", dwellMax, "mas permanencia = menos visitas por minuto"),
      field("Timeout (ms)", timeout),
      field("Intentos maximos", attempts),
      field("Bloquear imagenes y fuentes", block)
    );
    form.append(fieldset("Como visita (vacio = valores globales)", visBox));

    // Botones + vista previa
    const hours = el("select", { id: "pol-hours", "aria-label": "Horas para la vista previa" });
    for (const h of [1, 6, 24, 48]) hours.append(el("option", { value: String(h) }, `ultimas ${h} h`));
    hours.value = "6";
    const preview = el("button", { type: "button", class: "btn" }, "Vista previa");
    const save = el("button", { type: "submit", class: "btn primary" }, "Guardar");
    const cancel = el("button", { type: "button", class: "btn" }, "Cancelar");
    const row = el("div", { class: "form-row" });
    row.append(preview, hours, el("span", { style: "flex:1" }), cancel, save);
    const errors = el("div", { class: "result bad", "aria-live": "polite" });
    const previewBox = el("div", { class: "tbl-wrap", style: "margin-top:12px" });
    form.append(row, errors, previewBox);
    box.append(form);
    syncSel();

    const lines = (id) => $(id).value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
    const num = (input) => (input.value.trim() === "" ? null : Number(input.value));

    function collect() {
      const selection = {
        action: action.value,
        percentage: num(value) ?? 0,
        base: base.value,
        weeks: Number(weeks.value),
        strategy: strategy.value,
        weekStart: base.value === "semana_referencia" ? weekStart.value || null : sel.weekStart || null,
      };
      const parsedRanges = [];
      for (const line of lines("pol-ranges")) {
        const m = line.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
        if (!m) throw new Error(`Franja invalida: "${line}" (formato 08:00-20:00)`);
        const pad = (t) => t.padStart(5, "0");
        parsedRanges.push({ from: pad(m[1]), to: pad(m[2]) });
      }
      return {
        name: name.value.trim(),
        enabled: enabled.checked,
        rules: {
          match: Object.fromEntries(MATCH_FIELDS.map(([k]) => [k, lines(`pol-m-${k}`)])),
          selection,
          schedule: { days: [...dayBox.querySelectorAll("input[data-day]")].filter((c) => c.checked).map((c) => Number(c.value)), ranges: parsedRanges, spread: spread.checked },
          limits: { perHour: num(perHour), perDay: num(perDay) },
          visit: {
            dwellMinMs: num(dwellMin),
            dwellMaxMs: num(dwellMax),
            timeoutMs: num(timeout),
            maxAttempts: num(attempts),
            blockResources: block.value === "" ? null : block.value === "true",
          },
        },
      };
    }

    preview.addEventListener("click", async () => {
      errors.textContent = "";
      previewBox.replaceChildren(el("div", { class: "muted" }, "Calculando…"));
      try {
        const draft = collect();
        if (!draft.name) draft.name = "(sin nombre)";
        if (editing) draft.id = editing.id;
        const est = await api("/admin/policies/preview", { method: "POST", body: { hours: Number(hours.value), draft } });
        renderEstimate(previewBox, est, editing ? editing.id : -1);
      } catch (err) {
        previewBox.replaceChildren();
        errors.textContent = errorText(err);
      }
    });

    cancel.addEventListener("click", closeEditor);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errors.textContent = "";
      try {
        const body = collect();
        // Cambio en ejecucion: se activa, se desactiva o se cambian las reglas de la activa.
        const was = editing;
        // Apagarla desde el editor tampoco pregunta (como el interruptor).
        const runtime = body.enabled && (!was || !was.enabled || stable(was.rules) !== stable(body.rules));
        if (runtime) {
          const from = was && was.enabled ? was : active();
          const verb = was && was.enabled ? `Cambiar las reglas de "${body.name}" (es la activa)` : `Activar "${body.name}"`;
          const repeatMode = await confirmChange(from, body.enabled ? body : null, verb);
          if (!repeatMode) return;
          body.repeatMode = repeatMode;
        }
        const saved = editing
          ? await api(`/admin/policies/${editing.id}`, { method: "PUT", body })
          : await api("/admin/policies", { method: "POST", body });
        closeEditor();
        hideBanner();
        showBanner(`Politica "${body.name}" guardada.${saved.windowChanged ? " La ventana de ingesta paso a 1 hora." : ""}`);
        await load();
      } catch (err) {
        errors.textContent = errorText(err);
      }
    });
    CM.go("politicas", "editor");
    setTimeout(() => name.focus(), 0);
  }

  function closeEditor() {
    editing = null;
    editorOpen = false;
    $("pol-editor").replaceChildren();
    CM.go("politicas", "lista");
  }

  /** Tabla de estimacion: la usan la vista previa y las capturas. */
  function renderEstimate(target, est, highlightId) {
    target.replaceChildren();
    const info = `${fmtNum(est.sampled)} SMS${est.hours ? ` de las ultimas ${est.hours} h` : ""}${est.truncated ? " (muestra de los mas recientes)" : ""} · ${fmtNum(est.withoutLink)} sin link`;
    target.append(el("div", { class: "muted", style: "margin-bottom:6px" }, info));
    const holder = el("div");
    table(
      holder,
      [
        { label: "Politica", render: (r) => (r.policyId === highlightId ? `▶ ${r.name}` : r.name) },
        { label: "Coinciden", num: true, render: (r) => fmtNum(r.matched) },
        { label: "%", num: true, render: (r) => `${r.percentage}%` },
        { label: "Visitas estimadas", num: true, render: (r) => fmtNum(r.estimatedVisits) },
        { label: "Nota", cls: "text", render: (r) => r.note || "" },
      ],
      est.rows,
      "Sin SMS en ese rango"
    );
    target.append(holder);
  }

  $("pol-new").addEventListener("click", () => openEditor(null));
  CM.onEnter("politicas", load);
  CM.onLeave("politicas", () => clearTimeout(changesTimer));
  // El editor solo se abre con "Nueva politica" o "Editar": entrar directo
  // por la URL (o recargar la pagina) vuelve a la lista.
  CM.onTab("politicas", (tab) => {
    if (tab === "editor" && !editorOpen) CM.go("politicas", "lista");
    if (tab !== "editor" && editorOpen) {
      editorOpen = false;
      editing = null;
      $("pol-editor").replaceChildren();
    }
  });
  $("pol-back").addEventListener("click", closeEditor);
  CM.renderEstimate = renderEstimate;
  // El Panel (vista basica) usa el mismo aviso para cambiar la activa.
  CM.confirmPolicyChange = async (from, to, verb) => {
    if (!strategies) strategies = await api("/admin/policies/strategies").catch(() => null);
    return confirmChange(from, to, verb);
  };
})();
