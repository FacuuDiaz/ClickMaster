import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import { config } from "../config";
import { pool } from "../db/pool";
import { formatApiDate, parseApiDate } from "../edr/apiTime";
import { httpRequest, type HttpResponse } from "../fetcher/httpPost";
import { errorMessage, log } from "../logger";

/**
 * Cuantos SMS mando el producto un dia, hora por hora, segun la REST API de
 * la plataforma Alaris (GET sms_usage_stats, cubos horarios con
 * use_hourly_data=1). Se usa count_ok (mensajes enviados).
 *
 * Se guarda en alaris_usage_days: la seleccion (windowSelect) y la vista
 * previa leen de ahi, asi la API se pide pocas veces por dia:
 * - si fallo, se reintenta a los 15 minutos (mientras, conteo local);
 * - si salio bien pero se pidio antes de que el dia tuviera 3 horas de
 *   cerrado, se vuelve a pedir cada hora (los cubos pueden venir atrasados).
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RETRY_ERROR_MS = 15 * 60_000;
const RETRY_FRESH_MS = 60 * 60_000;
const SETTLE_MS = 3 * HOUR_MS;
// La doc no dice el tope por defecto: se pide de sobra (filas = horas x redes).
const REC_COUNT = 100_000;

export type Db = { query: typeof pool.query };

export interface UsageDay {
  hourly: number[]; // 24 valores, por hora de Alaris
  total: number;
}

const rowSchema = z
  .object({
    dcheck: z.string().optional(),
    count_ok: z.coerce.number().default(0),
    is_total: z.coerce.number().default(0),
  })
  .passthrough();

export function productId(): string | undefined {
  return config.alarisRest.productId ?? config.edr.clientProductId;
}

export function isConfigured(): boolean {
  return Boolean(config.alarisRest.url && config.alarisRest.auth && productId());
}

/** "YYYY-MM-DD" (hora de Alaris) del dia que empieza en `dayStart` (UTC). */
export function dayKey(dayStart: Date): string {
  return new Date(dayStart.getTime() + config.edr.timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function buildUrl(dayStart: Date): string {
  const offset = config.edr.timezoneOffsetMinutes;
  // Los cubos son diarios: fechas sin hora (con hora el dia no se cuenta).
  // Se pide hasta el dia siguiente y se filtra por dcheck: no depende de si
  // end_date es inclusivo.
  const date = (d: Date) => formatApiDate(d, offset).slice(0, 10);
  const params = new URLSearchParams({
    start_date: date(dayStart),
    end_date: date(new Date(dayStart.getTime() + DAY_MS)),
    product_id: String(productId()),
    use_hourly_data: "1",
    rec_count: String(REC_COUNT),
  });
  // Mismo pais que la ingesta (filter: el nombre del pais o destino empieza asi).
  if (config.edr.country) params.set("filter", config.edr.country);
  return `${String(config.alarisRest.url).replace(/\/+$/, "")}/sms_usage_stats?${params}`;
}

/** Suma count_ok por hora del dia; descarta la fila Total y otros dias. */
export function parseUsage(body: string, dayStart: Date): UsageDay {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`respuesta no es JSON: ${body.slice(0, 200)}`);
  }
  if (!Array.isArray(data)) {
    throw new Error(`se esperaba una lista: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const hourly = Array.from({ length: 24 }, () => 0);
  if (data.length >= REC_COUNT) throw new Error(`la respuesta llego al tope de ${REC_COUNT} filas`);
  for (const raw of data) {
    const row = rowSchema.parse(raw);
    if (row.is_total === 1 || !row.dcheck) continue;
    const at = parseApiDate(row.dcheck.trim(), config.edr.timezoneOffsetMinutes);
    if (!at) throw new Error(`dcheck con formato inesperado: ${row.dcheck}`);
    const hour = Math.floor((at.getTime() - dayStart.getTime()) / HOUR_MS);
    if (hour < 0 || hour > 23) continue;
    hourly[hour] += row.count_ok;
  }
  return { hourly, total: hourly.reduce((a, b) => a + b, 0) };
}

export type UsageFetcher = (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<HttpResponse>;

const httpFetcher: UsageFetcher = (url, headers, timeoutMs) => httpRequest("GET", url, null, headers, timeoutMs);

export async function fetchUsageDay(dayStart: Date, fetcher: UsageFetcher = httpFetcher): Promise<UsageDay> {
  const res = await fetcher(
    buildUrl(dayStart),
    { Accept: "application/json", Authorization: `Basic ${config.alarisRest.auth}` },
    config.alarisRest.timeoutMs
  );
  if (res.status !== 200) throw new Error(`HTTP ${res.status} ${res.statusText}: ${res.body.slice(0, 200)}`);
  return parseUsage(res.body, dayStart);
}

interface StoredRow {
  status: "ok" | "error";
  hourly: string | null;
  fetched_at: Date;
}

async function stored(day: string, db: Db): Promise<StoredRow | null> {
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT status, hourly, fetched_at FROM alaris_usage_days WHERE product_id = ? AND day = ?",
    [productId(), day]
  );
  return rows.length ? (rows[0] as StoredRow) : null;
}

function toUsage(row: StoredRow | null): UsageDay | null {
  if (!row || row.status !== "ok" || !row.hourly) return null;
  const hourly = (JSON.parse(row.hourly) as number[]).map(Number);
  return { hourly, total: hourly.reduce((a, b) => a + b, 0) };
}

/** Lo guardado del dia (sin pedir nada). null = no hay dato de Alaris. */
export async function storedUsage(dayStart: Date, db: Db = pool): Promise<UsageDay | null> {
  if (!productId()) return null;
  return toUsage(await stored(dayKey(dayStart), db));
}

/** Ultimo error al pedir el dia (null si el ultimo pedido salio bien o nunca se pidio). */
export async function usageError(dayStart: Date, db: Db = pool): Promise<string | null> {
  if (!productId()) return null;
  const [rows] = await db.query<RowDataPacket[]>(
    "SELECT error FROM alaris_usage_days WHERE product_id = ? AND day = ?",
    [productId(), dayKey(dayStart)]
  );
  return rows.length && rows[0].error ? String(rows[0].error) : null;
}

function needsFetch(row: StoredRow | null, dayStart: Date, now: Date): boolean {
  if (!row) return true;
  const fetchedAt = new Date(row.fetched_at).getTime();
  if (row.status === "error") return now.getTime() - fetchedAt >= RETRY_ERROR_MS;
  const settled = fetchedAt >= dayStart.getTime() + DAY_MS + SETTLE_MS;
  return !settled && now.getTime() - fetchedAt >= RETRY_FRESH_MS;
}

const inflight = new Map<string, Promise<UsageDay | null>>();

/**
 * Datos de Alaris de un dia ya cerrado, pidiendolos si hace falta. Nunca
 * tira: si la API falla queda registrado y devuelve lo ultimo bueno (o null).
 */
export async function ensureUsage(
  dayStart: Date,
  now: Date,
  fetcher?: UsageFetcher,
  opts: { force?: boolean } = {}
): Promise<UsageDay | null> {
  if (!isConfigured()) return null;
  // El dia todavia no cerro: el cubo esta incompleto.
  if (dayStart.getTime() + DAY_MS > now.getTime()) return null;
  const day = dayKey(dayStart);
  const key = `${productId()}|${day}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    const row = await stored(day, pool);
    if (!opts.force && !needsFetch(row, dayStart, now)) return toUsage(row);
    try {
      const usage = await fetchUsageDay(dayStart, fetcher);
      await pool.query(
        `INSERT INTO alaris_usage_days (product_id, day, status, hourly, total_ok, error, fetched_at)
         VALUES (?, ?, 'ok', ?, ?, NULL, ?)
         ON DUPLICATE KEY UPDATE status = 'ok', hourly = VALUES(hourly), total_ok = VALUES(total_ok), error = NULL, fetched_at = VALUES(fetched_at)`,
        [productId(), day, JSON.stringify(usage.hourly), usage.total, now]
      );
      log.info("alaris rest: sms_usage_stats guardado", { day, productId: productId(), total: usage.total });
      return usage;
    } catch (err) {
      const message = errorMessage(err).slice(0, 512);
      // Si ya habia un dato bueno se conserva; solo se anota el error.
      await pool.query(
        `INSERT INTO alaris_usage_days (product_id, day, status, hourly, total_ok, error, fetched_at)
         VALUES (?, ?, 'error', NULL, NULL, ?, ?)
         ON DUPLICATE KEY UPDATE error = VALUES(error), fetched_at = VALUES(fetched_at)`,
        [productId(), day, message, now]
      );
      log.warn("alaris rest: no se pudo pedir sms_usage_stats, se usa el conteo local", { day, error: message });
      return toUsage(row);
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}
