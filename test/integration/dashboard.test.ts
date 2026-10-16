import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RowDataPacket } from "mysql2";
import { pool } from "../../src/db/pool";
import { reportsPool } from "../../src/db/reportsPool";
import { bucketSeconds } from "../../src/db/dashboardRepo";
import { createApp } from "../../src/http/app";
import { clearDashboardCache } from "../../src/http/dashboardRoutes";
import { ingestWindow } from "../../src/service/ingestService";
import { config } from "../../src/config";
import { resetTables, rows, setupTestDb } from "../helpers/db";
import { rawRecord } from "../helpers/fixtures";

let server: Server;
let base: string;
const T0 = new Date("2026-10-14T12:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const iso = (d: Date) => encodeURIComponent(d.toISOString());
const range = (a: number, b: number) => `from=${iso(at(a))}&to=${iso(at(b))}`;

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as any };
}

// Intentos conocidos: por cada minuto 0..29, 3 cargadas, 1 404 y 1 timeout.
const OUTCOMES = ["cargada", "cargada", "cargada", "http_4xx", "timeout"];

before(async () => {
  await setupTestDb();
  await resetTables();
  config.checker.clickPercentage = 100;
  // 60 SMS que entran a la cola en T0+5 min (created_at = now de la ingesta).
  const data = Array.from({ length: 60 }, (_, i) => rawRecord(i + 1, at(0)));
  await ingestWindow("manual", { start: at(-30), end: at(0) }, { fetcher: async () => data, now: () => at(5) });

  const values: unknown[][] = [];
  for (let min = 0; min < 30; min++) {
    OUTCOMES.forEach((outcome, k) => {
      values.push([1, "https://x.test/" + k, new Date(at(min).getTime() + k * 1000), 200, outcome === "cargada" ? 1 : 0, outcome === "cargada" ? 100 : 15000, outcome, 1]);
    });
  }
  await pool.query(
    `INSERT INTO sms_link_checks (sms_content_id, link, checked_at, http_status, is_ok, response_time_ms, outcome, attempt) VALUES ?`,
    [values]
  );
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.close();
  await pool.end();
  await reportsPool.end();
});

describe("dashboard", () => {
  test("elige intervalos para no pasar de 60 columnas", () => {
    assert.equal(bucketSeconds(at(0), at(30)), 60);
    assert.equal(bucketSeconds(at(0), at(24 * 60)), 1800);
    assert.equal(bucketSeconds(at(0), at(7 * 24 * 60)), 3 * 3600);
  });

  test("series por intervalo, completadas con ceros, y totales que cierran", async () => {
    clearDashboardCache();
    const { status, body } = await get(`/dashboard/data?${range(0, 60)}`);
    assert.equal(status, 200);
    assert.equal(body.range.stepSeconds, 60);
    assert.equal(body.series.checks.length, 60);
    assert.deepEqual(
      { cargada: body.series.checks[0].cargada, sitio: body.series.checks[0].sitio, tecnico: body.series.checks[0].tecnico },
      { cargada: 3, sitio: 1, tecnico: 1 }
    );
    assert.equal(body.series.checks[45].total, 0, "sin datos = 0, no falta el bucket");
    assert.equal(body.totals.checks, 150);
    assert.equal(body.totals.cargada, 90);
    assert.equal(body.totals.successRate, 0.6);
    // El promedio de carga ignora los timeouts.
    assert.equal(body.totals.avgLoadMs, 100);
    assert.equal(body.totals.sms, 60);
    assert.equal(body.series.ingest[5].sms, 60);
    assert.equal(body.queue.pending, 60);
    assert.equal(body.lastRun.status, "success");
  });

  test("las respuestas se cachean: datos nuevos aparecen recien al vencer la cache", async () => {
    clearDashboardCache();
    const first = await get(`/dashboard/data?${range(0, 60)}`);
    await pool.query(
      `INSERT INTO sms_link_checks (sms_content_id, link, checked_at, is_ok, outcome) VALUES (1, 'x', ?, 1, 'cargada')`,
      [at(1)]
    );
    const cachedResp = await get(`/dashboard/data?${range(0, 60)}`);
    assert.equal(cachedResp.body.totals.checks, first.body.totals.checks);
    clearDashboardCache();
    const fresh = await get(`/dashboard/data?${range(0, 60)}`);
    assert.equal(fresh.body.totals.checks, first.body.totals.checks + 1);
    await pool.query(`DELETE FROM sms_link_checks WHERE link = 'x'`);
    clearDashboardCache();
  });

  test("listado de links paginado por cursor, sin repetir ni saltear", async () => {
    const seen = new Set<number>();
    let cursor: string | null = null;
    let previous = Infinity;
    let pages = 0;
    do {
      const { body }: { body: any } = await get(`/dashboard/checks?${range(0, 60)}&limit=40${cursor ? `&cursor=${cursor}` : ""}`);
      for (const item of body.items) {
        assert.equal(seen.has(item.id), false);
        seen.add(item.id);
        const t = new Date(item.checkedAt).getTime();
        assert.ok(t <= previous, "mas recientes primero");
        previous = t;
      }
      cursor = body.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(seen.size, 150);
    assert.equal(pages, 4);
  });

  test("filtro por grupo de resultado", async () => {
    const { body } = await get(`/dashboard/checks?${range(0, 60)}&group=tecnico&limit=100`);
    assert.equal(body.items.length, 30);
    assert.ok(body.items.every((i: any) => i.outcome === "timeout"));
  });

  test("listado de SMS paginado y filtrado por estado", async () => {
    const page1 = await get(`/dashboard/sms?${range(0, 60)}&limit=25`);
    assert.equal(page1.body.items.length, 25);
    assert.ok(page1.body.items[0].text);
    const page2 = await get(`/dashboard/sms?${range(0, 60)}&limit=25&cursor=${page1.body.nextCursor}`);
    const page3 = await get(`/dashboard/sms?${range(0, 60)}&limit=25&cursor=${page2.body.nextCursor}`);
    assert.equal(page3.body.items.length, 10);
    assert.equal(page3.body.nextCursor, null);
    const ids = [...page1.body.items, ...page2.body.items, ...page3.body.items].map((i: any) => i.id);
    assert.equal(new Set(ids).size, 60);
    const failed = await get(`/dashboard/sms?${range(0, 60)}&status=failed`);
    assert.equal(failed.body.items.length, 0);
  });

  test("valida el rango: invertido, demasiado largo o cursor invalido", async () => {
    assert.equal((await get(`/dashboard/data?${range(60, 0)}`)).status, 400);
    assert.equal((await get(`/dashboard/data?from=${iso(at(0))}&to=${iso(at(60 * 24 * 40))}`)).status, 400);
    assert.equal((await get(`/dashboard/checks?${range(0, 60)}&cursor=abc`)).status, 400);
    assert.equal((await get(`/dashboard/data?preset=30m`)).status, 200);
  });

  test("la pagina se sirve sin token aunque los datos lo pidan", async () => {
    config.adminToken = "token-test";
    try {
      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /ClickMaster/);
      assert.equal((await fetch(`${base}/dashboard.js`)).status, 200);
      assert.equal((await get(`/dashboard/data?preset=30m`)).status, 401);
    } finally {
      config.adminToken = undefined;
    }
  });
});

