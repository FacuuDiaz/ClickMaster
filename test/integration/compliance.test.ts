import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../../src/config";
import { pool } from "../../src/db/pool";
import { reportsPool } from "../../src/db/reportsPool";
import { createApp } from "../../src/http/app";
import { clearDashboardCache } from "../../src/http/dashboardRoutes";
import { ingestWindow } from "../../src/service/ingestService";
import { createPolicy, policiesCache } from "../../src/policies/repo";
import { policyInputSchema } from "../../src/policies/schema";
import { dayCompliance, dayRange } from "../../src/policies/compliance";
import { count, resetTables, rows, setupTestDb } from "../helpers/db";
import { ensureSchema } from "../../src/db/schema";
import { rawRecord } from "../helpers/fixtures";

const actor = { name: "tester", ip: null };
// Lunes 2026-11-16 09:00 en GMT-3.
const T0 = new Date("2026-11-16T12:00:00Z");
const DAY = "2026-11-16";
let server: Server;
let base: string;
let seq = 0;

const sms = (n: number, at: Date) => Array.from({ length: n }, (_, i) => rawRecord(++seq, new Date(at.getTime() + i * 1000), { client: "A" }));
const policy = (raw: Record<string, unknown>) => createPolicy(policyInputSchema.parse({ enabled: true, ...raw }), actor);
const ingest = (data: unknown[], at: Date) =>
  ingestWindow("manual", { start: at, end: new Date(at.getTime() + 1800_000) }, { fetcher: async () => [...data], now: () => at });

before(async () => {
  await setupTestDb();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await resetTables();
  await policiesCache.refresh();
  clearDashboardCache();
  config.checker.clickPercentage = 0;
});

after(async () => {
  server.close();
  await pool.end();
  await reportsPool.end();
});

describe("cumplimiento de politicas", () => {
  test("ventana: objetivo = % de los SMS del dia; cumplimiento = SMS con 200", async () => {
    const { id } = await policy({ name: "20%", rules: { selection: { percentage: 20, strategy: "primeros" } } });
    await ingest(sms(10, T0), T0);
    // De los 2 elegidos: uno con 200, el otro visitado sin 200.
    const chosen = (await rows("SELECT id FROM sms_processing WHERE status = 'pending' ORDER BY edr_date")).map((r) => Number(r.id));
    await pool.query("UPDATE sms_processing SET status = 'success', clicks = 1 WHERE id = ?", [chosen[0]]);
    await pool.query("UPDATE sms_processing SET status = 'failed', clicks = 0 WHERE id = ?", [chosen[1]]);

    const day = await dayCompliance(DAY, new Date(T0.getTime() + 3600_000), { visits: 0 });
    assert.equal(day.isToday, true);
    const p = day.policies.find((x) => x.policyId === id);
    assert.ok(p);
    assert.equal(p.base, "ventana");
    assert.equal(p.baseCount, 10);
    assert.equal(p.target, 2);
    assert.equal(p.stats.selected, 2);
    assert.equal(p.stats.clickedSms, 1);
    assert.equal(p.stats.no200, 1);
    assert.equal(p.compliance, 0.5);
    assert.equal(p.state, "en_curso");
  });

  test("dia vencido: espera el cierre y tiene hasta el fin del dia siguiente", async () => {
    await policy({ name: "vencido", rules: { selection: { percentage: 50, base: "dia_vencido" } } });
    await ingest(sms(4, T0), T0);
    const range = dayRange(DAY);
    const today = await dayCompliance(DAY, T0, { visits: 0 });
    assert.equal(today.policies[0].state, "esperando_cierre");
    assert.equal(today.policies[0].target, 2);
    assert.equal(today.policies[0].stats.held, 4);
    assert.equal(new Date(today.policies[0].deadline).getTime(), range.end.getTime() + 86_400_000);
  });

  test("semana anterior: el objetivo sale del mismo dia de la semana pasada", async () => {
    await policy({ name: "semanal", rules: { selection: { percentage: 50, base: "semana_anterior" } } });
    const lastWeek = new Date(T0.getTime() - 7 * 86_400_000);
    await ingest(sms(20, lastWeek), lastWeek);
    await ingest(sms(6, T0), T0);
    const day = await dayCompliance(DAY, T0, { visits: 0 });
    assert.equal(day.policies[0].baseCount, 20);
    assert.equal(day.policies[0].target, 10);
  });

  test("proyeccion: avisa si al ritmo actual la cola no termina antes del cierre", async () => {
    await policy({ name: "todo", rules: { selection: { percentage: 100 } } });
    await ingest(sms(30, T0), T0);
    // 23:30 del mismo dia: queda media hora, 30 en cola a 10 visitas/h -> 3 h.
    const late = new Date("2026-11-17T02:30:00Z");
    const slow = await dayCompliance(DAY, late, { visits: 10 });
    assert.equal(slow.policies[0].projection?.onTrack, false);
    assert.equal(slow.policies[0].projection?.hoursNeeded, 3);
    const fast = await dayCompliance(DAY, late, { visits: 1000 });
    assert.equal(fast.policies[0].projection?.onTrack, true);
  });

  test("migracion: clicks y selected_at se completan desde los datos anteriores", async () => {
    await policy({ name: "todo", rules: { selection: { percentage: 100 } } });
    await ingest(sms(2, T0), T0);
    const [a, b] = (await rows("SELECT id, sms_content_id FROM sms_processing ORDER BY id")).map((r) => r);
    // Visitas de antes de la migracion: a tuvo un 500 y despues un 200; b un timeout.
    await pool.query(
      `INSERT INTO sms_link_checks (sms_content_id, link, checked_at, http_status, is_ok, response_time_ms, outcome, attempt, processing_id) VALUES ?`,
      [[
        [a.sms_content_id, "https://x", T0, 500, 0, 10, "http_5xx", 1, a.id],
        [a.sms_content_id, "https://x", T0, 200, 1, 10, "cargada", 2, a.id],
        [b.sms_content_id, "https://x", T0, null, 0, 10, "timeout", 1, b.id],
      ]]
    );
    // Como estaba la tabla antes de esta version.
    await pool.query("ALTER TABLE sms_processing DROP INDEX idx_policy_selected");
    await pool.query("ALTER TABLE sms_processing DROP COLUMN clicks, DROP COLUMN selected_at");
    await ensureSchema();
    assert.deepEqual((await rows("SELECT clicks FROM sms_processing ORDER BY id")).map((r) => Number(r.clicks)), [1, 0]);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status <> 'skipped' AND selected_at = created_at"), 2);
  });

  test("rutas: por dia y avance por hora", async () => {
    const { id } = await policy({ name: "20%", rules: { selection: { percentage: 20, strategy: "primeros" } } });
    await ingest(sms(10, T0), T0);
    const res = await fetch(`${base}/dashboard/compliance?days=3`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.days.length, 3);
    assert.ok(typeof body.ratePerHour.visits === "number");

    const hourly = await fetch(`${base}/dashboard/compliance/hourly?day=${DAY}&policy=${id}`);
    assert.equal(hourly.status, 200);
    const h = (await hourly.json()) as any;
    assert.equal(h.buckets.length, 24);
    assert.equal(h.target, 2);
    // Se eligieron a las 09:00 (hora 9 desde las 00:00 de Alaris).
    assert.equal(h.buckets[9].selected, 2);
    assert.equal((await fetch(`${base}/dashboard/compliance/hourly?day=16-11-2026&policy=${id}`)).status, 400);
  });
});
