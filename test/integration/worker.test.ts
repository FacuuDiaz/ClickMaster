import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../../src/config";
import { pool } from "../../src/db/pool";
import { ProcessingWorker, type WorkerDeps } from "../../src/worker/processingWorker";
import type { VisitResult } from "../../src/checker/linkChecker";
import type { VisitOutcome } from "../../src/checker/classifyVisit";
import { ingestWindow } from "../../src/service/ingestService";
import { claimJobs } from "../../src/db/processingRepo";
import { count, resetTables, rows, setupTestDb } from "../helpers/db";
import { rawRecord } from "../helpers/fixtures";

const T0 = new Date("2026-10-14T12:00:00Z");

function visit(outcome: VisitOutcome, httpStatus: number | null = 200): VisitResult {
  return {
    httpStatus,
    ok: outcome === "cargada",
    outcome,
    responseTimeMs: 5,
    finalUrl: null,
    redirects: 0,
    errorMessage: outcome === "cargada" ? null : outcome,
  };
}

// SMS con links cuyo path dice como tiene que salir la visita en el fake.
async function seed(paths: string[]): Promise<void> {
  config.checker.clickPercentage = 100;
  const data = paths.map((p, i) => rawRecord(i + 1, new Date(T0.getTime() + i * 1000), { text: `Hola https://test.local/${p}` }));
  await ingestWindow("manual", { start: T0, end: new Date(T0.getTime() + 3600_000) }, { fetcher: async () => data });
}

const fastSettings: WorkerDeps["settings"] = {
  concurrency: 3,
  claimBatchSize: 4,
  pollIntervalMs: 50,
  leaseMs: 60_000,
  maxAttempts: 3,
  retryBaseDelayMs: 0,
  browserIdleCloseMs: 60_000,
  recoveryIntervalMs: 60_000,
};

async function until(fn: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error("timeout esperando la condicion");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const unfinished = () =>
  count("SELECT COUNT(*) FROM sms_processing WHERE status IN ('pending','retry','processing')");

before(setupTestDb);
after(() => pool.end());
beforeEach(resetTables);

describe("worker de verificacion", () => {
  test("drena la cola respetando la concurrencia y el resultado de cada visita", async () => {
    await seed(["ok", "ok", "ok", "ok", "ok", "404", "ok", "ok", "ok", "ok"]);
    let active = 0;
    let maxActive = 0;
    const worker = new ProcessingWorker({
      settings: fastSettings,
      visit: async (url) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 30));
        active--;
        return url.endsWith("/404") ? visit("http_4xx", 404) : visit("cargada");
      },
    });
    await worker.start();
    await until(async () => (await unfinished()) === 0);
    await worker.stop();

    assert.ok(maxActive <= 3, `maximo en paralelo ${maxActive}`);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status='success'"), 9);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status='failed' AND last_outcome='http_4xx'"), 1);
    assert.equal(await count("SELECT COUNT(*) FROM sms_link_checks"), 10);
  });

  test("reintenta los errores transitorios hasta el maximo de intentos", async () => {
    await seed(["timeout", "flaky"]);
    const calls = new Map<string, number>();
    const worker = new ProcessingWorker({
      settings: fastSettings,
      visit: async (url) => {
        const n = (calls.get(url) ?? 0) + 1;
        calls.set(url, n);
        if (url.endsWith("/timeout")) return visit("timeout", null);
        return n < 2 ? visit("http_5xx", 503) : visit("cargada");
      },
    });
    await worker.start();
    await until(async () => (await unfinished()) === 0);
    await worker.stop();

    const jobs = await rows("SELECT status, attempts, last_outcome FROM sms_processing ORDER BY id");
    assert.deepEqual(
      jobs.map((j) => [j.status, j.attempts, j.last_outcome]),
      [
        ["failed", 3, "timeout"],
        ["success", 2, "cargada"],
      ]
    );
    assert.equal(await count("SELECT COUNT(*) FROM sms_link_checks"), 5);
  });

  test("guarda cada resultado apenas termina, sin esperar a las otras visitas", async () => {
    await seed(["rapida", "lenta"]);
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    const worker = new ProcessingWorker({
      settings: fastSettings,
      visit: async (url) => {
        if (url.endsWith("/lenta")) await slowGate;
        return visit("cargada");
      },
    });
    await worker.start();
    await until(async () => (await count("SELECT COUNT(*) FROM sms_processing WHERE status='success'")) === 1);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status='processing'"), 1);
    releaseSlow();
    await until(async () => (await unfinished()) === 0);
    await worker.stop();
  });

  test("pausa (clicks manuales): devuelve el buffer, espera las visitas abiertas y no reclama mas", async () => {
    await seed(Array.from({ length: 12 }, () => "ok"));
    let releaseVisits!: () => void;
    const gate = new Promise<void>((r) => (releaseVisits = r));
    let started = 0;
    const worker = new ProcessingWorker({
      settings: fastSettings,
      visit: async () => {
        started++;
        await gate;
        return visit("cargada");
      },
    });
    await worker.start();
    await until(async () => started === 3);
    // 3 visitas abiertas + 1 en el buffer (lote de 4).
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status='processing'"), 4);

    let paused = false;
    const pausing = worker.pause("test").then(() => (paused = true));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(paused, false, "espera a las visitas abiertas");
    releaseVisits();
    await pausing;

    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status='processing'"), 0);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status='success'"), 3);
    const pendingWhilePaused = await count("SELECT COUNT(*) FROM sms_processing WHERE status='pending'");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status='pending'"), pendingWhilePaused);
    assert.equal(started, 3, "no arranco visitas pausado");

    worker.resume();
    await until(async () => (await unfinished()) === 0);
    await worker.stop();
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status='success'"), 12);
    // Ningun trabajo perdio intentos por la pausa.
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE attempts <> 1"), 0);
  });

  test("al arrancar recupera los trabajos que dejo a medias el proceso anterior", async () => {
    await seed(["ok", "ok", "ok"]);
    const worker = new ProcessingWorker({ settings: fastSettings, visit: async () => visit("cargada") });
    // Simula el proceso anterior de este container: mismo hostname, otro pid.
    const previous = `${worker.workerId.split(":")[0]}:1:dead`;
    await claimJobs(previous, 3, new Date(), 10 * 60_000);

    await worker.start();
    await until(async () => (await unfinished()) === 0);
    await worker.stop();
    const jobs = await rows("SELECT status, attempts FROM sms_processing");
    assert.ok(jobs.every((j) => j.status === "success" && j.attempts === 2));
  });

  test("un SMS sin link en la cola se cierra como skipped sin visita", async () => {
    await seed(["ok"]);
    await pool.query("UPDATE sms_content SET text = 'sin link'");
    let visits = 0;
    const worker = new ProcessingWorker({
      settings: fastSettings,
      visit: async () => {
        visits++;
        return visit("cargada");
      },
    });
    await worker.start();
    await until(async () => (await unfinished()) === 0);
    await worker.stop();
    assert.equal(visits, 0);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status='skipped' AND skip_reason='sin_link'"), 1);
  });
});
