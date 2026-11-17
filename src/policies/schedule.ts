import type { ScheduleRule } from "./schema";

/**
 * Franjas horarias de una politica, en la hora de Alaris (EDR_TIMEZONE_OFFSET,
 * sin horario de verano). Las fechas de la app son UTC: se corren por el
 * offset y se leen con los getters UTC, igual que en edr/apiTime.ts.
 */
const DAY_MS = 86_400_000;

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function rangesOf(schedule: ScheduleRule): [number, number][] {
  if (schedule.ranges.length === 0) return [[0, 1440]];
  return schedule.ranges.map((r) => [minutesOf(r.from), minutesOf(r.to)] as [number, number]).sort((a, b) => a[0] - b[0]);
}

export function isAllowedAt(schedule: ScheduleRule, date: Date, offsetMinutes: number): boolean {
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  if (!schedule.days.includes(local.getUTCDay())) return false;
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes();
  return rangesOf(schedule).some(([from, to]) => minute >= from && minute < to);
}

/**
 * `date` si la politica permite visitar en ese momento; si no, el inicio de
 * la proxima franja permitida. Busca hasta 8 dias (siempre hay alguno: el
 * schema exige al menos un dia).
 */
export function nextAllowedAt(schedule: ScheduleRule, date: Date, offsetMinutes: number): Date {
  if (isAllowedAt(schedule, date, offsetMinutes)) return date;
  const offsetMs = offsetMinutes * 60_000;
  const localMs = date.getTime() + offsetMs;
  const localMidnight = Math.floor(localMs / DAY_MS) * DAY_MS;
  const ranges = rangesOf(schedule);
  for (let d = 0; d <= 8; d++) {
    const dayStart = localMidnight + d * DAY_MS;
    if (!schedule.days.includes(new Date(dayStart).getUTCDay())) continue;
    for (const [from] of ranges) {
      const start = dayStart + from * 60_000;
      if (start > localMs) return new Date(start - offsetMs);
    }
  }
  return date;
}

/** Inicio de la hora y del dia (hora de Alaris) que contienen `date`, en UTC. */
export function periodStarts(date: Date, offsetMinutes: number): { hour: Date; day: Date } {
  const offsetMs = offsetMinutes * 60_000;
  const local = date.getTime() + offsetMs;
  return {
    hour: new Date(Math.floor(local / 3_600_000) * 3_600_000 - offsetMs),
    day: new Date(Math.floor(local / DAY_MS) * DAY_MS - offsetMs),
  };
}
