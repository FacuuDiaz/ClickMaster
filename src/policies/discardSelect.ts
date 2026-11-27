import type { RowDataPacket } from "mysql2";
import { config } from "../config";
import { pool } from "../db/pool";
import { messageKey } from "../db/smsContentRepo";
import type { TimeWindow } from "../edr/windows";
import { log, errorMessage } from "../logger";
import type { SmsRecord } from "../parser/smsRecordSchema";
import { persistSmsBatch } from "../service/ingestBatch";
import { factsOf } from "./match";
import { policiesCache } from "./repo";
import type { Policy } from "./schema";
import { assign, HELD } from "./select";
import { pickIndices } from "./strategies";
import { apply, referenceQuota, selectionChunks, type Chunk, type SelectResult } from "./windowSelect";

/**
 * Modo descarte (politica activa con base semana_referencia): se elige sobre
 * la ventana entera y en sms_content se guardan SOLO los elegidos. De los
 * demas quedan solo los contadores por minuto (ingest_minute_counts), que la
 * ingesta ya escribio.
 *
 * Mientras llega la ventana, cada lote se resuelve enseguida:
 * - ya conocido (tiene fila en sms_processing) -> se guarda (actualiza su
 *   status en sms_content, no crea trabajos);
 * - nuevo sin link o de una politica que no visita -> se descarta;
 * - nuevo candidato -> espera en la tabla ingest_buffer.
 * Nada de la ventana queda en memoria: una hora de produccion son cientos de
 * miles de SMS y no entran en el heap de Node (se caia por falta de memoria).
 *
 * Reintentar la ventana no elige de mas: lo ya guardado de la ventana cuenta
 * como aprobado (referenceQuota con includeChunk) y no vuelve a ser candidato.
 */

export interface DiscardResult extends SelectResult {
  discarded: number;
  smsNew: number;
  smsExisting: number;
}

export interface BufferBatchResult {
  smsNew: number;
  smsExisting: number;
  buffered: number;
  discarded: number;
}

/** Ids a leer por consulta al pasar los elegidos de ingest_buffer a sms_content. */
const LOAD_CHUNK = 500;

/** Vacia la tabla de trabajo. Solo hay una ingesta a la vez (lock de ingesta). */
export async function clearBuffer(): Promise<void> {
  try {
    await pool.query(`TRUNCATE TABLE ingest_buffer`);
  } catch (err) {
    // Sin permiso de DROP (TRUNCATE lo pide) se borra fila por fila.
    log.warn("seleccion con descarte: no se pudo truncar ingest_buffer, se borra", { error: errorMessage(err) });
    await pool.query(`DELETE FROM ingest_buffer`);
  }
}

/** Identidades del lote que ya estan en sms_processing. */
async function knownKeys(records: SmsRecord[]): Promise<Set<string>> {
  const known = new Set<string>();
  if (records.length === 0) return known;
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT client_message_id, vendor_message_id FROM sms_processing WHERE (client_message_id, vendor_message_id) IN (?)`,
    [records.map((r) => [r.client_message_id, r.vendor_message_id])]
  );
  for (const r of rows) known.add(messageKey(r.client_message_id, r.vendor_message_id));
  return known;
}

/** Resuelve un lote validado de la ventana (ver arriba). */
export async function bufferBatch(
  records: SmsRecord[],
  policies: Policy[],
  runId: number | null,
  now: Date
): Promise<BufferBatchResult> {
  const out: BufferBatchResult = { smsNew: 0, smsExisting: 0, buffered: 0, discarded: 0 };
  // Si la misma identidad viene dos veces en el lote gana la ultima (la mas nueva).
  const byKey = new Map<string, SmsRecord>();
  for (const r of records) byKey.set(messageKey(r.client_message_id, r.vendor_message_id), r);
  const unique = [...byKey.values()];
  const known = await knownKeys(unique);

  const existing = unique.filter((r) => known.has(messageKey(r.client_message_id, r.vendor_message_id)));
  if (existing.length > 0) {
    const saved = await persistSmsBatch(existing, runId, policies, now);
    out.smsNew += saved.smsNew;
    out.smsExisting += saved.smsExisting;
  }

  const fresh = unique.filter((r) => !known.has(messageKey(r.client_message_id, r.vendor_message_id)));
  const decisions = assign(
    fresh.map((r) => ({ key: r, facts: factsOf(r) })),
    policies
  );
  const rows: unknown[][] = [];
  for (const r of fresh) {
    const d = decisions.get(r);
    if (!d || d.skipReason !== HELD) {
      out.discarded++;
      continue;
    }
    rows.push([r.client_message_id, r.vendor_message_id, new Date(r.edr_date), d.policyId, JSON.stringify(r)]);
  }
  if (rows.length > 0) {
    await pool.query(
      `INSERT INTO ingest_buffer (client_message_id, vendor_message_id, edr_date, policy_id, record) VALUES ?
       ON DUPLICATE KEY UPDATE edr_date = VALUES(edr_date), policy_id = VALUES(policy_id), record = VALUES(record)`,
      [rows]
    );
  }
  out.buffered = rows.length;
  return out;
}

/** Ids en_seleccion del rango, por politica (los guardados y todavia no aprobados). */
async function heldByPolicy(range: TimeWindow): Promise<Map<number | null, number[]>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, policy_id FROM sms_processing FORCE INDEX (idx_held)
      WHERE skip_reason = ? AND edr_date >= ? AND edr_date <= ? ORDER BY edr_date, id`,
    [HELD, range.start, range.end]
  );
  const out = new Map<number | null, number[]>();
  for (const r of rows) {
    const id = r.policy_id === null ? null : Number(r.policy_id);
    if (!out.has(id)) out.set(id, []);
    (out.get(id) as number[]).push(Number(r.id));
  }
  return out;
}

