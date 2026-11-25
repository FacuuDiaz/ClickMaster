import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../../src/config";
import { pool } from "../../src/db/pool";
import { reportsPool } from "../../src/db/reportsPool";
import { createApp } from "../../src/http/app";
import { ingestWindow } from "../../src/service/ingestService";
import { createPolicy, policiesCache } from "../../src/policies/repo";
import { policyInputSchema } from "../../src/policies/schema";
import { keyOf, lastFullWeek, refDayFor } from "../../src/policies/referenceWeek";
import { count, resetTables, rows, setupTestDb } from "../helpers/db";
import { rawRecord } from "../helpers/fixtures";

const actor = { name: "tester", ip: null };
// Lunes 2026-11-16 12:00Z = 09:00 en GMT-3. Semana de referencia: lun 02/11 a dom 08/11.
const T0 = new Date("2026-11-16T12:00:00Z");
const WEEK = "2026-11-02";
let seq = 0;
let savedWindow = 0;

function sms(n: number, at: Date, withLink = true) {
  return Array.from({ length: n }, (_, i) =>
    rawRecord(++seq, new Date(at.getTime() + i * 1000), withLink ? {} : { text: `Hola ${seq}, sin enlace` })
  );
}

async function ingest(data: unknown[], windowStart: Date, now: Date) {
  return ingestWindow("manual", { start: windowStart, end: new Date(windowStart.getTime() + 3_600_000) }, { fetcher: async () => [...data], now: () => now });
}

async function referencePolicy(percentage: number, enabled = true) {
  return (
    await createPolicy(
      policyInputSchema.parse({
        enabled,
        name: "semana",
        rules: { selection: { percentage, base: "semana_referencia", weekStart: WEEK, strategy: "intercalado" } },
      }),
      actor
    )
  ).id;
}

// REST API falsa: la hora 9 vale 100 el lunes 02/11 y 10 el resto de los dias.
let restRequests: string[] = [];
let rest: Server;
let app: Server;
let base = "";

before(async () => {
  await setupTestDb();
  rest = http.createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://x");
    restRequests.push(url.searchParams.get("start_date") ?? "");
    const day = url.searchParams.get("start_date") as string;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify([
        { dcheck: `${day} 09:00:00`, country: "Brazil", net_name: "Vivo", count_ok: day === "2026.11.02" ? 100 : 10, is_total: 0 },
        { country: "Total", net_name: "Total", count_ok: 0, is_total: 1 },
      ])
    );
  });
  await new Promise<void>((resolve) => rest.listen(0, "127.0.0.1", resolve));
  app = createApp().listen(0);
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  savedWindow = config.scheduler.windowMinutes;
});

beforeEach(async () => {
  await resetTables();
  await policiesCache.refresh();
  config.checker.clickPercentage = 0;
  config.scheduler.windowMinutes = 60;
  config.alarisRest.url = `http://127.0.0.1:${(rest.address() as AddressInfo).port}/rest`;
  config.alarisRest.auth = Buffer.from("usuario:clave").toString("base64");
  config.alarisRest.productId = "837";
  restRequests = [];
});

after(async () => {
  config.scheduler.windowMinutes = savedWindow;
  rest.close();
  app.close();
  await pool.end();
  await reportsPool.end();
});

async function httpJson(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Actor": "tester" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("base semana de referencia", () => {
  test("mismo dia de la semana: el martes usa el martes de la semana de referencia", () => {
    assert.equal(keyOf(refDayFor(T0, WEEK)), "2026-11-02");
    assert.equal(keyOf(refDayFor(new Date("2026-11-17T12:00:00Z"), WEEK)), "2026-11-03");
    assert.equal(keyOf(refDayFor(new Date("2026-11-22T12:00:00Z"), WEEK)), "2026-11-08");
    // Miercoles 25/11 -> la ultima semana completa empieza el lunes 16.
    assert.equal(lastFullWeek(new Date("2026-11-25T15:00:00Z")), "2026-11-16");
  });

  test("solo guarda los elegidos; los demas quedan en los contadores por minuto", async () => {
    const id = await referencePolicy(10);
    // 09:00-10:00: 10 con link + 10 sin link -> proporcion 50 %.
    // Referencia: lunes 02/11 hasta las 10:00 = 100. Objetivo 10 % x 100 x 50 % = 5.
    const data = [...sms(10, T0), ...sms(10, T0, false)];
    const run = await ingest(data, T0, T0);
    assert.equal(run.status, "success");
    assert.equal(run.jobsCreated, 5);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing"), 5);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE policy_id = ? AND status = 'pending'", [id]), 5);
    assert.equal(await count("SELECT COUNT(*) FROM sms_content"), 5);
    const [c] = await rows("SELECT SUM(total) AS total, SUM(with_link) AS link, SUM(matched) AS matched FROM ingest_minute_counts");
    assert.deepEqual([Number(c.total), Number(c.link), Number(c.matched)], [20, 10, 10]);
    // Se pidio solo el dia de referencia de hoy.
    assert.deepEqual(restRequests, ["2026.11.02"]);

    // Reintentar la ventana no elige de mas ni duplica contadores.
    await ingest(data, T0, T0);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing"), 5);
    assert.equal(await count("SELECT COUNT(*) FROM sms_content"), 5);
    const [c2] = await rows("SELECT SUM(total) AS total FROM ingest_minute_counts");
    assert.equal(Number(c2.total), 20);
  });

  test("con otra politica activa se guarda todo, como siempre, y tambien se cuenta", async () => {
    await createPolicy(policyInputSchema.parse({ enabled: true, name: "ventana", rules: { selection: { percentage: 50 } } }), actor);
    await ingest([...sms(10, T0), ...sms(4, T0, false)], T0, T0);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing"), 14);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status = 'pending'"), 5);
    assert.equal(await count("SELECT COALESCE(SUM(total), 0) FROM ingest_minute_counts"), 14);
  });

  test("rutas: semana sin cerrar -> 400; activar pone la ventana en 60; serie de la semana y volver a bajar", async () => {
    config.scheduler.windowMinutes = 30;
    const bad = await httpJson("POST", "/admin/policies", {
      name: "futura",
      rules: { selection: { percentage: 10, base: "semana_referencia", weekStart: lastFullWeek(new Date(Date.now() + 7 * 86_400_000)) } },
    });
    assert.equal(bad.status, 400);
    const missing = await httpJson("POST", "/admin/policies", { name: "sin fecha", rules: { selection: { base: "semana_referencia" } } });
    assert.equal(missing.status, 400);

    const id = await referencePolicy(10, false);
    const act = await httpJson("POST", "/admin/policies/active", { id });
    assert.equal(act.status, 200);
    assert.equal(act.body.windowChanged, true);
    assert.equal(config.scheduler.windowMinutes, 60);
    assert.equal(await count("SELECT COUNT(*) FROM config_audit WHERE entity = 'setting' AND ref = 'scheduler.windowMinutes'"), 1);

    const refreshed = await httpJson("POST", `/admin/policies/${id}/week/refresh`);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.daysWithData, 7);

    const week = await httpJson("GET", `/admin/policies/${id}/week`);
    assert.equal(week.status, 200);
    assert.equal(week.body.days.length, 7);
    assert.deepEqual(week.body.days.map((d: any) => d.source), Array(7).fill("alaris"));
    assert.equal(week.body.days[0].hourly[9], 100);
    assert.equal(week.body.total, 160);

    const notRef = await httpJson("GET", "/admin/policies/999/week");
    assert.equal(notRef.status, 404);
  });
});
