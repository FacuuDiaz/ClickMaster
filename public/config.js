// Seccion Configuracion: edita app_settings via /admin/settings.
(function () {
  "use strict";
  const { $, el, api, errorText, showBanner, hideBanner, fmtDate, fmtValue } = CM;

  const state = {
    settings: [],
    // key -> valor nuevo (ya convertido al tipo) | Symbol RESET
    pending: new Map(),
    invalid: new Set(),
  };
  const RESET = Symbol("reset");

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Convierte lo que hay en el input al tipo de la clave. Devuelve
  // { ok, value } o { ok: false, error }.
  function parseInput(s, raw) {
    if (s.type === "bool" || s.type === "enum") return { ok: true, value: raw };
    const text = String(raw).trim();
    if (text === "") {
      return s.nullable ? { ok: true, value: null } : { ok: false, error: "no puede quedar vacio" };
    }
    if (s.type === "int" || s.type === "number") {
      const n = Number(text);
      if (!Number.isFinite(n) || (s.type === "int" && !Number.isInteger(n))) return { ok: false, error: "numero invalido" };
      if (s.min !== null && n < s.min) return { ok: false, error: `minimo ${s.min}` };
      if (s.max !== null && n > s.max) return { ok: false, error: `maximo ${s.max}` };
      return { ok: true, value: n };
    }
    if (s.type === "json") {
      try {
        const v = JSON.parse(text);
        if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "tiene que ser un objeto JSON" };
        return { ok: true, value: v };
      } catch {
        return { ok: false, error: "JSON invalido" };
      }
    }
    return { ok: true, value: text };
  }

  function toInputText(s, v) {
    if (v === null || v === undefined) return "";
    if (s.type === "json") return JSON.stringify(v, null, 2);
    return String(v);
  }

  function updateSavebar() {
    // Punto en las pestanas que tienen cambios (o errores) sin guardar.
    const touched = new Set([...state.pending.keys(), ...state.invalid].map((k) => state.settings.find((x) => x.key === k)?.group));
    for (const group of new Set(state.settings.map((x) => x.group))) CM.setTabDot("configuracion", group, touched.has(group));
    const n = state.pending.size;
    $("savebar").hidden = n === 0 && state.invalid.size === 0;
    $("settings-review").disabled = n === 0 || state.invalid.size > 0;
    $("savebar-text").textContent =
      state.invalid.size > 0
        ? `Hay ${state.invalid.size} valor(es) invalido(s)`
        : `${n} cambio${n === 1 ? "" : "s"} sin guardar`;
  }

  function originNode(s) {
    const box = el("div", { class: "origin" });
    if (s.source === "base") {
      box.append(el("span", { class: "badge base" }, "editado en la web"));
      const who = s.updatedBy ? ` por ${s.updatedBy}` : "";
      box.append(el("span", null, `${fmtDate(s.updatedAt)}${who}`));
      box.append(el("span", null, `· .env: ${fmtValue(s.envValue)}`));
    } else {
      box.append(el("span", { class: "badge" }, s.source === "env" ? ".env" : "por defecto"));
    }
    box.append(el("code", null, s.env));
    return box;
  }

  function renderSetting(s) {
    const row = el("div", { class: "setting", "data-key": s.key });
    const info = el("div");
    info.append(el("div", { class: "name" }, s.label), el("div", { class: "help" }, s.description), originNode(s));

    const control = el("div", { class: "control" });
    const id = `set-${s.key.replace(/\W/g, "-")}`;
    let input;
    if (s.options) {
      input = el("select", { id, "aria-label": s.label });
      const options = { ...s.options };
      // Un valor de .env fuera de la lista igual se muestra (y se puede cambiar).
      if (s.value !== null && !(String(s.value) in options)) options[String(s.value)] = `${s.value}${s.unit ? ` ${s.unit}` : ""} (fuera de la lista)`;
      for (const [value, label] of Object.entries(options)) input.append(el("option", { value }, label));
      input.value = String(s.value);
      control.append(input);
    } else if (s.type === "bool") {
      const label = el("label", { class: "row" });
      input = el("input", { type: "checkbox", id });
      input.checked = Boolean(s.value);
      label.append(input, document.createTextNode(" Activado"));
      control.append(label);
    } else if (s.type === "json") {
      input = el("textarea", { id, spellcheck: "false", "aria-label": s.label });
      input.value = toInputText(s, s.value);
      control.append(input);
    } else {
      const r = el("div", { class: "row" });
      const attrs = { id, "aria-label": s.label, type: s.type === "string" ? "text" : "number" };
      if (s.type !== "string") {
        if (s.min !== null) attrs.min = s.min;
        if (s.max !== null) attrs.max = s.max;
        attrs.step = s.type === "int" ? "1" : "any";
        attrs.inputmode = "decimal";
      }
      if (s.nullable) attrs.placeholder = "(vacio)";
      input = el("input", attrs);
      input.value = toInputText(s, s.value);
      r.append(input);
      if (s.unit) r.append(el("span", { class: "unit" }, s.unit));
      control.append(r);
    }
    const error = el("div", { class: "result bad", "aria-live": "polite" });
    control.append(error);
    if (s.source === "base") {
      const reset = el("button", { type: "button", class: "linkbtn" }, "Volver al valor de .env");
      reset.addEventListener("click", () => {
        state.pending.set(s.key, RESET);
        state.invalid.delete(s.key);
        input.value = toInputText(s, s.envValue);
        if (s.type === "bool") input.checked = Boolean(s.envValue);
        error.textContent = "";
        row.classList.add("dirty");
        updateSavebar();
      });
      control.append(reset);
    }

    const onChange = () => {
      const parsed = parseInput(s, s.type === "bool" ? input.checked : input.value);
      if (!parsed.ok) {
        state.invalid.add(s.key);
        state.pending.delete(s.key);
        error.textContent = parsed.error;
        row.classList.add("dirty");
      } else {
        state.invalid.delete(s.key);
        error.textContent = "";
        if (same(parsed.value, s.value)) state.pending.delete(s.key);
        else state.pending.set(s.key, parsed.value);
        row.classList.toggle("dirty", state.pending.has(s.key));
      }
      updateSavebar();
    };
    input.addEventListener(s.type === "bool" || s.options ? "change" : "input", onChange);

    row.append(info, control);
    return row;
  }

  function render(data) {
    state.settings = data.settings;
    state.pending.clear();
    state.invalid.clear();
    // Cada grupo va en su pestana (index.html: #settings-group-<grupo>).
    for (const group of Object.keys(data.groups)) {
      const card = $(`settings-group-${group}`);
      if (!card) continue;
      card.replaceChildren();
      for (const s of data.settings.filter((x) => x.group === group)) card.append(renderSetting(s));
    }
    updateSavebar();
    for (const fn of loadListeners) fn();
  }

  async function load() {
    try {
      render(await api("/admin/settings"));
    } catch (err) {
      if (!err.auth) showBanner(errorText(err), { error: true });
    }
  }

  function openReview() {
    const diff = $("settings-diff");
    diff.replaceChildren();
    for (const [key, value] of state.pending) {
      const s = state.settings.find((x) => x.key === key);
      const line = el("div");
      line.append(el("b", null, s.label), document.createTextNode(": "));
      line.append(el("del", null, fmtValue(s.value)), document.createTextNode(" → "));
      line.append(el("ins", null, value === RESET ? `${fmtValue(s.envValue)} (valor de .env)` : fmtValue(value)));
      diff.append(line);
    }
    if (!CM.$("actor").value.trim()) {
      diff.append(el("p", { class: "muted" }, "Tip: escribi tu nombre abajo a la izquierda (en el menu) para que quede en el historial."));
    }
    $("settings-dialog").showModal();
  }

  async function save() {
    const set = {};
    const reset = [];
    for (const [key, value] of state.pending) {
      if (value === RESET) reset.push(key);
      else set[key] = value;
    }
    $("settings-save").disabled = true;
    try {
      const data = await api("/admin/settings", { method: "PUT", body: { set, reset } });
      $("settings-dialog").close();
      render(data);
      CM.refreshSideStatus();
      showBanner(
        data.changed.length ? `Guardado. Se aplico en caliente: ${data.changed.length} valor(es).` : "No habia nada distinto para guardar."
      );
    } catch (err) {
      $("settings-dialog").close();
      if (!err.auth) showBanner(errorText(err), { error: true });
    } finally {
      $("settings-save").disabled = false;
    }
  }

  $("settings-review").addEventListener("click", openReview);
  $("settings-cancel").addEventListener("click", () => $("settings-dialog").close());
  $("settings-save").addEventListener("click", save);
  $("settings-discard").addEventListener("click", () => {
    hideBanner();
    load();
  });

  CM.onEnter("configuracion", load);

  // API para otras vistas de la misma pantalla (ej. el editor curl de la
  // fuente Alaris): leer el valor vigente (con lo pendiente) y escribir un
  // valor como si se hubiera tipeado en su campo (misma validacion y barra).
  const inputOf = (key) => document.getElementById(`set-${key.replace(/\W/g, "-")}`);
  CM.config = {
    get(key) {
      const s = state.settings.find((x) => x.key === key);
      if (!s) return undefined;
      if (state.pending.has(key)) {
        const v = state.pending.get(key);
        return v === RESET ? s.envValue : v;
      }
      return s.value;
    },
    set(key, value) {
      const s = state.settings.find((x) => x.key === key);
      const input = inputOf(key);
      if (!s || !input) return;
      if (s.type === "bool") input.checked = Boolean(value);
      else input.value = toInputText(s, value);
      input.dispatchEvent(new Event(s.type === "bool" || s.options ? "change" : "input"));
    },
    // Avisa cuando se recargan los valores (al entrar o despues de guardar).
    onLoad(fn) {
      loadListeners.push(fn);
    },
  };
  const loadListeners = [];
})();
