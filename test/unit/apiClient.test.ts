import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../../src/config";
import { EdrError, fetchEdrRange } from "../../src/fetcher/apiClient";

// API EDR de mentira: cada test define que responde. Nada sale de la maquina.
let respond: (body: any) => { status: number; json?: unknown; raw?: string; delayMs?: number };
const received: any[] = [];
let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      received.push({ body: parsed, headers: req.headers });
      const r = respond(parsed);
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(r.raw ?? JSON.stringify(r.json));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  config.edr.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  config.edr.auth = "secreto-de-test";
  config.edr.clientProductId = "1286";
  config.edr.country = "Brazil";
  config.edr.maxRetries = 2;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  received.length = 0;
  config.edr.maxRetries = 2;
  config.edr.httpTimeoutMs = 600000;
});

const range = { start: new Date("2026-10-14T12:00:00Z"), end: new Date("2026-10-14T12:30:00Z") };

describe("cliente JSON-RPC de EDR", () => {
  test("arma el request con fechas en hora de la API y los filtros", async () => {
    respond = () => ({ status: 200, json: { jsonrpc: "2.0", id: 1, result: { data: [{ a: 1 }] } } });
    const data = await fetchEdrRange(range);
    assert.deepEqual(data, [{ a: 1 }]);
    const { body } = received[0];
    assert.equal(body.method, "Enterprise.Cursor");
    assert.equal(body.params.name, "get_sms_edr");
    assert.equal(body.params.auth, "secreto-de-test");
    assert.deepEqual(body.params.args, {
      start_date: "2026.10.14 09:00:00",
      end_date: "2026.10.14 09:30:00",
      client_product_id: "1286",
      op_country: "==",
      country: "Brazil",
    });
  });

  test("un error JSON-RPC falla sin reintentar y sin filtrar el auth", async () => {
    respond = () => ({ status: 200, json: { jsonrpc: "2.0", id: 1, error: { code: 401, message: "auth invalido" } } });
    await assert.rejects(fetchEdrRange(range), (err: unknown) => {
      assert.ok(err instanceof EdrError);
      assert.equal(err.retryable, false);
      assert.match(err.message, /auth invalido/);
      assert.doesNotMatch(err.message, /secreto-de-test/);
      return true;
    });
    assert.equal(received.length, 1);
  });

  test("reintenta un HTTP 503 y despues sigue", async () => {
    let calls = 0;
    respond = () => (++calls === 1 ? { status: 503, json: {} } : { status: 200, json: { result: { data: [] } } });
    assert.deepEqual(await fetchEdrRange(range), []);
    assert.equal(received.length, 2);
  });

  test("un formato inesperado no se reintenta", async () => {
    respond = () => ({ status: 200, json: { result: { rows: [] } } });
    await assert.rejects(fetchEdrRange(range), /formato esperado/);
    assert.equal(received.length, 1);
  });

  test("espera una respuesta lenta mientras este dentro de EDR_HTTP_TIMEOUT_MS", async () => {
    config.edr.httpTimeoutMs = 5000;
    respond = () => ({ status: 200, delayMs: 1500, json: { result: { data: [{ lenta: true }] } } });
    assert.deepEqual(await fetchEdrRange(range), [{ lenta: true }]);
  });

  test("corta al pasar EDR_HTTP_TIMEOUT_MS y lo marca como reintentable", async () => {
    config.edr.httpTimeoutMs = 300;
    config.edr.maxRetries = 0;
    respond = () => ({ status: 200, delayMs: 3000, json: { result: { data: [] } } });
    await assert.rejects(fetchEdrRange(range), (err: unknown) => {
      assert.ok(err instanceof EdrError);
      assert.equal(err.retryable, true);
      assert.match(err.message, /sin respuesta completa/);
      return true;
    });
  });

  test("un 400 no se reintenta", async () => {
    respond = () => ({ status: 400, json: {} });
    await assert.rejects(fetchEdrRange(range), /HTTP 400/);
    assert.equal(received.length, 1);
  });
});
