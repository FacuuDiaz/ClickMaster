import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool, withTransaction, type DbConnection } from "./pool";
import { messageKey } from "./smsContentRepo";

/**
 * Cola persistente de verificaciones sobre sms_processing.
 *
 * Maquina de estados:
 *   pending ──claim──> processing ──ok──────────────> success
 *   retry   ──claim──┘      │──fallo transitorio────> retry  (si quedan intentos)
 *                           │──fallo definitivo─────> failed
 *                           │──intentos agotados────> failed
 *                           └──reserva vencida──────> retry / failed (recoverExpiredLeases)
 *   skipped: nunca entra a la cola (sin link o fuera de la muestra).
 */
export type JobStatus = "pending" | "processing" | "retry" | "success" | "failed" | "skipped";
export type SkipReason = "sin_link" | "fuera_de_muestra";

const MAX_ERROR_LENGTH = 255;

function truncate(value: string | null | undefined, max = MAX_ERROR_LENGTH): string | null {
  return value ? value.slice(0, max) : null;
}

// ---------- Ingesta ----------

export interface MessageIdentity {
  clientMessageId: string;
  vendorMessageId: string;
}

/** Identidades del lote que ya tienen fila en sms_processing -> sms_content_id. */
export async function findProcessingIdentities(
  conn: DbConnection,
  keys: MessageIdentity[]
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  if (keys.length === 0) return found;
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT client_message_id, vendor_message_id, sms_content_id
       FROM sms_processing
      WHERE (client_message_id, vendor_message_id) IN (?)`,
    [keys.map((k) => [k.clientMessageId, k.vendorMessageId])]
  );
  for (const row of rows) {
    found.set(messageKey(row.client_message_id, row.vendor_message_id), Number(row.sms_content_id));
  }
  return found;
}

export interface NewJob {
  smsContentId: number;
  clientMessageId: string;
  vendorMessageId: string;
  ingestRunId: number | null;
  edrDate: Date;
  status: "pending" | "skipped";
  skipReason: SkipReason | null;
}

/**
 * Crea las filas de identidad/trabajo. ON DUPLICATE KEY UPDATE id = id deja
 * intacta una fila existente: un SMS que la API vuelve a mandar nunca
 * genera un segundo trabajo ni le pisa el estado al que ya tiene.
 */
export async function insertJobs(conn: DbConnection, jobs: NewJob[], now: Date): Promise<void> {
  if (jobs.length === 0) return;
  await conn.query(
    `INSERT INTO sms_processing
       (sms_content_id, client_message_id, vendor_message_id, ingest_run_id, edr_date,
        status, skip_reason, next_attempt_at, created_at, finished_at)
     VALUES ?
     ON DUPLICATE KEY UPDATE id = id`,
    [
      jobs.map((j) => [
        j.smsContentId,
        j.clientMessageId,
        j.vendorMessageId,
        j.ingestRunId,
        j.edrDate,
        j.status,
        j.skipReason,
        j.status === "pending" ? now : null,
        now,
        j.status === "skipped" ? now : null,
      ]),
    ]
  );
}

// ---------- Worker ----------

export interface ClaimedJob {
  id: number;
  smsContentId: number;
  attempt: number;
  ingestRunId: number | null;
  // null si la fila de sms_content ya no existe.
  text: string | null;
}

/**
 * Reclama hasta `limit` trabajos listos. SELECT ... FOR UPDATE SKIP LOCKED
 * en una transaccion corta: dos workers (de este u otro proceso) nunca
 * agarran la misma fila, y ninguno espera a que el otro termine su
 * transaccion. La reserva (locked_by / locked_until) es lo que protege el
 * trabajo despues del COMMIT, mientras Playwright corre sin locks de base.
 * Requiere MySQL 8.0.1+ o MariaDB 10.6+.
 */
export async function claimJobs(
  workerId: string,
  limit: number,
  now: Date,
  leaseMs: number
): Promise<ClaimedJob[]> {
  const ids = await withTransaction(async (conn) => {
    const [rows] = await conn.query<RowDataPacket[]>(
      // FORCE INDEX: sin el, con casi toda la tabla lista el optimizador
      // elige full scan + filesort, y FOR UPDATE bloquea TODAS las filas que
      // lee (los demas workers las saltean y no reclaman nada). Recorriendo
      // el indice en orden, LIMIT corta y solo se bloquean las N reclamadas.
      `SELECT id FROM sms_processing FORCE INDEX (idx_next_attempt)
        WHERE next_attempt_at <= ? AND status IN ('pending', 'retry')
        ORDER BY next_attempt_at, id
        LIMIT ?
        FOR UPDATE SKIP LOCKED`,
      [now, limit]
    );
    const claimed = rows.map((r) => Number(r.id));
    if (claimed.length === 0) return claimed;
    await conn.query(
      `UPDATE sms_processing
          SET status = 'processing', attempts = attempts + 1, locked_by = ?, locked_until = ?,
              last_attempt_at = ?, next_attempt_at = NULL
        WHERE id IN (?)`,
      [workerId, new Date(now.getTime() + leaseMs), now, claimed]
    );
    return claimed;
  }, { isolation: "READ COMMITTED", retries: 3 });
  if (ids.length === 0) return [];

  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT p.id, p.sms_content_id, p.attempts, p.ingest_run_id, c.text
       FROM sms_processing p
       LEFT JOIN sms_content c ON c.id = p.sms_content_id
      WHERE p.id IN (?)
      ORDER BY p.id`,
    [ids]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    smsContentId: Number(r.sms_content_id),
    attempt: Number(r.attempts),
    ingestRunId: r.ingest_run_id === null ? null : Number(r.ingest_run_id),
    text: r.text ?? null,
  }));
}

