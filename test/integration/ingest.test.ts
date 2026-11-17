import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../../src/config";
import { pool } from "../../src/db/pool";
import { withNamedLock } from "../../src/db/locks";
import { INGEST_LOCK, ingestWindow, runDueWindows, runManualWindow } from "../../src/service/ingestService";
import type { EdrRange } from "../../src/fetcher/apiClient";
import { count, resetTables, rows, setupTestDb } from "../helpers/db";
import { createPolicy, policiesCache } from "../../src/policies/repo";
import { policyInputSchema } from "../../src/policies/schema";
import { rawRecord, syntheticSource } from "../helpers/fixtures";

const T0 = new Date("2026-10-14T12:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);
const win = (a: number, b: number) => ({ start: minutes(a), end: minutes(b) });
const fetcherFrom = (source: (r: EdrRange) => unknown[]) => async (r: EdrRange) => source(r);

before(async () => {
  await setupTestDb();
});

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetTables();
  config.ingest.dbBatchSize = 7; // lotes chicos para ejercitar varios por ventana
  config.checker.clickPercentage = 100;
  // Sin politica activa la ingesta queda en espera: una que toma todo al 100%.
  await createPolicy(policyInputSchema.parse({ name: "todo", enabled: true, rules: { selection: { percentage: 100 } } }), { name: "tester", ip: null });
  config.edr.maxRowsPerRequest = 20000;
  config.edr.minSplitSeconds = 60;
  config.scheduler.overlapMinutes = 0;
  config.scheduler.safetyDelayMinutes = 5;
  config.scheduler.windowMinutes = 30;
  config.scheduler.startDate = undefined;
  config.scheduler.maxWindowsPerTick = 6;
});

