// Utilidades compartidas por las secciones, sidebar y navegacion por hash
// (#seccion/pestana). Sin dependencias.
(function () {
  "use strict";

  // Secciones, sus pestanas y su grupo en el sidebar. Cada pestana con panel
  // tiene un [data-panel="seccion/pestana"] en index.html.
  const ICONS = {
    inicio: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    guia: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><path d="M12 17h.01"/>',
    reportes: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
    operacion: '<path d="M12 3v3"/><path d="M12 18v3"/><path d="m4.9 4.9 2.1 2.1"/><path d="m17 17 2.1 2.1"/><path d="M3 12h3"/><path d="M18 12h3"/><circle cx="12" cy="12" r="4"/>',
    politicas: '<path d="M4 6h16"/><path d="M7 12h10"/><path d="M10 18h4"/>',
    capturas: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 15h3"/>',
    configuracion: '<path d="M4 7h10"/><path d="M18 7h2"/><circle cx="16" cy="7" r="2"/><path d="M4 17h2"/><path d="M10 17h10"/><circle cx="8" cy="17" r="2"/>',
    entorno: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    historial: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  };
  // basic: true = aparece tambien en la vista basica. La basica es solo una
  // simplificacion de la interfaz, NO un control de acceso: cualquiera puede
  // pasar a la avanzada (el acceso lo sigue cuidando ADMIN_TOKEN).
  const NAV = [
    { group: "Inicio", items: [
      { id: "inicio", label: "Panel", basic: true, tabs: [["panel", "Panel"]] },
    ] },
    { group: "Empezar", items: [
      { id: "guia", label: "Como funciona", tabs: [["flujo", "Flujo general"], ["estados", "Estados y resultados"], ["pasos", "Primeros pasos"]] },
    ] },
    { group: "Monitoreo", items: [
      { id: "reportes", label: "Reportes", basic: true, tabs: [["resumen", "Resumen"], ["graficos", "Graficos"], ["registros", "Registros"], ["cumplimiento", "Cumplimiento"]] },
      { id: "operacion", label: "Operacion", tabs: [["estado", "Estado"], ["ventana", "Ingesta manual"], ["clicks", "Clicks manuales"]] },
    ] },
    { group: "Reglas", items: [
      // El editor no tiene pestana: se abre solo con "Nueva politica" o "Editar".
      { id: "politicas", label: "Politicas", tabs: [["lista", "Lista"], ["ayuda", "Como funcionan"], ["editor", "Editor", { hidden: true }]] },
      { id: "capturas", label: "Capturas", tabs: [["guardadas", "Guardadas"], ["pedir", "Pedir un rango"], ["ayuda", "Como funcionan"]] },
    ] },
    { group: "Sistema", items: [
      { id: "configuracion", label: "Configuracion", tabs: [["edr", "Fuente Alaris"], ["alarisRest", "Alaris REST"], ["scheduler", "Ingesta automatica"], ["worker", "Worker y Chromium"], ["horario", "Horario de visitas"], ["checker", "Verificacion"], ["clicker", "Clicks manuales"], ["capture", "Capturas"]] },
      { id: "entorno", label: "Entorno (.env)", tabs: [["variables", "Solo en .env"], ["pisadas", "Pisadas desde la web"], ["como", "Como cambiarlas"]] },
      { id: "historial", label: "Historial", tabs: [["todo", "Todo"], ["setting", "Configuracion"], ["policy", "Politicas"], ["action", "Acciones"], ["capture", "Capturas"]] },
    ] },
  ];
  const VIEWS = new Map(NAV.flatMap((g) => g.items).map((v) => [v.id, v]));
  // Pestanas que se muestran (las ocultas solo se abren desde el codigo con CM.go).
  const shownTabs = (v) => v.tabs.filter((t) => !(t[2] && t[2].hidden));

  const $ = (id) => document.getElementById(id);

  function el(tag, attrs, text) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function storageGet(store, key) {
    try {
      return window[store].getItem(key) || "";
    } catch {
      return "";
    }
  }
  function storageSet(store, key, value) {
    try {
      window[store].setItem(key, value);
    } catch {
      // Sin storage (modo privado): solo no se recuerda.
    }
  }

  const token = () => storageGet("sessionStorage", "cm_token");
  const actor = () => $("actor").value.trim();

  function showBanner(message, opts = {}) {
    $("banner-text").textContent = message;
    $("banner").className = `banner show${opts.error ? " error" : ""}`;
    $("token-form").className = `token-form${opts.auth ? " show" : ""}`;
  }
  function hideBanner() {
    $("banner").className = "banner";
  }

  /**
   * fetch con token y X-Actor. Devuelve el JSON; si falla tira un Error con
   * .status, .details (validaciones) y .auth (falta el token).
   */
  async function api(path, opts = {}) {
    const headers = {};
    const t = token();
    if (t) headers.Authorization = `Bearer ${t}`;
    const a = actor();
    if (a) headers["X-Actor"] = encodeURIComponent(a);
    let body;
    if (opts.body !== undefined) {
      if (typeof opts.body === "string") {
        headers["Content-Type"] = "text/plain";
        body = opts.body;
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
    }
    const qs = opts.params ? `?${new URLSearchParams(opts.params).toString()}` : "";
    const res = await fetch(`${path}${qs}`, { method: opts.method || "GET", headers, body });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showBanner("Hace falta el token de administrador", { auth: true, error: true });
      const err = new Error("Hace falta el token de administrador");
      err.auth = true;
      err.status = 401;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(data.error || `Error ${res.status}`);
      err.status = res.status;
      err.details = data.details || null;
      err.data = data;
      throw err;
    }
    return data;
  }

  function errorText(err) {
    return err.details && err.details.length ? `${err.message}: ${err.details.join(" · ")}` : err.message;
  }

  // ---------- Formato ----------

  const nf = new Intl.NumberFormat("es-AR");
  const dtFull = new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const fmtNum = (n) => (n === null || n === undefined ? "—" : nf.format(n));
  const fmtDate = (v) => (v ? dtFull.format(new Date(v)) : "—");
  function fmtValue(v) {
    if (v === null || v === undefined || v === "") return "(vacio)";
    if (typeof v === "boolean") return v ? "si" : "no";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }
  function fmtAgo(v) {
    if (!v) return "—";
    const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
    if (s < 60) return `hace ${Math.max(0, s)} s`;
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${(s / 3600).toFixed(1)} h`;
    return fmtDate(v);
  }

  function kv(target, pairs) {
    target.replaceChildren();
    for (const [k, v] of pairs) {
      const dd = el("dd");
      if (v instanceof Node) dd.append(v);
      else dd.textContent = v === null || v === undefined ? "—" : String(v);
      target.append(el("dt", null, k), dd);
    }
  }

  function table(target, columns, rows, emptyText) {
    target.replaceChildren();
    if (rows.length === 0) {
      target.appendChild(el("div", { class: "empty" }, emptyText || "Sin datos"));
      return;
    }
    const t = el("table");
    const head = el("tr");
    for (const c of columns) head.appendChild(el("th", c.num ? { style: "text-align:right" } : null, c.label));
    t.appendChild(el("thead")).appendChild(head);
    const tbody = t.appendChild(el("tbody"));
    for (const r of rows) {
      const tr = el("tr");
      for (const c of columns) {
        const td = el("td", { class: c.cls || (c.num ? "num" : "") });
        const v = c.render(r);
        if (v instanceof Node) td.appendChild(v);
        else td.textContent = v === null || v === undefined ? "—" : String(v);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    target.appendChild(t);
  }

  /** Pestanas internas (ej. detalle de una captura). Devuelve { select }. */
  function subtabs(container, tabs, onSelect) {
    const bar = el("div", { class: "subtabs", role: "tablist" });
    const buttons = tabs.map(([id, label]) => {
      const b = el("button", { type: "button", role: "tab", "aria-selected": "false" }, label);
      b.addEventListener("click", () => select(id));
      bar.append(b);
      return [id, b];
    });
    function select(id) {
      for (const [bid, b] of buttons) b.setAttribute("aria-selected", String(bid === id));
      onSelect(id);
    }
    container.append(bar);
    return { select };
  }

  // ---------- Sidebar y pestanas ----------

  function icon(id) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = ICONS[id] || "";
    return svg;
  }

  // ---------- Vista basica / avanzada ----------

  let uiMode = storageGet("localStorage", "cm_ui_mode") === "avanzada" ? "avanzada" : "basica";
  const visible = (v) => uiMode === "avanzada" || v.basic === true;

  function setUiMode(mode) {
    uiMode = mode === "avanzada" ? "avanzada" : "basica";
    storageSet("localStorage", "cm_ui_mode", uiMode);
    document.body.dataset.ui = uiMode;
    for (const b of $("ui-mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.ui === uiMode));
    buildSidebar();
    // Si la seccion abierta no existe en este modo, route() lleva al panel.
    if (current) route();
  }

  function buildSidebar() {
    const nav = $("side-nav");
    nav.replaceChildren();
    for (const g of NAV) {
      const items = g.items.filter(visible);
      if (items.length === 0) continue;
      // En la basica hay pocas secciones: los titulos de grupo sobran.
      if (uiMode === "avanzada") nav.append(el("div", { class: "side-group" }, g.group));
      const ul = el("ul");
      for (const v of items) {
        const li = el("li", { class: "side-item", "data-side": v.id });
        const a = el("a", { href: `#${v.id}/${v.tabs[0][0]}` });
        const tabs = shownTabs(v);
        a.append(icon(v.id), document.createTextNode(v.label));
        li.append(a);
        if (tabs.length < 2) {
          ul.append(li);
          continue;
        }
        const sub = el("ul", { class: "side-sub" });
        for (const [tab, label] of tabs) {
          const item = el("li");
          item.append(el("a", { href: `#${v.id}/${tab}`, "data-side-tab": `${v.id}/${tab}` }, label));
          sub.append(item);
        }
        li.append(sub);
        ul.append(li);
      }
      nav.append(ul);
    }
    if (current) markActive();
  }

  function buildTabs() {
    for (const bar of document.querySelectorAll(".vtabs[data-tabs]")) {
      const v = VIEWS.get(bar.dataset.tabs);
      bar.setAttribute("role", "tablist");
      for (const [tab, label] of shownTabs(v)) {
        bar.append(el("a", { href: `#${v.id}/${tab}`, role: "tab", "aria-selected": "false", "data-tab-link": `${v.id}/${tab}` }, label));
      }
    }
  }

  // ---------- Navegacion ----------

  const enterHandlers = {};
  const leaveHandlers = {};
  const tabHandlers = {};
  let current = null;
  let currentTab = null;

  function onEnter(view, fn) {
    (enterHandlers[view] = enterHandlers[view] || []).push(fn);
  }
  function onLeave(view, fn) {
    (leaveHandlers[view] = leaveHandlers[view] || []).push(fn);
  }
  /** Se llama en cada cambio de pestana de la seccion (incluida la primera). */
  function onTab(view, fn) {
    (tabHandlers[view] = tabHandlers[view] || []).push(fn);
  }

  function parseHash() {
    const [view, tab] = location.hash.replace(/^#/, "").split("/");
    return { view, tab };
  }

  function route() {
    let { view, tab } = parseHash();
    if (!VIEWS.has(view) || !visible(VIEWS.get(view))) {
      // Basica: siempre el panel. Avanzada: la primera vez la guia, despues el panel.
      if (uiMode === "basica" || storageGet("localStorage", "cm_seen_guide")) view = "inicio";
      else view = "guia";
      if (uiMode === "avanzada") storageSet("localStorage", "cm_seen_guide", "1");
      tab = null;
      history.replaceState(null, "", `#${view}`);
    }
    const def = VIEWS.get(view);
    if (!def.tabs.some(([t]) => t === tab)) tab = def.tabs[0][0];

    const previous = current;
    const viewChanged = view !== current;
    const tabChanged = viewChanged || tab !== currentTab;
    current = view;
    currentTab = tab;

    document.body.dataset.view = view;
    document.body.classList.remove("menu-open");
    for (const node of document.querySelectorAll("[data-view]")) node.hidden = node.dataset.view !== view;
    for (const node of document.querySelectorAll("[data-panel]")) {
      if (node.dataset.panel.startsWith(`${view}/`)) node.hidden = node.dataset.panel !== `${view}/${tab}`;
    }
    markActive();
    const tabLabel = def.tabs.find(([t]) => t === tab)[1];
    $("topbar-section").textContent = shownTabs(def).length > 1 ? `· ${def.label} · ${tabLabel}` : `· ${def.label}`;
    document.title = `${def.label} · ClickMaster`;

    if (viewChanged) {
      hideBanner();
      window.scrollTo(0, 0);
      if (previous) for (const fn of leaveHandlers[previous] || []) fn();
      for (const fn of enterHandlers[view] || []) fn();
    }
    if (tabChanged) for (const fn of tabHandlers[view] || []) fn(tab);
  }

  function markActive() {
    for (const a of document.querySelectorAll("[data-tab-link]")) a.setAttribute("aria-selected", String(a.dataset.tabLink === `${current}/${currentTab}`));
    for (const li of document.querySelectorAll("[data-side]")) li.classList.toggle("active", li.dataset.side === current);
    for (const a of document.querySelectorAll("[data-side-tab]")) {
      if (a.dataset.sideTab === `${current}/${currentTab}`) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
  }

  function go(view, tab) {
    const hash = `#${view}/${tab}`;
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function refreshCurrent() {
    for (const fn of enterHandlers[current] || []) fn();
    for (const fn of tabHandlers[current] || []) fn(currentTab);
  }

  /** Marca (punto) en una pestana: ej. configuracion con cambios sin guardar. */
  function setTabDot(view, tab, on) {
    const a = document.querySelector(`[data-tab-link="${view}/${tab}"]`);
    if (!a) return;
    const dot = a.querySelector(".dot");
    if (on && !dot) a.append(el("span", { class: "dot", "aria-label": "con cambios" }));
    if (!on && dot) dot.remove();
  }

  // ---------- Estado en el sidebar ----------

  async function refreshSideStatus() {
    const box = $("side-status");
    try {
      const s = await api("/admin/status");
      const pill = (ok, text) => el("span", { class: `pill ${ok ? "ok" : "bad"}` }, text);
      const worker = s.worker;
      const clicking = Boolean(s.clicks.current) || s.clicks.queued > 0;
      if (!s.policy || !s.policy.active) {
        // Sin politica activa no corre nada: un solo aviso claro.
        box.replaceChildren(
          el("span", { class: "pill warn" }, "En espera: sin politica activa"),
          el("span", null, s.queue ? `Cola: ${fmtNum(s.queue.pending + s.queue.retry)} pendientes` : "")
        );
        return;
      }
      box.replaceChildren(
        el("span", null, `Politica: ${s.policy.active.name}`),
        pill(s.scheduler.enabled && s.scheduler.running, s.scheduler.enabled ? "Ingesta activa" : "Ingesta pausada"),
        pill(
          worker.enabled && worker.running && !worker.paused && !worker.outsideHours,
          !worker.enabled ? "Worker pausado" : clicking ? "Worker en pausa (clicks)" : worker.outsideHours ? "Worker fuera de horario" : "Worker activo"
        ),
        el("span", null, s.queue ? `Cola: ${fmtNum(s.queue.pending + s.queue.retry)} pendientes` : "")
      );
    } catch {
      box.replaceChildren();
    }
  }

  // ---------- Arranque ----------

  document.body.dataset.ui = uiMode;
  for (const b of $("ui-mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.ui === uiMode));
  $("ui-mode").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-ui]");
    if (b && b.dataset.ui !== uiMode) setUiMode(b.dataset.ui);
  });
  buildSidebar();
  buildTabs();

  // El nombre se recuerda en este navegador: es solo para el historial.
  $("actor").value = storageGet("localStorage", "cm_actor");
  $("actor").addEventListener("change", () => storageSet("localStorage", "cm_actor", actor()));

  // El token tambien lo usa la seccion actual (dashboard.js maneja el de reportes).
  $("token-form").addEventListener("submit", (e) => {
    e.preventDefault();
    storageSet("sessionStorage", "cm_token", $("token").value.trim());
    hideBanner();
    if (current !== "reportes") refreshCurrent();
    refreshSideStatus();
  });

  $("menu-btn").addEventListener("click", () => document.body.classList.toggle("menu-open"));
  $("scrim").addEventListener("click", () => document.body.classList.remove("menu-open"));
  window.addEventListener("hashchange", route);

  window.CM = {
    $, el, api, errorText, showBanner, hideBanner,
    fmtNum, fmtDate, fmtValue, fmtAgo, kv, table, subtabs,
    onEnter, onLeave, onTab, go, setTabDot,
    uiMode: () => uiMode,
    setUiMode,
    currentView: () => current,
    currentTab: () => currentTab,
    refreshSideStatus,
    // Las secciones registran sus handlers y despues se llama start().
    start() {
      route();
      refreshSideStatus();
      setInterval(() => {
        if (document.visibilityState === "visible") refreshSideStatus();
      }, 30000);
    },
  };
})();
