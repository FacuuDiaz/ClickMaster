// Seccion Historial: config_audit paginado (mas nuevo primero).
(function () {
  "use strict";
  const { $, el, api, errorText, showBanner, fmtDate, fmtValue, table } = CM;

  const ENTITY = { setting: "Configuracion", policy: "Politica", action: "Accion", capture: "Captura" };
  const ACTION = {
    update: "Cambio", reset: "Volvio a .env", create: "Alta", delete: "Baja", reorder: "Reordeno",
    sync_manual: "Pidio ventana", recover: "Recupero reservas",
    clicks: "Lanzo clicks", clicks_batch: "Lanzo lote de clicks", clicks_cancel: "Cancelo clicks",
    capture: "Pidio captura", keep: "Conservo", unkeep: "Quito conservar", discard: "Descarto", reprocess: "Reproceso",
  };
  let items = [];
  let nextBeforeId = null;

  function change(r) {
    const box = el("div");
    if (r.oldValue !== null && r.oldValue !== undefined) {
      box.append(el("del", null, short(r.oldValue)), document.createTextNode(" → "));
    }
    box.append(el("ins", null, short(r.newValue)));
    box.className = "diff";
    return box;
  }

  function short(v) {
    const text = fmtValue(v);
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  }

  function render() {
    table(
      $("audit-table"),
      [
        { label: "Fecha", cls: "time", render: (r) => fmtDate(r.at) },
        { label: "Quien", render: (r) => (r.actor ? `${r.actor}${r.ip ? ` (${r.ip})` : ""}` : r.ip || "—") },
        { label: "Tipo", render: (r) => ENTITY[r.entity] || r.entity },
        { label: "Accion", render: (r) => ACTION[r.action] || r.action },
        { label: "Sobre", cls: "link", render: (r) => r.ref },
        { label: "Cambio", cls: "text", render: change },
      ],
      items,
      "Todavia no hay cambios registrados"
    );
    $("audit-more").disabled = !nextBeforeId;
  }

  async function load(more) {
    const params = { limit: "50" };
    // La pestana elegida es el filtro (todo / setting / policy / action / capture).
    const entity = CM.currentTab();
    if (entity && entity !== "todo") params.entity = entity;
    if (more && nextBeforeId) params.beforeId = String(nextBeforeId);
    try {
      const page = await api("/admin/audit", { params });
      items = more ? items.concat(page.items) : page.items;
      nextBeforeId = page.nextBeforeId;
      render();
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
  }

  $("audit-more").addEventListener("click", () => load(true));
  CM.onTab("historial", () => load(false));
})();
