import type { RowDataPacket } from "mysql2";
import { pool } from "../db/pool";
import { countPolicySms } from "./repo";
import type { Policy } from "./schema";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

type Db = { query: typeof pool.query };

function matchesEverything(policy: Policy): boolean {
  return Object.values(policy.rules.match).every((list) => list.length === 0);
}

/** SMS con link (de cualquier politica) con edr_date en el rango. */
export async function countSmsWithLink(start: Date, end: Date, db: Db = pool): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM sms_processing FORCE INDEX (idx_edr_date)
      WHERE edr_date >= ? AND edr_date < ? AND (skip_reason IS NULL OR skip_reason <> 'sin_link')`,
    [start, end]
  );
  return Number(rows[0].n);
}

/**
 * Cuantos SMS tuvo la politica en el mismo rango de las `weeks` semanas
 * anteriores (promedio de las semanas con datos; las que estan en cero casi
 * siempre son semanas en que la politica no existia y bajarian el promedio).
 *
 * Se cuenta por policy_id. Si la politica no tiene historico propio pero
 * toma todos los SMS (sin filtros), se usa el total de SMS con link: asi una
 * politica recien creada ya tiene referencia. Sin nada -> null.
 */
export async function weeklyBaseline(policy: Policy, start: Date, end: Date, weeks: number, db: Db = pool): Promise<number | null> {
  const avg = async (count: (s: Date, e: Date) => Promise<number>) => {
    const counts: number[] = [];
    for (let w = 1; w <= weeks; w++) {
      const n = await count(new Date(start.getTime() - w * WEEK_MS), new Date(end.getTime() - w * WEEK_MS));
      if (n > 0) counts.push(n);
    }
    return counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : null;
  };
  // Politica sin guardar (vista previa): no tiene filas propias.
  const own = policy.id > 0 ? await avg((s, e) => countPolicySms(policy.id, s, e, db)) : null;
  if (own !== null) return own;
  return matchesEverything(policy) ? avg((s, e) => countSmsWithLink(s, e, db)) : null;
}
