import type { RowDataPacket } from "mysql2";
import { config } from "../config";
import { pool } from "../db/pool";
import { messageKey } from "../db/smsContentRepo";
import type { TimeWindow } from "../edr/windows";
import { log } from "../logger";
import type { SmsRecord } from "../parser/smsRecordSchema";
import { persistSmsBatch } from "../service/ingestBatch";
import { factsOf } from "./match";
import { policiesCache } from "./repo";
import type { Policy } from "./schema";
import { assign, HELD } from "./select";
import { pick } from "./strategies";
import { apply, referenceQuota, selectionChunks, type Chunk, type SelectResult } from "./windowSelect";

/**
 * Seleccion en memoria (politica activa con base semana_referencia): la
 * ventana entera se junta en memoria, se elige con la estrategia y se guardan
 * SOLO los elegidos. Los demas se descartan: de ellos quedan solo los
 * contadores por minuto (ingest_minute_counts), que la ingesta ya escribio.
 *
 * Reintentar la ventana no elige de mas: lo ya guardado de la ventana cuenta
 * como aprobado (referenceQuota con includeChunk) y no vuelve a ser candidato.
 */

export interface InMemoryResult extends SelectResult {
  discarded: number;
  smsNew: number;
  smsExisting: number;
}

const LOOKUP_CHUNK = 1000;

/** Identidades que ya estan en sms_processing. */
async function knownKeys(records: SmsRecord[]): Promise<Set<string>> {
  const known = new Set<string>();
  for (let i = 0; i < records.length; i += LOOKUP_CHUNK) {
    const slice = records.slice(i, i + LOOKUP_CHUNK);
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT client_message_id, vendor_message_id FROM sms_processing WHERE (client_message_id, vendor_message_id) IN (?)`,
      [slice.map((r) => [r.client_message_id, r.vendor_message_id])]
    );
    for (const r of rows) known.add(messageKey(r.client_message_id, r.vendor_message_id));
  }
  return known;
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

function inChunk(ms: number, chunk: Chunk): boolean {
  return ms >= chunk.start.getTime() && (chunk.inclusive ? ms <= chunk.end.getTime() : ms < chunk.end.getTime());
}

async function quotaInMemory(policy: Policy | null, chunk: Chunk, n: number, now: Date) {
  if (!policy) return { count: Math.round((n * config.checker.clickPercentage) / 100), strategy: "aleatorio" as const, note: "por defecto (en memoria)" };
  const sel = policy.rules.selection;
  if (sel.action === "no_visitar") return { count: 0, strategy: sel.strategy, note: "no visitar" };
  if (sel.base === "semana_referencia" || sel.base === "dia_anterior") return referenceQuota(policy, chunk, n, now, { includeChunk: true });
  // Otras bases no usan este modo; por las dudas, el % de la ventana.
  return { count: Math.round((n * sel.percentage) / 100), strategy: sel.strategy, note: `${sel.percentage}% de la ventana (en memoria)` };
}

export async function selectInMemory(
  buffered: SmsRecord[],
  range: TimeWindow,
  policies: Policy[],
  runId: number | null,
  now: Date,
  ctx: Record<string, unknown> = {}
): Promise<InMemoryResult> {
  const result: InMemoryResult = { approved: 0, skipped: 0, discarded: 0, smsNew: 0, smsExisting: 0 };
  const records = [...buffered].sort((a, b) => new Date(a.edr_date).getTime() - new Date(b.edr_date).getTime());
  const known = await knownKeys(records);

  // 1. Lo que quedo guardado sin aprobar de un intento anterior de la ventana
  //    ya habia sido elegido: se aprueba antes de calcular cuotas.
  for (const [policyId, ids] of await heldByPolicy(range)) {
    const r = await apply(policiesCache.byId(policyId), ids, ids, now);
    result.approved += r.approved;
    result.skipped += r.skipped;
  }

  // 2. Candidatos nuevos: con link y de una politica que visita (o por defecto).
  const fresh = records.filter((r) => !known.has(messageKey(r.client_message_id, r.vendor_message_id)));
  const decisions = assign(
    fresh.map((r) => ({ key: r, facts: factsOf(r) })),
    policies
  );
  const chosen: SmsRecord[] = [];
  const offset = config.edr.timezoneOffsetMinutes;
  for (const chunk of selectionChunks(range, config.scheduler.windowMinutes, offset)) {
    const groups = new Map<number | null, SmsRecord[]>();
    for (const r of fresh) {
      const d = decisions.get(r);
      if (!d || d.skipReason !== HELD || !inChunk(new Date(r.edr_date).getTime(), chunk)) continue;
      if (!groups.has(d.policyId)) groups.set(d.policyId, []);
      (groups.get(d.policyId) as SmsRecord[]).push(r);
    }
    for (const [policyId, items] of groups) {
      const policy = policiesCache.byId(policyId);
      const quota = await quotaInMemory(policy, chunk, items.length, now);
      const picked = pick(items, quota.count, quota.strategy);
      chosen.push(...picked);
      log.info("seleccion en memoria: ventana", {
        ...ctx,
        policyId,
        start: chunk.start.toISOString(),
        end: chunk.end.toISOString(),
        candidates: items.length,
        chosen: picked.length,
        strategy: quota.strategy,
        note: quota.note,
      });
    }
  }
  result.discarded = fresh.length - chosen.length;

  // 3. Se guardan los elegidos (quedan en_seleccion con su politica) y los ya
  //    conocidos (actualiza su status en sms_content, no crea trabajos).
  const toPersist = [...chosen, ...records.filter((r) => known.has(messageKey(r.client_message_id, r.vendor_message_id)))];
  for (let i = 0; i < toPersist.length; i += config.ingest.dbBatchSize) {
    const batch = await persistSmsBatch(toPersist.slice(i, i + config.ingest.dbBatchSize), runId, policies, now);
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
