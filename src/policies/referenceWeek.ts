import { config } from "../config";
import { pool } from "../db/pool";
import { ensureUsage, isConfigured, storedUsage, usageError, type Db } from "../alaris/usageStats";
import { hourlyTotals } from "../db/minuteCountsRepo";
import { localHourly, type ReferenceSource } from "./previousDay";
import { periodStarts } from "./schedule";

/**
 * Base "semana_referencia": la referencia de hoy es el mismo dia de la
 * semana (y la misma hora) de una semana elegida en la politica
 * (selection.weekStart). Los 7 dias se piden a Alaris (sms_usage_stats, por
 * hora) y quedan guardados en alaris_usage_days: dias cerrados, no cambian.
 */

const DAY_MS = 86_400_000;
const offsetMs = () => config.edr.timezoneOffsetMinutes * 60_000;

/** "2026-11-16" (hora de Alaris) -> inicio UTC de ese dia. */
export function dayStartFromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - offsetMs());
}

export function keyOf(dayStart: Date): string {
  return new Date(dayStart.getTime() + offsetMs()).toISOString().slice(0, 10);
}

/** Inicio de cada uno de los 7 dias de la semana de referencia. */
export function weekDays(weekStart: string): Date[] {
  const first = dayStartFromKey(weekStart);
  return Array.from({ length: 7 }, (_, i) => new Date(first.getTime() + i * DAY_MS));
}

/** El dia de la semana de referencia que corresponde a `date` (mismo dia de la semana). */
export function refDayFor(date: Date, weekStart: string): Date {
  const today = periodStarts(date, config.edr.timezoneOffsetMinutes).day.getTime();
  const first = dayStartFromKey(weekStart).getTime();
  const diff = Math.round((today - first) / DAY_MS);
  return new Date(first + (((diff % 7) + 7) % 7) * DAY_MS);
}

/** La semana tiene que haber terminado: sus 7 dias cerrados a `now`. */
export function isClosedWeek(weekStart: string, now: Date): boolean {
  return dayStartFromKey(weekStart).getTime() + 7 * DAY_MS <= now.getTime();
}

/** Lunes de la ultima semana completa (default del editor). */
export function lastFullWeek(now: Date): string {
  const today = periodStarts(now, config.edr.timezoneOffsetMinutes).day;
  const weekday = new Date(today.getTime() + offsetMs()).getUTCDay(); // 0 = domingo
  const sinceMonday = (weekday + 6) % 7;
  return keyOf(new Date(today.getTime() - (sinceMonday + 7) * DAY_MS));
}

export interface WeekDay {
  day: string; // YYYY-MM-DD
  start: Date;
  hourly: number[];
  total: number;
  source: ReferenceSource | "sin_datos";
  error: string | null;
}

/**
 * Pide a Alaris los dias que falten (o todos con `force`). Devuelve cuantos
 * quedaron con datos de Alaris. Sin REST configurada no hace nada.
 */
export async function ensureWeek(weekStart: string, now: Date, opts: { force?: boolean } = {}): Promise<number> {
  if (!isConfigured()) return 0;
  let ok = 0;
  for (const day of weekDays(weekStart)) {
    if (await ensureUsage(day, now, undefined, opts)) ok++;
  }
  return ok;
}

/** Los 7 dias, hora por hora: Alaris si hay; si no, lo ingerido localmente. */
export async function weekSeries(weekStart: string, db: Db = pool): Promise<WeekDay[]> {
  const out: WeekDay[] = [];
  for (const start of weekDays(weekStart)) {
    const usage = await storedUsage(start, db);
    let hourly = usage?.hourly ?? null;
    let source: WeekDay["source"] = "alaris";
    if (!hourly) {
      const counts = await hourlyTotals(start, db);
      const local = counts ?? (await localHourly(start, db));
      hourly = local;
      source = local.some((n) => n > 0) ? "local" : "sin_datos";
    }
    out.push({
      day: keyOf(start),
      start,
      hourly,
      total: hourly.reduce((a, b) => a + b, 0),
      source,
      error: source === "alaris" ? null : await usageError(start, db),
    });
  }
  return out;
}
