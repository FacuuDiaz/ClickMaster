import { config } from "../config";
import { log, errorMessage } from "../logger";
import { withNamedLock } from "../db/locks";
import {
  countFailuresForWindow,
  createRun,
  emptyCounters,
  failInterruptedRuns,
  finishRun,
  heartbeatRun,
  lastCompletedScheduledEnd,
  type RunCounters,
  type RunKind,
  type RunStatus,
} from "../db/syncRunsRepo";
import { fetchEdrRange, type EdrFetcher } from "../fetcher/apiClient";
import { validateRecords } from "../parser/smsRecordSchema";
import { nextScheduledWindow, splitRange, type TimeWindow } from "../edr/windows";
import { parseApiDate } from "../edr/apiTime";
import { persistSmsBatch } from "./ingestBatch";
import { policiesCache } from "../policies/repo";
import { dayStartOf, selectHeld, sweepClosedDays } from "../policies/windowSelect";
import { runPendingChanges } from "../policies/retake";
import type { Policy } from "../policies/schema";
import { insertCaptureSafe } from "../captures/repo";
import { MinuteCounter, saveMinuteCounts } from "../db/minuteCountsRepo";
import { messageKey } from "../db/smsContentRepo";
import { factsOf, matchPolicy } from "../policies/match";
import { selectInMemory } from "../policies/discardSelect";
import type { SmsRecord } from "../parser/smsRecordSchema";
import { requestArgs } from "../fetcher/apiClient";

export const INGEST_LOCK = "ingesta";

export interface IngestRunSummary extends RunCounters {
  runId: number;
  kind: RunKind;
  windowStart: string;
  windowEnd: string;
  status: Exclude<RunStatus, "running">;
  durationMs: number;
  error: string | null;
}

export interface IngestDeps {
  fetcher?: EdrFetcher;
  now?: () => Date;
}

class TruncatedResponseError extends Error {}

/**
 * Ingesta de una ventana: pide los EDR, valida y persiste de a lotes, y
 * crea los trabajos. No corre Playwright: eso lo hacen los workers
 * leyendo la cola, desacoplados de la ingesta.
 *
 * La corrida queda "success" solo si se proceso la respuesta entera;
 * "partial" si hubo registros invalidos (repetir la ventana no los
 * arregla, por eso el cursor igual avanza y se reportan en sync_runs);
 * "failed" ante cualquier error de la API o de la base. Como todo es
 * idempotente, una ventana fallida se vuelve a pedir entera sin duplicar.
 */
