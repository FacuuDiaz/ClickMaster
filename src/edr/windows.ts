import { parseApiDate } from "./apiTime";

export interface TimeWindow {
  start: Date;
  end: Date;
}

const MINUTE_MS = 60_000;

/**
 * Redondea hacia abajo al multiplo de `windowMinutes` en la hora local de
 * la API (asi las ventanas quedan 09:00-09:30, 09:30-10:00 en esa hora).
 */
export function alignDown(date: Date, windowMinutes: number, offsetMinutes: number): Date {
  const windowMs = windowMinutes * MINUTE_MS;
  const localMs = date.getTime() + offsetMinutes * MINUTE_MS;
  return new Date(Math.floor(localMs / windowMs) * windowMs - offsetMinutes * MINUTE_MS);
}

export interface WindowPlan {
  windowMinutes: number;
  safetyDelayMinutes: number;
  offsetMinutes: number;
  startDate?: string;
}

/**
 * Proxima ventana a pedir, o null si todavia no cerro (contando el margen
 * de seguridad). El cursor es el fin de la ultima ventana completa, que
 * sale de sync_runs y no del reloj: despues de un reinicio o de una caida
 * de la API se siguen pidiendo las ventanas atrasadas, una tras otra.
 */
export function nextScheduledWindow(
  cursorEnd: Date | null,
  now: Date,
  plan: WindowPlan
): TimeWindow | null {
  const windowMs = plan.windowMinutes * MINUTE_MS;
  const horizon = new Date(now.getTime() - plan.safetyDelayMinutes * MINUTE_MS);

  let start: Date;
  if (cursorEnd) {
    start = cursorEnd;
  } else if (plan.startDate) {
    const parsed = parseApiDate(plan.startDate, plan.offsetMinutes) ?? new Date(plan.startDate);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`EDR_START_DATE invalida: "${plan.startDate}" (formato YYYY.MM.DD HH:mm:ss)`);
    }
    start = alignDown(parsed, plan.windowMinutes, plan.offsetMinutes);
  } else {
    // Sin historial: arranca por la ultima ventana ya cerrada, no hace backfill.
    start = new Date(alignDown(horizon, plan.windowMinutes, plan.offsetMinutes).getTime() - windowMs);
  }

  // El fin se alinea a la grilla del tamano actual. Con un cursor alineado
  // es lo mismo que start + ventana; si el tamano se cambio desde la web
  // (ej. 30 -> 60 min con el cursor en 09:30), la primera ventana se recorta
  // hasta el proximo borde (09:30-10:00) y despues sigue alineada. Nunca
  // quedan huecos ni rangos repetidos: siempre arranca en el cursor.
  let end = alignDown(new Date(start.getTime() + windowMs), plan.windowMinutes, plan.offsetMinutes);
  if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + windowMs);
  return end.getTime() <= horizon.getTime() ? { start, end } : null;
}

/** Parte un rango en dos mitades redondeadas al segundo (la API no tiene milisegundos). */
export function splitRange(range: TimeWindow): [TimeWindow, TimeWindow] {
  const halfMs = Math.floor((range.end.getTime() - range.start.getTime()) / 2 / 1000) * 1000;
  const mid = new Date(range.start.getTime() + halfMs);
  return [
    { start: range.start, end: mid },
    { start: mid, end: range.end },
  ];
}
