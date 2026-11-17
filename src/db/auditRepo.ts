import type { RowDataPacket } from "mysql2";
import { pool, type DbConnection } from "./pool";
import { errorMessage, log } from "../logger";

export type AuditEntity = "setting" | "policy" | "action" | "capture";

/** Quien hizo el cambio: el nombre que escribe en la web y desde donde. */
export interface Actor {
  name: string | null;
  ip: string | null;
}

export interface AuditEntry {
  entity: AuditEntity;
  action: string;
  ref?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}

// JSON NULL vs SQL NULL: undefined/null se guardan como SQL NULL.
function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/**
 * Inserta entradas en config_audit. Con `conn` va dentro de la transaccion
 * del cambio (si el cambio no se guarda, el historial tampoco).
 */
export async function insertAudit(
  entries: AuditEntry[],
  actor: Actor,
  now: Date,
  conn?: DbConnection
): Promise<void> {
  if (entries.length === 0) return;
  await (conn ?? pool).query(
    `INSERT INTO config_audit (at, actor, ip, entity, action, ref, old_value, new_value) VALUES ?`,
    [
      entries.map((e) => [
        now,
        actor.name,
        actor.ip,
        e.entity,
        e.action,
        e.ref ?? null,
        json(e.oldValue),
        json(e.newValue),
      ]),
    ]
  );
}

/**
 * Para acciones que ya pasaron (lanzar clicks, pedir una ventana...): si
 * no se puede guardar el historial se loguea, pero la accion no falla.
 */
export async function auditBestEffort(entry: AuditEntry, actor: Actor): Promise<void> {
  try {
    await insertAudit([entry], actor, new Date());
  } catch (err) {
    log.error("auditoria: no se pudo guardar", { entity: entry.entity, action: entry.action, error: errorMessage(err) });
  }
}

// MariaDB devuelve las columnas JSON como texto; MySQL ya parseadas.
/**
 * Valor de una columna JSON leida como texto (`CAST(col AS CHAR)`): se
 * decodifica UNA vez. Hace falta leerla como texto porque MySQL la devuelve ya
 * decodificada y MariaDB como texto: decodificar dos veces convierte el texto
 * "1300" en el numero 1300.
 */
export function parseJsonText(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  return JSON.parse(value);
}

export function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export interface AuditRow {
  id: number;
  at: Date;
  actor: string | null;
  ip: string | null;
  entity: AuditEntity;
  action: string;
  ref: string | null;
  oldValue: unknown;
  newValue: unknown;
}

/** Historial paginado por keyset (id < beforeId), el mas nuevo primero. */
export async function listAudit(filters: {
  entity?: AuditEntity;
  beforeId?: number;
  limit: number;
}): Promise<{ items: AuditRow[]; nextBeforeId: number | null }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.entity) {
    where.push("entity = ?");
    params.push(filters.entity);
  }
  if (filters.beforeId) {
    where.push("id < ?");
    params.push(filters.beforeId);
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, at, actor, ip, entity, action, ref,
            CAST(old_value AS CHAR) AS old_value, CAST(new_value AS CHAR) AS new_value
       FROM config_audit
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY id DESC
      LIMIT ?`,
    [...params, filters.limit + 1]
  );
  const items = rows.slice(0, filters.limit).map((r) => ({
    id: Number(r.id),
    at: r.at,
    actor: r.actor,
    ip: r.ip,
    entity: r.entity,
    action: r.action,
    ref: r.ref,
    oldValue: parseJsonText(r.old_value),
    newValue: parseJsonText(r.new_value),
  }));
  return { items, nextBeforeId: rows.length > filters.limit ? items[items.length - 1].id : null };
}
