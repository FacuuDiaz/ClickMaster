import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../../src/config";
import { pool } from "../../src/db/pool";
import { reportsPool } from "../../src/db/reportsPool";
import { createApp } from "../../src/http/app";
import { NoActivePolicyError, ingestWindow, runDueWindows, runManualWindow } from "../../src/service/ingestService";
import { claimJobs } from "../../src/db/processingRepo";
import { createPolicy, deletePolicy, ensureSingleActive, policiesCache, seedDefaultPolicies, setActivePolicy } from "../../src/policies/repo";
import { runPendingChanges } from "../../src/policies/retake";
import { sweepClosedDays } from "../../src/policies/windowSelect";
import { parseApiDate } from "../../src/edr/apiTime";
import type { PolicyInput } from "../../src/policies/schema";
import { policyInputSchema } from "../../src/policies/schema";
import { ProcessingWorker, productionGate } from "../../src/worker/processingWorker";
import type { VisitOptions } from "../../src/checker/linkChecker";
import { count, resetTables, rows, setupTestDb } from "../helpers/db";
import { rawRecord } from "../helpers/fixtures";

const actor = { name: "tester", ip: null };
// Lunes 2026-11-16 12:00Z = 09:00 en GMT-3.
const T0 = new Date("2026-11-16T12:00:00Z");
const DAY = 86_400_000;
let server: Server;
let base: string;
let seq = 0;

// En los tests las politicas nacen activas salvo que se diga otra cosa.
const policyInput = (raw: Record<string, unknown>): PolicyInput => policyInputSchema.parse({ enabled: true, ...raw });

// SMS con link de un cliente, con edr_date a partir de `at`.
function sms(n: number, client: string, at: Date) {
  return Array.from({ length: n }, (_, i) => rawRecord(++seq, new Date(at.getTime() + i * 1000), { client }));
}

async function ingest(data: unknown[], windowStart: Date, now: Date) {
  return ingestWindow("manual", { start: windowStart, end: new Date(windowStart.getTime() + 3600_000) }, { fetcher: async () => [...data], now: () => now });
}

