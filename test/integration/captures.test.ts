import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { config } from "../../src/config";
import { pool } from "../../src/db/pool";
import { reportsPool } from "../../src/db/reportsPool";
import { createApp } from "../../src/http/app";
import { ingestWindow } from "../../src/service/ingestService";
import { forgetCapture } from "../../src/captures/analyze";
import { insertCapture, purgeCaptures } from "../../src/captures/repo";
import { createPolicy, policiesCache } from "../../src/policies/repo";
import { policyInputSchema } from "../../src/policies/schema";
import { count, resetTables, rows, setupTestDb } from "../helpers/db";
import { rawRecord } from "../helpers/fixtures";

const T0 = new Date("2026-11-16T12:00:00Z");
const WINDOW = { start: T0, end: new Date(T0.getTime() + 30 * 60_000) };

// Alaris de mentira: cada test define que responde.
let respond: () => { status: number; body: string };
let edr: http.Server;
let app: Server;
let base: string;

const records = (n: number, client = "ACME") =>
  Array.from({ length: n }, (_, i) => rawRecord(i + 1, new Date(T0.getTime() + i * 1000), { client }));
const ok = (data: unknown[]) => ({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { data } }) });

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Actor": "tester" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

before(async () => {
  await setupTestDb();
  edr = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const r = respond();
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(r.body);
    });
  });
  await new Promise<void>((resolve) => edr.listen(0, "127.0.0.1", resolve));
  config.edr.url = `http://127.0.0.1:${(edr.address() as AddressInfo).port}/`;
  config.edr.maxRetries = 0;
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await resetTables();
  // Sin politica activa no se puede reprocesar (en espera): una al 100%.
  await createPolicy(policyInputSchema.parse({ name: "todo", enabled: true, rules: { selection: { percentage: 100 } } }), { name: "tester", ip: null });
  await policiesCache.refresh();
  forgetCapture();
  config.checker.clickPercentage = 100;
  config.capture.mode = "errores";
  config.capture.retentionHours = 24;
  config.capture.maxTotalMb = 500;
});

after(async () => {
  edr.closeAllConnections();
  edr.close();
  app.close();
  await pool.end();
  await reportsPool.end();
});

describe("capturas en la ingesta", () => {
  test("modo todas: guarda la respuesta completa, comprimida y sin el auth", async () => {
    config.capture.mode = "todas";
    respond = () => ok(records(5));
    const run = await ingestWindow("manual", WINDOW);
    assert.equal(run.status, "success");

    const [c] = await rows("SELECT * FROM edr_captures");
    assert.equal(c.origin, "ingesta");
    assert.equal(Number(c.run_id), run.runId);
    assert.equal(Number(c.rows_count), 5);
    const body = gunzipSync(c.body_gz).toString("utf8");
    assert.equal(JSON.parse(body).result.data.length, 5);
    assert.equal(Number(c.bytes), Buffer.byteLength(body));
    assert.ok(!JSON.stringify(c.request_args).includes(String(config.edr.auth)));
    assert.ok(c.expires_at > new Date());
  });

  test("modo errores: guarda solo lo que falla y los registros invalidos", async () => {
    respond = () => ok(records(3));
    await ingestWindow("manual", WINDOW);
    assert.equal(await count("SELECT COUNT(*) FROM edr_captures"), 0);

    respond = () => ({ status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "auth invalido" } }) });
    const failed = await ingestWindow("manual", WINDOW);
    assert.equal(failed.status, "failed");
    const [err] = await rows("SELECT origin, error_message FROM edr_captures");
    assert.equal(err.origin, "error");
    assert.match(err.error_message, /auth invalido/);

    // Un registro sin client_message_id -> corrida partial + captura de invalidos.
    const data = records(3);
    delete (data[1] as Record<string, unknown>).client_message_id;
    respond = () => ok(data);
    const partial = await ingestWindow("manual", WINDOW);
    assert.equal(partial.status, "partial");
    const [inv] = await rows("SELECT origin, rows_count, run_id FROM edr_captures WHERE origin = 'invalidos'");
    assert.equal(Number(inv.rows_count), 1);
    assert.equal(Number(inv.run_id), partial.runId);
  });

  test("modo off: no guarda nada", async () => {
    config.capture.mode = "off";
    respond = () => ({ status: 500, body: "{}" });
    await ingestWindow("manual", WINDOW);
    assert.equal(await count("SELECT COUNT(*) FROM edr_captures"), 0);
  });
});

