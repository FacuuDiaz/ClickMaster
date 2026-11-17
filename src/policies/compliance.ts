import { config } from "../config";
import { reportsPool } from "../db/reportsPool";
import { policyDayStats, recentRate, type PolicyDayRow } from "../db/complianceRepo";
import { weeklyBaseline } from "./historical";
import { policiesCache } from "./repo";
import { periodStarts } from "./schedule";
import { withinVisitHours } from "./visitHours";
import type { Policy } from "./schema";

/**
 * Cumplimiento: por dia (de los SMS, hora de Alaris) y por politica, lo que
 * la politica prometia (objetivo) contra lo que se hizo (SMS con un 200).
 *
 * El objetivo se calcula con las reglas ACTUALES de la politica (si se
 * cambio el % a mitad del dia, el dia entero se mide con el nuevo):
 * - ventana / por defecto: X % de los SMS del dia (con el arrastre del
 *   redondeo, la suma de las ventanas da justo esto);
 * - dia vencido: X % de los SMS del dia; se eligen y visitan al dia siguiente;
 * - semana anterior: X % del mismo dia de la semana anterior (cuota diaria).
 * Las visitas de un dia tienen hasta el fin del dia para hacerse (dia
 * vencido: hasta el fin del dia siguiente).
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type ComplianceState = "en_curso" | "esperando_cierre" | "cerrado";

export interface PolicyCompliance {
  policyId: number | null;
  name: string;
  deleted: boolean;
  base: "ventana" | "dia_vencido" | "semana_anterior" | "por_defecto" | "no_visitar" | "desconocida";
  percentage: number | null;
  strategy: string | null;
  baseCount: number | null;
  baseLabel: string;
  target: number;
  stats: PolicyDayRow;
  compliance: number | null; // clickedSms / target
  state: ComplianceState;
  deadline: Date;
  projection: Projection | null;
}

export interface Projection {
  backlog: number; // en cola sin visitar
  ratePerHour: number; // visitas/hora del worker en la ultima hora
  hoursNeeded: number | null; // null = el worker no visito nada en la ultima hora
  hoursLeft: number; // horas de visita (respeta el horario global) hasta el limite
  onTrack: boolean;
}

export interface DayCompliance {
  day: string; // YYYY-MM-DD en hora de Alaris
  start: Date;
  end: Date;
  isToday: boolean;
  policies: PolicyCompliance[];
}

const offsetMs = () => config.edr.timezoneOffsetMinutes * 60_000;

/** "2026-11-17" (hora de Alaris) -> rango UTC del dia. */
export function dayRange(day: string): { start: Date; end: Date } {
  const [y, m, d] = day.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d) - offsetMs());
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export function dayLabel(start: Date): string {
  return new Date(start.getTime() + offsetMs()).toISOString().slice(0, 10);
}

/** Horas en que el worker puede visitar entre `from` y `to` (horario global). */
function visitHoursBetween(from: Date, to: Date): number {
  let hours = 0;
  for (let t = from.getTime(); t < to.getTime(); t += HOUR_MS) {
    const slice = Math.min(HOUR_MS, to.getTime() - t) / HOUR_MS;
    if (withinVisitHours(new Date(t))) hours += slice;
  }
  return hours;
}