async function http(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Actor": "tester" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

before(async () => {
  await setupTestDb();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await resetTables();
  await policiesCache.refresh();
  config.checker.clickPercentage = 0;
});

after(async () => {
  server.close();
  await pool.end();
  await reportsPool.end();
});

describe("politicas en la ingesta", () => {
  test("asigna la politica activa y el porcentaje; lo que no coincide usa el default", async () => {
    const half = (await createPolicy(policyInput({ name: "mitad", rules: { match: { clients: ["MITAD"] }, selection: { percentage: 50 } } }), actor)).id;
    await ingest([...sms(10, "MITAD", T0), ...sms(3, "OTRO", T0)], T0, T0);

    const byPolicy = await rows(
      "SELECT policy_id, status, skip_reason, COUNT(*) AS n FROM sms_processing GROUP BY policy_id, status, skip_reason ORDER BY policy_id, status"
    );
    const summary = byPolicy.map((r) => [r.policy_id === null ? null : Number(r.policy_id), r.status, r.skip_reason, Number(r.n)]);
    assert.deepEqual(summary, [
      [null, "skipped", "fuera_de_muestra", 3],
      [half, "pending", null, 5],
      [half, "skipped", "fuera_de_muestra", 5],
    ]);
  });

  test("no_visitar: los que coinciden quedan salteados por politica", async () => {
    const skip = (await createPolicy(policyInput({ name: "nunca", rules: { match: { clients: ["NO"] }, selection: { action: "no_visitar" } } }), actor)).id;
    await ingest(sms(4, "NO", T0), T0, T0);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE policy_id = ? AND skip_reason = 'politica'", [skip]), 4);
  });

  test("tope por hora: lo que excede queda tope_politica, tambien entre ventanas", async () => {
    const { id } = await createPolicy(policyInput({ name: "tope", rules: { selection: { percentage: 100 }, limits: { perHour: 3 } } }), actor);
    await ingest(sms(10, "A", T0), T0, T0);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status = 'pending' AND policy_id = ?", [id]), 3);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE skip_reason = 'tope_politica'"), 7);

    // Misma hora, otra ventana: ya no queda cupo.
    await ingest(sms(5, "A", new Date(T0.getTime() + 3600_000)), new Date(T0.getTime() + 3600_000), new Date(T0.getTime() + 30 * 60_000));
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status = 'pending'"), 3);
    // La hora siguiente tiene cupo nuevo.
    await ingest(sms(5, "A", new Date(T0.getTime() + 7200_000)), new Date(T0.getTime() + 7200_000), new Date(T0.getTime() + 61 * 60_000));
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status = 'pending'"), 6);
  });

  test("fuera de horario el trabajo espera a la franja y no se reclama antes", async () => {
    await createPolicy(policyInput({ name: "tarde", rules: { selection: { percentage: 100 }, schedule: { ranges: [{ from: "14:00", to: "18:00" }] } } }), actor);
    await ingest(sms(2, "A", T0), T0, T0);
    const [job] = await rows("SELECT next_attempt_at FROM sms_processing LIMIT 1");
    assert.equal(new Date(job.next_attempt_at).toISOString(), "2026-11-16T17:00:00.000Z");
    assert.equal((await claimJobs("w", 10, T0, 60_000)).length, 0);
    assert.equal((await claimJobs("w", 10, new Date("2026-11-16T17:00:00Z"), 60_000)).length, 2);
  });

  test("elige sobre la ventana completa: el % y la estrategia se aplican al total, no por pagina", async () => {
    const saved = config.edr.maxRowsPerRequest;
    config.edr.maxRowsPerRequest = 7; // la ventana llega en varias paginas
    try {
      const { id } = await createPolicy(policyInput({ name: "primeros", rules: { selection: { percentage: 25, strategy: "primeros" } } }), actor);
      const data = sms(20, "A", T0);
      const run = await ingestWindow(
        "manual",
        { start: T0, end: new Date(T0.getTime() + 3600_000) },
        {
          // Paginacion por ultimo registro: desde el inicio pedido, hasta 7 filas.
          fetcher: async (range) => data.filter((r: any) => (parseApiDate(r.edr_date, config.edr.timezoneOffsetMinutes) as Date) >= range.start).slice(0, 7),
          now: () => T0,
        }
      );
      assert.equal(run.status, "success");
      assert.ok(run.apiRequests >= 3);
      // 25% de 20 = 5, los 5 primeros de la ventana (no 25% de cada pagina).
      const pending = await rows("SELECT client_message_id FROM sms_processing WHERE policy_id = ? AND status = 'pending' ORDER BY edr_date", [id]);
      assert.deepEqual(pending.map((r) => r.client_message_id), data.slice(0, 5).map((r: any) => r.client_message_id));
      assert.equal(run.jobsCreated, 5);
      assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE skip_reason = 'en_seleccion'"), 0);
    } finally {
      config.edr.maxRowsPerRequest = saved;
    }
  });

  test("semana anterior: la cuota diaria sale del mismo dia de la semana pasada y se reparte en el dia", async () => {
    const { id } = await createPolicy(
      policyInput({ name: "semanal", rules: { selection: { percentage: 50, base: "semana_anterior", strategy: "intercalado" } } }),
      actor
    );
    // Lunes pasado: 20 SMS de la politica (sin historico propio: usa el % de la ventana).
    const lastWeek = new Date(T0.getTime() - 7 * DAY);
    await ingest(sms(20, "A", lastWeek), lastWeek, lastWeek);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE policy_id = ? AND status = 'pending'", [id]), 10);

    // Hoy: cuota 50% de 20 = 10. A las 09:00-09:30 (x = 9.5/24) intercalado deja ~40% -> 4.
    await ingest(sms(40, "A", T0), T0, T0);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE policy_id = ? AND status = 'pending' AND edr_date >= ?", [id, T0]), 4);

    // Ultima ventana del dia (23:30): completa la cuota -> 6 mas.
    const late = new Date(T0.getTime() + 14.5 * 3600_000);
    await ingest(sms(40, "A", late), late, late);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE policy_id = ? AND status = 'pending' AND edr_date >= ?", [id, T0]), 10);
  });

  test("dia vencido: los SMS esperan al cierre del dia y se elige sobre el dia entero", async () => {
    const { id } = await createPolicy(
      policyInput({ name: "vencido", rules: { selection: { percentage: 25, base: "dia_vencido", strategy: "primeros" } } }),
      actor
    );
    const data = sms(20, "A", T0);
    const run = await ingest(data, T0, T0);
    assert.equal(run.jobsCreated, 0);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE skip_reason = 'en_seleccion'"), 20);

    // El dia todavia no cerro: no se toca.
    const todayStart = new Date("2026-11-16T03:00:00Z");
    assert.deepEqual(await sweepClosedDays(todayStart, T0), { approved: 0, skipped: 0 });

    const tomorrow = new Date(todayStart.getTime() + DAY);
    const swept = await sweepClosedDays(tomorrow, tomorrow);
    assert.equal(swept.approved, 5);
    assert.equal(swept.skipped, 15);
    const pending = await rows("SELECT client_message_id FROM sms_processing WHERE policy_id = ? AND status = 'pending' ORDER BY edr_date", [id]);
    assert.deepEqual(pending.map((r) => r.client_message_id), data.slice(0, 5).map((r: any) => r.client_message_id));
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE skip_reason = 'fuera_de_muestra'"), 15);
  });

  test("redondeo con arrastre: ventanas chicas no se pierden", async () => {
    const { id } = await createPolicy(policyInput({ name: "20%", rules: { selection: { percentage: 20, strategy: "primeros" } } }), actor);
    // 5 ventanas de 30 min con 2 SMS cada una: redondeando por ventana serian 0.
    for (let w = 0; w < 5; w++) {
      const start = new Date(T0.getTime() + w * 1800_000);
      await ingestWindow("manual", { start, end: new Date(start.getTime() + 1800_000) }, { fetcher: async () => sms(2, "A", start), now: () => start });
    }
    // 20% de 10 = 2 en el dia.
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE policy_id = ? AND status = 'pending'", [id]), 2);
  });

  test("los topes cuentan por momento de seleccion: dia vencido no los saltea", async () => {
    const { id } = await createPolicy(
      policyInput({ name: "vencido con tope", rules: { selection: { percentage: 100, base: "dia_vencido", strategy: "primeros" }, limits: { perDay: 3 } } }),
      actor
    );
    // Dos dias atrasados (entraron ayer y antes de ayer) que se eligen hoy.
    const d1 = new Date(T0.getTime() - 2 * DAY);
    const d2 = new Date(T0.getTime() - DAY);
    await ingest(sms(10, "A", d1), d1, d1);
    await ingest(sms(10, "A", d2), d2, d2);
    const today = new Date("2026-11-16T03:00:00Z");
    const swept = await sweepClosedDays(today, T0);
    // Tope 3 por dia para todo lo elegido HOY (antes contaba por ingreso y aprobaba 6).
    assert.equal(swept.approved, 3);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE policy_id = ? AND status = 'pending'", [id]), 3);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE skip_reason = 'tope_politica'"), 17);
  });

  test("las politicas de fabrica se cargan una sola vez", async () => {
    assert.equal(await seedDefaultPolicies(), 3);
    await policiesCache.refresh();
    const list = policiesCache.list();
    assert.deepEqual(list.map((p) => [p.rules.selection.base, p.enabled]), [["ventana", true], ["dia_vencido", false], ["semana_anterior", false]]);
    assert.equal(await seedDefaultPolicies(), 0);
    // Si se borran todas a proposito, no vuelven.
    for (const p of list) await deletePolicy(p.id, actor);
    assert.equal(await seedDefaultPolicies(), 0);
  });
});

