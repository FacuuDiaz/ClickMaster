import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../../src/config";
import { pool } from "../../src/db/pool";
import {
  claimJobs,
  completeAttempt,
  confirmLease,
  recoverExpiredLeases,
  releaseJobs,
  type AttemptResult,
} from "../../src/db/processingRepo";
import { ingestWindow } from "../../src/service/ingestService";
import { count, resetTables, rows, setupTestDb } from "../helpers/db";
import { syntheticSource } from "../helpers/fixtures";

const T0 = new Date("2026-10-14T12:00:00Z");
const LEASE = 60_000;

async function seedJobs(perMinute: number): Promise<number> {
  config.checker.clickPercentage = 100;
  const source = syntheticSource(perMinute, 1_000_000); // todos con link
  await ingestWindow("manual", { start: T0, end: new Date(T0.getTime() + 30 * 60_000) }, {
    fetcher: async (r) => source(r),
  });
  return count("SELECT COUNT(*) FROM sms_processing WHERE status = 'pending'");
}

function attempt(jobId: number, smsContentId: number, workerId: string, over: Partial<AttemptResult> = {}): AttemptResult {
  const now = new Date();
  return {
    jobId,
    workerId,
    smsContentId,
    attempt: 1,
    link: "https://cutt.ly/x",
    startedAt: now,
    finishedAt: now,
    httpStatus: 200,
    ok: true,
    outcome: "cargada",
    responseTimeMs: 120,
    finalUrl: null,
    redirects: 0,
    errorMessage: null,
    nextStatus: "success",
    nextAttemptAt: null,
    ...over,
  };
}

before(setupTestDb);
after(() => pool.end());
beforeEach(resetTables);

