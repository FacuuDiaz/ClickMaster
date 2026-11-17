import { config } from "../config";
import { isAllowedAt } from "./schedule";
import type { ScheduleRule } from "./schema";

/**
 * Horario global de visitas (Configuracion -> Horario de visitas): fuera de
 * el, el worker no toma SMS de la cola (los que estan en curso terminan).
 * Es aparte del horario de cada politica, que mueve el next_attempt_at.
 * No afecta a los clicks manuales.
 */

const NAMES = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"];

/**
 * "lun-vie", "lun,mie,vie", "lun-vie,sab" o "todos" -> [1,2,3,4,5]...
 * Un rango que da la vuelta (vie-lun) vale. Null si no se entiende.
 */
export function parseDays(text: string): number[] | null {
  const t = text.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (t === "todos") return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set<number>();
  for (const part of t.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [a, b] = part.split("-").map((x) => NAMES.indexOf(x.trim().slice(0, 3)));
    if (a < 0 || (part.includes("-") && (b === undefined || b < 0))) return null;
    if (!part.includes("-")) {
      out.add(a);
      continue;
    }
    for (let d = a; ; d = (d + 1) % 7) {
      out.add(d);
      if (d === b) break;
    }
  }
  return out.size ? [...out].sort((x, y) => x - y) : null;
}

/** El horario global como regla de horario, o null si esta apagado. */
export function visitSchedule(): ScheduleRule | null {
  const v = config.visitHours;
  if (!v.enabled) return null;
  return { days: parseDays(v.days) ?? [0, 1, 2, 3, 4, 5, 6], ranges: [{ from: v.from, to: v.to }] };
}

export function withinVisitHours(date: Date): boolean {
  const schedule = visitSchedule();
  return schedule === null || isAllowedAt(schedule, date, config.edr.timezoneOffsetMinutes);
}
