// Seccion Entorno (.env): lo que no se edita desde la web (/admin/env) y
// los valores de .env que hoy estan pisados desde Configuracion.
(function () {
  "use strict";
  const { $, el, api, errorText, showBanner, fmtDate, fmtValue, table } = CM;

  function renderGroups(groups) {
    const box = $("env-groups");
    box.replaceChildren();
    for (const g of groups) {
      const card = el("section", { class: "card env-group", "aria-label": g.group });
      card.append(el("h2", null, g.group), el("p", { class: "desc" }, g.description));
      for (const item of g.items) {
        const row = el("div", { class: "env-row" });
        const name = el("div");
        name.append(el("div", { style: "font-weight:600" }, item.label), el("code", null, item.env));
        const value = item.value === null
          ? el("div", { class: "v secret" }, item.configured ? "•••••• configurado" : "sin configurar")
          : el("div", { class: "v" }, item.value);
        row.append(name, el("div", { class: "d" }, item.description), value);
        card.append(row);
      }
      box.append(card);
    }
  }

  function renderOverrides(settings) {
    const pisadas = settings.filter((s) => s.source === "base");
    const link = (s) => {
      const a = el("a", { href: `#configuracion/${s.group}` }, s.label);
      return a;
    };
    table(
      $("env-overrides"),
      [
        { label: "Configuracion", render: link },
        { label: "Variable", render: (s) => el("code", null, s.env) },
        { label: "En .env", cls: "text", render: (s) => fmtValue(s.envValue) },
        { label: "Manda hoy (web)", cls: "text", render: (s) => fmtValue(s.value) },
        { label: "Cambiado", cls: "time", render: (s) => `${fmtDate(s.updatedAt)}${s.updatedBy ? ` · ${s.updatedBy}` : ""}` },
      ],
      pisadas,
      "Ninguna: hoy todo sale de .env o de los valores por defecto"
    );
  }

  // ---------- Vista "como archivo .env" (solo lectura) ----------

  let fileText = "";

  function renderFile(groups) {
    const pre = $("env-file");
    pre.replaceChildren();
    const lines = [];
    const add = (cls, text) => {
      const span = el("span", cls ? { class: cls } : null, text);
      pre.append(span, document.createTextNode("\n"));
      lines.push(text);
    };
    const line = (parts) => {
      for (const [cls, text] of parts) pre.append(cls ? el("span", { class: cls }, text) : document.createTextNode(text));
      pre.append(document.createTextNode("\n"));
      lines.push(parts.map(([, t]) => t).join(""));
    };
    groups.forEach((g, i) => {
      if (i > 0) add(null, "");
      add("h", `# --- ${g.group} ---`);
      add("c", `# ${g.description}`);
      for (const item of g.items) {
        add("c", `# ${item.label}: ${item.description}`);
        if (item.value === null) {
          // Secreto: nunca se muestra el valor.
          if (item.configured) line([["k", item.env], [null, "="], ["s", "********"]]);
          else line([["k", item.env], [null, "="], ["c", "   # sin configurar"]]);
        } else if (item.raw === null) {
          line([["c", `# ${item.env}=   (no esta en .env: usa ${item.value})`]]);
        } else {
          line([["k", item.env], [null, `=${item.raw}`]]);
        }
      }
    });
    fileText = lines.join("\n") + "\n";
  }

  function setMode(mode) {
    for (const b of $("env-mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    $("env-groups").hidden = mode !== "vars";
    $("env-file-view").hidden = mode !== "file";
    try {
      localStorage.setItem("cm_env_mode", mode);
    } catch {
      // Sin storage: arranca en variables.
    }
  }

  $("env-mode").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (b) setMode(b.dataset.mode);
  });
  $("env-file-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(fileText);
      showBanner("Copiado. Los secretos quedaron como ******** : completalos a mano.");
    } catch {
      showBanner("No se pudo copiar: selecciona el texto y usa Ctrl+C", { error: true });
    }
  });
  try {
    setMode(localStorage.getItem("cm_env_mode") || "vars");
  } catch {
    setMode("vars");
  }

  async function load() {
    try {
      const [env, settings] = await Promise.all([api("/admin/env"), api("/admin/settings")]);
      renderGroups(env.groups);
      renderFile(env.groups);
      renderOverrides(settings.settings);
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
  }

  CM.onEnter("entorno", load);
})();
