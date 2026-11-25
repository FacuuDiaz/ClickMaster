import type { RowDataPacket } from "mysql2";
import { reportsPool } from "../db/reportsPool";
import { factsOf, matchPolicy, type SmsFacts } from "./match";
import { weeklyBaseline } from "./historical";
import { config } from "../config";
import { referenceVolume, SOURCE_LABEL } from "./previousDay";
import { refDayFor } from "./referenceWeek";
import { periodStarts } from "./schedule";
import { STRATEGY_INFO } from "./strategies";
import type { Policy } from "./schema";

// Tope de SMS que se leen para estimar: alcanza para una muestra
// representativa sin cargar la base ni la memoria.
const MAX_ROWS = 20_000;

export interface PolicyEstimate {
  policyId: number | null;
  name: string;
  matched: number;
  percentage: number;
  estimatedVisits: number;
  note: string | null;
}

export interface Estimate {
  hours: number;
  sampled: number;
  truncated: boolean;
  withoutLink: number;
  rows: PolicyEstimate[];
}

/**
 * Cuenta, sobre un conjunto de SMS, cuantos tomaria cada politica y cuantos
 * se visitarian. Es una estimacion: no aplica topes ni horarios, y la
 * estrategia decide cuales pero no cuantos. Lo usan la vista previa y la
 * simulacion sobre capturas de Alaris.
 */
export async function estimate(
  facts: SmsFacts[],
  policies: Policy[],
  defaultPercentage: number,
  range: { start: Date; end: Date },
  db: { query: typeof reportsPool.query } = reportsPool
): Promise<Omit<Estimate, "hours" | "truncated">> {
  const matched = new Map<number | null, number>();
  let withoutLink = 0;
  for (const f of facts) {
    if (!f.link) {
      withoutLink++;
      continue;
    }
    const policy = matchPolicy(policies, f);
    const id = policy?.id ?? null;
    matched.set(id, (matched.get(id) ?? 0) + 1);
  }

  const rows: PolicyEstimate[] = [];
  for (const policy of [...policies.filter((p) => p.enabled), null]) {
    const n = matched.get(policy?.id ?? null) ?? 0;
    let visits = Math.round((n * defaultPercentage) / 100);
    let note: string | null = policy ? null : "SMS que no coinciden con ninguna politica (porcentaje por defecto, al azar)";
    if (policy) {
      const sel = policy.rules.selection;
      const how = STRATEGY_INFO[sel.strategy].label.toLowerCase();
      visits = Math.round((n * sel.percentage) / 100);
      if (sel.action === "no_visitar") {
        visits = 0;
        note = "no se visitan";
      } else if (sel.base === "ventana") {
        note = `${sel.percentage}% de cada ventana, ${how}`;
      } else if (sel.base === "dia_vencido") {
        note = `${sel.percentage}% del dia, ${how}: se eligen al dia siguiente`;
      } else if (sel.base === "dia_anterior" || sel.base === "semana_referencia") {
        const shift =
          sel.base === "semana_referencia" && sel.weekStart
            ? refDayFor(range.start, sel.weekStart).getTime() - periodStarts(range.start, config.edr.timezoneOffsetMinutes).day.getTime()
            : -86_400_000;
        const ref = await referenceVolume(new Date(range.start.getTime() + shift), new Date(range.end.getTime() + shift), db);
        const ratio = facts.length > 0 ? n / facts.length : 0;
        visits = Math.min(n, Math.round((sel.percentage / 100) * ratio * ref.volume));
        note =
          `${sel.percentage}% de ${Math.round(ref.volume)} SMS ${sel.base === "semana_referencia" ? "de la semana de referencia" : "de ayer"} en el mismo rango (${SOURCE_LABEL[ref.source]}), ` +
          `x ${Math.round(ratio * 1000) / 10}% que toma la politica, ${how}`;
      } else {
        const baseline = await weeklyBaseline(policy, range.start, range.end, sel.weeks, db);
        if (baseline === null) {
          note = `sin historico de la semana anterior: ${sel.percentage}% de cada ventana`;
        } else {
          visits = Math.min(n, Math.round((sel.percentage / 100) * baseline));
          note = `${sel.percentage}% de ${Math.round(baseline)} SMS en el mismo rango de la semana anterior, ${how}`;
        }
      }
      const { perHour, perDay } = policy.rules.limits;
      if (perHour !== null || perDay !== null) {
        note = `${note ? `${note}; ` : ""}topes no incluidos en la estimacion`;
      }
    }
    rows.push({
      policyId: policy?.id ?? null,
      name: policy?.name ?? "Por defecto",
      matched: n,
      percentage: n > 0 ? Math.round((1000 * visits) / n) / 10 : 0,
      estimatedVisits: visits,
      note,
    });
  }
  return { sampled: facts.length, withoutLink, rows };
}

/** Estimacion sobre los SMS ingestados en las ultimas `hours` horas. */
export async function previewRecent(policies: Policy[], defaultPercentage: number, hours: number, now = new Date()): Promise<Estimate> {
  const start = new Date(now.getTime() - hours * 3_600_000);
  const [rows] = await reportsPool.query<RowDataPacket[]>(
    `SELECT c.client, c.sender_name, c.country, c.network, c.mccmnc, c.vendor, c.text
       FROM sms_processing p FORCE INDEX (idx_created_at)
       JOIN sms_content c ON c.id = p.sms_content_id
      WHERE p.created_at >= ? AND p.created_at < ?
      ORDER BY p.created_at DESC
      LIMIT ?`,
    [start, now, MAX_ROWS + 1]
  );
  const truncated = rows.length > MAX_ROWS;
  const facts = rows.slice(0, MAX_ROWS).map((r) => factsOf(r));
  return { hours, truncated, ...(await estimate(facts, policies, defaultPercentage, { start, end: now })) };
}