describe("cola persistente", () => {
  test("reclama solo el lote pedido, no toda la cola", async () => {
    const pending = await seedJobs(10);
    assert.ok(pending > 100);
    const jobs = await claimJobs("w1", 16, new Date(), LEASE);
    assert.equal(jobs.length, 16);
    assert.ok(jobs.every((j) => j.text !== null && j.attempt === 1));
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status='processing'"), 16);
  });

  test("varios workers en paralelo nunca reclaman el mismo trabajo", async () => {
    const pending = await seedJobs(10);
    const seen = new Map<number, string>();
    const duplicates: number[] = [];
    const worker = async (id: string) => {
      for (;;) {
        const jobs = await claimJobs(id, 7, new Date(), LEASE);
        if (jobs.length === 0) return;
        for (const job of jobs) {
          if (seen.has(job.id)) duplicates.push(job.id);
          seen.set(job.id, id);
        }
      }
    };
    await Promise.all(["w1", "w2", "w3", "w4", "w5"].map(worker));
    assert.deepEqual(duplicates, []);
    assert.equal(seen.size, pending);
    assert.equal(new Set(seen.values()).size > 1, true, "el trabajo se repartio entre workers");
  });

  test("cada resultado se guarda solo y relacionado con su SMS", async () => {
    await seedJobs(1);
    const [a, b] = await claimJobs("w1", 2, new Date(), LEASE);
    assert.equal(await completeAttempt(attempt(a.id, a.smsContentId, "w1")), true);

    // a ya esta terminado aunque b siga en curso.
    const [ja] = await rows("SELECT status, last_outcome, locked_by FROM sms_processing WHERE id = ?", [a.id]);
    const [jb] = await rows("SELECT status FROM sms_processing WHERE id = ?", [b.id]);
    assert.equal(ja.status, "success");
    assert.equal(ja.last_outcome, "cargada");
    assert.equal(ja.locked_by, null);
    assert.equal(jb.status, "processing");

    const [check] = await rows("SELECT * FROM sms_link_checks WHERE processing_id = ?", [a.id]);
    assert.equal(Number(check.sms_content_id), a.smsContentId);
    assert.equal(check.attempt, 1);
    assert.equal(check.outcome, "cargada");
  });

  test("retry vuelve a la cola con backoff y conserva el historial de intentos", async () => {
    await seedJobs(1);
    const [job] = await claimJobs("w1", 1, new Date(), LEASE);
    const later = new Date(Date.now() + 60_000);
    await completeAttempt(
      attempt(job.id, job.smsContentId, "w1", { outcome: "timeout", ok: false, httpStatus: null, nextStatus: "retry", nextAttemptAt: later })
    );
    // Todavia no esta lista.
    const notYet = await claimJobs("w1", 100, new Date(), LEASE);
    assert.equal(notYet.some((j) => j.id === job.id), false);
    // Pasado el backoff si, como segundo intento.
    const again = (await claimJobs("w2", 100, new Date(later.getTime() + 1), LEASE)).find((j) => j.id === job.id);
    assert.equal(again?.attempt, 2);
    assert.equal(await count("SELECT COUNT(*) FROM sms_link_checks WHERE processing_id = ?", [job.id]), 1);
  });

  test("una reserva vencida se recupera: retry, o failed si no quedan intentos", async () => {
    await seedJobs(1);
    const [a, b] = await claimJobs("muerto", 2, new Date(), LEASE);
    await pool.query("UPDATE sms_processing SET attempts = 3 WHERE id = ?", [b.id]);

    // Antes de vencer no se toca.
    assert.equal(await recoverExpiredLeases(new Date(), 3), 0);
    const recovered = await recoverExpiredLeases(new Date(Date.now() + LEASE + 1), 3);
    assert.equal(recovered, 2);
    const [ja] = await rows("SELECT status, next_attempt_at, locked_by, last_outcome FROM sms_processing WHERE id = ?", [a.id]);
    const [jb] = await rows("SELECT status, next_attempt_at FROM sms_processing WHERE id = ?", [b.id]);
    assert.equal(ja.status, "retry");
    assert.notEqual(ja.next_attempt_at, null);
    assert.equal(ja.locked_by, null);
    assert.equal(ja.last_outcome, "reserva_vencida");
    assert.equal(jb.status, "failed");
    assert.equal(jb.next_attempt_at, null);
  });

  test("despues de un reinicio se liberan al toque las reservas del proceso anterior", async () => {
    await seedJobs(1);
    await claimJobs("host-a:100:aaaa", 3, new Date(), LEASE); // proceso anterior del mismo container
    await claimJobs("host-b:200:bbbb", 2, new Date(), LEASE); // otro container, vivo
    const recovered = await recoverExpiredLeases(new Date(), 3, { ownerPrefix: "host-a:", excludeOwner: "host-a:101:cccc" });
    assert.equal(recovered, 3);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE locked_by LIKE 'host-b:%'"), 2);
  });

  test("si otro worker recupero el trabajo, el resultado viejo se guarda pero no pisa el estado", async () => {
    await seedJobs(1);
    const [job] = await claimJobs("lento", 1, new Date(), LEASE);
    await recoverExpiredLeases(new Date(Date.now() + LEASE + 1), 3);
    // Recuperado queda en retry al final de la cola: se reclama todo para encontrarlo.
    const again = (await claimJobs("rapido", 100, new Date(Date.now() + LEASE + 2), LEASE)).find((j) => j.id === job.id);
    assert.ok(again);

    assert.equal(await confirmLease(job.id, "lento", new Date(Date.now() + LEASE)), false);
    const applied = await completeAttempt(attempt(job.id, job.smsContentId, "lento", { outcome: "http_4xx", nextStatus: "failed" }));
    assert.equal(applied, false);
    const [state] = await rows("SELECT status, locked_by FROM sms_processing WHERE id = ?", [job.id]);
    assert.equal(state.status, "processing");
    assert.equal(state.locked_by, "rapido");
    assert.equal(await count("SELECT COUNT(*) FROM sms_link_checks WHERE processing_id = ?", [job.id]), 1);
  });

  test("releaseJobs devuelve a la cola sin gastar el intento", async () => {
    await seedJobs(1);
    const jobs = await claimJobs("w1", 3, new Date(), LEASE);
    assert.equal(await releaseJobs(jobs.map((j) => j.id), "w1", new Date()), 3);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status='pending' AND attempts=0 AND id IN (?)", [jobs.map((j) => j.id)]), 3);
  });

  test("la consulta de reclamo usa el indice de next_attempt_at", async () => {
    await seedJobs(10);
    const [plan] = await rows(
      `EXPLAIN SELECT id FROM sms_processing FORCE INDEX (idx_next_attempt) WHERE next_attempt_at <= ? AND status IN ('pending','retry')
        ORDER BY next_attempt_at, id LIMIT 8 FOR UPDATE SKIP LOCKED`,
      [new Date()]
    );
    assert.equal(plan.key, "idx_next_attempt");
  });
});
