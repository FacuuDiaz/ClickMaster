// Mock local de la API EDR (JSON-RPC Enterprise.Cursor / get_sms_edr) y de
// las paginas a las que apuntan los links. Sin dependencias: node server.js.
//
// - Genera MOCK_EDR_PER_MINUTE SMS por minuto, deterministicos: pedir dos
//   veces el mismo rango (o rangos solapados) devuelve los mismos ids.
// - Corta en MOCK_EDR_MAX_ROWS filas, como la API real.
// - Los links rotan entre paginas que cargan, 404, 500, vacia, lenta y un
//   dominio que no existe, para ver todos los resultados del worker.
const http = require("http");

const PORT = Number(process.env.PORT || 8080);
const PER_MINUTE = Number(process.env.MOCK_EDR_PER_MINUTE || 10);
const MAX_ROWS = Number(process.env.MOCK_EDR_MAX_ROWS || 20000);
const AUTH = process.env.MOCK_EDR_AUTH || "";
const PUBLIC_URL = process.env.MOCK_EDR_PUBLIC_URL || "http://mock-edr:8080";
const OFFSET_MIN = -180; // la API trabaja en GMT-3

const pad = (n) => String(n).padStart(2, "0");

function parseApiDate(value) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value || "");
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - OFFSET_MIN * 60000;
}

function formatApiDate(ms) {
  const d = new Date(ms + OFFSET_MIN * 60000);
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const LINKS = [
  `${PUBLIC_URL}/ok`,
  `${PUBLIC_URL}/ok`,
  `${PUBLIC_URL}/ok`,
  `${PUBLIC_URL}/ok?redir=1`,
  `${PUBLIC_URL}/404`,
  `${PUBLIC_URL}/error-500`,
  `${PUBLIC_URL}/vacia`,
  `${PUBLIC_URL}/lenta`,
  "http://dominio-que-no-existe.invalid/x",
  null,
];

function record(ms, i, slot) {
  const seq = Math.floor(ms / 1000) * 100 + i;
  const link = LINKS[slot % LINKS.length];
  return {
    cdr_delivery_time: formatApiDate(ms + 5000),
    client: "MOCK CLIENT",
    client_acc_id: 1,
    client_message_id: `mock-c-${seq}`,
    client_rate: 0.008,
    country: "Brazil",
    dnis: `55${String(seq).slice(-11)}`,
    dst_is_successful: 1,
    dst_part_amount: 1,
    edr_date: formatApiDate(ms),
    edr_type: 1,
    mccmnc: "724005",
    network: "[BR] Mock",
    sender_name: "MOCK",
    src_is_successful: 1,
    src_part_amount: 1,
    status: "DELIVRD",
    "t#tech_details_json": "{}",
    "t#translated_text": null,
    text: link ? `Promo mock ${seq}: ${link}` : `Su codigo es ${seq % 1000000}`,
    vendor: "MOCK VENDOR",
    vendor_acc_id: 2,
    vendor_message_id: `mock-v-${seq}`,
    vendor_rate: 0.004,
  };
}

function generate(startMs, endMs) {
  const out = [];
  const stepMs = 60000 / PER_MINUTE;
  // Arranca en el primer slot >= start, alineado a la grilla absoluta.
  let ms = Math.ceil(startMs / stepMs) * stepMs;
  for (; ms <= endMs && out.length < MAX_ROWS; ms += stepMs) {
    const second = Math.floor(ms / 1000) * 1000;
    out.push(record(second, Math.round((ms - second) / 10), Math.round(ms / stepMs)));
  }
  return out;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function handleRpc(req, res) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let rpc;
    try {
      rpc = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: "json invalido" });
    }
    const id = rpc.id ?? null;
    const params = rpc.params || {};
    if (rpc.method !== "Enterprise.Cursor" || params.name !== "get_sms_edr") {
      return sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "metodo desconocido" } });
    }
    if (AUTH && params.auth !== AUTH) {
      return sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: 401, message: "auth invalido" } });
    }
    const start = parseApiDate(params.args?.start_date);
    const end = parseApiDate(params.args?.end_date);
    if (start === null || end === null || end < start) {
      return sendJson(res, 200, { jsonrpc: "2.0", id, error: { code: -32602, message: "fechas invalidas" } });
    }
    const data = generate(start, end);
    console.log(`get_sms_edr ${params.args.start_date} -> ${params.args.end_date}: ${data.length} filas`);
    sendJson(res, 200, { jsonrpc: "2.0", id, result: { data } });
  });
}

const PAGE = "<!doctype html><html><head><title>OK</title></head><body><h1>Pagina mock</h1><p>Cargo bien.</p></body></html>";

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST") return handleRpc(req, res);
    switch (url.pathname) {
      case "/ok":
        if (url.searchParams.get("redir")) {
          res.writeHead(302, { Location: "/ok" });
          return res.end();
        }
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(PAGE);
      case "/vacia":
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("");
      case "/lenta":
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(PAGE);
        }, 60000);
        return;
      case "/error-500":
        res.writeHead(500, { "Content-Type": "text/plain" });
        return res.end("error mock");
      case "/health":
        return sendJson(res, 200, { status: "ok" });
      default:
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("no encontrado");
    }
  })
  .listen(PORT, () => console.log(`mock-edr escuchando en :${PORT} (${PER_MINUTE}/min, tope ${MAX_ROWS})`));