describe("una sola activa y cambios en ejecucion", () => {
  const status = async (ids: number[]) =>
    (await rows("SELECT id, status, skip_reason, clicks, attempts FROM sms_processing WHERE id IN (?) ORDER BY edr_date, id", [ids])).map((r) => [
      r.status,
      r.skip_reason,
      Number(r.clicks),
    ]);
  const allIds = async () => (await rows("SELECT id FROM sms_processing ORDER BY edr_date, id")).map((r) => Number(r.id));

  test("activar una apaga la otra; tambien se puede quedar sin ninguna", async () => {
    const a = await createPolicy(policyInput({ name: "A", rules: {} }), actor);
    const b = await createPolicy(policyInput({ name: "B", rules: {} }), actor);
    await policiesCache.refresh();
    assert.deepEqual(policiesCache.active().map((p) => p.id), [b.id]);
    assert.ok(a.changeId && b.changeId);

    const back = await setActivePolicy(a.id, actor);
    assert.ok(back.changeId);
    assert.deepEqual(policiesCache.active().map((p) => p.id), [a.id]);
    // Activar la que ya esta activa no es un cambio.
    assert.equal((await setActivePolicy(a.id, actor)).changeId, null);

    await setActivePolicy(null, actor);
    assert.equal(policiesCache.active().length, 0);
    // Solo el ultimo cambio queda pendiente.
    assert.equal(await count("SELECT COUNT(*) FROM policy_changes WHERE status = 'pendiente'"), 1);

    // Datos viejos con dos activas: queda la primera.
    await pool.query("UPDATE policies SET enabled = 1");
    assert.equal(await ensureSingleActive(), 1);
    await policiesCache.refresh();
    assert.deepEqual(policiesCache.active().map((p) => p.id), [a.id]);
  });

  test("cambio de ventana a ventana: retoma el contenido del dia, lo clickeado se deja y cuenta", async () => {
    await createPolicy(policyInput({ name: "20%", rules: { selection: { percentage: 20, strategy: "intercalado" } } }), actor);
    await ingest(sms(10, "A", T0), T0, T0);
    const ids = await allIds();
    // Intercalado al 20% de 10: posiciones 2 y 7. Se clickearon.
    assert.deepEqual((await status(ids)).map((r) => r[0]), ["skipped", "skipped", "pending", "skipped", "skipped", "skipped", "skipped", "pending", "skipped", "skipped"]);
    await pool.query("UPDATE sms_processing SET status = 'success', clicks = 1 WHERE status = 'pending'");

    const c = await createPolicy(policyInput({ name: "50% primeros", enabled: false, rules: { selection: { percentage: 50, strategy: "primeros" } } }), actor);
    await setActivePolicy(c.id, actor, T0, "igual");
    const result = await runPendingChanges(new Date(T0.getTime() + 3600_000));
    assert.equal(result?.reassigned, 10);
    // 50% primeros = posiciones 0-4: la 2 ya estaba clickeada (cuenta), se aprueban 0,1,3,4.
    assert.equal(result?.approved, 4);
    assert.equal(result?.counted, 1);
    assert.deepEqual(await status(ids), [
      ["pending", null, 0], ["pending", null, 0], ["success", null, 1], ["pending", null, 0], ["pending", null, 0],
      ["skipped", "fuera_de_muestra", 0], ["skipped", "fuera_de_muestra", 0], ["success", null, 1],
      ["skipped", "fuera_de_muestra", 0], ["skipped", "fuera_de_muestra", 0],
    ]);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE policy_id = ?", [c.id]), 10);
    const [change] = await rows("SELECT status, result FROM policy_changes ORDER BY id DESC LIMIT 1");
    assert.equal(change.status, "aplicado");
  });

  for (const repeat of ["igual", "doble"] as const) {
    test(`cambio a dia vencido (${repeat}): manana se elige sobre todo el dia, incluidos los ya clickeados`, async () => {
      await createPolicy(policyInput({ name: "mitad", rules: { selection: { percentage: 50, strategy: "primeros" } } }), actor);
      await ingest(sms(10, "A", T0), T0, T0);
      const ids = await allIds();
      // Se clickearon los 2 primeros; 2, 3 y 4 siguen en cola.
      await pool.query("UPDATE sms_processing SET status = 'success', clicks = 1, attempts = 1 WHERE id IN (?)", [ids.slice(0, 2)]);

      const v = await createPolicy(
        policyInput({ name: "vencido", enabled: false, rules: { selection: { percentage: 30, base: "dia_vencido", strategy: "primeros" } } }),
        actor
      );
      await setActivePolicy(v.id, actor, T0, repeat);
      const now = new Date(T0.getTime() + 3600_000);
      const retake = await runPendingChanges(now);
      // Hoy no se elige nada: los salteados vuelven a esperar al cierre del dia.
      assert.equal(retake?.approved, 0);
      assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE skip_reason = 'en_seleccion'"), 5);

      const tomorrow = new Date("2026-11-17T03:00:00Z");
      const swept = await sweepClosedDays(tomorrow, tomorrow);
      // 30% de los 10 del dia = 3 primeros: 0 y 1 ya clickeados, 2 en cola.
      if (repeat === "igual") {
        assert.equal(swept.counted, 3);
        assert.equal(swept.requeued ?? 0, 0);
        assert.deepEqual((await status(ids.slice(0, 2))).map((r) => r[0]), ["success", "success"]);
      } else {
        assert.equal(swept.requeued, 2);
        assert.deepEqual((await status(ids.slice(0, 2))).map((r) => r[0]), ["pending", "pending"]);
        assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE id IN (?) AND attempts = 0", [ids.slice(0, 2)]), 2);
      }
      // Lo que la anterior ya habia mandado a la cola se deja.
      assert.deepEqual((await status(ids.slice(2, 5))).map((r) => r[0]), ["pending", "pending", "pending"]);
      assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE skip_reason = 'fuera_de_muestra'"), 5);
    });
  }

  test("un visitado que nunca llego al sitio no es un click: se reintenta aunque sea 'cuenta igual'", async () => {
    await createPolicy(policyInput({ name: "mitad", rules: { selection: { percentage: 50, strategy: "primeros" } } }), actor);
    await ingest(sms(4, "A", T0), T0, T0);
    const ids = await allIds();
    // 0: clickeado; 1: fallo sin llegar al sitio (timeout).
    await pool.query("UPDATE sms_processing SET status = 'success', clicks = 1 WHERE id = ?", [ids[0]]);
    await pool.query("UPDATE sms_processing SET status = 'failed', clicks = 0, attempts = 3 WHERE id = ?", [ids[1]]);
    const v = await createPolicy(policyInput({ name: "otra", enabled: false, rules: { selection: { percentage: 50, strategy: "primeros" } } }), actor);
    await setActivePolicy(v.id, actor, T0, "igual");
    const r = await runPendingChanges(new Date(T0.getTime() + 3600_000));
    assert.equal(r?.counted, 1);
    assert.equal(r?.requeued, 1);
    assert.deepEqual((await status(ids.slice(0, 2))).map((x) => x[0]), ["success", "pending"]);
  });

  test("cada visita suma un click realizado: un SMS que se vuelve a visitar queda con 2", async () => {
    await createPolicy(policyInput({ name: "todo", rules: { selection: { percentage: 100 } } }), actor);
    await ingest(sms(1, "A", T0), T0, new Date());
    const ok = async () => ({ httpStatus: 200, ok: true, outcome: "cargada" as const, responseTimeMs: 1, finalUrl: null, redirects: 0, errorMessage: null });
    const runUntil = async (where: string) => {
      const worker = new ProcessingWorker({
        settings: { concurrency: 1, claimBatchSize: 1, pollIntervalMs: 50, maxAttempts: 3, retryBaseDelayMs: 0 },
        visit: ok as any,
      });
      await worker.start();
      const deadline = Date.now() + 10_000;
      while ((await count(`SELECT COUNT(*) FROM sms_processing WHERE ${where}`)) < 1) {
        if (Date.now() > deadline) throw new Error(`timeout esperando ${where}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      await worker.stop();
    };
    await runUntil("status = 'success' AND clicks = 1");
    // "Cuenta como otro click": vuelve a la cola (como lo deja reselect) y se visita de nuevo.
    await pool.query("UPDATE sms_processing SET status = 'pending', attempts = 0, next_attempt_at = NOW(3), finished_at = NULL");
    await runUntil("status = 'success' AND clicks = 2");
    assert.equal(await count("SELECT COUNT(*) FROM sms_link_checks"), 2);

    // Una respuesta que no es 200 (ej. 500 del sitio) no es un click.
    await pool.query("UPDATE sms_processing SET status = 'pending', attempts = 0, next_attempt_at = NOW(3), finished_at = NULL");
    const worker = new ProcessingWorker({
      settings: { concurrency: 1, claimBatchSize: 1, pollIntervalMs: 50, maxAttempts: 1, retryBaseDelayMs: 0 },
      visit: async () => ({ httpStatus: 500, ok: false, outcome: "http_5xx" as const, responseTimeMs: 1, finalUrl: null, redirects: 0, errorMessage: "HTTP 500" }),
    });
    await worker.start();
    const deadline = Date.now() + 10_000;
    while ((await count("SELECT COUNT(*) FROM sms_link_checks")) < 3) {
      if (Date.now() > deadline) throw new Error("timeout esperando la visita con 500");
      await new Promise((r) => setTimeout(r, 50));
    }
    await worker.stop();
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE clicks = 2"), 1);
  });
});

describe("sin politica activa: en espera", () => {
  test("no se pide nada a Alaris (automatica ni manual) y /sync responde 409", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return sms(3, "A", T0);
    };
    const tick = await runDueWindows({ fetcher, now: () => new Date(T0.getTime() + 3600_000) });
    assert.deepEqual(tick, { runs: [], caughtUp: true, waiting: true });
    await assert.rejects(runManualWindow({ start: T0, end: new Date(T0.getTime() + 1800_000) }, { fetcher }), NoActivePolicyError);
    assert.equal(calls, 0);
    assert.equal(await count("SELECT COUNT(*) FROM sync_runs"), 0);

    const res = await http("POST", "/sync", { start: T0.toISOString(), end: new Date(T0.getTime() + 1800_000).toISOString() });
    assert.equal(res.status, 409);
    assert.equal(res.body.waiting, true);
    // Pedir una captura tampoco consulta a Alaris.
    const cap = await http("POST", "/admin/captures", { start: T0.toISOString(), end: new Date(T0.getTime() + 1800_000).toISOString() });
    assert.equal(cap.status, 409);
    assert.equal(cap.body.waiting, true);
    const status = await http("GET", "/admin/status");
    assert.equal(status.body.policy.active, null);

    // Con una activa, arranca.
    await createPolicy(policyInput({ name: "todo", rules: { selection: { percentage: 100 } } }), actor);
    const run = await runManualWindow({ start: T0, end: new Date(T0.getTime() + 1800_000) }, { fetcher, now: () => T0 });
    assert.equal(run?.jobsCreated, 3);
    assert.equal(calls, 1);
  });

  test("el worker de produccion no toma SMS de la cola sin politica activa", async () => {
    const id = (await createPolicy(policyInput({ name: "todo", rules: { selection: { percentage: 100 } } }), actor)).id;
    await ingest(sms(2, "A", T0), T0, new Date());
    await setActivePolicy(null, actor);
    assert.equal(productionGate(), "sin_politica");
    let visits = 0;
    const worker = new ProcessingWorker({
      gate: productionGate,
      settings: { concurrency: 1, claimBatchSize: 2, pollIntervalMs: 50, maxAttempts: 1, retryBaseDelayMs: 0 },
      visit: async () => {
        visits++;
        return { httpStatus: 200, ok: true, outcome: "cargada" as const, responseTimeMs: 1, finalUrl: null, redirects: 0, errorMessage: null };
      },
    });
    try {
      await worker.start();
      assert.equal(worker.status().waiting, "sin_politica");
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(visits, 0);
      // Apagarla no re-elige nada: lo que estaba en cola se queda ahi.
      assert.equal(await runPendingChanges(new Date()).then((r) => r?.approved), 0);
      assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status = 'pending' AND policy_id = ?", [id]), 2);
    } finally {
      await worker.stop();
    }
  });
});

describe("politicas en el worker", () => {
  test("usa intentos y timeout de la politica", async () => {
    await createPolicy(policyInput({ name: "rapida", rules: { selection: { percentage: 100 }, visit: { maxAttempts: 1, timeoutMs: 4321 } } }), actor);
    await ingest(sms(2, "A", T0), T0, new Date());
    const seen: VisitOptions[] = [];
    const worker = new ProcessingWorker({
      settings: { concurrency: 2, claimBatchSize: 2, pollIntervalMs: 50, maxAttempts: 3, retryBaseDelayMs: 0 },
      visit: async (_url, options) => {
        seen.push(options);
        return { httpStatus: null, ok: false, outcome: "timeout", responseTimeMs: 1, finalUrl: null, redirects: 0, errorMessage: "timeout" };
      },
    });
    await worker.start();
    const deadline = Date.now() + 10_000;
    while ((await count("SELECT COUNT(*) FROM sms_processing WHERE status = 'failed'")) < 2) {
      if (Date.now() > deadline) throw new Error("timeout esperando que fallen");
      await new Promise((r) => setTimeout(r, 50));
    }
    await worker.stop();
    // Un transitorio con maxAttempts global 3 iria a retry; la politica dice 1.
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status = 'retry'"), 0);
    assert.ok(seen.every((o) => o.timeoutMs === 4321));
    // Timeouts: la visita no llego al sitio, no es un click realizado.
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE clicks > 0"), 0);
  });

  test("fuera del horario global de visitas no toma trabajos", async () => {
    await createPolicy(policyInput({ name: "todo", rules: { selection: { percentage: 100 } } }), actor);
    await ingest(sms(2, "A", T0), T0, new Date());
    const saved = { ...config.visitHours };
    // Una franja de un minuto que ya paso hoy (o casi): fuera de horario seguro.
    Object.assign(config.visitHours, { enabled: true, days: "todos", from: "00:00", to: "00:01" });
    let visits = 0;
    const worker = new ProcessingWorker({
      settings: { concurrency: 1, claimBatchSize: 2, pollIntervalMs: 50, maxAttempts: 1, retryBaseDelayMs: 0 },
      visit: async () => {
        visits++;
        return { httpStatus: 200, ok: true, outcome: "cargada" as const, responseTimeMs: 1, finalUrl: null, redirects: 0, errorMessage: null };
      },
    });
    try {
      if (new Date().getUTCHours() === 3 && new Date().getUTCMinutes() === 0) return; // justo 00:00 en GMT-3
      await worker.start();
      assert.equal(worker.status().outsideHours, true);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(visits, 0);
      assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status = 'pending'"), 2);
    } finally {
      await worker.stop();
      Object.assign(config.visitHours, saved);
    }
  });
});

describe("rutas /admin/policies", () => {
  test("alta, edicion, orden, baja y vista previa, con historial", async () => {
    const bad = await http("POST", "/admin/policies", { name: "", rules: { selection: { percentage: 150 } } });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details.length >= 2);

    // Sin "enabled" nace apagada: no cambia lo que corre.
    const off = await http("POST", "/admin/policies", { name: "apagada", rules: {} });
    assert.equal(off.body.enabled, false);
    assert.equal(off.body.changeId, null);
    await http("DELETE", `/admin/policies/${off.body.id}`);
    const a = await http("POST", "/admin/policies", { name: "A", enabled: true, rules: { match: { clients: ["A"] } } });
    const b = await http("POST", "/admin/policies", { name: "B", enabled: true, rules: { selection: { percentage: 100 } } });
    assert.equal(a.status, 201);
    assert.equal(b.body.priority, 2);

    const upd = await http("PUT", `/admin/policies/${a.body.id}`, { name: "A2", enabled: false, rules: a.body.rules });
    assert.equal(upd.body.name, "A2");
    assert.equal(upd.body.enabled, false);

    const reordered = await http("POST", "/admin/policies/reorder", { ids: [b.body.id, a.body.id] });
    assert.deepEqual(reordered.body.policies.map((p: any) => p.name), ["B", "A2"]);
    assert.equal((await http("POST", "/admin/policies/reorder", { ids: [b.body.id] })).status, 404);

    await ingest(sms(6, "A", T0), T0, new Date());
    const preview = await http("POST", "/admin/policies/preview", {
      hours: 1,
      draft: { name: "nueva", rules: { match: { clients: ["A"] }, selection: { percentage: 50 } } },
    });
    assert.equal(preview.status, 200);
    // Se estima como si la nueva fuera LA activa (aunque este apagada): B no cuenta.
    assert.equal(preview.body.rows.some((r: any) => r.name === "B"), false);
    const draftRow = preview.body.rows.find((r: any) => r.name === "nueva");
    assert.equal(draftRow.matched, 6);
    assert.equal(draftRow.estimatedVisits, 3);

    assert.equal((await http("DELETE", `/admin/policies/${a.body.id}`)).status, 200);
    assert.equal((await http("DELETE", `/admin/policies/${a.body.id}`)).status, 404);

    const audit = await http("GET", "/admin/audit?entity=policy");
    assert.deepEqual(
      audit.body.items.map((i: any) => i.action),
      ["delete", "reorder", "update", "change", "deactivate", "create", "change", "create", "delete", "create"]
    );
    assert.equal(audit.body.items[0].actor, "tester");
  });

  test("activar por la ruta registra el cambio y se aplica en segundo plano", async () => {
    const a = await http("POST", "/admin/policies", { name: "A", enabled: false, rules: {} });
    const res = await http("POST", "/admin/policies/active", { id: a.body.id, repeatMode: "doble" });
    assert.equal(res.status, 200);
    assert.ok(res.body.changeId);
    assert.deepEqual(res.body.policies.filter((p: any) => p.enabled).map((p: any) => p.id), [a.body.id]);
    assert.equal((await http("POST", "/admin/policies/active", { id: a.body.id, repeatMode: "otra" })).status, 400);

    const deadline = Date.now() + 5000;
    let changes: any[] = [];
    while (Date.now() < deadline) {
      changes = (await http("GET", "/admin/policies/changes")).body.changes;
      if (changes[0]?.status === "aplicado") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(changes[0].status, "aplicado");
    assert.equal(changes[0].toName, "A");
    assert.equal(changes[0].repeatMode, "doble");
  });

  test("estrategias con su ejemplo", async () => {
    const res = await http("GET", "/admin/policies/strategies?n=40&percentage=20");
    assert.equal(res.status, 200);
    assert.equal(res.body.k, 8);
    assert.equal(res.body.strategies.length, 7);
    assert.ok(res.body.strategies.every((s: any) => s.picks.length === 8 && s.label && s.description));
  });
});
