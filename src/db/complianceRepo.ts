import type { RowDataPacket } from "mysql2";
import { reportsPool } from "./reportsPool";

/**
 * Consultas del cumplimiento de politicas (Reportes -> Cumplimiento). Todas
 * por el pool de reportes (solo lectura, con MAX_EXECUTION_TIME).
 */

export interface PolicyDayRow {
  policyId: number | null;
  // SMS con link que tomo la politica (sin los que manda no visitar).
  candidates: number;
  selected: number; // elegidos para visitar (en cola o visitados)
  queued: number; // pending / processing / retry
  visited: number; // success / failed
  clickedSms: number; // con al menos un 200
  clicks: number; // total de 200 (un SMS re-clickeado suma 2)
  capped: number; // recortados por tope
  held: number; // todavia en seleccion
  no200: number; // visitados sin ningun 200
  rejected: number; // la politica dice no visitar
}

const num = (v: unknown) => Number(v ?? 0);

/** Totales por politica de los SMS con edr_date en el rango (un dia). */
export async function policyDayStats(start: Date, end: Date): Promise<PolicyDayRow[]> {
  const [rows] = await reportsPool.query<RowDataPacket[]>(
    `SELECT policy_id,
            SUM(skip_reason IS NULL OR skip_reason <> 'politica') AS candidates,
            SUM(status <> 'skipped') AS selected,
            SUM(status IN ('pending', 'processing', 'retry')) AS queued,
            SUM(status IN ('success', 'failed')) AS visited,
            SUM(clicks > 0) AS clicked_sms,
            SUM(clicks) AS clicks,
            SUM(skip_reason = 'tope_politica') AS capped,
            SUM(skip_reason = 'en_seleccion') AS held,
            SUM(status IN ('success', 'failed') AND clicks = 0) AS no200,
            SUM(skip_reason = 'politica') AS rejected
       FROM sms_processing FORCE INDEX (idx_edr_date)
      WHERE edr_date >= ? AND edr_date < ? AND (skip_reason IS NULL OR skip_reason <> 'sin_link')
      GROUP BY policy_id`,
    [start, end]
  );
  return rows.map((r) => ({
    policyId: r.policy_id === null ? null : Number(r.policy_id),
    candidates: num(r.candidates),
    selected: num(r.selected),
    queued: num(r.queued),
    visited: num(r.visited),
    clickedSms: num(r.clicked_sms),
    clicks: num(r.clicks),
    capped: num(r.capped),
    held: num(r.held),
    no200: num(r.no200),
    rejected: num(r.rejected),
  }));
}

export interface HourBucket {
  h: number; // horas desde `from`
  selected: number;
  clicks: number;
}

function policyWhere(policyId: number | null): [string, unknown[]] {
  return policyId === null ? ["p.policy_id IS NULL", []] : ["p.policy_id = ?", [policyId]];
}

/**
 * Avance por hora de una politica en un dia de SMS: cuantos se eligieron y
 * cuantos 200 hubo en cada hora desde `from` (las visitas pueden caer despues
 * del dia de los SMS: dia vencido se visita al dia siguiente).
 */
export async function policyHourly(
  policyId: number | null,
  day: { start: Date; end: Date },
  from: Date,
  to: Date
): Promise<HourBucket[]> {
  const [where, params] = policyWhere(policyId);
  const [sel] = await reportsPool.query<RowDataPacket[]>(
    `SELECT TIMESTAMPDIFF(HOUR, ?, p.selected_at) AS h, COUNT(*) AS n
       FROM sms_processing p FORCE INDEX (idx_policy_edr)
      WHERE ${where} AND p.edr_date >= ? AND p.edr_date < ?
        AND p.status <> 'skipped' AND p.selected_at >= ? AND p.selected_at < ?
      GROUP BY h`,
    [from, ...params, day.start, day.end, from, to]
  );
  const [clk] = await reportsPool.query<RowDataPacket[]>(
    `SELECT TIMESTAMPDIFF(HOUR, ?, c.checked_at) AS h, COUNT(*) AS n
       FROM sms_processing p FORCE INDEX (idx_policy_edr)
       JOIN sms_link_checks c FORCE INDEX (idx_processing_id) ON c.processing_id = p.id
      WHERE ${where} AND p.edr_date >= ? AND p.edr_date < ?
        AND c.http_status = 200 AND c.checked_at >= ? AND c.checked_at < ?
      GROUP BY h`,
    [from, ...params, day.start, day.end, from, to]
  );
  const hours = Math.ceil((to.getTime() - from.getTime()) / 3_600_000);
  const out: HourBucket[] = Array.from({ length: hours }, (_, h) => ({ h, selected: 0, clicks: 0 }));
  for (const r of sel) if (out[Number(r.h)]) out[Number(r.h)].selected = num(r.n);
  for (const r of clk) if (out[Number(r.h)]) out[Number(r.h)].clicks = num(r.n);
  return out;
}

/** Ritmo del worker en la ultima hora (todas las politicas): visitas y 200. */
export async function recentRate(now: Date): Promise<{ visits: number; clicks: number }> {
  const [rows] = await reportsPool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS visits, SUM(http_status = 200) AS clicks
       FROM sms_link_checks FORCE INDEX (idx_checked_at)
      WHERE checked_at >= ? AND checked_at < ?`,
    [new Date(now.getTime() - 3_600_000), now]
  );
  return { visits: num(rows[0].visits), clicks: num(rows[0].clicks) };
}
