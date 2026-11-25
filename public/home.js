// Panel (vista basica): estado general, prender/frenar todo, la peticion a
// Alaris (producto, pais, frecuencia, %) y pedir un rango a mano. Usa los
// mismos endpoints que las secciones avanzadas (/admin/status,
// /admin/actions, /admin/settings, /sync), asi que todo queda auditado igual.
(function () {
  "use strict";
  const { $, el, api, errorText, showBanner, fmtNum, fmtDate, fmtAgo } = CM;

  const REFRESH_MS = 10000;
  // Campo del formulario -> clave de configuracion.
  const FIELDS = [
    { id: "home-product", key: "edr.clientProductId", kind: "text" },
    { id: "home-country", key: "edr.country", kind: "text" },
    { id: "home-window", key: "scheduler.windowMinutes", kind: "select" },
  ];
  const RUN_STATUS = { success: "ok", partial: "parcial", failed: "fallo", running: "en curso" };

  let timer = null;
  let status = null;
  let settings = new Map(); // key -> vista de /admin/settings
  let policies = []; // de /admin/policies (una sola activa)
  let busy = false;

  // ---------- Estado ----------

  function overall(s) {
    const ingest = s.scheduler.enabled;
    const visits = s.worker.enabled;
    if (ingest && visits) return "on";
    if (!ingest && !visits) return "off";
    return "mixed";
  }

  function renderStatus(s) {
    status = s;
    const state = overall(s);
    const clicking = Boolean(s.clicks.current) || s.clicks.queued > 0;
    const dot = $("home-dot");
    const title = $("home-title");
    const sub = $("home-sub");
    const btn = $("home-toggle");
    if (state === "on") {
      dot.className = "home-dot ok";
      title.textContent = "Corriendo";
      sub.textContent = clicking
        ? "Trae SMS de Alaris; las visitas automaticas esperan a que terminen unos clicks manuales."
        : s.worker.outsideHours
          ? "Trae SMS de Alaris; fuera del horario de visitas, los links esperan en la cola."
          : "Trae SMS de Alaris y visita sus links.";
      btn.textContent = "Detener";
      btn.className = "btn big danger";
    } else if (state === "off") {
      dot.className = "home-dot bad";
      title.textContent = "Detenido";
      sub.textContent = "No pide SMS nuevos ni visita links. Al iniciar retoma donde quedo, sin saltear nada.";
      btn.textContent = "Iniciar";
      btn.className = "btn big primary";
    } else {
      dot.className = "home-dot warn";
      title.textContent = "Detenido a medias";
      sub.textContent = s.scheduler.enabled
        ? "Trae SMS de Alaris pero no visita links (quedan en cola)."
        : "Visita lo que hay en cola pero no pide SMS nuevos a Alaris.";
      btn.textContent = "Iniciar todo";
      btn.className = "btn big primary";
    }
    btn.disabled = busy;

    // Sin politica activa no corre nada, este prendido o no.
    const waiting = !s.policy || !s.policy.active;
    $("home-policy").hidden = !waiting;
    $("home-sync-btn").disabled = waiting;
    $("home-sync-btn").title = waiting ? "No hay politica activa: no se le pide nada a Alaris" : "";
    if (waiting) {
      dot.className = "home-dot warn";
      title.textContent = "En espera";
      sub.textContent = "No hay politica activa: no se piden SMS a Alaris ni se visitan links. Cuando actives una, retoma donde quedo.";
    }

    const run = s.lastRun;
    const q = s.queue;
    const tick = s.scheduler.lastTick;
    const facts = [
      ["Politica activa", s.policy && s.policy.active ? s.policy.active.name : "ninguna (en espera)"],
      ["Consulta a Alaris", s.scheduler.windowMinutes ? `cada ${windowText(s.scheduler.windowMinutes)}` : "—"],
      ["Ultima consulta", run ? `${fmtAgo(run.finishedAt || run.startedAt || run.windowEnd)} · ${RUN_STATUS[run.status] || run.status}` : "todavia ninguna"],
      ["SMS en la ultima", run ? fmtNum(run.recordsReceived) : "—"],
      ["Esperando visita", q ? fmtNum(q.pending + q.retry + q.processing) : "—"],
    ];
    if (tick && tick.error) facts.push(["Ultimo error", tick.error]);
    const dl = $("home-facts");
    dl.replaceChildren(
      ...facts.map(([k, v]) => {
        const box = el("div");
        box.append(el("dt", null, k), el("dd", null, v));
        return box;
      })
    );
    $("home-updated").textContent = `Actualizado ${fmtDate(s.generatedAt)}`;
  }

  function windowText(min) {
    if (min < 60) return `${min} min`;
    if (min === 60) return "1 hora";
    if (min < 1440) return `${min / 60} horas`;
    return "dia";
  }

  async function refresh() {
    clearTimeout(timer);
    try {
      renderStatus(await api("/admin/status"));
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
    if (CM.currentView() === "inicio") timer = setTimeout(refresh, REFRESH_MS);
  }

  async function toggleAll() {
    if (!status) return;
    const stop = overall(status) === "on";
    if (stop && !confirm("¿Detener ClickMaster? Deja de pedir SMS a Alaris y de visitar links hasta que lo inicies de nuevo (sobrevive a un reinicio).")) return;
    busy = true;
    $("home-toggle").disabled = true;
    const op = stop ? "pause" : "resume";
    try {
      // Solo se toca lo que hace falta: "Iniciar todo" desde "a medias" no
      // re-audita la pieza que ya estaba prendida.
      for (const target of ["scheduler", "worker"]) {
        const enabled = status[target].enabled;
        if (stop ? enabled : !enabled) await api(`/admin/actions/${target}/${op}`, { method: "POST" });
      }
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    } finally {
      busy = false;
      await refresh();
      CM.refreshSideStatus();
    }
  }

  // ---------- Peticion a Alaris ----------

  function inputValue(f) {
    const node = $(f.id);
    const text = node.value.trim();
    if (f.kind === "text") return text === "" ? null : text;
    if (f.kind === "select") return Number(text);
    return text === "" ? NaN : Number(text);
  }

  function fillForm() {
    for (const f of FIELDS) {
      const s = settings.get(f.key);
      if (!s) continue;
      const node = $(f.id);
      if (f.kind === "select") {
        node.replaceChildren(...Object.entries(s.options || {}).map(([v, label]) => el("option", { value: v }, label)));
      }
      if (f.kind === "number") {
        if (s.min !== null) node.min = s.min;
        if (s.max !== null) node.max = s.max;
      }
      node.value = s.value === null || s.value === undefined ? "" : String(s.value);
    }
    markChanges();
  }

  /** Devuelve { set, errors } con solo lo que cambio respecto de lo vigente. */
  function collect() {
    const set = {};
    const errors = [];
    for (const f of FIELDS) {
      const s = settings.get(f.key);
      if (!s) continue;
      const v = inputValue(f);
      const label = $(f.id).closest(".field");
      let error = null;
      if (f.kind === "number" && (!Number.isFinite(v) || (s.min !== null && v < s.min) || (s.max !== null && v > s.max))) {
        error = `entre ${s.min ?? 0} y ${s.max ?? 100}`;
      }
      let errNode = label.querySelector(".err");
      if (error) {
        if (!errNode) label.append((errNode = el("span", { class: "err" })));
        errNode.textContent = error;
      } else if (errNode) {
        errNode.remove();
      }
      const changed = !error && JSON.stringify(v) !== JSON.stringify(s.value ?? null);
      label.classList.toggle("changed", changed);
      if (error) errors.push(`${s.label}: ${error}`);
      else if (changed) set[f.key] = v;
    }
    return { set, errors };
  }

  // ---------- Politica activa y su porcentaje ----------

  const BASE_TEXT = {
    ventana: "de cada ventana",
    dia_vencido: "del dia anterior (se elige al cerrar el dia)",
    semana_anterior: "del mismo dia de la semana anterior, repartido en el dia",
    dia_anterior: "de lo que se mando ayer, hora por hora",
    semana_referencia: "de la misma hora y dia de la semana de referencia (solo se guardan los elegidos, ventana de 1 hora)",
  };
  const activePolicy = () => policies.find((p) => p.enabled) || null;
  const selectedPolicy = () => policies.find((p) => String(p.id) === $("home-policy-select").value) || null;

  function describe(p) {
    if (!p) return "Sin politica activa no se piden SMS a Alaris ni se visita ningun link (en espera).";
    const sel = p.rules.selection;
    if (sel.action === "no_visitar") return "Esta politica no visita los SMS que toma.";
    return `Visita el ${sel.percentage}% ${BASE_TEXT[sel.base]}, estrategia ${sel.strategy}. El resto de las reglas se cambia en la vista avanzada.`;
  }

  function fillPolicy() {
    const select = $("home-policy-select");
    select.replaceChildren(
      el("option", { value: "" }, "Ninguna (en espera)"),
      ...policies.map((p) => el("option", { value: String(p.id) }, p.name))
    );
    const active = activePolicy();
    select.value = active ? String(active.id) : "";
    syncPolicyPct();
  }

  /** Al elegir otra politica, el porcentaje muestra el de esa politica. */
  function syncPolicyPct() {
    const p = selectedPolicy();
    const pct = $("home-policy-pct");
    const usable = p && p.rules.selection.action === "visitar";
    pct.disabled = !usable;
    pct.value = usable ? String(p.rules.selection.percentage) : "";
    const note = $("home-policy-note");
    note.hidden = false;
    note.textContent = describe(p);
  }

  /** { target, pct, changed, error } respecto de lo vigente. */
  function policyState() {
    const p = selectedPolicy();
    const active = activePolicy();
    const field = $("home-policy-pct").closest(".field");
    let pct = null;
    let error = null;
    if (p && p.rules.selection.action === "visitar") {
      const text = $("home-policy-pct").value.trim();
      pct = text === "" ? NaN : Number(text);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) error = "entre 0 y 100";
    }
    let errNode = field.querySelector(".err");
    if (error) {
      if (!errNode) field.append((errNode = el("span", { class: "err" })));
      errNode.textContent = error;
    } else if (errNode) {
      errNode.remove();
    }
    const switching = (p ? p.id : null) !== (active ? active.id : null);
    const pctChanged = !error && pct !== null && pct !== p.rules.selection.percentage;
    $("home-policy-select").closest(".field").classList.toggle("changed", switching);
    field.classList.toggle("changed", pctChanged);
    return { target: p, pct, switching, pctChanged, error };
  }

  /**
   * Aplica el cambio de politica. Activar otra o cambiar el % de la activa
   * pasa por el mismo aviso que en Politicas; apagarla no pregunta.
   */
  async function savePolicy(state) {
    const { target, pct, switching, pctChanged } = state;
    if (!switching && !pctChanged) return false;
    if (!target) {
      await api("/admin/policies/active", { method: "POST", body: { id: null, repeatMode: "igual" } });
      return true;
    }
    const rules = { ...target.rules, selection: { ...target.rules.selection, ...(pctChanged ? { percentage: pct } : {}) } };
    const verb = switching ? `Activar "${target.name}"` : `Cambiar el porcentaje de "${target.name}" (es la activa)`;
    const repeatMode = await CM.confirmPolicyChange(activePolicy(), { ...target, rules }, verb);
    if (!repeatMode) return null; // cancelado
    if (pctChanged) {
      await api(`/admin/policies/${target.id}`, { method: "PUT", body: { name: target.name, enabled: true, rules, repeatMode } });
    } else {
      await api("/admin/policies/active", { method: "POST", body: { id: target.id, repeatMode } });
    }
    return true;
  }

  function markChanges() {
    const { set, errors } = collect();
    const pol = policyState();
    if (pol.error) errors.push(`Porcentaje de la politica: ${pol.error}`);
    const n = Object.keys(set).length + (pol.switching ? 1 : 0) + (pol.pctChanged ? 1 : 0);
    $("home-save").disabled = n === 0 || errors.length > 0;
    $("home-undo").disabled = n === 0 && errors.length === 0;
    $("home-form-result").textContent = errors.length ? "" : n ? `${n} cambio${n === 1 ? "" : "s"} sin guardar` : "";
    $("home-form-result").className = "result";
  }

  async function loadSettings() {
    try {
      const [data, pol] = await Promise.all([api("/admin/settings"), api("/admin/policies")]);
      settings = new Map(data.settings.map((s) => [s.key, s]));
      policies = pol.policies;
      fillPolicy();
      fillForm();
      CM.homeWeek.load(activePolicy());
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
  }

  async function save(e) {
    e.preventDefault();
    const { set, errors } = collect();
    const pol = policyState();
    if (errors.length || pol.error) return;
    if (Object.keys(set).length === 0 && !pol.switching && !pol.pctChanged) return;
    $("home-save").disabled = true;
    try {
      // Primero la politica (puede cancelarse en el aviso); despues la peticion.
      const policyResult = await savePolicy(pol);
      if (policyResult === null) {
        $("home-save").disabled = false;
        return;
      }
      if (Object.keys(set).length) await api("/admin/settings", { method: "PUT", body: { set } });
      await loadSettings();
      CM.refreshSideStatus();
      $("home-form-result").textContent = policyResult ? "Guardado. El cambio de politica se aplica sobre el contenido de hoy." : "Guardado y aplicado";
      $("home-form-result").className = "result";
      refresh();
    } catch (err) {
      $("home-form-result").textContent = errorText(err);
      $("home-form-result").className = "result bad";
      $("home-save").disabled = false;
    }
  }

  // ---------- Pedir un rango ----------

  function toLocalInput(d) {
    const off = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - off).toISOString().slice(0, 16);
  }

  function presetRange(minutes) {
    const end = new Date(Math.floor(Date.now() / 60000) * 60000);
    $("home-sync-start").value = toLocalInput(new Date(end.getTime() - minutes * 60000));
    $("home-sync-end").value = toLocalInput(end);
  }

  function syncResult(text, bad) {
    $("home-sync-result").textContent = text;
    $("home-sync-result").className = `result${bad ? " bad" : ""}`;
  }

  async function sync(e) {
    e.preventDefault();
    const start = new Date($("home-sync-start").value);
    const end = new Date($("home-sync-end").value);
    if (!(end > start)) return syncResult("El fin tiene que ser posterior al inicio", true);
    $("home-sync-btn").disabled = true;
    syncResult("Pidiendo a Alaris (puede tardar unos minutos)…");
    try {
      const run = await api("/sync", { method: "POST", body: { start: start.toISOString(), end: end.toISOString() } });
      syncResult(`Listo: ${fmtNum(run.recordsReceived)} SMS recibidos, ${fmtNum(run.smsNew)} nuevos, ${fmtNum(run.jobsCreated)} para visitar.`);
    } catch (err) {
      const run = err.data && err.data.runId ? err.data : null;
      syncResult(run ? `Fallo: ${run.error}` : errorText(err), true);
    } finally {
      $("home-sync-btn").disabled = false;
      refresh();
    }
  }

  // ---------- Eventos ----------

  $("home-toggle").addEventListener("click", toggleAll);
  $("home-form").addEventListener("input", markChanges);
  $("home-form").addEventListener("change", markChanges);
  $("home-form").addEventListener("submit", save);
  $("home-undo").addEventListener("click", () => {
    fillPolicy();
    fillForm();
  });
  $("home-policy-select").addEventListener("change", syncPolicyPct);
  $("home-sync").addEventListener("submit", sync);
  for (const b of document.querySelectorAll("[data-home-range]")) {
    b.addEventListener("click", () => presetRange(Number(b.dataset.homeRange)));
  }
  // En espera: el selector de politica esta en el mismo Panel.
  $("home-policy").addEventListener("click", () => {
    $("home-policy-select").focus();
    $("home-policy-select").scrollIntoView({ block: "center" });
  });
  $("home-advanced").addEventListener("click", (e) => {
    e.preventDefault();
    CM.setUiMode("avanzada");
    CM.go("operacion", "estado");
  });

  CM.onEnter("inicio", () => {
    if (!$("home-sync-start").value) presetRange(30);
    refresh();
    loadSettings();
  });
  CM.onLeave("inicio", () => clearTimeout(timer));
})();
