import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../../src/config";
import { pool } from "../../src/db/pool";
import { reportsPool } from "../../src/db/reportsPool";
import { ingestWindow } from "../../src/service/ingestService";
import { createPolicy, policiesCache } from "../../src/policies/repo";
import { policyInputSchema } from "../../src/policies/schema";
import { dayCompliance } from "../../src/policies/compliance";
import { count, resetTables, rows, setupTestDb } from "../helpers/db";
import { rawRecord } from "../helpers/fixtures";

const actor = { name: "tester", ip: null };
// Lunes 2026-11-16 12:00Z = 09:00 en GMT-3. Ayer = domingo 15.
const T0 = new Date("2026-11-16T12:00:00Z");
const DAY = 86_400_000;
let seq = 0;

function sms(n: number, at: Date, withLink = true) {
  return Array.from({ length: n }, (_, i) =>
    rawRecord(++seq, new Date(at.getTime() + i * 1000), withLink ? {} : { text: `Hola ${seq}, sin enlace` })
  );
}

async function ingest(data: unknown[], windowStart: Date, now: Date) {
  return ingestWindow("manual", { start: windowStart, end: new Date(windowStart.getTime() + 1800_000) }, { fetcher: async () => [...data], now: () => now });
}

const pendingToday = (id: number) =>
  count("SELECT COUNT(*) FROM sms_processing WHERE policy_id = ? AND status = 'pending' AND edr_date >= ?", [id, T0]);

async function previousDayPolicy(percentage: number) {
  return (
    await createPolicy(
      policyInputSchema.parse({ enabled: true, name: "dia anterior", rules: { selection: { percentage, base: "dia_anterior", strategy: "intercalado" } } }),
      actor
    )
  ).id;
}

// REST API de Alaris falsa: sms_usage_stats con cubos horarios.
let restStatus = 200;
let restBody: unknown = [];
let restRequests: { url: string; auth: string | undefined }[] = [];
let rest: Server;

before(async () => {
  await setupTestDb();
  rest = http.createServer((req, res) => {
    restRequests.push({ url: req.url ?? "", auth: req.headers.authorization });
    res.writeHead(restStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify(restBody));
  });
  await new Promise<void>((resolve) => rest.listen(0, "127.0.0.1", resolve));
});

beforeEach(async () => {
  await resetTables();
  await policiesCache.refresh();
  config.checker.clickPercentage = 0;
  config.alarisRest.url = undefined;
  config.alarisRest.auth = undefined;
  config.alarisRest.productId = undefined;
  config.edr.country = undefined;
  restStatus = 200;
  restBody = [];
  restRequests = [];
});

after(async () => {
  rest.close();
  await pool.end();
  await reportsPool.end();
});

function useRest() {
  config.alarisRest.url = `http://127.0.0.1:${(rest.address() as AddressInfo).port}/rest/`;
  config.alarisRest.auth = Buffer.from("usuario:clave").toString("base64");
  config.alarisRest.productId = "1286";
}

