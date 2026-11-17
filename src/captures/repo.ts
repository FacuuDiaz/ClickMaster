import { promisify } from "util";
import { gunzip as gunzipCb, gzip as gzipCb } from "zlib";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { config } from "../config";
import { pool } from "../db/pool";
import { parseJsonColumn } from "../db/auditRepo";
import { errorMessage, log } from "../logger";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

/**
 * Capturas de respuestas de Alaris: copias temporales para inspeccionar y
 * decidir. Origen:
 * - ingesta: respuesta completa de una ventana (modo "todas").
 * - error: respuesta que no se pudo usar (JSON invalido, error JSON-RPC...).
 * - invalidos: solo los registros que no pasaron la validacion.
 * - manual: rango pedido desde la web sin ingestar.
 */
export type CaptureOrigin = "ingesta" | "error" | "invalidos" | "manual";
export type CaptureStatus = "nueva" | "conservada" | "reprocesada";

export interface NewCapture {
  runId: number | null;
  origin: CaptureOrigin;
  rangeStart: Date;
  rangeEnd: Date;
  requestArgs: Record<string, unknown>;
  body: string;
  errorMessage?: string | null;
  rowsCount?: number | null;
  createdBy?: string | null;
}

export interface CaptureMeta {
  id: number;
  runId: number | null;
  origin: CaptureOrigin;
  rangeStart: Date;
  rangeEnd: Date;
  requestArgs: unknown;
  errorMessage: string | null;
  rowsCount: number | null;
  bytes: number;
  gzBytes: number;
  summary: unknown;
  status: CaptureStatus;
  note: string | null;
  createdAt: Date;
  createdBy: string | null;
  expiresAt: Date | null;
}

const META_COLUMNS = `id, run_id, origin, range_start, range_end, request_args, error_message, rows_count,
  bytes, gz_bytes, summary, status, note, created_at, created_by, expires_at`;

function mapMeta(r: RowDataPacket): CaptureMeta {
  return {
    id: Number(r.id),
    runId: r.run_id === null ? null : Number(r.run_id),
    origin: r.origin,
    rangeStart: r.range_start,
    rangeEnd: r.range_end,
    requestArgs: parseJsonColumn(r.request_args),
    errorMessage: r.error_message,
    rowsCount: r.rows_count === null ? null : Number(r.rows_count),
    bytes: Number(r.bytes),
    gzBytes: Number(r.gz_bytes),
    summary: parseJsonColumn(r.summary),
    status: r.status,
    note: r.note,
    createdAt: r.created_at,
    createdBy: r.created_by,
    expiresAt: r.expires_at,
  };
}

/** Comprime y guarda. Devuelve el id. Fuera de cualquier transaccion. */
export async function insertCapture(c: NewCapture, now = new Date()): Promise<number> {
  const raw = Buffer.from(c.body, "utf8");
  const gz = await gzip(raw);
  const [result] = await pool.query<ResultSetHeader>(
    `INSERT INTO edr_captures
       (run_id, origin, range_start, range_end, request_args, error_message, rows_count,
        bytes, gz_bytes, body_gz, status, created_at, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nueva', ?, ?, ?)`,
    [
      c.runId,
      c.origin,
      c.rangeStart,
      c.rangeEnd,
      JSON.stringify(c.requestArgs),
      c.errorMessage ? c.errorMessage.slice(0, 1024) : null,
      c.rowsCount ?? null,
      raw.length,
      gz.length,
      gz,
      now,
      c.createdBy ?? null,
      new Date(now.getTime() + config.capture.retentionHours * 3_600_000),
    ]
  );
  log.info("capturas: respuesta guardada", {
    captureId: result.insertId,
    origin: c.origin,
    runId: c.runId,
    bytes: raw.length,
    gzBytes: gz.length,
  });
  return result.insertId;
}

/**
 * Para la ingesta: si guardar la captura falla (base llena, paquete muy
 * grande...) se loguea y la ingesta sigue. Nunca tira.
 */
export async function insertCaptureSafe(c: NewCapture): Promise<number | null> {
  try {
    const id = await insertCapture(c);
    await purgeCaptures().catch(() => undefined);
    return id;
  } catch (err) {
    log.error("capturas: no se pudo guardar la respuesta", { origin: c.origin, runId: c.runId, error: errorMessage(err) });
    return null;
  }
}

