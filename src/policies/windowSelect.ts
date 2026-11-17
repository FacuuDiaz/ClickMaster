import type { RowDataPacket } from "mysql2";
import { config } from "../config";
import { pool, withTransaction, type DbConnection } from "../db/pool";
import { alignDown, type TimeWindow } from "../edr/windows";
import { log } from "../logger";
import { countApprovedSince, policiesCache, repeatModeFor, type RepeatMode } from "./repo";
import { nextAllowedAt, periodStarts } from "./schedule";
import { HELD } from "./select";
import { dayCurve, pick } from "./strategies";
import { weeklyBaseline } from "./historical";
import type { Policy, Strategy } from "./schema";

/**
 * Seleccion sobre el total del periodo. En la ingesta los SMS quedan
 * "en_seleccion" (skipped + skip_reason) con su politica; cuando el periodo
 * llego entero se elige cuales se visitan con la estrategia de la politica:
 *
 * - base "ventana" (y los SMS sin politica): al terminar de ingestar cada
 *   ventana, sobre todos sus SMS.
 * - base "semana_anterior": igual, por ventana, pero la cantidad sale de la
 *   cuota diaria (X % del mismo dia de la semana anterior) repartida en el
 *   dia segun la estrategia.
 * - base "dia_vencido": cuando cerro el dia, sobre todos los SMS del dia
 *   (sweepClosedDays, en cada chequeo del scheduler).
 *
 * Todo es idempotente: si algo falla los SMS siguen en_seleccion y se eligen
 * en el proximo intento (reintento de la ventana o barrido de dias).
 */

const DAY_MS = 86_400_000;
const UPDATE_CHUNK = 1000;

export interface SelectResult {
  approved: number;
  skipped: number;
  // Solo al retomar: elegidos que ya estaban clickeados.
  counted?: number; // cuentan como hechos (repeat igual)
  requeued?: number; // se vuelven a visitar (repeat doble)
}

export interface Group {
  // Tal como esta en la fila (puede ser de una politica ya borrada).
  policyId: number | null;
  // null = sin politica o politica borrada: se trata como "por defecto".
  policy: Policy | null;
  n: number;
}

/**
 * Periodo de seleccion. `inclusive`: incluye edr_date == end (el ultimo del
 * rango pedido: Alaris puede devolver el segundo del fin y no hay otra
 * ventana que lo vaya a elegir enseguida).
 */
type Chunk = TimeWindow & { inclusive?: boolean };

function addResult(total: SelectResult, r: SelectResult): void {
  total.approved += r.approved;
  total.skipped += r.skipped;
  if (r.counted) total.counted = (total.counted ?? 0) + r.counted;
  if (r.requeued) total.requeued = (total.requeued ?? 0) + r.requeued;
}

/** Periodos de seleccion: las ventanas (alineadas) que cubren el rango. */
export function selectionChunks(range: TimeWindow, windowMinutes: number, offsetMinutes: number): Chunk[] {
  const windowMs = windowMinutes * 60_000;
  const out: Chunk[] = [];
  let start = range.start;
  while (start < range.end) {
    const aligned = alignDown(start, windowMinutes, offsetMinutes).getTime();
    const end = new Date(Math.min(range.end.getTime(), aligned + windowMs));
    out.push({ start, end });
    start = end;
  }
  if (out.length) out[out.length - 1].inclusive = true;
  return out;
}

function dayOf(date: Date): TimeWindow {
  const start = periodStarts(date, config.edr.timezoneOffsetMinutes).day;
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

const endOp = (range: Chunk) => (range.inclusive ? "<=" : "<");

async function heldGroups(range: Chunk): Promise<Group[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT policy_id, COUNT(*) AS n FROM sms_processing FORCE INDEX (idx_held)
      WHERE skip_reason = ? AND edr_date >= ? AND edr_date ${endOp(range)} ?
      GROUP BY policy_id`,
    [HELD, range.start, range.end]
  );
  return rows.map((r) => {
    const policyId = r.policy_id === null ? null : Number(r.policy_id);
    return { policyId, policy: policiesCache.byId(policyId), n: Number(r.n) };
  });
}

async function heldIds(policyId: number | null, range: Chunk): Promise<number[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id FROM sms_processing FORCE INDEX (idx_held)
      WHERE skip_reason = ? AND edr_date >= ? AND edr_date ${endOp(range)} ? AND policy_id <=> ?
      ORDER BY edr_date, id`,
    [HELD, range.start, range.end, policyId]
  );
  return rows.map((r) => Number(r.id));
}