async function targetFor(row: PolicyDayRow, policy: Policy | null, deleted: boolean, day: { start: Date; end: Date }) {
  const pctOf = (pct: number, n: number) => Math.round((n * pct) / 100);
  if (row.policyId === null) {
    const pct = config.checker.clickPercentage;
    return {
      base: "por_defecto" as const,
      percentage: pct,
      strategy: "aleatorio",
      baseCount: row.candidates,
      baseLabel: "SMS del dia que no coinciden con la politica",
      target: pctOf(pct, row.candidates),
    };
  }
  if (!policy) {
    // Borrada: no se sabe que prometia; se toma lo elegido como objetivo.
    return { base: "desconocida" as const, percentage: null, strategy: null, baseCount: null, baseLabel: "politica borrada: objetivo = elegidos", target: row.selected };
  }
  const sel = policy.rules.selection;
  if (sel.action === "no_visitar") {
    return { base: "no_visitar" as const, percentage: 0, strategy: null, baseCount: row.rejected, baseLabel: "SMS que la politica no visita", target: 0 };
  }
  if (sel.base === "semana_anterior") {
    const baseline = await weeklyBaseline(policy, day.start, day.end, sel.weeks, reportsPool);
    if (baseline !== null) {
      return {
        base: sel.base,
        percentage: sel.percentage,
        strategy: sel.strategy,
        baseCount: Math.round(baseline),
        baseLabel: sel.weeks > 1 ? `promedio del mismo dia de las ultimas ${sel.weeks} semanas` : "SMS del mismo dia de la semana anterior",
        target: Math.round((sel.percentage / 100) * baseline),
      };
    }
    return {
      base: sel.base,
      percentage: sel.percentage,
      strategy: sel.strategy,
      baseCount: row.candidates,
      baseLabel: "sin datos de la semana anterior: SMS del dia",
      target: pctOf(sel.percentage, row.candidates),
    };
  }
  return {
    base: sel.base,
    percentage: sel.percentage,
    strategy: sel.strategy,
    baseCount: row.candidates,
    baseLabel: sel.base === "dia_vencido" ? "SMS del dia (se eligen al dia siguiente)" : "SMS del dia",
    target: pctOf(sel.percentage, row.candidates),
  };
}

export async function dayCompliance(day: string, now: Date, rate?: { visits: number }): Promise<DayCompliance> {
  const range = dayRange(day);
  const rows = await policyDayStats(range.start, range.end);
  const ratePerHour = (rate ?? (await recentRate(now))).visits;
  const policies: PolicyCompliance[] = [];
  for (const row of rows) {
    const policy = row.policyId === null ? null : policiesCache.byId(row.policyId);
    const deleted = row.policyId !== null && !policy;
    const t = await targetFor(row, policy, deleted, range);
    // Sin nada que medir (ej. por defecto con 0 SMS) no se muestra.
    if (row.candidates === 0 && row.rejected === 0) continue;

    const deadline = new Date(range.end.getTime() + (t.base === "dia_vencido" ? DAY_MS : 0));
    let state: ComplianceState = now >= deadline ? "cerrado" : "en_curso";
    if (t.base === "dia_vencido" && now < range.end) state = "esperando_cierre";

    let projection: Projection | null = null;
    if (state === "en_curso" && row.queued > 0) {
      const hoursLeft = visitHoursBetween(now, deadline);
      const hoursNeeded = ratePerHour > 0 ? row.queued / ratePerHour : null;
      projection = {
        backlog: row.queued,
        ratePerHour,
        hoursNeeded: hoursNeeded === null ? null : Math.round(hoursNeeded * 10) / 10,
        hoursLeft: Math.round(hoursLeft * 10) / 10,
        onTrack: hoursNeeded !== null && hoursNeeded <= hoursLeft,
      };
    }

    policies.push({
      policyId: row.policyId,
      name: row.policyId === null ? "Por defecto" : policy?.name ?? `Politica ${row.policyId} (borrada)`,
      deleted,
      ...t,
      stats: row,
      compliance: t.target > 0 ? row.clickedSms / t.target : null,
      state,
      deadline,
      projection,
    });
  }
  // La politica (no la regla por defecto) primero; despues por objetivo.
  policies.sort((a, b) => Number(a.policyId === null) - Number(b.policyId === null) || b.target - a.target);
  return { day, ...range, isToday: dayLabel(periodStarts(now, config.edr.timezoneOffsetMinutes).day) === day, policies };
}

/** Los ultimos `days` dias (el de hoy primero). */
export function lastDays(now: Date, days: number): string[] {
  const today = periodStarts(now, config.edr.timezoneOffsetMinutes).day.getTime();
  return Array.from({ length: days }, (_, i) => dayLabel(new Date(today - i * DAY_MS)));
}
