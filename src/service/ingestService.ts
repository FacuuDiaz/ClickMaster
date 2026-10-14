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
import { persistSmsBatch } from "./ingestBatch";

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
    await ingestRange(query, { fetcher, now, runId, counters, invalidSamples, ctx });
    status = counters.recordsInvalid > 0 ? "partial" : "success";
    if (status === "partial") {
      error = `${counters.recordsInvalid} registros invalidos. Ej: ${invalidSamples.join(" | ")}`;
    }
  } catch (err) {
    status = "failed";
    counters.errors++;
    error = errorMessage(err);
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
  fetcher: EdrFetcher;
  now: () => Date;
  runId: number;
  counters: RunCounters;
  invalidSamples: string[];
  ctx: Record<string, unknown>;
}

async function ingestRange(range: TimeWindow, rc: RangeContext): Promise<void> {
  let records: unknown[] | null = await rc.fetcher(range);
  rc.counters.apiRequests++;

  // La API no pagina y corta en EDR_MAX_ROWS_PER_REQUEST filas: si la
  // respuesta llego al tope puede estar truncada. Se descarta y se pide de
  // nuevo en dos mitades, hasta EDR_MIN_SPLIT_SECONDS.
  if (config.edr.maxRowsPerRequest > 0 && records.length >= config.edr.maxRowsPerRequest) {
    const spanSeconds = (range.end.getTime() - range.start.getTime()) / 1000;
    if (spanSeconds / 2 < config.edr.minSplitSeconds) {
      throw new TruncatedResponseError(
        `La API devolvio ${records.length} filas (el tope) para un rango de ${spanSeconds}s: ` +
          `la respuesta puede estar truncada. Bajar EDR_MIN_SPLIT_SECONDS o revisar EDR_MAX_ROWS_PER_REQUEST`
      );
    }
    log.info("ingesta: respuesta en el tope, se parte el rango", {
      ...rc.ctx,
      rows: records.length,
      start: range.start.toISOString(),
      end: range.end.toISOString(),
    });
    records = null;
    for (const half of splitRange(range)) {
      await ingestRange(half, rc);
    }
    return;
  }

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
      }
    }

    const result = await persistSmsBatch(valid, rc.runId, config.checker.clickPercentage, rc.now());
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
  });
}

/** Ingesta de una ventana puntual (diagnostico/re-proceso). No mueve el cursor. */
export async function runManualWindow(
  window: TimeWindow,
  deps: IngestDeps = {}
): Promise<IngestRunSummary | null> {
  const now = deps.now ?? (() => new Date());
  return withNamedLock(INGEST_LOCK, async () => {
    await failInterruptedRuns(now());
    return ingestWindow("manual", window, deps);
  });
}