/** Cupo que le queda a la politica en la hora y el dia de `now` (hora de Alaris). */
async function remainingCap(conn: DbConnection, policy: Policy | null, now: Date): Promise<number> {
  if (!policy) return Infinity;
  const { perHour, perDay } = policy.rules.limits;
  const { hour, day } = periodStarts(now, config.edr.timezoneOffsetMinutes);
  let left = Infinity;
  if (perHour !== null) left = Math.min(left, perHour - (await countApprovedSince(conn, policy.id, hour)));
  if (perDay !== null) left = Math.min(left, perDay - (await countApprovedSince(conn, policy.id, day)));
  return Math.max(0, left);
}

async function updateIds(conn: DbConnection, ids: number[], sql: string, params: unknown[]): Promise<void> {
  for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
    await conn.query(`${sql} AND id IN (?)`, [...params, ids.slice(i, i + UPDATE_CHUNK)]);
  }
}

/**
 * Aplica la eleccion: los elegidos (hasta el tope) quedan pending desde la
 * proxima franja de la politica; el resto, skipped. Solo toca filas que
 * siguen en_seleccion (si otra instancia ya las eligio, no hace nada).
 */
async function apply(policy: Policy | null, ids: number[], chosen: number[], now: Date): Promise<SelectResult> {
  return withTransaction(async (conn) => {
    const cap = await remainingCap(conn, policy, now);
    const approved = chosen.slice(0, Number.isFinite(cap) ? cap : chosen.length);
    const overCap = chosen.slice(approved.length);
    const chosenSet = new Set(chosen);
    const rest = ids.filter((id) => !chosenSet.has(id));
    const startAt = policy ? nextAllowedAt(policy.rules.schedule, now, config.edr.timezoneOffsetMinutes) : now;
    const where = "WHERE skip_reason = ?";
    await updateIds(
      conn,
      approved,
      `UPDATE sms_processing SET status = 'pending', skip_reason = NULL, next_attempt_at = ?, finished_at = NULL, selected_at = ? ${where}`,
      [startAt, now, HELD]
    );
    await updateIds(conn, overCap, `UPDATE sms_processing SET skip_reason = 'tope_politica', finished_at = ? ${where}`, [now, HELD]);
    await updateIds(conn, rest, `UPDATE sms_processing SET skip_reason = 'fuera_de_muestra', finished_at = ? ${where}`, [now, HELD]);
    return { approved: approved.length, skipped: overCap.length + rest.length };
  }, { retries: 3 });
}

// ---------- Cantidad a visitar ----------