export async function ingestWindow(
  kind: RunKind,
  window: TimeWindow,
  deps: IngestDeps = {}
): Promise<IngestRunSummary> {
  const fetcher = deps.fetcher ?? fetchEdrRange;
  const now = deps.now ?? (() => new Date());
  const startedAt = Date.now();
  const overlapMs = kind === "scheduled" ? config.scheduler.overlapMinutes * 60_000 : 0;
  const query: TimeWindow = { start: new Date(window.start.getTime() - overlapMs), end: window.end };

  const counters = emptyCounters();
  const invalidRaw: unknown[] = [];
  const runId = await createRun({
    kind,
    windowStart: window.start,
    windowEnd: window.end,
    queryStart: query.start,
    clientProductId: config.edr.clientProductId ?? null,
    country: config.edr.country ?? null,
    now: now(),
  });
  const ctx = { runId, windowStart: window.start.toISOString(), windowEnd: window.end.toISOString() };
  log.info("ingesta: inicio", { ...ctx, kind, queryStart: query.start.toISOString() });

  let status: Exclude<RunStatus, "running">;
  let error: string | null = null;
  const invalidSamples: string[] = [];

  try {
    const policies = await policiesCache.refresh().then(() => policiesCache.active());
    const minutes = new MinuteCounter(window);
    // semana_referencia: se elige en memoria y solo se guardan los elegidos.
    const buffer = discardMode(policies) ? new Map<string, SmsRecord>() : null;
    await ingestRange(query, { policies, fetcher, now, runId, counters, invalidSamples, invalidRaw, ctx, minutes, buffer });
    // Antes de elegir: la proporcion con link de las cuotas sale de aca.
    await saveMinuteCounts(minutes, policies[0]?.id ?? null, now());
    if (buffer) {
      const selected = await selectInMemory([...buffer.values()], query, policies, runId, now(), ctx);
      buffer.clear();
      counters.smsNew += selected.smsNew;
      counters.smsExisting += selected.smsExisting;
      counters.jobsCreated += selected.approved;
      counters.jobsSkipped += selected.skipped + selected.discarded;
    } else {
      // Con la ventana entera en la base, recien ahora se elige cuales visitar.
      const selected = await selectHeld(query, now(), { ctx });
      counters.jobsCreated += selected.approved;
      counters.jobsSkipped += selected.skipped;
    }
    status = counters.recordsInvalid > 0 ? "partial" : "success";
    if (status === "partial") {
      error = `${counters.recordsInvalid} registros invalidos. Ej: ${invalidSamples.join(" | ")}`;
    }
  } catch (err) {
    status = "failed";
    counters.errors++;
    error = errorMessage(err);
  }

  // Modo capturas "errores": los registros invalidos quedan guardados para
  // ver que mando Alaris (repetir la ventana no los arregla).
  if (invalidRaw.length > 0 && config.capture.mode !== "off") {
    await insertCaptureSafe({
      runId,
      origin: "invalidos",
      rangeStart: query.start,
      rangeEnd: query.end,
      requestArgs: requestArgs(query),
      body: JSON.stringify(invalidRaw),
      errorMessage: error,
      rowsCount: invalidRaw.length,
    });
  }

  try {
    await finishRun(runId, status, counters, error, now());
  } catch (err) {
    // Si no se pudo cerrar queda "running" y la proxima corrida la marca como interrumpida.
    log.error("ingesta: no se pudo guardar el cierre de la corrida", { ...ctx, error: errorMessage(err) });
  }

  const summary: IngestRunSummary = {
    runId,
    kind,
    windowStart: ctx.windowStart,
    windowEnd: ctx.windowEnd,
    status,
    durationMs: Date.now() - startedAt,
    error,
    ...counters,
  };
  (status === "failed" ? log.error : status === "partial" ? log.warn : log.info)("ingesta: fin", {
    ...summary,
  });
  return summary;
}

interface RangeContext {
  // Fijas durante toda la ventana: editar una politica a mitad no la parte en dos.
  policies: Policy[];
  fetcher: EdrFetcher;
  now: () => Date;
  runId: number;
  counters: RunCounters;
  invalidSamples: string[];
  // Registros crudos invalidos (con tope) para la captura.
  invalidRaw: unknown[];
  ctx: Record<string, unknown>;
  // Conteo por minuto de lo que llega (todas las politicas).
  minutes: MinuteCounter;
  // Modo descarte: los registros validos se juntan aca en vez de guardarse.
  buffer: Map<string, SmsRecord> | null;
}

/** La politica activa (una sola) es semana_referencia y visita. */
export function discardMode(policies: Policy[]): boolean {
  const sel = policies[0]?.rules.selection;
  return Boolean(sel && sel.action === "visitar" && sel.base === "semana_referencia");
}

const MAX_INVALID_CAPTURED = 2000;

// ---------- Paginacion por fecha del ultimo registro ----------

type PageOrder = "asc" | "desc" | "none";

function edrMs(record: unknown): number | null {
  if (!record || typeof record !== "object") return null;
  const v = (record as Record<string, unknown>).edr_date;
  if (typeof v !== "string") return null;
  const d = parseApiDate(v, config.edr.timezoneOffsetMinutes) ?? new Date(v);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}

function identityOf(record: unknown): string {
  const r = (record ?? {}) as Record<string, unknown>;
  return `${String(r.client_message_id)}\u0000${String(r.vendor_message_id)}`;
}