describe("base dia anterior", () => {
  test("sin REST API: copia la curva horaria de lo ingerido ayer, escalada por la proporcion con link", async () => {
    // Ayer 09:00: 40 SMS ingeridos (20 con link). Sin politica todavia.
    const yesterday = new Date(T0.getTime() - DAY);
    await ingest([...sms(20, yesterday), ...sms(20, yesterday, false)], yesterday, yesterday);

    const id = await previousDayPolicy(20);
    // Hoy 09:00-09:30: 10 con link + 10 sin link -> proporcion 50 %.
    // Ayer hasta las 09:30: la hora 9 se prorratea (los datos son por hora)
    // -> 20. Objetivo: 20 % x 20 x 50 % = 2.
    await ingest([...sms(10, T0), ...sms(10, T0, false)], T0, T0);
    assert.equal(await pendingToday(id), 2);

    // 15:00: 10 mas con link -> proporcion 20/30; ayer hasta las 15:30 = 40:
    // objetivo 20 % x 40 x 2/3 = 5.3 -> 5, ya hay 2 -> 3 mas.
    const later = new Date(T0.getTime() + 6 * 3600_000);
    await ingest(sms(10, later), later, later);
    assert.equal(await pendingToday(id), 5);
  });

  test("con REST API: pide sms_usage_stats una vez, suma count_ok por hora y descarta Total y otros dias", async () => {
    useRest();
    config.edr.country = "Brazil";
    restBody = [
      { dcheck: "2026.11.15 09:00:00", country: "Brazil", net_name: "Claro", count_total: 90, count_ok: 60, is_total: 0 },
      { dcheck: "2026.11.15 09:00:00", country: "Brazil", net_name: "Vivo", count_total: 50, count_ok: 40, is_total: 0 },
      { dcheck: "2026.11.15 20:00:00", country: "Brazil", net_name: "Vivo", count_total: 999, count_ok: 500, is_total: 0 },
      { dcheck: "2026.11.16 09:00:00", country: "Brazil", net_name: "Vivo", count_total: 999, count_ok: 999, is_total: 0 },
      { country: "Total", net_name: "Total", count_total: 2137, count_ok: 1599, is_total: 1 },
    ];
    const id = await previousDayPolicy(20);
    // Proporcion 50 %; ayer hasta las 09:30 = media hora 9 = 50 (las 20:00 no
    // cuentan todavia). Objetivo 20 % x 50 x 50 % = 5.
    await ingest([...sms(10, T0), ...sms(10, T0, false)], T0, T0);
    assert.equal(await pendingToday(id), 5);

    assert.equal(restRequests.length, 1);
    const url = new URL(restRequests[0].url, "http://x");
    assert.equal(url.pathname, "/rest/sms_usage_stats");
    assert.equal(url.searchParams.get("start_date"), "2026.11.15");
    assert.equal(url.searchParams.get("end_date"), "2026.11.16");
    assert.equal(url.searchParams.get("product_id"), "1286");
    assert.equal(url.searchParams.get("use_hourly_data"), "1");
    assert.equal(url.searchParams.get("filter"), "Brazil");
    assert.equal(restRequests[0].auth, `Basic ${Buffer.from("usuario:clave").toString("base64")}`);

    const [stored] = await rows("SELECT status, total_ok FROM alaris_usage_days WHERE product_id = '1286' AND day = '2026-11-15'");
    assert.equal(stored.status, "ok");
    assert.equal(Number(stored.total_ok), 600);

    // La ventana siguiente usa lo guardado: no vuelve a pedir.
    const next = new Date(T0.getTime() + 1800_000);
    await ingest(sms(2, next), next, next);
    assert.equal(restRequests.length, 1);

    // Cumplimiento: objetivo del dia = 20 % x 600 (ayer entero) x proporcion
    // del dia (12 con link de 22 ingeridos).
    const day = await dayCompliance("2026-11-16", next, { visits: 0 });
    const row = day.policies.find((p) => p.policyId === id);
    assert.ok(row);
    assert.equal(row.base, "dia_anterior");
    assert.equal(row.baseCount, 600);
    assert.equal(row.target, Math.round(0.2 * 600 * (12 / 22)));
  });

  test("si la REST API falla usa el conteo local y lo anota para reintentar", async () => {
    useRest();
    restStatus = 500;
    restBody = { error: "boom" };
    const yesterday = new Date(T0.getTime() - DAY);
    await ingest(sms(40, yesterday), yesterday, yesterday);

    const id = await previousDayPolicy(25);
    // Local: 40 ayer a las 09, hasta las 09:30 = 20; proporcion 100 %
    // -> 25 % x 20 = 5.
    await ingest(sms(20, T0), T0, T0);
    assert.equal(await pendingToday(id), 5);
    const [stored] = await rows("SELECT status, error FROM alaris_usage_days");
    assert.equal(stored.status, "error");
    assert.match(String(stored.error), /HTTP 500/);

    // Antes de 15 minutos no se vuelve a pedir.
    const requests = restRequests.length;
    const soon = new Date(T0.getTime() + 5 * 60_000);
    await ingest(sms(1, soon), soon, soon);
    assert.equal(restRequests.length, requests);
  });
});