/**
 * Confirma que la reserva sigue siendo de este worker y la extiende justo
 * antes de abrir el navegador. Si vencio y otro worker la tomo, devuelve
 * false y la visita no se hace.
 */
export async function confirmLease(
  jobId: number,
  workerId: string,
  lockedUntil: Date
): Promise<boolean> {
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE sms_processing SET locked_until = ?
      WHERE id = ? AND status = 'processing' AND locked_by = ?`,
    [lockedUntil, jobId, workerId]
  );
  return result.affectedRows === 1;
}

export interface AttemptResult {
  jobId: number;
  workerId: string;
  smsContentId: number;
  attempt: number;
  link: string;
  startedAt: Date;
  finishedAt: Date;
  httpStatus: number | null;
  ok: boolean;
  outcome: string;
  responseTimeMs: number | null;
  finalUrl: string | null;
  redirects: number;
  errorMessage: string | null;
  nextStatus: "success" | "retry" | "failed";
  nextAttemptAt: Date | null;
}

/**
 * Guarda el intento en sms_link_checks y actualiza el trabajo, en una
 * transaccion corta. El intento se guarda SIEMPRE (trazabilidad); el
 * estado solo cambia si la reserva sigue siendo de este worker. Si otro
 * la tomo mientras tanto, gana el estado que deje ese otro worker.
 * Devuelve si el estado del trabajo se actualizo.
 */
export async function completeAttempt(r: AttemptResult): Promise<boolean> {
  return withTransaction(async (conn) => {
    await conn.query(
      `INSERT INTO sms_link_checks
         (sms_content_id, link, checked_at, http_status, is_ok, response_time_ms, error_message,
          processing_id, attempt, outcome, final_url, redirects, started_at, worker_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.smsContentId,
        r.link.slice(0, 2048),
        r.finishedAt,
        r.httpStatus,
        r.ok ? 1 : 0,
        r.responseTimeMs,
        truncate(r.errorMessage),
        r.jobId,
        r.attempt,
        r.outcome,
        r.finalUrl ? r.finalUrl.slice(0, 2048) : null,
        r.redirects,
        r.startedAt,
        r.workerId,
      ]
    );
    const [result] = await conn.query<ResultSetHeader>(
      `UPDATE sms_processing
          SET status = ?, next_attempt_at = ?, locked_by = NULL, locked_until = NULL,
              finished_at = ?, last_outcome = ?, last_error = ?
        WHERE id = ? AND status = 'processing' AND locked_by = ?`,
      [
        r.nextStatus,
        r.nextStatus === "retry" ? r.nextAttemptAt : null,
        r.nextStatus === "retry" ? null : r.finishedAt,
        r.outcome,
        truncate(r.errorMessage),
        r.jobId,
        r.workerId,
      ]
    );
    return result.affectedRows === 1;
  }, { retries: 3 });
}

