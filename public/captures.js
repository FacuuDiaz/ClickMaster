// Seccion Capturas: respuestas de Alaris guardadas temporalmente (/admin/captures).
(function () {
  "use strict";
  const { $, el, api, errorText, showBanner, fmtNum, fmtDate, table } = CM;

  const ORIGIN = {
    ingesta: "Ingesta (completa)",
    error: "Respuesta con error",
    invalidos: "Registros invalidos",
    manual: "Pedida desde la web",
  };
  const STATUS = { nueva: "Nueva", conservada: "Conservada", reprocesada: "Reprocesada" };
  const MODE = { off: "no se guarda ninguna", errores: "solo errores y registros invalidos", todas: "todas las respuestas" };
  const PAGE = 25;

  let items = [];
  let nextBeforeId = null;
  let selected = null;
  let rowsState = { offset: 0, q: "" };

  const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${b} B`);

  function renderList() {
    const wrap = $("cap-list");
    wrap.replaceChildren();
    if (items.length === 0) {
      wrap.append(el("div", { class: "empty" }, "No hay capturas guardadas"));
      return;
    }
    const t = el("table");
    const head = el("tr");
    for (const h of ["Fecha", "Origen", "Rango pedido", "Filas", "Tamano", "Estado", "Vence"]) head.append(el("th", null, h));
    t.appendChild(el("thead")).appendChild(head);
    const body = t.appendChild(el("tbody"));
    for (const c of items) {
      const tr = el("tr", { class: `clickable${selected === c.id ? " selected" : ""}`, tabindex: "0" });
      tr.append(
        el("td", { class: "time" }, fmtDate(c.createdAt)),
        el("td", null, `${ORIGIN[c.origin] || c.origin}${c.runId ? ` · corrida ${c.runId}` : ""}`),
        el("td", { class: "time" }, `${fmtDate(c.rangeStart)} → ${fmtDate(c.rangeEnd)}`),
        el("td", { class: "num" }, c.rowsCount === null ? "—" : fmtNum(c.rowsCount)),
        el("td", { class: "num" }, `${fmtBytes(c.gzBytes)} (${fmtBytes(c.bytes)})`),
        el("td", null, STATUS[c.status] || c.status),
        el("td", { class: "time" }, c.expiresAt ? fmtDate(c.expiresAt) : "no vence")
      );
      const open = () => openDetail(c.id);
      tr.addEventListener("click", open);
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter") open();
      });
      body.append(tr);
    }
    wrap.append(t);
    $("cap-more").disabled = !nextBeforeId;
  }

  async function load(more) {
    const params = { limit: String(PAGE) };
    if (more && nextBeforeId) params.beforeId = String(nextBeforeId);
    try {
      const page = await api("/admin/captures", { params });
      items = more ? items.concat(page.items) : page.items;
      nextBeforeId = page.nextBeforeId;
      $("cap-usage").textContent = `Guardando ${MODE[page.mode]} · ${fmtNum(page.usage.count)} capturas, ${fmtBytes(page.usage.totalBytes)} de ${fmtBytes(page.usage.maxBytes)} · vencen a las ${page.retentionHours} h`;
      renderList();
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
  }

  function topList(title, list) {
    const box = el("div");
    box.append(el("h3", null, title));
    const ol = el("ol");
    for (const x of list || []) {
      const li = el("li");
      li.append(document.createTextNode(`${x.value} `), el("span", null, fmtNum(x.count)));
      ol.append(li);
    }
    if (!list || !list.length) ol.append(el("li", null, "—"));
    box.append(ol);
    return box;
  }

  async function openDetail(id) {
    selected = id;
    rowsState = { offset: 0, q: "" };
    renderList();
    const box = $("cap-detail");
    box.hidden = false;
    box.replaceChildren(el("div", { class: "muted" }, "Analizando la captura…"));
    box.scrollIntoView({ behavior: "smooth", block: "start" });
    let c;
    try {
      c = await api(`/admin/captures/${id}`);
    } catch (err) {
      box.replaceChildren(el("div", { class: "result bad" }, errorText(err)));
      return;
    }
    const s = c.summary || {};
    box.replaceChildren();
    box.append(el("h2", null, `Captura #${c.id} · ${ORIGIN[c.origin] || c.origin}`));
    box.append(el("p", { class: "desc" }, `${fmtDate(c.rangeStart)} → ${fmtDate(c.rangeEnd)} · ${fmtNum(s.rows ?? c.rowsCount)} registros`));

    // Acciones (siempre visibles)
    const actions = el("div", { class: "form-row" });
    const btn = (label, fn, cls, disabled) => {
      const b = el("button", { type: "button", class: `btn${cls ? ` ${cls}` : ""}` }, label);
      b.disabled = Boolean(disabled);
      b.addEventListener("click", fn);
      actions.append(b);
      return b;
    };
    const result = el("div", { class: "result", "aria-live": "polite" });
    const canUse = Boolean(s.rows) && c.origin !== "invalidos";
    btn("Reprocesar", async () => {
      if (!confirm("Se ingesta la captura como una ventana manual con las politicas de ahora. Los SMS que ya estaban no se duplican. ¿Seguir?")) return;
      result.textContent = "Reprocesando…";
      result.className = "result";
      try {
        const run = await api(`/admin/captures/${id}/reprocess`, { method: "POST" });
        result.textContent = `${run.status}: ${fmtNum(run.smsNew)} SMS nuevos, ${fmtNum(run.jobsCreated)} a visitar (corrida ${run.runId})`;
        load(false);
      } catch (err) {
        result.textContent = errorText(err);
        result.className = "result bad";
      }
    }, "primary", !canUse);
    btn(c.expiresAt ? "Conservar (no vence)" : "Quitar conservar", async () => {
      try {
        await api(`/admin/captures/${id}/keep`, { method: "POST", body: { keep: Boolean(c.expiresAt) } });
        await load(false);
        openDetail(id);
      } catch (err) {
        showBanner(errorText(err), { error: true });
      }
    });
    btn("Descartar", async () => {
      if (!confirm("¿Borrar esta captura? No se puede deshacer.")) return;
      try {
        await api(`/admin/captures/${id}`, { method: "DELETE" });
        selected = null;
        $("cap-detail").hidden = true;
        load(false);
      } catch (err) {
        showBanner(errorText(err), { error: true });
      }
    }, "danger");
    box.append(actions, result);
    if (!canUse) {
      box.append(el("p", { class: "muted" }, c.origin === "invalidos"
        ? "Son registros que no pasaron la validacion: se pueden revisar, pero reprocesarlos no los arregla."
        : "Esta captura no tiene registros utilizables para reprocesar."));
    }

    // Sub-pestanas: resumen, registros, simulacion
    const panes = { resumen: el("div"), registros: el("div"), simulacion: el("div") };

    const dl = el("dl", { class: "kv" });
    panes.resumen.append(dl);
    CM.kv(dl, [
      ["Rango pedido", `${fmtDate(c.rangeStart)} → ${fmtDate(c.rangeEnd)}`],
      ["Request (sin credenciales)", JSON.stringify(c.requestArgs)],
      ["Filas", `${fmtNum(s.rows ?? c.rowsCount)}${s.rows !== undefined ? ` · ${fmtNum(s.withLink)} con link · ${fmtNum(s.withoutLink)} sin link` : ""}`],
      ["EDR entre", s.firstEdr ? `${fmtDate(s.firstEdr)} y ${fmtDate(s.lastEdr)}` : "—"],
      ["Estado", `${STATUS[c.status] || c.status}${c.note ? ` · ${c.note}` : ""}${c.expiresAt ? ` · vence ${fmtDate(c.expiresAt)}` : " · no vence"}`],
      ["Guardada por", c.createdBy || (c.runId ? `ingesta (corrida ${c.runId})` : "—")],
    ]);
    if (c.errorMessage) panes.resumen.append(el("div", { class: "result bad" }, c.errorMessage));
    if (c.parseError) panes.resumen.append(el("div", { class: "result bad" }, `No se pudieron leer registros: ${c.parseError}`));
    if (s.rows) {
      const mini = el("div", { class: "mini" });
      mini.append(topList("Clientes", s.clients), topList("Senders", s.senders), topList("Paises", s.countries), topList("Dominios", s.domains));
      panes.resumen.append(el("h3", { class: "muted", style: "margin:14px 0 0;font-size:13px" }, "Los 10 valores mas frecuentes"), mini);
    }

    if (s.rows) {
      const search = el("form", { class: "form-row" });
      const q = el("input", { type: "search", placeholder: "Buscar cliente, sender, pais o texto", "aria-label": "Buscar en la captura", style: "flex:1 1 240px" });
      search.append(q, el("button", { type: "submit", class: "btn" }, "Buscar"));
      const rows = el("div", { class: "tbl-wrap", style: "margin-top:8px" });
      const pager = el("div", { class: "pager" });
      panes.registros.append(search, rows, pager);
      search.addEventListener("submit", (e) => {
        e.preventDefault();
        rowsState = { offset: 0, q: q.value };
        loadRows(id, rows, pager);
      });
      loadRows(id, rows, pager);
    } else {
      panes.registros.append(el("div", { class: "empty" }, "Sin registros legibles"));
    }

    const sim = el("div", { class: "tbl-wrap", style: "margin-top:10px" });
    const simBtn = el("button", { type: "button", class: "btn primary" }, "Calcular con las politicas de ahora");
    simBtn.disabled = !s.rows;
    simBtn.addEventListener("click", async () => {
      sim.replaceChildren(el("div", { class: "muted" }, "Simulando…"));
      try {
        CM.renderEstimate(sim, await api(`/admin/captures/${id}/simulate`, { method: "POST" }), null);
      } catch (err) {
        sim.replaceChildren(el("div", { class: "result bad" }, errorText(err)));
      }
    });
    panes.simulacion.append(
      el("p", { class: "muted", style: "margin:0 0 8px" }, "Cuantos SMS de esta captura tomaria cada politica y cuantos se visitarian. No guarda nada; es una estimacion sin topes ni horarios."),
      simBtn,
      sim
    );

    const tabsBox = el("div");
    box.append(tabsBox);
    for (const pane of Object.values(panes)) box.append(pane);
    CM.subtabs(tabsBox, [["resumen", "Resumen"], ["registros", "Registros"], ["simulacion", "Simular politicas"]], (tab) => {
      for (const [k, pane] of Object.entries(panes)) pane.hidden = k !== tab;
    }).select("resumen");
  }

  async function loadRows(id, target, pager) {
    const params = { offset: String(rowsState.offset), limit: String(PAGE) };
    if (rowsState.q) params.q = rowsState.q;
    try {
      const page = await api(`/admin/captures/${id}/rows`, { params });
      table(
        target,
        [
          { label: "EDR", cls: "time", render: (r) => fmtDate(r.edrDate) },
          { label: "Cliente", render: (r) => r.client },
          { label: "Sender", render: (r) => r.sender },
          { label: "Pais", render: (r) => r.country },
          { label: "Estado", render: (r) => r.status },
          { label: "Texto", cls: "text", render: (r) => r.text },
        ],
        page.items,
        "Sin registros"
      );
      pager.replaceChildren();
      const from = page.total ? page.offset + 1 : 0;
      pager.append(el("span", null, `${fmtNum(from)}-${fmtNum(Math.min(page.offset + PAGE, page.total))} de ${fmtNum(page.total)}`));
      const prev = el("button", { type: "button", class: "btn" }, "Anterior");
      const next = el("button", { type: "button", class: "btn" }, "Siguiente");
      prev.disabled = page.offset === 0;
      next.disabled = page.offset + PAGE >= page.total;
      prev.addEventListener("click", () => {
        rowsState.offset = Math.max(0, rowsState.offset - PAGE);
        loadRows(id, target, pager);
      });
      next.addEventListener("click", () => {
        rowsState.offset += PAGE;
        loadRows(id, target, pager);
      });
      pager.append(prev, next);
    } catch (err) {
      target.replaceChildren(el("div", { class: "result bad" }, errorText(err)));
    }
  }

  function toLocalInput(d) {
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  $("cap-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const start = new Date($("cap-start").value);
    const end = new Date($("cap-end").value);
    const out = $("cap-form-result");
    if (!(end > start)) {
      out.textContent = "El fin tiene que ser posterior al inicio";
      out.className = "result bad";
      return;
    }
    out.textContent = "Pidiendo a Alaris (puede tardar varios minutos)…";
    out.className = "result";
    try {
      const r = await api("/admin/captures", { method: "POST", body: { start: start.toISOString(), end: end.toISOString() } });
      out.textContent = `Captura #${r.captureId} guardada${r.rows !== null ? ` con ${fmtNum(r.rows)} registros` : ""}.`;
      CM.go("capturas", "guardadas");
      await load(false);
      openDetail(r.captureId);
    } catch (err) {
      out.textContent = errorText(err);
      out.className = "result bad";
    }
  });

  $("cap-more").addEventListener("click", () => load(true));

  CM.onEnter("capturas", () => {
    if (!$("cap-start").value) {
      const end = new Date(Math.floor(Date.now() / 1800000) * 1800000);
      $("cap-start").value = toLocalInput(new Date(end.getTime() - 1800000));
      $("cap-end").value = toLocalInput(end);
    }
    load(false);
  });
})();