describe("aislamiento del dashboard", () => {
  test("el pool de reportes es de solo lectura y tiene timeout por consulta", async () => {
    const [[session]] = await reportsPool.query<RowDataPacket[]>(
      "SELECT @@SESSION.MAX_EXECUTION_TIME AS timeout_ms, @@SESSION.transaction_read_only AS read_only, @@SESSION.transaction_isolation AS iso"
    );
    assert.equal(Number(session.timeout_ms), config.reports.queryTimeoutMs);
    assert.equal(Number(session.read_only), 1);
    assert.equal(session.iso, "READ-COMMITTED");
    await assert.rejects(
      reportsPool.query("INSERT INTO sync_runs (kind, window_start, window_end, query_start, status, started_at) VALUES ('manual', NOW(), NOW(), NOW(), 'running', NOW())"),
      /READ ONLY/i
    );
  });

  test("una consulta que se pasa del timeout la corta MySQL", async () => {
    // SLEEP() no sirve: interrumpido devuelve 1 sin error. Un cross join enorme si.
    const heavy = `SELECT /*+ MAX_EXECUTION_TIME(300) */ COUNT(*)
                     FROM information_schema.COLUMNS a, information_schema.COLUMNS b, information_schema.COLUMNS c`;
    await assert.rejects(reportsPool.query(heavy), (err: any) => {
      assert.equal(err.errno, 3024);
      return true;
    });
  });

  test("tiene su propio limite de conexiones, aparte del pool de la app", () => {
    assert.equal((reportsPool.pool.config as any).connectionLimit, config.reports.dbConnectionLimit);
    assert.notEqual(reportsPool.pool, pool.pool);
  });

  test("los graficos leen solo indices (no tocan las filas)", async () => {
    const [plan] = await rows(
      `EXPLAIN SELECT FLOOR(UNIX_TIMESTAMP(checked_at) / 60) * 60 AS b, SUM(outcome = 'cargada'), COUNT(*),
              SUM(IF(outcome = 'cargada', response_time_ms, 0))
         FROM sms_link_checks FORCE INDEX (idx_checked_outcome)
        WHERE checked_at >= ? AND checked_at < ? GROUP BY b`,
      [at(0), at(60)]
    );
    assert.equal(plan.key, "idx_checked_outcome");
    assert.match(plan.Extra, /Using index/);
    const [plan2] = await rows(
      `EXPLAIN SELECT FLOOR(UNIX_TIMESTAMP(created_at) / 60) * 60 AS b, COUNT(*)
         FROM sms_processing FORCE INDEX (idx_created_at)
        WHERE created_at >= ? AND created_at < ? GROUP BY b`,
      [at(0), at(60)]
    );
    assert.match(plan2.Extra, /Using index/);
  });
});
