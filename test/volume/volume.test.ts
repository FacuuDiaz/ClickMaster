import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../../src/config";
import { pool } from "../../src/db/pool";
import { claimJobs } from "../../src/db/processingRepo";
import { ingestWindow } from "../../src/service/ingestService";
import type { EdrRange } from "../../src/fetcher/apiClient";
import { count, resetTables, rows, setupTestDb } from "../helpers/db";
import { syntheticSource } from "../helpers/fixtures";

/**
 * Prueba de volumen: una ventana de 30 min con ~20.000 SMS sinteticos
 * (como la API real, con un 10% sin link). Mide tiempo, consultas SQL
 * (contador Questions del servidor) y memoria de la ingesta, y verifica
 * deduplicacion y reclamo por lotes. Sin Playwright: eso se mide aparte.
 */
const T0 = new Date("2026-10-14T12:00:00Z");
const WINDOW = { start: T0, end: new Date(T0.getTime() + 30 * 60_000) };
const PER_MINUTE = 666; // 30 min x 666/min ~ 20.000

async function questions(): Promise<number> {
  const [r] = await rows("SHOW GLOBAL STATUS LIKE 'Questions'");
  return Number(r.Value);
}

function memorySampler() {
  let peakHeap = 0;
  let peakRss = 0;
  const sample = () => {
    const m = process.memoryUsage();
    peakHeap = Math.max(peakHeap, m.heapUsed);
    peakRss = Math.max(peakRss, m.rss);
  };
  sample();
  const timer = setInterval(sample, 20);
  return {
    stop() {
      clearInterval(timer);
      sample();
      return { peakHeapMb: Math.round(peakHeap / 1e6), peakRssMb: Math.round(peakRss / 1e6) };
    },
  };
}

before(async () => {
  await setupTestDb();
  await resetTables();
  config.ingest.dbBatchSize = 500;
  config.checker.clickPercentage = 100;
  config.edr.maxRowsPerRequest = 50_000;
});

after(() => pool.end());

test("ingesta de una ventana de ~20.000 SMS", async () => {
  const source = syntheticSource(PER_MINUTE, 10);
  // La "API" devuelve el JSON serializado y se parsea, como fetch: el
  // sampler de memoria ve el mismo patron que con la respuesta real.
  const fetcher = async (r: EdrRange) => JSON.parse(JSON.stringify(source(r))) as unknown[];
  const expected = source(WINDOW).length;
  assert.ok(expected >= 19_000, `registros sinteticos: ${expected}`);

  global.gc?.();
  const baseHeap = Math.round(process.memoryUsage().heapUsed / 1e6);
  const q0 = await questions();
  const mem = memorySampler();
  const t0 = Date.now();
  const run = await ingestWindow("manual", WINDOW, { fetcher });
  const ingestMs = Date.now() - t0;
  const memory = mem.stop();
  const sqlQueries = (await questions()) - q0;

  assert.equal(run.status, "success");
  assert.equal(run.recordsReceived, expected);
  assert.equal(await count("SELECT COUNT(*) FROM sms_content"), expected);
  assert.equal(await count("SELECT COUNT(*) FROM sms_processing"), expected);
  const pending = await count("SELECT COUNT(*) FROM sms_processing WHERE status='pending'");
  assert.equal(pending, run.jobsCreated);

  const batches = Math.ceil(expected / 500);
  // ~6 consultas de datos + transaccion + heartbeat por lote.
  assert.ok(sqlQueries < batches * 12, `consultas SQL: ${sqlQueries} para ${batches} lotes`);

  // Re-ingesta solapada (mitad de la ventana): nada nuevo.
  const q1 = await questions();
  const t1 = Date.now();
  const again = await ingestWindow(
    "manual",
    { start: new Date(T0.getTime() + 15 * 60_000), end: WINDOW.end },
    { fetcher }
  );
  const reingestMs = Date.now() - t1;
  const reingestQueries = (await questions()) - q1;
  assert.equal(again.smsNew, 0);
  assert.equal(again.jobsCreated, 0);
  assert.equal(await count("SELECT COUNT(*) FROM sms_content"), expected);

  // El worker reclama de a lotes chicos aunque haya 18.000 pendientes.
  const t2 = Date.now();
  const claimed = await claimJobs("volumen", 16, new Date(), 60_000);
  const claimMs = Date.now() - t2;
  assert.equal(claimed.length, 16);

  const report = {
    registros: expected,
    trabajosPendientes: pending,
    ingestaMs: ingestMs,
    registrosPorSegundo: Math.round(expected / (ingestMs / 1000)),
    consultasSql: sqlQueries,
    lotes: batches,
    heapBaseMb: baseHeap,
    heapPicoMb: memory.peakHeapMb,
    rssPicoMb: memory.peakRssMb,
    reingestaSolapadaMs: reingestMs,
    reingestaConsultasSql: reingestQueries,
    reclamo16Ms: claimMs,
  };
  console.log(`\nRESULTADO VOLUMEN ${JSON.stringify(report, null, 2)}`);
});
