import type { RowDataPacket } from "mysql2";
import { config } from "../config";
import { pool } from "../db/pool";
import { ensureUsage, storedUsage, type Db } from "../alaris/usageStats";
import { countsBetween, hourlyTotals } from "../db/minuteCountsRepo";
import { periodStarts } from "./schedule";

/**
 * Base "dia_anterior": la cuota de hoy sale de lo que mando el producto
 * ayer, hora por hora (sms_usage_stats de Alaris; si no hay, el conteo local
 * de lo ingerido ayer). Al llegar a la hora H de hoy se apunta a:
 *
 *   X % x (SMS de ayer hasta la hora H) x (proporcion de hoy con link)
 *
 * La proporcion es SMS de la politica (con link) / todos los SMS ingeridos
 * hoy hasta ahi: Alaris cuenta todos los SMS, tengan link o no.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const LOCAL_CACHE_MS = 10 * 60_000;

export type ReferenceSource = "alaris" | "local";

export interface Reference {
  volume: number;
  source: ReferenceSource;
}

const localCache = new Map<number, { at: number; hourly: number[] }>();

/** Para los tests (truncan las tablas entre casos). */
export function clearReferenceCache(): void {
  localCache.clear();
}

/**
 * Todos los SMS ingeridos del dia (con y sin link), por hora de Alaris. Sale
 * de los contadores por minuto (con semana_referencia los no elegidos no se
 * guardan); dias anteriores a los contadores, de sms_processing.
 */
export async function localHourly(dayStart: Date, db: Db = pool): Promise<number[]> {
  const cached = localCache.get(dayStart.getTime());
  if (cached && Date.now() - cached.at < LOCAL_CACHE_MS) return cached.hourly;
  const fromCounts = await hourlyTotals(dayStart, db);
  if (fromCounts) {
    if (dayStart.getTime() + DAY_MS <= Date.now()) localCache.set(dayStart.getTime(), { at: Date.now(), hourly: fromCounts });
    return fromCounts;
  }
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT TIMESTAMPDIFF(HOUR, ?, edr_date) AS h, COUNT(*) AS n
       FROM sms_processing FORCE INDEX (idx_edr_date)
      WHERE edr_date >= ? AND edr_date < ?
      GROUP BY h`,
    [dayStart, dayStart, new Date(dayStart.getTime() + DAY_MS)]
  );
  const hourly = Array.from({ length: 24 }, () => 0);
  for (const r of rows) {
    const h = Number(r.h);
    if (h >= 0 && h < 24) hourly[h] += Number(r.n);
  }
  // Solo se guarda un dia cerrado: el de hoy sigue creciendo.
  if (dayStart.getTime() + DAY_MS <= Date.now()) localCache.set(dayStart.getTime(), { at: Date.now(), hourly });
  return hourly;
}

/**
 * SMS del rango [from, to) segun la referencia (las horas partidas se
 * prorratean). `now` = se puede pedir a Alaris; sin `now` solo se lee lo
 * guardado (vista previa y cumplimiento, por el pool de reportes).
 */
export async function referenceVolume(from: Date, to: Date, db: Db = pool, now?: Date): Promise<Reference> {
  let volume = 0;
  let source: ReferenceSource = "alaris";
  const offset = config.edr.timezoneOffsetMinutes;
  for (let day = periodStarts(from, offset).day; day < to; day = new Date(day.getTime() + DAY_MS)) {
    const usage = now ? await ensureUsage(day, now) : await storedUsage(day, db);
    let hourly = usage?.hourly ?? null;
    if (!hourly) {
      source = "local";
      hourly = await localHourly(day, db);
    }
    for (let h = 0; h < 24; h++) {
      const hs = day.getTime() + h * HOUR_MS;
      const overlap = Math.min(hs + HOUR_MS, to.getTime()) - Math.max(hs, from.getTime());
      if (overlap > 0) volume += (hourly[h] * overlap) / HOUR_MS;
    }
  }
  return { volume, source };
}

/** El mismo rango, ayer. */
export function previousDayVolume(from: Date, to: Date, db: Db = pool, now?: Date): Promise<Reference> {
  return referenceVolume(new Date(from.getTime() - DAY_MS), new Date(to.getTime() - DAY_MS), db, now);
}

/**
 * Proporcion de SMS que la politica puede tomar entre todos los ingeridos en
 * [start, end): de los contadores por minuto; sin contadores (datos viejos),
 * de sms_processing (`candidates` = SMS de la politica en el rango).
 */
export async function linkRatio(
  policyId: number,
  start: Date,
  end: Date,
  candidates: () => Promise<number>,
  inclusive = false,
  db: Db = pool
): Promise<number> {
  const c = await countsBetween(start, end, policyId, db);
  if (c.minutes > 0) return c.total > 0 ? c.eligible / c.total : 0;
  const [mine, all] = await Promise.all([candidates(), countAllSms(start, end, inclusive, db)]);
  return all > 0 ? mine / all : 0;
}

/** Todos los SMS ingeridos (con y sin link) con edr_date en el rango. */
export async function countAllSms(start: Date, end: Date, inclusive = false, db: Db = pool): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM sms_processing FORCE INDEX (idx_edr_date)
      WHERE edr_date >= ? AND edr_date ${inclusive ? "<=" : "<"} ?`,
    [start, end]
  );
  return Number(rows[0].n);
}

export const SOURCE_LABEL: Record<ReferenceSource, string> = {
  alaris: "Alaris (sms_usage_stats)",
  local: "conteo local de ayer",
};
