import type { RowDataPacket } from "mysql2";
import { reportsPool } from "./reportsPool";

/**
 * Consultas del dashboard. Todas por reportsPool (solo lectura, con
 * timeout) y acotadas a un rango de tiempo:
 * - Los graficos agregan por bucket leyendo solo indices
 *   (idx_checked_outcome, idx_created_at): no se leen filas completas.
 * - Los listados paginan por keyset (fecha, id) sobre el indice de fecha:
 *   cada pagina lee ~limit filas, sin OFFSET ni COUNT(*) del total.
 */

// Los 11 outcomes se agrupan en 4 para graficar (mas de 4-5 series apiladas
// no se leen). El detalle sigue en el listado y en /processing/jobs.
export const OUTCOME_GROUPS = {
  cargada: ["cargada"],
  sitio: ["http_4xx", "http_5xx", "http_429_408", "certificado", "navegacion"],
  indeterminado: ["indeterminado"],
  tecnico: ["timeout", "dns", "conexion", "error_interno", "reserva_vencida"],
} as const;
export type OutcomeGroup = keyof typeof OUTCOME_GROUPS;

const BUCKET_STEPS_S = [60, 300, 900, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400];
const MAX_BUCKETS = 60;

/** Bucket mas chico que deja el grafico en <= 60 columnas. */
export function bucketSeconds(from: Date, to: Date): number {
  const rangeS = (to.getTime() - from.getTime()) / 1000;
  return BUCKET_STEPS_S.find((s) => rangeS / s <= MAX_BUCKETS) ?? 86400;
}

function list(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(", ");
}

export interface ChecksBucket {
  t: number; // inicio del bucket, epoch ms
  cargada: number;
  sitio: number;
  indeterminado: number;
  tecnico: number;
  total: number;
  // Promedio de carga solo de las paginas que cargaron: los timeouts
  // (15 s) distorsionarian el promedio.
  avgLoadMs: number | null;
}

export async function checksSeries(from: Date, to: Date, stepS: number): Promise<ChecksBucket[]> {
  const g = OUTCOME_GROUPS;
  const [rows] = await reportsPool.query<RowDataPacket[]>(
    `SELECT FLOOR(UNIX_TIMESTAMP(checked_at) / ?) * ? AS b,
            SUM(outcome = 'cargada') AS cargada,
            SUM(outcome IN (${list(g.sitio)})) AS sitio,
            -- outcome NULL = intentos de la version anterior, sin clasificar
            SUM(outcome = 'indeterminado' OR outcome IS NULL) AS indeterminado,
            SUM(outcome IN (${list(g.tecnico)})) AS tecnico,
            COUNT(*) AS total,
            SUM(IF(outcome = 'cargada', response_time_ms, 0)) AS load_sum
       FROM sms_link_checks FORCE INDEX (idx_checked_outcome)
      WHERE checked_at >= ? AND checked_at < ?
      GROUP BY b
      ORDER BY b`,
    [stepS, stepS, from, to]
  );
  return rows.map((r) => {
    const cargada = Number(r.cargada);
    return {
      t: Number(r.b) * 1000,
      cargada,
      sitio: Number(r.sitio),
      indeterminado: Number(r.indeterminado),
      tecnico: Number(r.tecnico),
      total: Number(r.total),
      avgLoadMs: cargada > 0 ? Math.round(Number(r.load_sum) / cargada) : null,
    };
  });
}

export interface IngestBucket {
  t: number;
  sms: number;
}

export async function ingestSeries(from: Date, to: Date, stepS: number): Promise<IngestBucket[]> {
  const [rows] = await reportsPool.query<RowDataPacket[]>(
    `SELECT FLOOR(UNIX_TIMESTAMP(created_at) / ?) * ? AS b, COUNT(*) AS n
       FROM sms_processing FORCE INDEX (idx_created_at)
      WHERE created_at >= ? AND created_at < ?
      GROUP BY b
      ORDER BY b`,
    [stepS, stepS, from, to]
  );
  return rows.map((r) => ({ t: Number(r.b) * 1000, sms: Number(r.n) }));
}

/**
 * Foto de la cola ahora (no depende del rango). Lee solo las filas en
 * pending/retry/processing por idx_status_edr_date: es poco aunque la
 * tabla tenga millones de terminadas.
 */
export async function queueSnapshot() {
  const [rows] = await reportsPool.query<RowDataPacket[]>(
    `SELECT status, COUNT(*) AS n FROM sms_processing
      WHERE status IN ('pending', 'retry', 'processing')
      GROUP BY status`
  );
  const [oldest] = await reportsPool.query<RowDataPacket[]>(
    `SELECT MIN(next_attempt_at) AS oldest FROM sms_processing WHERE next_attempt_at <= ?`,
    [new Date()]
  );
  const counts = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  const oldestReady = oldest[0].oldest ? new Date(oldest[0].oldest) : null;
  return {
    pending: counts.pending ?? 0,
    retry: counts.retry ?? 0,
    processing: counts.processing ?? 0,
    lagSeconds: oldestReady ? Math.max(0, Math.round((Date.now() - oldestReady.getTime()) / 1000)) : 0,
  };
}