/** Orden de la respuesta por edr_date (ignora fechas ilegibles). */
function pageOrder(records: unknown[]): PageOrder {
  let asc = true;
  let desc = true;
  let prev: number | null = null;
  for (const r of records) {
    const ms = edrMs(r);
    if (ms === null) continue;
    if (prev !== null) {
      if (ms < prev) asc = false;
      if (ms > prev) desc = false;
      if (!asc && !desc) return "none";
    }
    prev = ms;
  }
  return asc ? "asc" : desc ? "desc" : "none";
}

/** Fecha del ultimo registro con fecha legible. */
function lastEdr(records: unknown[]): number | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const ms = edrMs(records[i]);
    if (ms !== null) return ms;
  }
  return null;
}

/**
 * Pide un rango a Alaris. La API no pagina y corta en
 * EDR_MAX_ROWS_PER_REQUEST filas, asi que si una respuesta llega al tope:
 *
 * - Ordenada por fecha (lo normal): se procesa y se vuelve a pedir desde la
 *   fecha del ULTIMO registro hasta el mismo fin (o, si viene descendente,
 *   desde el mismo inicio hasta esa fecha). 60.000 SMS = 3 consultas.
 *   Los registros de ese segundo vuelven a llegar en la pagina siguiente:
 *   se descartan por identidad.
 * - Desordenada: no hay un "ultimo" confiable; se descarta y se pide el rango
 *   en dos mitades (hasta EDR_MIN_SPLIT_SECONDS). Mas lento, pero correcto
 *   cualquiera sea el orden.
 *
 * Si en un mismo segundo hay mas registros que el tope, ni una cosa ni la
 * otra pueden avanzar: la corrida falla con un error claro (nunca se pierden
 * datos en silencio) y se reintenta en el proximo chequeo.
 */
async function ingestRange(range: TimeWindow, rc: RangeContext): Promise<void> {
  let cursor: TimeWindow = range;
  // Identidades del segundo de corte de la pagina anterior (ya procesadas).
  let seen = new Set<string>();

  for (let page = 1; ; page++) {
    if (page > config.edr.maxPagesPerWindow) {
      throw new TruncatedResponseError(
        `Se pidieron ${config.edr.maxPagesPerWindow} paginas para un mismo rango y Alaris sigue llegando al tope: ` +
          `revisar EDR_MAX_ROWS_PER_REQUEST o subir EDR_MAX_PAGES_PER_WINDOW`
      );
    }
    let records: unknown[] = await rc.fetcher(cursor, { runId: rc.runId });
    rc.counters.apiRequests++;

    let next: TimeWindow | null = null;
    let boundaryIds = new Set<string>();
    if (config.edr.maxRowsPerRequest > 0 && records.length >= config.edr.maxRowsPerRequest) {
      const order = pageOrder(records);
      const boundary = lastEdr(records);
      if (order === "none" || boundary === null) {
        await splitInHalves(cursor, records.length, rc);
        return;
      }
      const stuck = order === "asc" ? boundary <= cursor.start.getTime() : boundary >= cursor.end.getTime();
      if (stuck) {
        throw new TruncatedResponseError(
          `La API devolvio ${records.length} filas (el tope) todas del mismo segundo ` +
            `(${new Date(boundary).toISOString()}): la respuesta esta truncada y no se puede avanzar. Revisar EDR_MAX_ROWS_PER_REQUEST`
        );
      }
      const edge = new Date(boundary);
      next = order === "asc" ? { start: edge, end: cursor.end } : { start: cursor.start, end: edge };
      for (const r of records) if (edrMs(r) === boundary) boundaryIds.add(identityOf(r));
      log.info("ingesta: respuesta en el tope, se pide la pagina siguiente desde el ultimo registro", {
        ...rc.ctx,
        page,
        rows: records.length,
        order,
        nextStart: next.start.toISOString(),
        nextEnd: next.end.toISOString(),
      });
    }

    if (seen.size > 0) records = records.filter((r) => !seen.has(identityOf(r)));
    await processRecords(records, rc);
    if (!next) return;
    cursor = next;
    seen = boundaryIds;
  }
}