/** Aprobados (no skipped) de la politica con edr_date en el rango. */
async function approvedIn(policyId: number, start: Date, end: Date): Promise<number> {
  if (end <= start) return 0;
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM sms_processing FORCE INDEX (idx_policy_edr)
      WHERE policy_id = ? AND edr_date >= ? AND edr_date < ? AND status <> 'skipped'`,
    [policyId, start, end]
  );
  return Number(rows[0].n);
}

export interface Quota {
  count: number;
  strategy: Strategy;
  // Para el log / la vista previa.
  note: string;
}

/**
 * Cuantos visitar en una ventana de la base semana_anterior: la cuota del dia
 * (X % del mismo dia de la semana anterior) repartida segun la estrategia,
 * descontando lo ya aprobado hoy antes de esta ventana.
 */
async function weeklyQuota(policy: Policy, chunk: TimeWindow, n: number): Promise<Quota> {
  const sel = policy.rules.selection;
  const day = dayOf(chunk.start);
  const baseline = await weeklyBaseline(policy, day.start, day.end, sel.weeks);
  if (baseline === null) {
    return { count: await carriedCount(policy.id, chunk, n, sel.percentage), strategy: sel.strategy, note: "sin historico: % de la ventana" };
  }
  const daily = Math.round((sel.percentage / 100) * baseline);
  const done = await approvedIn(policy.id, day.start, chunk.start);
  let target: number;
  if (sel.strategy === "primeros") {
    target = daily; // todo lo que entre, desde el principio del dia
  } else if (sel.strategy === "ultimos") {
    // Se guarda la cuota para el final: aca solo lo que no alcanzaria con lo
    // que se espera que llegue despues (segun la misma referencia).
    const after = (await weeklyBaseline(policy, chunk.end, day.end, sel.weeks)) ?? 0;
    target = daily - Math.min(daily, Math.round(after));
  } else {
    const windowMs = config.scheduler.windowMinutes * 60_000;
    const slots = Math.max(1, Math.round(DAY_MS / windowMs));
    const slot = Math.floor((chunk.start.getTime() - day.start.getTime()) / windowMs);
    const x = (chunk.end.getTime() - day.start.getTime()) / DAY_MS;
    target = Math.round(daily * dayCurve(sel.strategy, x, slot, slots));
  }
  return {
    count: Math.max(0, Math.min(n, target - done)),
    strategy: sel.strategy,
    note: `cuota del dia ${daily} (${sel.percentage}% de ${Math.round(baseline)}), ya aprobados ${done}`,
  };
}

/**
 * X % de los `n` SMS de la ventana, arrastrando el redondeo dentro del dia:
 * se redondea el acumulado (SMS de la politica desde las 00:00 hasta el fin
 * de esta ventana) y se resta lo que ya correspondia antes. Asi 10 ventanas
 * de 2 SMS al 20 % dan 4 visitas en el dia (redondeando cada una darian 0).
 */
export async function carriedCount(policyId: number | null, chunk: TimeWindow, n: number, percentage: number): Promise<number> {
  const day = dayOf(chunk.start);
  const before = chunk.start > day.start ? await countCandidates(policyId, { start: day.start, end: chunk.start }) : 0;
  const share = (x: number) => Math.round((x * percentage) / 100);
  return Math.max(0, Math.min(n, share(before + n) - share(before)));
}

export async function quotaFor(group: Group, chunk: TimeWindow): Promise<Quota> {
  const { policy, n } = group;
  if (!policy) {
    const count = await carriedCount(group.policyId, chunk, n, config.checker.clickPercentage);
    return { count, strategy: "aleatorio", note: "por defecto" };
  }
  const sel = policy.rules.selection;
  if (sel.action === "no_visitar") return { count: 0, strategy: sel.strategy, note: "no visitar" };
  if (sel.base === "semana_anterior") return weeklyQuota(policy, chunk, n);
  const count = await carriedCount(policy.id, chunk, n, sel.percentage);
  return { count, strategy: sel.strategy, note: `${sel.percentage}% de ${n} (con arrastre del dia)` };
}

// ---------- Entradas ----------

/**
 * Elige entre los SMS en_seleccion del rango, ventana por ventana. Los de
 * politicas "dia vencido" se dejan para el cierre del dia salvo `includeDaily`.
 */
export async function selectHeld(
  range: TimeWindow,
  now: Date,
  opts: { includeDaily?: boolean; ctx?: Record<string, unknown> } = {}
): Promise<SelectResult> {
  const total: SelectResult = { approved: 0, skipped: 0 };
  const add = (r: SelectResult) => addResult(total, r);
  const isDaily = (g: Group) => g.policy?.rules.selection.base === "dia_vencido" && g.policy.rules.selection.action === "visitar";

  for (const chunk of selectionChunks(range, config.scheduler.windowMinutes, config.edr.timezoneOffsetMinutes)) {
    for (const group of await heldGroups(chunk)) {
      if (isDaily(group)) continue;
      const quota = await quotaFor(group, chunk);
      const ids = await heldIds(group.policyId, chunk);
      const result = await apply(group.policy, ids, pick(ids, quota.count, quota.strategy), now);
      add(result);
      log.info("seleccion: ventana", {
        ...opts.ctx,
        policyId: group.policyId,
        start: chunk.start.toISOString(),
        end: chunk.end.toISOString(),
        candidates: ids.length,
        strategy: quota.strategy,
        note: quota.note,
        ...result,
      });
    }
  }

  if (opts.includeDaily) {
    for (const group of await heldGroups(range)) {
      if (!isDaily(group)) continue;
      const policy = group.policy as Policy;
      const sel = policy.rules.selection;
      // Sobre TODO el dia (incluidos los que ya proceso otra politica antes de
      // un cambio): el % se calcula sobre el total y lo ya hecho cuenta.
      const repeat = await repeatModeFor(policy.id, range.start);
      const n = await countCandidates(policy.id, range);
      const result = await reselect(policy, policy.id, range, Math.round((n * sel.percentage) / 100), sel.strategy, repeat, now);
      add(result);
      log.info("seleccion: dia vencido", {
        policyId: policy.id,
        day: range.start.toISOString(),
        candidates: n,
        strategy: sel.strategy,
        repeat,
        ...result,
      });
    }
  }
  return total;
}

/**
 * Elige los dias ya cerrados que tienen SMS en_seleccion (dia vencido, o
 * sobras de una ventana que fallo y no se reintento). `closedBefore` es el
 * inicio del primer dia que todavia puede recibir SMS.
 */
export async function sweepClosedDays(closedBefore: Date, now: Date, maxDays = 7): Promise<SelectResult> {
  const total: SelectResult = { approved: 0, skipped: 0 };
  for (let i = 0; i < maxDays; i++) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT edr_date FROM sms_processing FORCE INDEX (idx_held)
        WHERE skip_reason = ? AND edr_date < ? ORDER BY edr_date LIMIT 1`,
      [HELD, closedBefore]
    );
    if (rows.length === 0) break;
    const day = dayOf(new Date(rows[0].edr_date));
    addResult(total, await selectHeld(day, now, { includeDaily: true }));
  }
  return total;
}

