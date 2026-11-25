import type { RowDataPacket } from "mysql2";
import { pool } from "./pool";

/**
 * Contadores por minuto de lo ingerido (ver ingest_minute_counts en
 * db/schema.ts). Los escribe la ingesta; los leen la base semana_referencia
 * (proporcion con link de hoy), el respaldo local de las referencias y el
 * grafico del Panel.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

type Db = { query: typeof pool.query };

export interface MinuteCount {
  total: number;
  withLink: number;
  matched: number;
}

/** Acumulador en memoria de una ventana (minuto UTC en ms -> conteos). */
export class MinuteCounter {
  private readonly minutes = new Map<number, MinuteCount>();

  constructor(private readonly range: { start: Date; end: Date }) {}

  add(edrDate: Date, withLink: boolean, matched: boolean): void {
    const t = edrDate.getTime();
    // El solape de la consulta (antes del inicio) es de la ventana anterior.
    if (t < this.range.start.getTime() || t >= this.range.end.getTime()) return;
    const minute = Math.floor(t / MINUTE_MS) * MINUTE_MS;
    let c = this.minutes.get(minute);
    if (!c) {
      c = { total: 0, withLink: 0, matched: 0 };
      this.minutes.set(minute, c);
    }
    c.total++;
    if (withLink) c.withLink++;
    if (matched) c.matched++;
  }

  /** Minutos enteros de la ventana (un minuto partido quedaria contado a medias). */
  rows(): [number, MinuteCount][] {
    const first = Math.ceil(this.range.start.getTime() / MINUTE_MS) * MINUTE_MS;
    const last = Math.floor(this.range.end.getTime() / MINUTE_MS) * MINUTE_MS; // excluido
    const out: [number, MinuteCount][] = [];
    for (let m = first; m < last; m += MINUTE_MS) {
      out.push([m, this.minutes.get(m) ?? { total: 0, withLink: 0, matched: 0 }]);
    }
    return out;
  }
}

/** Escribe los minutos de la ventana (pisa lo que habia: mismo rango, mismo valor). */
export async function saveMinuteCounts(counter: MinuteCounter, policyId: number | null, now: Date, db: Db = pool): Promise<void> {
  const rows = counter.rows();
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await db.query(
      `INSERT INTO ingest_minute_counts (minute_start, total, with_link, policy_id, matched, updated_at) VALUES ?
       ON DUPLICATE KEY UPDATE total = VALUES(total), with_link = VALUES(with_link), policy_id = VALUES(policy_id),
         matched = VALUES(matched), updated_at = VALUES(updated_at)`,
      [chunk.map(([m, c]) => [new Date(m), c.total, c.withLink, policyId, c.matched, now])]
    );
  }
}

export interface RangeCounts {
  minutes: number; // minutos con fila (0 = no hay contadores para el rango)
  total: number;
  withLink: number;
  // SMS que la politica pedida podia tomar: los que tomo en los minutos
  // ingeridos con ella activa; en los demas, todos los con link (mejor
  // aproximacion si se cambio de politica a mitad del dia).
  eligible: number;
}

/** Suma de [start, end) (`inclusive`: hasta end inclusive). */
export async function countsBetween(start: Date, end: Date, policyId: number | null, db: Db = pool): Promise<RangeCounts> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS minutes, COALESCE(SUM(total), 0) AS total, COALESCE(SUM(with_link), 0) AS with_link,
            COALESCE(SUM(CASE WHEN policy_id <=> ? THEN matched ELSE with_link END), 0) AS eligible
       FROM ingest_minute_counts WHERE minute_start >= ? AND minute_start < ?`,
    [policyId, start, end]
  );
  const r = rows[0];
  return { minutes: Number(r.minutes), total: Number(r.total), withLink: Number(r.with_link), eligible: Number(r.eligible) };
}

/** Total por hora de un dia (24 valores) o null si no hay contadores ese dia. */
export async function hourlyTotals(dayStart: Date, db: Db = pool): Promise<number[] | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT TIMESTAMPDIFF(HOUR, ?, minute_start) AS h, SUM(total) AS n
       FROM ingest_minute_counts WHERE minute_start >= ? AND minute_start < ?
      GROUP BY h`,
    [dayStart, dayStart, new Date(dayStart.getTime() + 24 * HOUR_MS)]
  );
  if (rows.length === 0) return null;
  const hourly = Array.from({ length: 24 }, () => 0);
  for (const r of rows) {
    const h = Number(r.h);
    if (h >= 0 && h < 24) hourly[h] += Number(r.n);
  }
  return hourly;
}