/** Respaldo para respuestas desordenadas: se descarta y se pide en mitades. */
async function splitInHalves(range: TimeWindow, rows: number, rc: RangeContext): Promise<void> {
  const spanSeconds = (range.end.getTime() - range.start.getTime()) / 1000;
  if (spanSeconds / 2 < config.edr.minSplitSeconds) {
    throw new TruncatedResponseError(
      `La API devolvio ${rows} filas (el tope), desordenadas, para un rango de ${spanSeconds}s: ` +
        `la respuesta puede estar truncada. Bajar EDR_MIN_SPLIT_SECONDS o revisar EDR_MAX_ROWS_PER_REQUEST`
    );
  }
  log.warn("ingesta: respuesta en el tope y desordenada, se parte el rango en mitades", {
    ...rc.ctx,
    rows,
    start: range.start.toISOString(),
    end: range.end.toISOString(),
  });
  for (const half of splitRange(range)) {
    await ingestRange(half, rc);
  }
}

/**
 * Valida, asigna politica y persiste una pagina de registros, de a lotes.
 * Los SMS quedan en_seleccion: se eligen al final de la ventana (selectHeld).
 */
async function processRecords(records: unknown[], rc: RangeContext): Promise<void> {
  rc.counters.recordsReceived += records.length;
  const batchSize = config.ingest.dbBatchSize;
  for (let i = 0; i < records.length; i += batchSize) {
    const raw = records.slice(i, i + batchSize);
    // Suelta las referencias del array original a medida que avanza: el
    // GC puede ir liberando la respuesta en vez de tenerla entera hasta el final.
    records.fill(null, i, i + raw.length);

    const { valid, invalid } = validateRecords(raw, i);
    if (invalid.length > 0) {
      rc.counters.recordsInvalid += invalid.length;
      for (const item of invalid) {
        if (rc.invalidSamples.length < 3) rc.invalidSamples.push(`#${item.index}: ${item.error}`);
        if (rc.invalidRaw.length < MAX_INVALID_CAPTURED) rc.invalidRaw.push(raw[item.index - i]);
      }
    }

    for (const r of valid) {
      const facts = factsOf(r);
      const policy = facts.link ? matchPolicy(rc.policies, facts) : null;
      rc.minutes.add(new Date(r.edr_date), Boolean(facts.link), Boolean(policy && policy.rules.selection.action === "visitar"));
    }
    if (rc.buffer) {
      // Si la misma identidad viene dos veces gana la ultima (la mas nueva).
      for (const r of valid) rc.buffer.set(messageKey(r.client_message_id, r.vendor_message_id), r);
      await heartbeatRun(rc.runId, rc.counters, rc.now());
      continue;
    }
    const result = await persistSmsBatch(valid, rc.runId, rc.policies, rc.now());
    rc.counters.smsNew += result.smsNew;
    rc.counters.smsExisting += result.smsExisting;
    rc.counters.jobsCreated += result.jobsCreated;
    rc.counters.jobsSkipped += result.jobsSkipped;
    await heartbeatRun(rc.runId, rc.counters, rc.now());
  }
}

export interface TickResult {
  runs: IngestRunSummary[];
  // Proxima ventana que todavia no cerro (o null si quedan atrasadas).
  caughtUp: boolean;
  // Sin politica activa: no se pidio nada a Alaris (en espera).
  waiting?: boolean;
}

/** Sin politica activa no se ingesta: el sistema queda en espera. */
export class NoActivePolicyError extends Error {
  constructor() {
    super("No hay politica activa: el sistema esta en espera. Activa una en Politicas.");
  }
}

async function hasActivePolicy(): Promise<boolean> {
  await policiesCache.refresh();
  return policiesCache.active().length > 0;
}

/**
 * Procesa las ventanas programadas que ya cerraron, en orden. Devuelve
 * null si otra ingesta tiene el lock (otra instancia, o /sync manual).
 * Si una ventana falla corta ahi: la proxima vez se reintenta la misma,
 * nunca se saltea.
 */
