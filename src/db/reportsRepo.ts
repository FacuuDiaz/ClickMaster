import type { RowDataPacket } from "mysql2";
import { pool } from "./pool";
import { lastCompletedScheduledEnd } from "./syncRunsRepo";

/**
 * Consultas de solo lectura para reportes. Todas paginan por keyset
 * (id < beforeId, ORDER BY id DESC): no hay OFFSET que se vuelva lento con
 * cientos de miles de filas ni respuestas con 20.000 registros.
 */

export interface Page<T> {
  items: T[];
  // Pasar como beforeId para la pagina siguiente. null = no hay mas.
  nextBeforeId: number | null;
}

function toPage<T extends { id: number }>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  return { items, nextBeforeId: rows.length > limit ? items[items.length - 1].id : null };
}

function mapRun(r: RowDataPacket) {
  return {
    id: Number(r.id),
    kind: r.kind,
    status: r.status,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    queryStart: r.query_start,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    heartbeatAt: r.heartbeat_at,
    durationMs: r.finished_at ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime() : null,
    apiRequests: r.api_requests,
    recordsReceived: r.records_received,
    recordsInvalid: r.records_invalid,
    smsNew: r.sms_new,
    smsExisting: r.sms_existing,
    jobsCreated: r.jobs_created,
    jobsSkipped: r.jobs_skipped,
    errors: r.errors,
    errorMessage: r.error_message,
    clientProductId: r.client_product_id,
    country: r.country,
  };
}

export async function listRuns(filters: {
  status?: string;
  kind?: string;
  beforeId?: number;
  limit: number;
}): Promise<Page<ReturnType<typeof mapRun>>> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    where.push("status = ?");
    params.push(filters.status);
  }
  if (filters.kind) {
    where.push("kind = ?");
    params.push(filters.kind);
  }
  if (filters.beforeId) {
    where.push("id < ?");
    params.push(filters.beforeId);
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM sync_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY id DESC LIMIT ?`,
    [...params, filters.limit + 1]
  );
  return toPage(rows.map(mapRun), filters.limit);
}

export async function getRun(id: number) {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM sync_runs WHERE id = ?`, [id]);
  if (rows.length === 0) return null;
  const [jobs] = await pool.query<RowDataPacket[]>(
    `SELECT status, COUNT(*) AS n FROM sms_processing WHERE ingest_run_id = ? GROUP BY status`,
    [id]
  );
  return {
    ...mapRun(rows[0]),
    jobsByStatus: Object.fromEntries(jobs.map((j) => [j.status, Number(j.n)])),
  };
}

export async function ingestStatus() {
  const [last] = await pool.query<RowDataPacket[]>(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1`);
  return {
    lastRun: last.length ? mapRun(last[0]) : null,
    cursor: await lastCompletedScheduledEnd(),
  };
}

// Fallas tecnicas (de la infraestructura o la red), separadas de las del sitio.
const TECHNICAL_OUTCOMES = ["timeout", "conexion", "dns", "error_interno", "reserva_vencida"];

export async function processingSummary(filters: { from?: Date; to?: Date }, maxAttempts: number) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.from) {
    where.push("edr_date >= ?");
    params.push(filters.from);
  }
  if (filters.to) {
    where.push("edr_date < ?");
    params.push(filters.to);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [byStatus] = await pool.query<RowDataPacket[]>(
    `SELECT status, COUNT(*) AS n, SUM(attempts > 1) AS retried,
            SUM(status = 'failed' AND attempts >= ?) AS exhausted,
            AVG(CASE WHEN status IN ('success', 'failed')
                     THEN TIMESTAMPDIFF(SECOND, created_at, last_attempt_at) END) AS avg_wait_s
       FROM sms_processing ${whereSql}
      GROUP BY status`,
    [maxAttempts, ...params]
  );
  const [byOutcome] = await pool.query<RowDataPacket[]>(
    `SELECT last_outcome, COUNT(*) AS n FROM sms_processing
      ${whereSql ? `${whereSql} AND` : "WHERE"} last_outcome IS NOT NULL
      GROUP BY last_outcome`,
    params
  );
  const [bySkip] = await pool.query<RowDataPacket[]>(
    `SELECT skip_reason, COUNT(*) AS n FROM sms_processing
      ${whereSql ? `${whereSql} AND` : "WHERE"} status = 'skipped'
      GROUP BY skip_reason`,
    params
  );
  const [oldest] = await pool.query<RowDataPacket[]>(
    `SELECT MIN(next_attempt_at) AS oldest FROM sms_processing WHERE next_attempt_at <= ?`,
    [new Date()]
  );
  const [lastHour] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS checks, SUM(outcome = 'cargada') AS loaded, AVG(response_time_ms) AS avg_ms
       FROM sms_link_checks WHERE checked_at >= ?`,
    [new Date(Date.now() - 60 * 60 * 1000)]
  );

  const counts: Record<string, number> = {};
  let retried = 0;
  let exhausted = 0;
  let waitSum = 0;
  let waitN = 0;
  for (const row of byStatus) {
    counts[row.status] = Number(row.n);
    retried += Number(row.retried ?? 0);
    exhausted += Number(row.exhausted ?? 0);
    if (row.avg_wait_s !== null) {
      waitSum += Number(row.avg_wait_s) * Number(row.n);
      waitN += Number(row.n);
    }
  }
  const outcomes = Object.fromEntries(byOutcome.map((r) => [r.last_outcome, Number(r.n)]));
  const technicalErrors = TECHNICAL_OUTCOMES.reduce((sum, o) => sum + (outcomes[o] ?? 0), 0);
  const oldestReady = oldest[0].oldest ? new Date(oldest[0].oldest) : null;

  return {
    range: { from: filters.from ?? null, to: filters.to ?? null },
    pending: counts.pending ?? 0,
    processing: counts.processing ?? 0,
    retry: counts.retry ?? 0,
    success: counts.success ?? 0,
    failed: counts.failed ?? 0,
    skipped: counts.skipped ?? 0,
    skippedByReason: Object.fromEntries(bySkip.map((r) => [r.skip_reason, Number(r.n)])),
    retried,
    exhaustedAttempts: exhausted,
    technicalErrors,
    outcomes,
    // Espera promedio entre que se encola y su ultimo intento (trabajos terminados).
    avgQueueWaitSeconds: waitN ? Math.round(waitSum / waitN) : null,
    oldestReadySince: oldestReady,
    queueLagSeconds: oldestReady ? Math.round((Date.now() - oldestReady.getTime()) / 1000) : 0,
    lastHour: {
      checks: Number(lastHour[0].checks),
      loaded: Number(lastHour[0].loaded ?? 0),
      avgResponseTimeMs: lastHour[0].avg_ms === null ? null : Math.round(Number(lastHour[0].avg_ms)),
    },
  };
}