export async function setRowsCount(id: number, rows: number): Promise<void> {
  await pool.query("UPDATE edr_captures SET rows_count = ? WHERE id = ?", [rows, id]);
}

export async function listCaptures(beforeId: number | undefined, limit: number): Promise<{ items: CaptureMeta[]; nextBeforeId: number | null }> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT ${META_COLUMNS} FROM edr_captures ${beforeId ? "WHERE id < ?" : ""} ORDER BY id DESC LIMIT ?`,
    beforeId ? [beforeId, limit + 1] : [limit + 1]
  );
  const items = rows.slice(0, limit).map(mapMeta);
  return { items, nextBeforeId: rows.length > limit ? items[items.length - 1].id : null };
}

export async function getCapture(id: number): Promise<CaptureMeta | null> {
  const [rows] = await pool.query<RowDataPacket[]>(`SELECT ${META_COLUMNS} FROM edr_captures WHERE id = ?`, [id]);
  return rows.length ? mapMeta(rows[0]) : null;
}

/** Body descomprimido (string). */
export async function readCaptureBody(id: number): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT body_gz FROM edr_captures WHERE id = ?", [id]);
  if (!rows.length) return null;
  return (await gunzip(rows[0].body_gz as Buffer)).toString("utf8");
}

export async function saveSummary(id: number, rowsCount: number, summary: unknown): Promise<void> {
  await pool.query("UPDATE edr_captures SET rows_count = ?, summary = ? WHERE id = ?", [rowsCount, JSON.stringify(summary), id]);
}

/** Conservar = no vence. Quitar la marca vuelve a contar la retencion desde ahora. */
export async function setKeep(id: number, keep: boolean, now = new Date()): Promise<void> {
  await pool.query(
    `UPDATE edr_captures SET expires_at = ?, status = CASE WHEN status = 'reprocesada' THEN status ELSE ? END WHERE id = ?`,
    [keep ? null : new Date(now.getTime() + config.capture.retentionHours * 3_600_000), keep ? "conservada" : "nueva", id]
  );
}

export async function markReprocessed(id: number, runId: number): Promise<void> {
  await pool.query("UPDATE edr_captures SET status = 'reprocesada', note = ? WHERE id = ?", [`reprocesada en la corrida ${runId}`, id]);
}

export async function deleteCapture(id: number): Promise<boolean> {
  const [result] = await pool.query<ResultSetHeader>("DELETE FROM edr_captures WHERE id = ?", [id]);
  return result.affectedRows === 1;
}

export async function captureUsage(): Promise<{ totalBytes: number; count: number; maxBytes: number }> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT COALESCE(SUM(gz_bytes), 0) AS total, COUNT(*) AS n FROM edr_captures");
  return { totalBytes: Number(rows[0].total), count: Number(rows[0].n), maxBytes: config.capture.maxTotalMb * 1024 * 1024 };
}

/**
 * Borra las vencidas y, si se pasa del espacio maximo, las mas viejas no
 * conservadas. De a pocas filas: los body pueden pesar varios MB.
 */
export async function purgeCaptures(now = new Date()): Promise<number> {
  let deleted = 0;
  for (;;) {
    const [result] = await pool.query<ResultSetHeader>(
      "DELETE FROM edr_captures WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT 20",
      [now]
    );
    deleted += result.affectedRows;
    if (result.affectedRows < 20) break;
  }

  const { totalBytes, maxBytes } = await captureUsage();
  if (totalBytes > maxBytes) {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT id, gz_bytes FROM edr_captures WHERE expires_at IS NOT NULL ORDER BY id LIMIT 500"
    );
    let excess = totalBytes - maxBytes;
    const ids: number[] = [];
    for (const r of rows) {
      if (excess <= 0) break;
      ids.push(Number(r.id));
      excess -= Number(r.gz_bytes);
    }
    if (ids.length) {
      const [result] = await pool.query<ResultSetHeader>("DELETE FROM edr_captures WHERE id IN (?)", [ids]);
      deleted += result.affectedRows;
    }
  }
  if (deleted > 0) log.info("capturas: borradas por vencimiento o espacio", { deleted });
  return deleted;
}
