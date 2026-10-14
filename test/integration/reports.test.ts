import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../../src/config";
import { pool } from "../../src/db/pool";
import { createApp } from "../../src/http/app";
import { ingestWindow } from "../../src/service/ingestService";
import { resetTables, setupTestDb } from "../helpers/db";
import { syntheticSource } from "../helpers/fixtures";

let server: Server;
let base: string;
const T0 = new Date("2026-10-14T12:00:00Z");

async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: (await res.json()) as any };
}

before(async () => {
  await setupTestDb();
  await resetTables();
  config.checker.clickPercentage = 100;
  const source = syntheticSource(2, 10);
  for (let i = 0; i < 3; i++) {
    const start = new Date(T0.getTime() + i * 30 * 60_000);
    await ingestWindow("manual", { start, end: new Date(start.getTime() + 30 * 60_000) }, {
      fetcher: async (r) => source(r),
    });
  }
  await pool.query("UPDATE sms_processing SET status='failed', last_outcome='http_4xx', next_attempt_at=NULL, attempts=1 WHERE id % 5 = 0 AND status='pending'");
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

describe("endpoints de reportes", () => {
  test("GET /processing/jobs pagina con beforeId sin repetir ni saltear", async () => {
    const total = Number((await pool.query<any[]>("SELECT COUNT(*) AS n FROM sms_processing"))[0][0].n);
    const seen = new Set<number>();
    let beforeId: number | null = null;
    let pages = 0;
    do {
      const { status, body }: { status: number; body: any } = await get(
        `/processing/jobs?limit=50${beforeId ? `&beforeId=${beforeId}` : ""}`
      );
      assert.equal(status, 200);
      assert.ok(body.items.length <= 50);
      for (const item of body.items) {
        assert.equal(seen.has(item.id), false);
        seen.add(item.id);
      }
      beforeId = body.nextBeforeId;
      pages++;
    } while (beforeId !== null);
    assert.equal(seen.size, total);
    assert.equal(pages, Math.ceil(total / 50));
  });

  test("filtros por estado, outcome, pais e intervalo", async () => {
    const failed = await get("/processing/jobs?status=failed&outcome=http_4xx&limit=500");
    assert.ok(failed.body.items.length > 0);
    assert.ok(failed.body.items.every((j: any) => j.status === "failed" && j.lastOutcome === "http_4xx"));

    const brazil = await get("/processing/jobs?country=Brazil&limit=1");
    assert.equal(brazil.body.items[0].country, "Brazil");

    // Primera ventana en hora de la API (09:00-09:30 GMT-3).
    const ranged = await get(
      `/processing/jobs?limit=500&from=${encodeURIComponent("2026.10.14 09:00:00")}&to=${encodeURIComponent("2026.10.14 09:30:00")}`
    );
    assert.ok(ranged.body.items.length > 0);
    assert.ok(ranged.body.items.every((j: any) => new Date(j.edrDate) < new Date("2026-10-14T12:30:00Z")));
  });

  test("GET /processing/summary cuenta por estado", async () => {
    const { status, body } = await get("/processing/summary");
    assert.equal(status, 200);
    assert.ok(body.pending > 0);
    assert.ok(body.failed > 0);
    assert.ok(body.skippedByReason.sin_link > 0);
    assert.equal(body.outcomes.http_4xx, body.failed);
    assert.ok(body.worker);
  });

  test("GET /sync/runs pagina y GET /sync/runs/:id trae los trabajos por estado", async () => {
    const page1 = await get("/sync/runs?limit=2");
    assert.equal(page1.body.items.length, 2);
    assert.notEqual(page1.body.nextBeforeId, null);
    const page2 = await get(`/sync/runs?limit=2&beforeId=${page1.body.nextBeforeId}`);
    assert.equal(page2.body.items.length, 1);
    assert.equal(page2.body.nextBeforeId, null);

    const detail = await get(`/sync/runs/${page1.body.items[0].id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.jobsByStatus.pending > 0);
    assert.equal((await get("/sync/runs/999999")).status, 404);
  });

  test("GET /processing/jobs/:id devuelve el SMS y sus intentos", async () => {
    const list = await get("/processing/jobs?limit=1");
    const detail = await get(`/processing/jobs/${list.body.items[0].id}`);
    assert.equal(detail.status, 200);
    assert.ok(detail.body.sms.text);
    assert.ok(Array.isArray(detail.body.checks));
  });

  test("parametros invalidos responden 400", async () => {
    assert.equal((await get("/processing/jobs?limit=100000")).status, 400);
    assert.equal((await get("/processing/jobs?status=raro")).status, 400);
    assert.equal((await get("/processing/summary?from=ayer")).status, 400);
  });

  test("con ADMIN_TOKEN los endpoints piden Bearer (salvo /health)", async () => {
    config.adminToken = "token-test";
    try {
      assert.equal((await get("/processing/summary")).status, 401);
      assert.equal((await get("/processing/summary", { Authorization: "Bearer token-test" })).status, 200);
      assert.equal((await get("/health")).status, 200);
    } finally {
      config.adminToken = undefined;
    }
  });
});