export async function lastRun() {
  const [rows] = await reportsPool.query<RowDataPacket[]>(
    `SELECT id, kind, status, window_start, window_end, started_at, finished_at,
            records_received, jobs_created, error_message
       FROM sync_runs ORDER BY id DESC LIMIT 1`
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: Number(r.id),
    kind: r.kind,
    status: r.status,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    recordsReceived: Number(r.records_received),
    jobsCreated: Number(r.jobs_created),
    errorMessage: r.error_message,
  };
}

// ---------- Listados paginados (keyset por fecha + id) ----------

export interface Cursor {
  at: Date;
  id: number;
}

/** "epochMs_id": opaco para el cliente, se devuelve tal cual. */
export function encodeCursor(at: Date, id: number): string {
  return `${at.getTime()}_${id}`;
}

export function decodeCursor(value: string): Cursor | null {
  const m = /^(\d+)_(\d+)$/.exec(value);
  return m ? { at: new Date(Number(m[1])), id: Number(m[2]) } : null;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

export async function listChecks(params: {
  from: Date;
  to: Date;
  group?: OutcomeGroup;
  cursor?: Cursor;
  limit: number;
}): Promise<PageResult<Record<string, unknown>>> {
  const where = ["checked_at >= ?", "checked_at < ?"];
  const args: unknown[] = [params.from, params.to];
  if (params.group) {
    where.push(
      params.group === "indeterminado"
        ? "(outcome = 'indeterminado' OR outcome IS NULL)"
        : `outcome IN (${list(OUTCOME_GROUPS[params.group])})`
    );
  }
  if (params.cursor) {
    where.push("(checked_at < ? OR (checked_at = ? AND id < ?))");
    args.push(params.cursor.at, params.cursor.at, params.cursor.id);
  }
  const [rows] = await reportsPool.query<RowDataPacket[]>(
    `SELECT id, processing_id, sms_content_id, attempt, outcome, http_status, response_time_ms,
            link, final_url, redirects, checked_at, error_message
       FROM sms_link_checks FORCE INDEX (idx_checked_at)
      WHERE ${where.join(" AND ")}
      ORDER BY checked_at DESC, id DESC
      LIMIT ?`,
    [...args, params.limit + 1]
  );
  const items = rows.slice(0, params.limit).map((r) => ({
    id: Number(r.id),
    jobId: r.processing_id === null ? null : Number(r.processing_id),
    smsContentId: Number(r.sms_content_id),
    attempt: r.attempt,
    outcome: r.outcome,
    httpStatus: r.http_status,
    responseTimeMs: r.response_time_ms,
    link: r.link,
    finalUrl: r.final_url,
    redirects: r.redirects,
    checkedAt: r.checked_at,
    error: r.error_message,
  }));
  const last = rows[params.limit - 1];
  return {
    items,
    nextCursor: rows.length > params.limit ? encodeCursor(new Date(last.checked_at), Number(last.id)) : null,
  };
}

export async function listSms(params: {
  from: Date;
  to: Date;
  status?: string;
  cursor?: Cursor;
  limit: number;
}): Promise<PageResult<Record<string, unknown>>> {
  const where = ["p.created_at >= ?", "p.created_at < ?"];
  const args: unknown[] = [params.from, params.to];
  if (params.status) {
    where.push("p.status = ?");
    args.push(params.status);
  }
  if (params.cursor) {
    where.push("(p.created_at < ? OR (p.created_at = ? AND p.id < ?))");
    args.push(params.cursor.at, params.cursor.at, params.cursor.id);
  }
  // El JOIN a sms_content es por PRIMARY KEY y solo para las filas de la pagina.
  const [rows] = await reportsPool.query<RowDataPacket[]>(
    `SELECT p.id, p.sms_content_id, p.status, p.skip_reason, p.attempts, p.last_outcome,
            p.last_error, p.edr_date, p.created_at, p.finished_at,
            c.client, c.sender_name, c.status AS sms_status, LEFT(c.text, 300) AS text
       FROM sms_processing p FORCE INDEX (idx_created_at)
       LEFT JOIN sms_content c ON c.id = p.sms_content_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ?`,
    [...args, params.limit + 1]
  );
  const items = rows.slice(0, params.limit).map((r) => ({
    id: Number(r.id),
    smsContentId: Number(r.sms_content_id),
    status: r.status,
    skipReason: r.skip_reason,
    attempts: r.attempts,
    lastOutcome: r.last_outcome,
    lastError: r.last_error,
    edrDate: r.edr_date,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
    client: r.client,
    sender: r.sender_name,
    smsStatus: r.sms_status,
    text: r.text,
  }));
  const last = rows[params.limit - 1];
  return {
    items,
    nextCursor: rows.length > params.limit ? encodeCursor(new Date(last.created_at), Number(last.id)) : null,
  };
}
