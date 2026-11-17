import type { RowDataPacket } from "mysql2";
import { pool } from "../db/pool";
import { config } from "../config";
import { errorMessage, log } from "../logger";
import { factsOf, matchPolicy } from "./match";
import { policiesCache, type RepeatMode } from "./repo";
import { HELD } from "./select";
import { quotaFor, reselect, selectionChunks, type Group, type SelectResult } from "./windowSelect";

/**
 * Aplica un cambio de la politica activa sobre TODO el contenido del dia en
 * curso (desde period_start), tomado de sms_content:
 *
 * 1. Re-asigna cada SMS con link a la politica activa ahora (o a "por
 *    defecto" si no coincide). Los que no se habian elegido (salteados por
 *    muestra o tope, o en_seleccion) vuelven a en_seleccion; lo que ya esta
 *    en cola o clickeado conserva su estado.
 * 2. Vuelve a elegir ventana por ventana lo que ya llego (base ventana /
 *    semana anterior). La base "dia vencido" no elige nada ahora: el dia se
 *    elige entero cuando cierra (sweepClosedDays), contando lo ya hecho.
 *    Si se elige un SMS ya clickeado, repeat_mode decide si cuenta o se
 *    vuelve a visitar.
 *
 * Corre con el lock de ingesta (ninguna ventana se ingesta a la vez).
 * Idempotente: si se corta, se vuelve a correr entero.
 */

const BATCH = 2000;

interface ChangeRow {
  id: number;
  period_start: Date;
  repeat_mode: RepeatMode;
}

export interface RetakeResult extends SelectResult {
  reassigned: number;
}

async function reassign(periodStart: Date): Promise<number> {
  const active = policiesCache.active();
  let lastDate = periodStart;
  let lastId = 0;
  let total = 0;
  for (;;) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT p.id, p.edr_date, p.status, p.skip_reason, p.policy_id,
              c.client, c.sender_name, c.country, c.network, c.mccmnc, c.vendor, c.text
         FROM sms_processing p FORCE INDEX (idx_edr_date)
         JOIN sms_content c ON c.id = p.sms_content_id
        WHERE p.edr_date >= ? AND (p.edr_date > ? OR (p.edr_date = ? AND p.id > ?))
          AND (p.skip_reason IS NULL OR p.skip_reason <> 'sin_link')
        ORDER BY p.edr_date, p.id
        LIMIT ?`,
      [lastDate, lastDate, lastDate, lastId, BATCH]
    );
    if (rows.length === 0) break;

    // policy_id|skip_reason -> ids. Los no salteados solo cambian de politica.
    const groups = new Map<string, number[]>();
    for (const r of rows) {
      const facts = factsOf(r);
      if (!facts.link) continue;
      const policy = matchPolicy(active, facts);
      const policyId = policy?.id ?? null;
      const reason = r.status !== "skipped" ? "" : policy?.rules.selection.action === "no_visitar" ? "politica" : HELD;
      const key = `${policyId ?? ""}|${reason}`;
      if (!groups.has(key)) groups.set(key, []);
      (groups.get(key) as number[]).push(Number(r.id));
    }
    for (const [key, ids] of groups) {
      const [p, reason] = key.split("|");
      const policyId = p === "" ? null : Number(p);
      if (reason) {
        await pool.query(
          "UPDATE sms_processing SET policy_id = ?, skip_reason = ? WHERE status = 'skipped' AND id IN (?)",
          [policyId, reason, ids]
        );
      } else {
        await pool.query("UPDATE sms_processing SET policy_id = ? WHERE status <> 'skipped' AND id IN (?)", [policyId, ids]);
      }
      total += ids.length;
    }
    const last = rows[rows.length - 1];
    lastDate = new Date(last.edr_date);
    lastId = Number(last.id);
  }
  return total;
}

async function candidateGroups(range: { start: Date; end: Date }): Promise<Group[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT policy_id, COUNT(*) AS n FROM sms_processing FORCE INDEX (idx_edr_date)
      WHERE edr_date >= ? AND edr_date < ? AND (skip_reason IS NULL OR skip_reason NOT IN ('sin_link', 'politica'))
      GROUP BY policy_id`,
    [range.start, range.end]
  );
  return rows.map((r) => {
    const policyId = r.policy_id === null ? null : Number(r.policy_id);
    return { policyId, policy: policiesCache.byId(policyId), n: Number(r.n) };
  });
}

export async function retakeDay(periodStart: Date, repeat: RepeatMode, now: Date): Promise<RetakeResult> {
  await policiesCache.refresh();
  // Sin politica activa el sistema queda en espera: no se re-asigna ni se
  // elige nada (lo que ya estaba en cola se queda ahi sin visitarse).
  if (policiesCache.active().length === 0) return { reassigned: 0, approved: 0, skipped: 0, counted: 0, requeued: 0 };
  const result: RetakeResult = { reassigned: await reassign(periodStart), approved: 0, skipped: 0, counted: 0, requeued: 0 };

  const chunks = selectionChunks({ start: periodStart, end: now }, config.scheduler.windowMinutes, config.edr.timezoneOffsetMinutes);
  for (const chunk of chunks) {
    // El ultimo pedazo es la ventana abierta: llega a "ahora" inclusive.
    for (const group of await candidateGroups({ start: chunk.start, end: new Date(chunk.end.getTime() + (chunk.inclusive ? 1000 : 0)) })) {
      const sel = group.policy?.rules.selection;
      if (sel?.action === "visitar" && sel.base === "dia_vencido") continue;
      const quota = await quotaFor(group, chunk);
      const r = await reselect(group.policy, group.policyId, chunk, quota.count, quota.strategy, repeat, now);
      result.approved += r.approved;
      result.skipped += r.skipped;
      result.counted = (result.counted ?? 0) + (r.counted ?? 0);
      result.requeued = (result.requeued ?? 0) + (r.requeued ?? 0);
    }
  }
  return result;
}

/**
 * Aplica el ultimo cambio pendiente (los anteriores quedan reemplazados).
 * Lo llaman la ruta que hace el cambio (enseguida, en segundo plano) y cada
 * chequeo del scheduler (por si el proceso se corto a la mitad).
 */
export async function runPendingChanges(now: Date): Promise<RetakeResult | null> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT id, period_start, repeat_mode FROM policy_changes WHERE status IN ('pendiente', 'aplicando') ORDER BY id"
  );
  if (rows.length === 0) return null;
  const changes = rows as unknown as ChangeRow[];
  const latest = changes[changes.length - 1];
  const older = changes.slice(0, -1).map((c) => c.id);
  if (older.length) await pool.query("UPDATE policy_changes SET status = 'reemplazado' WHERE id IN (?)", [older]);

  await pool.query("UPDATE policy_changes SET status = 'aplicando' WHERE id = ?", [latest.id]);
  try {
    const result = await retakeDay(new Date(latest.period_start), latest.repeat_mode, now);
    await pool.query("UPDATE policy_changes SET status = 'aplicado', applied_at = ?, result = ?, error = NULL WHERE id = ?", [
      now,
      JSON.stringify(result),
      latest.id,
    ]);
    log.info("politicas: cambio aplicado sobre el contenido del dia", { changeId: latest.id, ...result });
    return result;
  } catch (err) {
    // Queda "aplicando": el proximo chequeo del scheduler lo reintenta.
    await pool
      .query("UPDATE policy_changes SET error = ? WHERE id = ?", [errorMessage(err).slice(0, 512), latest.id])
      .catch(() => undefined);
    log.error("politicas: no se pudo aplicar el cambio", { changeId: latest.id, error: errorMessage(err) });
    throw err;
  }
}