async function discardQuota(policy: Policy | null, chunk: Chunk, n: number, now: Date) {
  if (!policy) return { count: Math.round((n * config.checker.clickPercentage) / 100), strategy: "aleatorio" as const, note: "por defecto (descarte)" };
  const sel = policy.rules.selection;
  if (sel.action === "no_visitar") return { count: 0, strategy: sel.strategy, note: "no visitar" };
  if (sel.base === "semana_referencia" || sel.base === "dia_anterior") return referenceQuota(policy, chunk, n, now, { includeChunk: true });
  // Otras bases no usan este modo; por las dudas, el % de la ventana.
  return { count: Math.round((n * sel.percentage) / 100), strategy: sel.strategy, note: `${sel.percentage}% de la ventana (descarte)` };
}

/** Ids de ingest_buffer de un tramo y una politica, por edr_date (orden de llegada en empates). */
async function bufferedIds(policyId: number | null, chunk: Chunk): Promise<number[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM ingest_buffer
      WHERE policy_id <=> ? AND edr_date >= ? AND edr_date ${chunk.inclusive ? "<=" : "<"} ?
      ORDER BY edr_date, id`,
    [policyId, chunk.start, chunk.end]
  );
  return rows.map((r) => Number(r.id));
}

/** Politicas con candidatos en el tramo. */
async function bufferedPolicies(chunk: Chunk): Promise<(number | null)[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT policy_id FROM ingest_buffer WHERE edr_date >= ? AND edr_date ${chunk.inclusive ? "<=" : "<"} ?`,
    [chunk.start, chunk.end]
  );
  return rows.map((r) => (r.policy_id === null ? null : Number(r.policy_id)));
}

/**
 * Elige entre los candidatos de ingest_buffer, guarda los elegidos y los pasa
 * a la cola. El llamador ya guardo (bufferBatch) los conocidos de la ventana.
 * En memoria solo hay ids, nunca los registros de toda la ventana.
 */
export async function selectBuffered(
  range: TimeWindow,
  policies: Policy[],
  runId: number | null,
  now: Date,
  ctx: Record<string, unknown> = {}
): Promise<DiscardResult> {
  const result: DiscardResult = { approved: 0, skipped: 0, discarded: 0, smsNew: 0, smsExisting: 0 };

  // 1. Lo que quedo guardado sin aprobar de un intento anterior de la ventana
  //    ya habia sido elegido: se aprueba antes de calcular cuotas.
  for (const [policyId, ids] of await heldByPolicy(range)) {
    const r = await apply(policiesCache.byId(policyId), ids, ids, now);
    result.approved += r.approved;
    result.skipped += r.skipped;
  }

  // 2. Se elige por tramo y politica.
  const chosen: number[] = [];
  const offset = config.edr.timezoneOffsetMinutes;
  for (const chunk of selectionChunks(range, config.scheduler.windowMinutes, offset)) {
    for (const policyId of await bufferedPolicies(chunk)) {
      const ids = await bufferedIds(policyId, chunk);
      const policy = policiesCache.byId(policyId);
      const quota = await discardQuota(policy, chunk, ids.length, now);
      const picked = pickIndices(ids.length, quota.count, quota.strategy);
      for (const i of picked) chosen.push(ids[i]);
      result.discarded += ids.length - picked.length;
      log.info("seleccion con descarte: ventana", {
        ...ctx,
        policyId,
        start: chunk.start.toISOString(),
        end: chunk.end.toISOString(),
        candidates: ids.length,
        chosen: picked.length,
        strategy: quota.strategy,
        note: quota.note,
      });
    }
  }

  // 3. Se guardan los elegidos (quedan en_seleccion con su politica), de a lotes.
  for (let i = 0; i < chosen.length; i += LOAD_CHUNK) {
    const [rows] = await pool.query<RowDataPacket[]>(`SELECT record FROM ingest_buffer WHERE id IN (?) ORDER BY edr_date, id`, [
      chosen.slice(i, i + LOAD_CHUNK),
    ]);
    const records = rows.map((r) => JSON.parse(String(r.record)) as SmsRecord);
    const batch = await persistSmsBatch(records, runId, policies, now);
    result.smsNew += batch.smsNew;
    result.smsExisting += batch.smsExisting;
  }

  // 4. Los elegidos pasan a la cola (con tope y horario de la politica).
  for (const [policyId, ids] of await heldByPolicy(range)) {
    const r = await apply(policiesCache.byId(policyId), ids, ids, now);
    result.approved += r.approved;
    result.skipped += r.skipped;
  }
  return result;
}