describe("ingesta y persistencia", () => {
  test("persiste por lotes y crea un trabajo por SMS (sin link = skipped)", async () => {
    const source = syntheticSource(2, 10); // 2/min, 1 de cada 10 sin link
    const run = await ingestWindow("manual", win(0, 30), { fetcher: fetcherFrom(source) });

    const expected = source(win(0, 30)).length;
    assert.equal(run.status, "success");
    assert.equal(run.recordsReceived, expected);
    assert.equal(run.smsNew, expected);
    assert.equal(await count("SELECT COUNT(*) FROM sms_content"), expected);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing"), expected);
    const noLink = await count("SELECT COUNT(*) FROM sms_processing WHERE status='skipped' AND skip_reason='sin_link'");
    assert.ok(noLink > 0);
    assert.equal(run.jobsCreated, expected - noLink);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing WHERE status='pending'"), expected - noLink);
    // Los skipped no se pueden reclamar.
    assert.equal(
      await count("SELECT COUNT(*) FROM sms_processing WHERE status='skipped' AND next_attempt_at IS NOT NULL"),
      0
    );
    // Cada trabajo apunta a su SMS.
    assert.equal(
      await count(
        `SELECT COUNT(*) FROM sms_processing p JOIN sms_content c ON c.id = p.sms_content_id
          AND c.client_message_id = p.client_message_id AND c.vendor_message_id = p.vendor_message_id`
      ),
      expected
    );
  });

  test("ventanas solapadas y reintentos no duplican SMS ni trabajos", async () => {
    const source = syntheticSource(4);
    await ingestWindow("manual", win(0, 30), { fetcher: fetcherFrom(source) });
    const smsBefore = await count("SELECT COUNT(*) FROM sms_content");
    const jobsBefore = await count("SELECT COUNT(*) FROM sms_processing");

    // Misma ventana otra vez + una solapada a la mitad.
    const again = await ingestWindow("manual", win(0, 30), { fetcher: fetcherFrom(source) });
    const overlapped = await ingestWindow("manual", win(15, 45), { fetcher: fetcherFrom(source) });

    assert.equal(again.smsNew, 0);
    assert.equal(again.jobsCreated, 0);
    assert.equal(overlapped.smsNew, source(win(30, 45)).length - 1); // el borde 12:30 ya estaba
    assert.equal(await count("SELECT COUNT(*) FROM sms_content"), smsBefore + overlapped.smsNew);
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing"), jobsBefore + overlapped.smsNew);
    assert.equal(
      await count(
        `SELECT COUNT(*) FROM (SELECT client_message_id, vendor_message_id FROM sms_content
          GROUP BY client_message_id, vendor_message_id HAVING COUNT(*) > 1) d`
      ),
      0
    );
  });

  test("un SMS que vuelve con otro status se actualiza sin crear otro trabajo ni pisar su estado", async () => {
    const first = [rawRecord(1, minutes(1), { status: "SENT" })];
    await ingestWindow("manual", win(0, 30), { fetcher: async () => first });
    await pool.query("UPDATE sms_processing SET status='success', next_attempt_at=NULL");

    const second = [rawRecord(1, minutes(1), { status: "DELIVRD" })];
    const run = await ingestWindow("manual", win(0, 30), { fetcher: async () => second });
    assert.equal(run.smsExisting, 1);
    const [sms] = await rows("SELECT status FROM sms_content");
    assert.equal(sms.status, "DELIVRD");
    const [job] = await rows("SELECT status FROM sms_processing");
    assert.equal(job.status, "success");
    assert.equal(await count("SELECT COUNT(*) FROM sms_processing"), 1);
  });

  test("reusa filas de sms_content cargadas por la version anterior", async () => {
    // Fila vieja sin sms_processing (como las del sync anterior).
    await ingestWindow("manual", win(0, 30), { fetcher: async () => [rawRecord(9, minutes(2))] });
    const [{ id }] = await rows("SELECT id FROM sms_content");
    await pool.query("TRUNCATE TABLE sms_processing");

    const run = await ingestWindow("manual", win(0, 30), { fetcher: async () => [rawRecord(9, minutes(2))] });
    assert.equal(run.smsNew, 0);
    assert.equal(run.smsExisting, 1);
    assert.equal(run.jobsCreated, 1);
    assert.equal(await count("SELECT COUNT(*) FROM sms_content"), 1);
    const [job] = await rows("SELECT sms_content_id FROM sms_processing");
    assert.equal(Number(job.sms_content_id), Number(id));
  });

  test("duplicados dentro de la misma respuesta quedan una sola vez", async () => {
    const dup = [rawRecord(5, minutes(1), { status: "SENT" }), rawRecord(5, minutes(1), { status: "DELIVRD" })];
    const run = await ingestWindow("manual", win(0, 30), { fetcher: async () => dup });
    assert.equal(run.smsNew, 1);
    const [sms] = await rows("SELECT status FROM sms_content");
    assert.equal(sms.status, "DELIVRD");
  });

  test("CLICK_PERCENTAGE manda el resto a skipped fuera_de_muestra", async () => {
    // El % por defecto aplica a lo que no coincide con la politica activa.
    await pool.query("UPDATE policies SET rules = JSON_SET(rules, '$.match.clients', JSON_ARRAY('NINGUNO'))");
    await policiesCache.refresh();
    config.checker.clickPercentage = 0;
    const run = await ingestWindow("manual", win(0, 30), { fetcher: fetcherFrom(syntheticSource(2)) });
    assert.equal(run.jobsCreated, 0);
    assert.ok((await count("SELECT COUNT(*) FROM sms_processing WHERE skip_reason='fuera_de_muestra'")) > 0);
  });

  test("registros invalidos: la corrida queda partial y el resto se guarda", async () => {
    const data = [rawRecord(1, minutes(1)), { ...rawRecord(2, minutes(2)), edr_date: "mal" }];
    const run = await ingestWindow("manual", win(0, 30), { fetcher: async () => data });
    assert.equal(run.status, "partial");
    assert.equal(run.recordsInvalid, 1);
    assert.equal(run.smsNew, 1);
    assert.match(run.error ?? "", /edr_date/);
  });

  // Alaris corta en `cap` filas, ordenadas como diga `order`.
  function cappedApi(cap: number, order: "asc" | "desc" | "shuffle", sameSecond = false) {
    const all = sameSecond
      ? Array.from({ length: 10 }, (_, i) => rawRecord(500 + i, minutes(3)))
      : syntheticSource(2)(win(0, 30));
    const requested: EdrRange[] = [];
    const t = (r: any) => Date.parse(r.edr_date.replace(/\./g, "-").replace(" ", "T") + "-03:00");
    const fetcher = async (r: EdrRange) => {
      requested.push(r);
      const inRange = all.filter((x) => t(x) >= r.start.getTime() && t(x) <= r.end.getTime());
      if (order === "desc") inRange.reverse();
      // Desorden determinista: el ultimo va segundo (con 3+ filas nunca queda ordenado).
      if (order === "shuffle" && inRange.length > 2) inRange.splice(1, 0, inRange.pop() as (typeof inRange)[number]);
      return inRange.slice(0, cap) as unknown[];
    };
    return { all, requested, fetcher, t };
  }

  test("respuesta en el tope: pide la pagina siguiente desde el ultimo registro", async () => {
    config.edr.maxRowsPerRequest = 25;
    const api = cappedApi(25, "asc");
    const run = await ingestWindow("manual", win(0, 30), { fetcher: api.fetcher });
    assert.equal(run.status, "success", run.error ?? "");
    assert.equal(await count("SELECT COUNT(*) FROM sms_content"), api.all.length);
    // 61 SMS con tope 25: 3 consultas encadenadas, mismo fin, cada una desde el ultimo de la anterior.
    assert.equal(run.apiRequests, 3);
    assert.ok(api.requested.every((r) => r.end.getTime() === minutes(30).getTime()));
    const page1Last = api.t(api.all[24]);
    assert.equal(api.requested[1].start.getTime(), page1Last);
    // Los del segundo de corte no se cuentan dos veces.
    assert.equal(run.recordsReceived, api.all.length);
    assert.equal(run.smsExisting, 0);
  });

  test("respuesta en el tope descendente: avanza hacia atras con el mismo inicio", async () => {
    config.edr.maxRowsPerRequest = 25;
    const api = cappedApi(25, "desc");
    const run = await ingestWindow("manual", win(0, 30), { fetcher: api.fetcher });
    assert.equal(run.status, "success", run.error ?? "");
    assert.equal(await count("SELECT COUNT(*) FROM sms_content"), api.all.length);
    assert.equal(run.apiRequests, 3);
    assert.ok(api.requested.every((r) => r.start.getTime() === minutes(0).getTime()));
  });

  test("respuesta en el tope desordenada: respaldo partiendo en mitades, sin perder registros", async () => {
    config.edr.maxRowsPerRequest = 25;
    const api = cappedApi(25, "shuffle");
    const run = await ingestWindow("manual", win(0, 30), { fetcher: api.fetcher });
    assert.equal(run.status, "success", run.error ?? "");
    assert.equal(await count("SELECT COUNT(*) FROM sms_content"), api.all.length);
    assert.ok(api.requested.some((r) => r.end.getTime() < minutes(30).getTime()), "tiene que haber partido el rango");
  });

  test("mas registros en un mismo segundo que el tope: falla en vez de perder datos", async () => {
    config.edr.maxRowsPerRequest = 5;
    const api = cappedApi(5, "asc", true);
    const run = await ingestWindow("manual", win(3, 30), { fetcher: api.fetcher });
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /mismo segundo/);
  });

  test("desordenada aun en el rango minimo: la corrida falla en vez de perder datos en silencio", async () => {
    config.edr.maxRowsPerRequest = 3;
    config.edr.minSplitSeconds = 600;
    const api = cappedApi(3, "shuffle");
    const run = await ingestWindow("manual", win(0, 30), { fetcher: api.fetcher });
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /truncada/);
  });

  test("corte de seguridad: no pide mas paginas que EDR_MAX_PAGES_PER_WINDOW", async () => {
    config.edr.maxRowsPerRequest = 5;
    config.edr.maxPagesPerWindow = 2;
    try {
      const api = cappedApi(5, "asc");
      const run = await ingestWindow("manual", win(0, 30), { fetcher: api.fetcher });
      assert.equal(run.status, "failed");
      assert.match(run.error ?? "", /paginas/);
      assert.equal(api.requested.length, 2);
    } finally {
      config.edr.maxPagesPerWindow = 50;
    }
  });
});