export async function runDueWindows(deps: IngestDeps = {}): Promise<TickResult | null> {
  const now = deps.now ?? (() => new Date());
  return withNamedLock(INGEST_LOCK, async () => {
    const interrupted = await failInterruptedRuns(now());
    if (interrupted > 0) log.warn("ingesta: corridas interrumpidas marcadas como failed", { interrupted });

    await applyChanges(now);
    // Sin politica activa no se le pide nada a Alaris ni se elige nada. Las
    // ventanas no se saltean: al activar una, se retoma desde el cursor.
    if (!(await hasActivePolicy())) {
      log.info("ingesta: en espera, no hay politica activa");
      return { runs: [], caughtUp: true, waiting: true };
    }
    const result = await dueWindows(deps, now);
    await sweepDays(now);
    return result;
  });
}

/** Cambios de politica que quedaron sin aplicar (ej. el proceso se corto). */
async function applyChanges(now: () => Date): Promise<void> {
  try {
    await runPendingChanges(now());
  } catch {
    // Ya se logueo; se reintenta en el proximo chequeo.
  }
}

/**
 * Aplica enseguida un cambio de politica recien hecho, con el lock de
 * ingesta. Si hay una ingesta corriendo, lo toma el proximo chequeo del
 * scheduler (o el proximo cambio).
 */
export function applyPolicyChangesSoon(): void {
  setImmediate(() => {
    withNamedLock(INGEST_LOCK, () => applyChanges(() => new Date())).catch((err) =>
      log.error("politicas: no se pudo aplicar el cambio", { error: errorMessage(err) })
    );
  });
}

/**
 * Politicas "dia vencido" (y sobras de ventanas fallidas): se eligen los dias
 * ya cerrados. Un dia esta cerrado cuando la ingesta programada ya paso su
 * fin; si nunca corrio, se toma el dia de hoy como abierto.
 */
async function sweepDays(now: () => Date): Promise<void> {
  try {
    await policiesCache.refresh();
    const cursor = (await lastCompletedScheduledEnd()) ?? now();
    const closedBefore = dayStartOf(cursor < now() ? cursor : now());
    const r = await sweepClosedDays(closedBefore, now());
    if (r.approved + r.skipped > 0) log.info("seleccion: dias cerrados", { ...r, closedBefore: closedBefore.toISOString() });
  } catch (err) {
    // Se reintenta en el proximo chequeo: los SMS siguen en_seleccion.
    log.error("seleccion: no se pudieron elegir los dias cerrados", { error: errorMessage(err) });
  }
}

async function dueWindows(deps: IngestDeps, now: () => Date): Promise<TickResult> {
  const runs: IngestRunSummary[] = [];
  for (let i = 0; i < config.scheduler.maxWindowsPerTick; i++) {
    const window = nextScheduledWindow(await lastCompletedScheduledEnd(), now(), {
      windowMinutes: config.scheduler.windowMinutes,
      safetyDelayMinutes: config.scheduler.safetyDelayMinutes,
      offsetMinutes: config.edr.timezoneOffsetMinutes,
      startDate: config.scheduler.startDate,
    });
    if (!window) return { runs, caughtUp: true };

    const run = await ingestWindow("scheduled", window, deps);
    runs.push(run);
    if (run.status === "failed") {
      const failures = await countFailuresForWindow(window.start);
      log.error("ingesta: la ventana fallo, se reintenta en el proximo tick", {
        windowStart: run.windowStart,
        failuresForWindow: failures,
        alert: failures >= 3,
      });
      return { runs, caughtUp: false };
    }
  }
  return { runs, caughtUp: false };
}

/** Ingesta de una ventana puntual (diagnostico/re-proceso). No mueve el cursor. */
export async function runManualWindow(
  window: TimeWindow,
  deps: IngestDeps = {}
): Promise<IngestRunSummary | null> {
  const now = deps.now ?? (() => new Date());
  return withNamedLock(INGEST_LOCK, async () => {
    if (!(await hasActivePolicy())) throw new NoActivePolicyError();
    await failInterruptedRuns(now());
    return ingestWindow("manual", window, deps);
  });
}