/** Inicio (UTC) del dia de Alaris que contiene `date`. */
export function dayStartOf(date: Date): Date {
  return dayOf(date).start;
}

// ---------- Seleccion "retomando" (cambio de politica / dia vencido) ----------

const QUEUED = new Set(["pending", "processing", "retry"]);
const VISITED = new Set(["success", "failed"]);

// Candidatos: SMS con link de la politica, salvo los que la politica manda no visitar.
const CANDIDATE = "(skip_reason IS NULL OR skip_reason NOT IN ('sin_link', 'politica'))";

function policyFilter(policyId: number | null): [string, unknown[]] {
  return policyId === null ? ["policy_id IS NULL", []] : ["policy_id = ?", [policyId]];
}

export async function countCandidates(policyId: number | null, range: Chunk): Promise<number> {
  const [where, params] = policyFilter(policyId);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM sms_processing FORCE INDEX (idx_policy_edr)
      WHERE ${where} AND edr_date >= ? AND edr_date ${endOp(range)} ? AND ${CANDIDATE}`,
    [...params, range.start, range.end]
  );
  return Number(rows[0].n);
}

/**
 * Elige `count` sobre TODOS los SMS de la politica en el rango (no solo los
 * en_seleccion), con la estrategia. De los elegidos:
 * - sin elegir todavia o salteados -> pending;
 * - ya en cola -> quedan (cuentan);
 * - ya clickeados (clicks > 0) -> repeat "igual": cuentan como hechos;
 *   "doble": vuelven a la cola para otro click (attempts = 0; clicks sigue sumando);
 * - visitados sin ningun click (el sitio nunca respondio 200) -> vuelven a la cola.
 * Los no elegidos que seguian en_seleccion quedan fuera_de_muestra; lo ya
 * aprobado o clickeado por la politica anterior no se toca.
 */
export async function reselect(
  policy: Policy | null,
  policyId: number | null,
  range: Chunk,
  count: number,
  strategy: Strategy,
  repeat: RepeatMode,
  now: Date
): Promise<SelectResult> {
  const [where, params] = policyFilter(policyId);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, status, skip_reason, clicks FROM sms_processing FORCE INDEX (idx_policy_edr)
      WHERE ${where} AND edr_date >= ? AND edr_date ${endOp(range)} ? AND ${CANDIDATE}
      ORDER BY edr_date, id`,
    [...params, range.start, range.end]
  );
  const picked = new Set(pick(rows, count, strategy, undefined).map((r) => Number(r.id)));
  const approve: number[] = [];
  const requeue: number[] = [];
  const release: number[] = [];
  let counted = 0;
  for (const r of rows) {
    const id = Number(r.id);
    if (picked.has(id)) {
      if (r.status === "skipped") approve.push(id);
      else if (VISITED.has(r.status)) {
        // Sin ningun 200 (error del sitio, timeout, DNS...) no hubo click:
        // se vuelve a intentar en cualquier modo.
        if (Number(r.clicks) === 0 || repeat === "doble") requeue.push(id);
        else counted++;
      } else if (QUEUED.has(r.status)) counted++;
    } else if (r.skip_reason === HELD) {
      release.push(id);
    }
  }

  return withTransaction(async (conn) => {
    // El tope cuenta aprobados nuevos y re-clicks (los dos son visitas de hoy).
    const cap = await remainingCap(conn, policy, now);
    const limit = Number.isFinite(cap) ? cap : approve.length + requeue.length;
    const approved = approve.slice(0, limit);
    const requeued = requeue.slice(0, Math.max(0, limit - approved.length));
    const overCap = approve.slice(approved.length);
    const startAt = policy ? nextAllowedAt(policy.rules.schedule, now, config.edr.timezoneOffsetMinutes) : now;
    await updateIds(
      conn,
      approved,
      `UPDATE sms_processing SET status = 'pending', skip_reason = NULL, next_attempt_at = ?, finished_at = NULL, selected_at = ? WHERE status = 'skipped'`,
      [startAt, now]
    );
    await updateIds(
      conn,
      requeued,
      `UPDATE sms_processing SET status = 'pending', attempts = 0, next_attempt_at = ?, finished_at = NULL, selected_at = ? WHERE status IN ('success', 'failed')`,
      [startAt, now]
    );
    await updateIds(conn, overCap, `UPDATE sms_processing SET skip_reason = 'tope_politica', finished_at = ? WHERE status = 'skipped'`, [now]);
    await updateIds(conn, release, `UPDATE sms_processing SET skip_reason = 'fuera_de_muestra', finished_at = ? WHERE skip_reason = ?`, [now, HELD]);
    return { approved: approved.length + requeued.length, skipped: overCap.length + release.length, counted, requeued: requeued.length };
  }, { retries: 3 });
}
