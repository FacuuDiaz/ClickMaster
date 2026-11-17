// Fuente Alaris como curl: muestra la peticion que arma la app con las
// variables y, si se edita el texto, la interpreta y actualiza esas mismas
// variables (via CM.config). Lo que no se puede tocar (auth, fechas) queda
// como marcador.
(function () {
  "use strict";
  const { $, el, api } = CM;

  const START = "<inicio>";
  const END = "<fin>";
  const AUTH = "$EDR_AUTH";
  const BEARER = "$API_TOKEN";
  // Siempre se manda (la paginacion por ultimo registro necesita el orden).
  const ORDER = "edr_date asc";
  const KEYS = ["edr.url", "edr.method", "edr.cursorName", "edr.clientProductId", "edr.country", "edr.extraArgs", "edr.httpTimeoutMs", "edr.maxRetries"];

  let mode = "vars";
  let bearerConfigured = false;
  let lastGenerated = "";
  let debounce = null;

  // ---------- Variables -> curl ----------

  // Comillas simples de bash: una ' adentro se escribe '\''.
  const sq = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;

  function build(v) {
    // Mismo orden y reglas que buildRequest en src/fetcher/apiClient.ts.
    const args = { start_date: START, end_date: END };
    if (v["edr.clientProductId"]) args.client_product_id = v["edr.clientProductId"];
    if (v["edr.country"]) {
      args.op_country = "==";
      args.country = v["edr.country"];
    }
    args.orderby_clause = ORDER;
    Object.assign(args, v["edr.extraArgs"] || {});
    const body = { id: 1, jsonrpc: "2.0", method: v["edr.method"], params: { name: v["edr.cursorName"], auth: AUTH, args } };
    const lines = [`curl -X POST ${sq(v["edr.url"])}`, `  -H 'Content-Type: application/json'`];
    if (bearerConfigured) lines.push(`  -H ${sq(`Authorization: Bearer ${BEARER}`)}`);
    lines.push(`  --max-time ${Math.round(v["edr.httpTimeoutMs"] / 1000)}`);
    if (v["edr.maxRetries"] > 0) lines.push(`  --retry ${v["edr.maxRetries"]}`);
    lines.push(`  --data-raw ${sq(JSON.stringify(body, null, 2))}`);
    return lines.join(" \\\n");
  }

  function currentValues() {
    return Object.fromEntries(KEYS.map((k) => [k, CM.config.get(k)]));
  }

  // ---------- curl -> variables ----------

  /** Separa en argumentos como bash: comillas simples/dobles, \ y continuaciones de linea. */
  function tokenize(text) {
    const tokens = [];
    let cur = "";
    let has = false;
    let i = 0;
    const src = text.replace(/\\\r?\n/g, " ");
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) {
        if (has) tokens.push(cur);
        cur = "";
        has = false;
        i++;
      } else if (c === "'") {
        const end = src.indexOf("'", i + 1);
        if (end === -1) throw new Error("falta cerrar una comilla simple");
        cur += src.slice(i + 1, end);
        has = true;
        i = end + 1;
      } else if (c === '"') {
        i++;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === "\\" && i + 1 < src.length && '"\\$`'.includes(src[i + 1])) i++;
          cur += src[i++];
        }
        if (i >= src.length) throw new Error("falta cerrar una comilla doble");
        has = true;
        i++;
      } else if (c === "\\" && i + 1 < src.length) {
        cur += src[i + 1];
        has = true;
        i += 2;
      } else {
        cur += c;
        has = true;
        i++;
      }
    }
    if (has) tokens.push(cur);
    return tokens;
  }

  const DATA_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-ascii"]);

  /** Devuelve { values, notes } o tira un Error con el motivo. */
  function parse(text) {
    const tokens = tokenize(text);
    if (tokens[0] !== "curl") throw new Error("tiene que empezar con curl");
    const notes = [];
    let url = null;
    let data = null;
    let maxTime = null;
    let retry = null;
    const ignored = [];
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      const next = () => {
        if (i + 1 >= tokens.length) throw new Error(`a ${t} le falta el valor`);
        return tokens[++i];
      };
      if (t === "-X" || t === "--request") {
        const m = next();
        if (m.toUpperCase() !== "POST") notes.push(`La app siempre usa POST (se ignora ${m}).`);
      } else if (t === "-H" || t === "--header") {
        const h = next();
        if (/^authorization:/i.test(h)) {
          if (!h.includes(BEARER)) notes.push("El bearer sale de API_TOKEN en .env: el header Authorization escrito se ignora.");
        } else if (!/^content-type:\s*application\/json/i.test(h)) {
          notes.push(`Header ignorado (la app no manda headers extra): ${h}`);
        }
      } else if (DATA_FLAGS.has(t)) {
        data = next();
      } else if (t === "--url") {
        url = next();
      } else if (t === "-m" || t === "--max-time") {
        maxTime = Number(next());
      } else if (t === "--retry") {
        retry = Number(next());
      } else if (/^https?:\/\//i.test(t)) {
        url = t;
      } else if (t.startsWith("-")) {
        ignored.push(t);
      } else {
        throw new Error(`no se entiende "${t}"`);
      }
    }
    if (ignored.length) notes.push(`Opciones de curl ignoradas: ${ignored.join(" ")}`);
    if (!url) throw new Error("falta la URL");
    if (data === null) throw new Error("falta el cuerpo (--data-raw '{...}')");

    let body;
    try {
      body = JSON.parse(data);
    } catch (err) {
      throw new Error(`el cuerpo no es JSON valido: ${err.message}`);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("el cuerpo tiene que ser un objeto JSON");
    if (typeof body.method !== "string" || !body.method.trim()) throw new Error('falta "method"');
    const params = body.params;
    if (!params || typeof params !== "object") throw new Error('falta "params"');
    if (typeof params.name !== "string" || !params.name.trim()) throw new Error('falta "params.name" (el cursor)');
    if (params.auth !== undefined && params.auth !== AUTH) notes.push("La credencial sale de EDR_AUTH en .env: el \"auth\" escrito se ignora.");
    const args = params.args && typeof params.args === "object" && !Array.isArray(params.args) ? { ...params.args } : null;
    if (!args) throw new Error('falta "params.args"');
    for (const k of Object.keys(body)) if (!["id", "jsonrpc", "method", "params"].includes(k)) notes.push(`Campo ignorado del cuerpo: ${k}`);

    // Las fechas las pone la ingesta en cada ventana.
    if (args.start_date !== START || args.end_date !== END) notes.push(`Las fechas las completa la ingesta: dejar ${START} y ${END}.`);
    delete args.start_date;
    delete args.end_date;
    // El orden lo agrega la app; otro valor queda como argumento extra (lo pisa).
    if (args.orderby_clause === ORDER) delete args.orderby_clause;
    else if (args.orderby_clause !== undefined) notes.push(`orderby_clause distinto de "${ORDER}": si las respuestas llegan desordenadas, la ingesta pagina partiendo en mitades (mas lento).`);
    else notes.push(`Falta orderby_clause: la app lo agrega igual ("${ORDER}").`);

    // Producto y pais van a sus variables si tienen la forma que arma la app;
    // cualquier otra cosa queda en "argumentos extra" (que pisa a los otros).
    let clientProductId = null;
    if (typeof args.client_product_id === "string" && args.client_product_id.trim()) {
      clientProductId = args.client_product_id.trim();
      delete args.client_product_id;
    }
    let country = null;
    if (args.op_country === "==" && typeof args.country === "string" && args.country.trim()) {
      country = args.country.trim();
      delete args.op_country;
      delete args.country;
    }

    if (maxTime !== null && !(Number.isFinite(maxTime) && maxTime >= 1)) throw new Error("--max-time tiene que ser un numero de segundos >= 1");
    if (retry !== null && !(Number.isInteger(retry) && retry >= 0 && retry <= 10)) throw new Error("--retry tiene que ser un entero entre 0 y 10");

    return {
      notes,
      values: {
        "edr.url": url,
        "edr.method": body.method.trim(),
        "edr.cursorName": params.name.trim(),
        "edr.clientProductId": clientProductId,
        "edr.country": country,
        "edr.extraArgs": args,
        "edr.httpTimeoutMs": maxTime === null ? CM.config.get("edr.httpTimeoutMs") : Math.round(maxTime * 1000),
        "edr.maxRetries": retry === null ? 0 : retry,
      },
    };
  }

  // ---------- UI ----------

  function status(text, kind) {
    const node = $("edr-curl-status");
    node.textContent = text;
    node.className = `curl-status${kind ? ` ${kind}` : ""}`;
    $("edr-curl").classList.toggle("bad", kind === "bad");
  }

  function notes(list) {
    $("edr-curl-notes").replaceChildren(...list.map((n) => el("li", null, n)));
  }

  function regenerate() {
    // Todavia no cargo la configuracion: lo arma el onLoad.
    if (CM.config.get("edr.url") === undefined) return;
    lastGenerated = build(currentValues());
    $("edr-curl").value = lastGenerated;
    status("Generado desde las variables", "");
    notes([]);
  }

  function apply() {
    const text = $("edr-curl").value;
    if (text === lastGenerated) {
      status("Sin cambios respecto de las variables", "");
      notes([]);
      return;
    }
    let parsed;
    try {
      parsed = parse(text);
    } catch (err) {
      status(`No se aplico: ${err.message}`, "bad");
      return;
    }
    const before = currentValues();
    const changed = KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(parsed.values[k]));
    for (const k of changed) CM.config.set(k, parsed.values[k]);
    status(changed.length ? `Aplicado a ${changed.length} variable(s) · falta guardar` : "Igual a las variables actuales", "ok");
    notes(parsed.notes);
  }

  function setMode(next) {
    // Al salir del curl se aplica lo escrito (si es valido) antes de mostrar las variables.
    if (mode === "curl" && next === "vars") {
      clearTimeout(debounce);
      apply();
    }
    mode = next;
    for (const b of $("edr-mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode));
    $("settings-group-edr").hidden = mode !== "vars";
    $("edr-curl-view").hidden = mode !== "curl";
    if (mode === "curl") regenerate();
    try {
      localStorage.setItem("cm_edr_mode", mode);
    } catch {
      // Sin storage: arranca siempre en variables.
    }
  }

  $("edr-mode").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (b && b.dataset.mode !== mode) setMode(b.dataset.mode);
  });
  $("edr-curl").addEventListener("input", () => {
    clearTimeout(debounce);
    status("Escribiendo…", "");
    debounce = setTimeout(apply, 500);
  });
  $("edr-curl-reset").addEventListener("click", regenerate);
  $("edr-curl-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("edr-curl").value);
      status("Copiado. Para correrlo en una terminal reemplaza <inicio>, <fin> y las variables de .env.", "ok");
    } catch {
      $("edr-curl").select();
      status("Selecciona y copia con Ctrl+C", "");
    }
  });

  // Despues de cargar o guardar la configuracion, el curl refleja lo vigente.
  CM.config.onLoad(() => {
    if (mode === "curl") regenerate();
  });
  CM.onEnter("configuracion", async () => {
    try {
      const env = await api("/admin/env");
      const item = env.groups.flatMap((g) => g.items).find((i) => i.env === "API_TOKEN");
      bearerConfigured = Boolean(item && item.configured);
    } catch {
      bearerConfigured = false;
    }
    let saved = "vars";
    try {
      saved = localStorage.getItem("cm_edr_mode") || "vars";
    } catch {
      // idem
    }
    if (saved !== mode) setMode(saved);
  });

  // Para tests manuales desde la consola.
  CM.curl = { build, parse, tokenize };
})();