export interface JobFilters {
  status?: string;
  outcome?: string;
  from?: Date;
  to?: Date;
  country?: string;
  clientProductId?: string;
  runId?: number;
  smsContentId?: number;
  beforeId?: number;
  limit: number;
}

export async function listJobs(f: JobFilters) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    where.push(sql);
    params.push(value);
  };
  if (f.status) add("p.status = ?", f.status);
  if (f.outcome) add("p.last_outcome = ?", f.outcome);
  if (f.from) add("p.edr_date >= ?", f.from);
  if (f.to) add("p.edr_date < ?", f.to);
  if (f.country) add("c.country = ?", f.country);
  if (f.clientProductId) add("r.client_product_id = ?", f.clientProductId);
  if (f.runId) add("p.ingest_run_id = ?", f.runId);
  if (f.smsContentId) add("p.sms_content_id = ?", f.smsContentId);
  if (f.beforeId) add("p.id < ?", f.beforeId);

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT p.id, p.sms_content_id, p.client_message_id, p.vendor_message_id, p.ingest_run_id,
            p.edr_date, p.status, p.skip_reason, p.attempts, p.next_attempt_at, p.created_at,
            p.last_attempt_at, p.finished_at, p.last_outcome, p.last_error,
            c.country, c.client, c.status AS sms_status
       FROM sms_processing p
       LEFT JOIN sms_content c ON c.id = p.sms_content_id
       ${f.clientProductId ? "LEFT JOIN sync_runs r ON r.id = p.ingest_run_id" : ""}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY p.id DESC
      LIMIT ?`,
    [...params, f.limit + 1]
  );
  return toPage(
    rows.map((r) => ({
      id: Number(r.id),
      smsContentId: Number(r.sms_content_id),
      clientMessageId: r.client_message_id,
      vendorMessageId: r.vendor_message_id,
      ingestRunId: r.ingest_run_id === null ? null : Number(r.ingest_run_id),
      edrDate: r.edr_date,
      status: r.status,
      skipReason: r.skip_reason,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at,
      createdAt: r.created_at,
      lastAttemptAt: r.last_attempt_at,
      finishedAt: r.finished_at,
      lastOutcome: r.last_outcome,
      lastError: r.last_error,
      country: r.country,
      client: r.client,
      smsStatus: r.sms_status,
    })),
    f.limit
  );
}

/** Detalle de un trabajo: datos basicos del SMS y todos sus intentos. */
export async function getJob(id: number) {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT * FROM sms_processing WHERE id = ?`, [id]);
  if (rows.length === 0) return null;
  const job = rows[0];
  // tech_details_json no se devuelve: es grande y no aporta para diagnosticar el link.
  const [sms] = await pool.query<RowDataPacket[]>(
    `SELECT id, edr_date, cdr_delivery_time, client, country, network, sender_name, status, text,
            client_message_id, vendor_message_id
       FROM sms_content WHERE id = ?`,
    [job.sms_content_id]
  );
  const [checks] = await pool.query<RowDataPacket[]>(
    `SELECT id, attempt, outcome, http_status, is_ok, response_time_ms, link, final_url, redirects,
            started_at, checked_at, error_message, worker_id
       FROM sms_link_checks
      WHERE processing_id = ? OR (processing_id IS NULL AND sms_content_id = ?)
      ORDER BY id`,
    [id, job.sms_content_id]
  );
  return { job, sms: sms[0] ?? null, checks };
}
