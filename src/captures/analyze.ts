import { config } from "../config";
import { parseApiDate } from "../edr/apiTime";
import { edrEnvelopeSchema } from "../parser/smsRecordSchema";
import { factsOf } from "../policies/match";
import type { EdrFetcher } from "../fetcher/apiClient";
import { getCapture, readCaptureBody, saveSummary, type CaptureMeta } from "./repo";

/**
 * Analisis de una captura: descomprime y parsea bajo demanda. Una respuesta
 * de 20.000 EDR son ~40 MB de texto y bastante mas en objetos, asi que:
 * - una sola a la vez (single-flight por id, y nunca dos ids en paralelo),
 * - se guarda en memoria solo la ultima, por 2 minutos, para paginar.
 */
const CACHE_MS = 2 * 60_000;

interface Loaded {
  meta: CaptureMeta;
  records: Record<string, unknown>[];
  parseError: string | null;
}

let cache: { id: number; value: Loaded; expires: number } | null = null;
let current: Promise<unknown> = Promise.resolve();
const inflight = new Map<number, Promise<Loaded | null>>();

function parse(meta: CaptureMeta, body: string): Loaded {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { meta, records: [], parseError: "la respuesta no es JSON valido" };
  }
  // Los registros invalidos se guardan como array plano.
  const envelope = edrEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { meta, records: [], parseError: "la respuesta no trae result.data (puede ser un error de la API)" };
  }
  const records = envelope.data.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object");
  return { meta, records, parseError: null };
}

export function loadCapture(id: number): Promise<Loaded | null> {
  if (cache && cache.id === id && cache.expires > Date.now()) return Promise.resolve(cache.value);
  const pending = inflight.get(id);
  if (pending) return pending;

  // Encadenada detras de la anterior: nunca dos parseos grandes a la vez.
  const run = current.then(async () => {
    const meta = await getCapture(id);
    if (!meta) return null;
    const body = await readCaptureBody(id);
    if (body === null) return null;
    const loaded = parse(meta, body);
    cache = { id, value: loaded, expires: Date.now() + CACHE_MS };
    return loaded;
  });
  current = run.catch(() => undefined);
  inflight.set(id, run);
  run.finally(() => inflight.delete(id)).catch(() => undefined);
  return run;
}

/** Para tests y despues de borrar/reprocesar. */
export function forgetCapture(id?: number): void {
  if (!id || cache?.id === id) cache = null;
}

function top(counter: Map<string, number>, n = 10): { value: string; count: number }[] {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => ({ value, count }));
}

export function summarize(records: Record<string, unknown>[]) {
  const counters = { clients: new Map<string, number>(), senders: new Map<string, number>(), countries: new Map<string, number>(), domains: new Map<string, number>() };
  const inc = (m: Map<string, number>, k: string) => m.set(k || "(vacio)", (m.get(k || "(vacio)") ?? 0) + 1);
  let withLink = 0;
  let minDate: Date | null = null;
  let maxDate: Date | null = null;
  for (const r of records) {
    const f = factsOf(r);
    inc(counters.clients, f.client);
    inc(counters.senders, f.sender);
    inc(counters.countries, f.country);
    if (f.link) {
      withLink++;
      inc(counters.domains, f.domain ?? "(invalido)");
    }
    const d = edrDateOf(r);
    if (d) {
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
  }
  return {
    rows: records.length,
    withLink,
    withoutLink: records.length - withLink,
    firstEdr: minDate,
    lastEdr: maxDate,
    clients: top(counters.clients),
    senders: top(counters.senders),
    countries: top(counters.countries),
    domains: top(counters.domains),
  };
}

/** Resumen guardado en la fila: se calcula una vez por captura. */
export async function summaryOf(id: number) {
  const loaded = await loadCapture(id);
  if (!loaded) return null;
  if (loaded.meta.summary) return { ...loaded.meta, parseError: loaded.parseError };
  const summary = summarize(loaded.records);
  await saveSummary(id, loaded.records.length, summary);
  loaded.meta.summary = summary;
  loaded.meta.rowsCount = loaded.records.length;
  return { ...loaded.meta, parseError: loaded.parseError };
}

function edrDateOf(r: Record<string, unknown>): Date | null {
  const v = r.edr_date;
  if (typeof v !== "string") return null;
  const d = parseApiDate(v, config.edr.timezoneOffsetMinutes) ?? new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Pagina de filas (campos utiles para decidir), con filtro de texto opcional. */
export function rowsPage(records: Record<string, unknown>[], offset: number, limit: number, q?: string) {
  const needle = q?.trim().toLowerCase();
  const filtered = needle
    ? records.filter((r) => {
        const f = factsOf(r);
        return [f.client, f.sender, f.country, f.network, String(r.text ?? "")].some((x) => x.toLowerCase().includes(needle));
      })
    : records;
  return {
    total: filtered.length,
    offset,
    items: filtered.slice(offset, offset + limit).map((r) => {
      const f = factsOf(r);
      return {
        edrDate: edrDateOf(r),
        clientMessageId: r.client_message_id ?? null,
        client: f.client,
        sender: f.sender,
        country: f.country,
        network: f.network,
        status: r.status ?? null,
        domain: f.domain,
        text: String(r.text ?? "").slice(0, 300),
      };
    }),
  };
}

/**
 * Fetcher para reprocesar: devuelve los registros capturados del rango
 * pedido (la ingesta puede partir el rango si llega al tope de filas).
 * Bordes inclusivos: las mitades se tocan y los repetidos se deduplican.
 */
export function captureFetcher(records: Record<string, unknown>[]): EdrFetcher {
  return async (range) =>
    records.filter((r) => {
      const d = edrDateOf(r);
      return d !== null && d >= range.start && d <= range.end;
    });
}
