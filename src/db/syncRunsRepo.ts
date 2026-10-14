import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool } from "./pool";

export type RunKind = "scheduled" | "manual";
export type RunStatus = "running" | "success" | "partial" | "failed";

export interface RunCounters {
  apiRequests: number;
  recordsReceived: number;
  recordsInvalid: number;
  smsNew: number;
  smsExisting: number;
  jobsCreated: number;
  jobsSkipped: number;
  errors: number;
}

export function emptyCounters(): RunCounters {
  return {
    apiRequests: 0,
    recordsReceived: 0,
    recordsInvalid: 0,
    smsNew: 0,
    smsExisting: 0,
    jobsCreated: 0,
    jobsSkipped: 0,
    errors: 0,
  };
}

export async function createRun(params: {
  kind: RunKind;
  windowStart: Date;
  windowEnd: Date;
  queryStart: Date;
  clientProductId: string | null;
  country: string | null;
  now: Date;
}): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO sync_runs
       (kind, window_start, window_end, query_start, status, started_at, heartbeat_at,
        client_product_id, country)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    [
      params.kind,
      params.windowStart,
      params.windowEnd,
      params.queryStart,
      params.now,
      params.now,
      params.clientProductId,
      params.country,
    ]
  );
  return result.insertId;
}

/** Guarda los contadores parciales: si el proceso muere se ve hasta donde llego. */
export async function heartbeatRun(id: number, counters: RunCounters, now: Date): Promise<void> {
  await pool.query(
    `UPDATE sync_runs SET heartbeat_at = ?, api_requests = ?, records_received = ?,
       records_invalid = ?, sms_new = ?, sms_existing = ?, jobs_created = ?, jobs_skipped = ?, errors = ?
     WHERE id = ?`,
    [
      now,
      counters.apiRequests,
      counters.recordsReceived,
      counters.recordsInvalid,
      counters.smsNew,
      counters.smsExisting,
      counters.jobsCreated,
      counters.jobsSkipped,
      counters.errors,
      id,
    ]
  );
}

export async function finishRun(
  id: number,
  status: Exclude<RunStatus, "running">,
  counters: RunCounters,
  errorMessage: string | null,
  now: Date
): Promise<void> {
  await heartbeatRun(id, counters, now);
  await pool.query(
    `UPDATE sync_runs SET status = ?, finished_at = ?, error_message = ? WHERE id = ?`,
    [status, now, errorMessage ? errorMessage.slice(0, 1024) : null, id]
  );
}

/**
 * Corridas que quedaron en "running" de un proceso que murio. Solo se
 * llama con el lock de ingesta tomado: ahi seguro no hay otra corriendo.
 */
export async function failInterruptedRuns(now: Date): Promise<number> {
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE sync_runs
        SET status = 'failed', finished_at = ?,
            error_message = 'corrida interrumpida (el proceso se detuvo antes de terminar)'
      WHERE status = 'running'`,
    [now]
  );
  return result.affectedRows;
}

/**
 * Fin de la ultima ventana programada completa. Las ventanas se procesan
 * en orden y el scheduler nunca saltea una que fallo, asi que el maximo
 * es tambien el borde de lo contiguo.
 */
export async function lastCompletedScheduledEnd(): Promise<Date | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT MAX(window_end) AS window_end FROM sync_runs
      WHERE kind = 'scheduled' AND status IN ('success', 'partial')`
  );
  return rows[0].window_end ? new Date(rows[0].window_end) : null;
}

/** Fallos seguidos de la ventana que empieza en windowStart (para loguear y alertar). */
export async function countFailuresForWindow(windowStart: Date): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM sync_runs
      WHERE kind = 'scheduled' AND status = 'failed' AND window_start = ?`,
    [windowStart]
  );
  return Number(rows[0].n);
}