/** Cierra un trabajo sin visita (ej. el SMS ya no existe o no tiene link). */
export async function finishWithoutVisit(
  jobId: number,
  workerId: string,
  status: "failed" | "skipped",
  reason: string,
  now: Date
): Promise<void> {
  await pool.query(
    `UPDATE sms_processing
        SET status = ?, skip_reason = ?, next_attempt_at = NULL, locked_by = NULL,
            locked_until = NULL, finished_at = ?, last_error = ?
      WHERE id = ? AND status = 'processing' AND locked_by = ?`,
    [status, status === "skipped" ? reason.slice(0, 32) : null, now, truncate(reason), jobId, workerId]
  );
}

/**
 * Devuelve a la cola trabajos reclamados que todavia no arrancaron (ej. al
 * pausar el worker para un job de clicks manual): se descuenta el intento
 * que no llego a hacerse y quedan listos para reclamar de nuevo.
 */
export async function releaseJobs(jobIds: number[], workerId: string, now: Date): Promise<number> {
  if (jobIds.length === 0) return 0;
  // MySQL evalua el SET de izquierda a derecha: status usa attempts antes de restarle 1.
  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE sms_processing
        SET status = IF(attempts > 1, 'retry', 'pending'), attempts = attempts - 1,
            next_attempt_at = ?, locked_by = NULL, locked_until = NULL
      WHERE id IN (?) AND status = 'processing' AND locked_by = ?`,
    [now, jobIds, workerId]
  );
  return result.affectedRows;
}

/**
 * Recupera trabajos abandonados: reservas vencidas (worker o container que
 * murio a mitad de una visita). Vuelven a retry, o a failed si ya no les
 * quedan intentos. Con `ownerPrefix` tambien libera al toque las reservas
 * de un proceso anterior del mismo container (despues de un reinicio no
 * hace falta esperar a que venzan).
 */
export async function recoverExpiredLeases(
  now: Date,
  maxAttempts: number,
  options: { ownerPrefix?: string; excludeOwner?: string; force?: boolean } = {}
): Promise<number> {
  const conditions = ["status = 'processing'"];
  const params: unknown[] = [];
  if (options.force) {
    // Recuperacion manual: todo lo que este en processing, sin mirar el vencimiento.
  } else if (options.ownerPrefix) {
    conditions.push("(locked_until < ? OR (locked_by LIKE ? AND locked_by <> ?))");
    params.push(now, `${options.ownerPrefix}%`, options.excludeOwner ?? "");
  } else {
    conditions.push("locked_until < ?");
    params.push(now);
  }

  const [result] = await pool.query<ResultSetHeader>(
    `UPDATE sms_processing
        SET status = IF(attempts >= ?, 'failed', 'retry'),
            next_attempt_at = IF(attempts >= ?, NULL, ?),
            finished_at = IF(attempts >= ?, ?, NULL),
            last_outcome = 'reserva_vencida',
            last_error = 'reserva vencida: el worker se detuvo o no respondio a tiempo',
            locked_by = NULL, locked_until = NULL
      WHERE ${conditions.join(" AND ")}`,
    [maxAttempts, maxAttempts, now, maxAttempts, now, ...params]
  );
  return result.affectedRows;
}

/** Cantidad de trabajos listos para reclamar (para logs y metricas). */
export async function countReadyJobs(now: Date): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM sms_processing WHERE next_attempt_at <= ?`,
    [now]
  );
  return Number(rows[0].n);
}