describe("rutas /admin/captures", () => {
  test("pedir, ver, buscar, simular, reprocesar sin duplicar, conservar y descartar", async () => {
    await createPolicy(policyInputSchema.parse({ name: "nunca beta", enabled: true, rules: { match: { clients: ["BETA"] }, selection: { action: "no_visitar" } } }), { name: "t", ip: null });
    respond = () => ok([...records(4, "ACME"), ...records(2, "BETA").map((r, i) => ({ ...r, client_message_id: `b-${i}`, vendor_message_id: `vb-${i}` }))]);

    const created = await call("POST", "/admin/captures", { start: WINDOW.start.toISOString(), end: WINDOW.end.toISOString() });
    assert.equal(created.status, 201);
    assert.equal(created.body.rows, 6);
    const id = created.body.captureId;
    // Pedir una captura no ingesta nada.
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing"), 0);

    const detail = await call("GET", `/admin/captures/${id}`);
    assert.equal(detail.body.summary.rows, 6);
    assert.deepEqual(detail.body.summary.clients.map((c: any) => [c.value, c.count]), [["ACME", 4], ["BETA", 2]]);
    assert.equal(detail.body.createdBy, "tester");

    const page = await call("GET", `/admin/captures/${id}/rows?limit=2&q=beta`);
    assert.equal(page.body.total, 2);
    assert.ok(page.body.items.every((r: any) => r.client === "BETA"));

    const sim = await call("POST", `/admin/captures/${id}/simulate`);
    const byName = Object.fromEntries(sim.body.rows.map((r: any) => [r.name, r]));
    assert.equal(byName["nunca beta"].matched, 2);
    assert.equal(byName["nunca beta"].estimatedVisits, 0);
    assert.equal(byName["Por defecto"].estimatedVisits, 4);

    const run = await call("POST", `/admin/captures/${id}/reprocess`);
    assert.equal(run.status, 200);
    assert.equal(run.body.smsNew, 6);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status = 'pending'"), 4);
    const again = await call("POST", `/admin/captures/${id}/reprocess`);
    assert.equal(again.body.smsNew, 0);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing"), 6);

    const kept = await call("POST", `/admin/captures/${id}/keep`, { keep: true });
    assert.equal(kept.body.expiresAt, null);
    assert.equal(kept.body.status, "reprocesada");

    assert.equal((await call("DELETE", `/admin/captures/${id}`)).status, 200);
    assert.equal((await call("GET", `/admin/captures/${id}`)).status, 404);

    const audit = await call("GET", "/admin/audit?entity=capture");
    assert.deepEqual(audit.body.items.map((i: any) => i.action), ["discard", "keep", "reprocess", "reprocess", "capture"]);
  });

  test("la lista informa uso y modo; una captura de error no se puede reprocesar", async () => {
    const id = await insertCapture({
      runId: null,
      origin: "error",
      rangeStart: WINDOW.start,
      rangeEnd: WINDOW.end,
      requestArgs: {},
      body: "<html>502</html>",
      errorMessage: "JSON invalido",
    });
    const list = await call("GET", "/admin/captures");
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.mode, "errores");
    assert.ok(list.body.usage.totalBytes > 0);

    const detail = await call("GET", `/admin/captures/${id}`);
    assert.ok(detail.body.parseError);
    assert.equal((await call("POST", `/admin/captures/${id}/reprocess`)).status, 400);
  });
});

describe("purga de capturas", () => {
  test("borra las vencidas y, si se pasa del espacio, las mas viejas no conservadas", async () => {
    const base = { runId: null, origin: "manual" as const, rangeStart: T0, rangeEnd: T0, requestArgs: {} };
    const old = await insertCapture({ ...base, body: "viejo" }, new Date(Date.now() - 48 * 3_600_000));
    const keep = await insertCapture({ ...base, body: "conservada" }, new Date(Date.now() - 48 * 3_600_000));
    await pool.query("UPDATE edr_captures SET expires_at = NULL WHERE id = ?", [keep]);
    assert.equal(await purgeCaptures(), 1);
    assert.equal(await count("SELECT COUNT(*) FROM edr_captures WHERE id = ?", [old]), 0);

    // Espacio: se simulan 1 MB comprimido por captura y un tope de 2 MB:
    // con la conservada encima se pasa, y se borra la mas vieja no conservada.
    const a = await insertCapture({ ...base, body: "a" });
    const b = await insertCapture({ ...base, body: "b" });
    await pool.query("UPDATE edr_captures SET gz_bytes = 1048576 WHERE id IN (?)", [[a, b]]);
    config.capture.maxTotalMb = 2;
    await purgeCaptures();
    const left = (await rows("SELECT id FROM edr_captures ORDER BY id")).map((r) => Number(r.id));
    assert.deepEqual(left, [keep, b]);
  });
});