describe("scheduler de ventanas", () => {
  test("procesa las ventanas atrasadas en orden y avanza el cursor", async () => {
    config.scheduler.startDate = "2026.10.14 09:00:00"; // 12:00 UTC
    const now = () => minutes(100); // 13:40 -> horizonte 13:35: 12:00, 12:30, 13:00
    const result = await runDueWindows({ fetcher: fetcherFrom(syntheticSource(1)), now });
    assert.ok(result);
    assert.deepEqual(
      result.runs.map((r) => r.windowStart),
      ["2026-10-14T12:00:00.000Z", "2026-10-14T12:30:00.000Z", "2026-10-14T13:00:00.000Z"]
    );
    assert.equal(result.caughtUp, true);

    const again = await runDueWindows({ fetcher: fetcherFrom(syntheticSource(1)), now });
    assert.equal(again?.runs.length, 0);
  });

  test("una ventana fallida no se saltea: se reintenta y despues sigue", async () => {
    config.scheduler.startDate = "2026.10.14 09:00:00";
    const now = () => minutes(70);
    let fail = true;
    const fetcher = async (r: EdrRange) => {
      if (fail) throw new Error("API caida");
      return syntheticSource(1)(r);
    };
    const first = await runDueWindows({ fetcher, now });
    assert.equal(first?.runs.length, 1);
    assert.equal(first?.runs[0].status, "failed");
    assert.equal(await count("SELECT COUNT(*) FROM sms_content"), 0);

    fail = false;
    const second = await runDueWindows({ fetcher, now });
    assert.deepEqual(
      second?.runs.map((r) => [r.windowStart, r.status]),
      [
        ["2026-10-14T12:00:00.000Z", "success"],
        ["2026-10-14T12:30:00.000Z", "success"],
      ]
    );
  });

  test("no corren dos ingestas a la vez (lock persistente en MySQL)", async () => {
    config.scheduler.startDate = "2026.10.14 09:00:00";
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = runDueWindows({
      fetcher: async (r) => {
        await gate;
        return syntheticSource(1)(r);
      },
      now: () => minutes(40),
    });
    // Le da tiempo a tomar el lock.
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(await runDueWindows({ fetcher: fetcherFrom(syntheticSource(1)), now: () => minutes(40) }), null);
    assert.equal(await runManualWindow(win(0, 30), { fetcher: fetcherFrom(syntheticSource(1)) }), null);

    release();
    const done = await slow;
    assert.equal(done?.runs.length, 1);
    assert.equal(await count("SELECT COUNT(*) FROM sync_runs WHERE window_start = ?", [T0]), 1);
  });

  test("una corrida que quedo en running (proceso muerto) se marca failed y se repite", async () => {
    config.scheduler.startDate = "2026.10.14 09:00:00";
    await pool.query(
      `INSERT INTO sync_runs (kind, window_start, window_end, query_start, status, started_at)
       VALUES ('scheduled', ?, ?, ?, 'running', ?)`,
      [minutes(0), minutes(30), minutes(0), minutes(36)]
    );
    const result = await runDueWindows({ fetcher: fetcherFrom(syntheticSource(1)), now: () => minutes(40) });
    assert.equal(result?.runs[0].status, "success");
    const [old] = await rows("SELECT status, error_message FROM sync_runs ORDER BY id LIMIT 1");
    assert.equal(old.status, "failed");
    assert.match(old.error_message, /interrumpida/);
  });

  test("el lock queda libre si el que lo tenia termina con error", async () => {
    await assert.rejects(
      withNamedLock(INGEST_LOCK, async () => {
        throw new Error("boom");
      })
    );
    assert.equal(await withNamedLock(INGEST_LOCK, async () => "ok"), "ok");
  });
});
