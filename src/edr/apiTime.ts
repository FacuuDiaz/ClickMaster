/**
 * La API EDR trabaja con fechas "YYYY.MM.DD HH:mm:ss" sin zona, en hora
 * local (EDR_TIMEZONE_OFFSET, hoy GMT-3 sin horario de verano). Adentro de
 * la app todo es UTC (Date); estas funciones son la unica frontera.
 */
const API_DATE_REGEX = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026.09.30 12:18:55" (local de la API) -> Date UTC. null si no matchea. */
export function parseApiDate(value: string, offsetMinutes: number): Date | null {
  const m = value.match(API_DATE_REGEX);
  if (!m) return null;
  const utcMs =
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) -
    offsetMinutes * 60_000;
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Date UTC -> "2026.09.30 12:18:55" en la hora local de la API. */
export function formatApiDate(date: Date, offsetMinutes: number): string {
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  return (
    `${local.getUTCFullYear()}.${pad(local.getUTCMonth() + 1)}.${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`
  );
}

/** "+HH:MM" / "-HH:MM" para armar ISO 8601 con offset. */
export function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
