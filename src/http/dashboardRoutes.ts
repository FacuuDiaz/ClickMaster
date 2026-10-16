import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { errorMessage, log } from "../logger";
import {
  bucketSeconds,
  checksSeries,
  decodeCursor,
  ingestSeries,
  lastRun,
  listChecks,
  listSms,
  queueSnapshot,
  OUTCOME_GROUPS,
  type ChecksBucket,
  type IngestBucket,
} from "../db/dashboardRepo";

const PRESETS_MS: Record<string, number> = {
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 3600_000,
  "24h": 24 * 3600_000,
  "7d": 7 * 86400_000,
};

// Los rangos relativos se redondean a 10 s: todas las pestanas que piden
// "ultima media hora" en esos 10 s comparten la misma consulta (cache).
const ROUND_MS = 10_000;

const rangeQuery = z
  .object({
    preset: z.enum(Object.keys(PRESETS_MS) as [string, ...string[]]).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .transform((q, ctx) => {
    let from: Date;
    let to: Date;
    if (q.from && q.to) {
      from = new Date(q.from);
      to = new Date(q.to);
    } else {
      to = new Date(Math.floor(Date.now() / ROUND_MS) * ROUND_MS);
      from = new Date(to.getTime() - PRESETS_MS[q.preset ?? "30m"]);
    }
    if (to <= from) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "to tiene que ser posterior a from" });
      return z.NEVER;
    }
    if (to.getTime() - from.getTime() > config.reports.maxRangeDays * 86400_000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `el rango no puede superar ${config.reports.maxRangeDays} dias (REPORTS_MAX_RANGE_DAYS)`,
      });
      return z.NEVER;
    }
    return { from, to };
  });

const pageQuery = {
  cursor: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
};

const checksQuery = z.object({
  group: z.enum(Object.keys(OUTCOME_GROUPS) as [string, ...string[]]).optional(),
  ...pageQuery,
});

const smsQuery = z.object({
  status: z.enum(["pending", "processing", "retry", "success", "failed", "skipped"]).optional(),
  ...pageQuery,
});

// ---------- Cache con single-flight ----------

interface CacheEntry {
  expires: number;
  value: Promise<unknown>;
}
const cache = new Map<string, CacheEntry>();
const MAX_CACHE_ENTRIES = 200;

/**
 * Mismo pedido dentro de REPORTS_CACHE_SECONDS = misma respuesta, y si
 * llegan varios a la vez mientras la consulta corre, esperan todos la
 * misma promesa: N pestanas abiertas no son N consultas a MySQL.
 */
function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value as Promise<T>;

  if (cache.size >= MAX_CACHE_ENTRIES) {
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
    if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
  }
  const value = fn();
  cache.set(key, { expires: now + config.reports.cacheSeconds * 1000, value });
  // Un error no se cachea: el proximo pedido reintenta.
  value.catch(() => cache.delete(key));
  return value;
}

export function clearDashboardCache(): void {
  cache.clear();
}

// Completa con ceros los buckets sin datos: el grafico muestra el hueco.
function fillBuckets<T extends { t: number }>(rows: T[], from: Date, to: Date, stepS: number, empty: (t: number) => T): T[] {
  const stepMs = stepS * 1000;
  const byT = new Map(rows.map((r) => [r.t, r]));
  const out: T[] = [];
  for (let t = Math.floor(from.getTime() / stepMs) * stepMs; t < to.getTime(); t += stepMs) {
    out.push(byT.get(t) ?? empty(t));
  }
  return out;
}

async function buildData(from: Date, to: Date) {
  const stepS = bucketSeconds(from, to);
  // Secuencial a proposito: el pool de reportes tiene 2 conexiones y no
  // conviene que un solo pedido las ocupe todas.
  const checks = await checksSeries(from, to, stepS);
  const ingest = await ingestSeries(from, to, stepS);
  const queue = await cached("queue", queueSnapshot);
  const run = await cached("lastRun", lastRun);

  const checksFilled = fillBuckets<ChecksBucket>(checks, from, to, stepS, (t) => ({
    t,
    cargada: 0,
    sitio: 0,
    indeterminado: 0,
    tecnico: 0,
    total: 0,
    avgLoadMs: null,
  }));
  const ingestFilled = fillBuckets<IngestBucket>(ingest, from, to, stepS, (t) => ({ t, sms: 0 }));

  const totals = checks.reduce(
    (acc, b) => {
      acc.checks += b.total;
      acc.cargada += b.cargada;
      acc.sitio += b.sitio;
      acc.indeterminado += b.indeterminado;
      acc.tecnico += b.tecnico;
      if (b.avgLoadMs !== null) acc.loadSum += b.avgLoadMs * b.cargada;
      return acc;
    },
    { checks: 0, cargada: 0, sitio: 0, indeterminado: 0, tecnico: 0, loadSum: 0 }
  );
  const { loadSum, ...counts } = totals;

  return {
    range: { from, to, stepSeconds: stepS },
    totals: {
      ...counts,
      sms: ingest.reduce((sum, b) => sum + b.sms, 0),
      successRate: totals.checks > 0 ? totals.cargada / totals.checks : null,
      avgLoadMs: totals.cargada > 0 ? Math.round(loadSum / totals.cargada) : null,
    },
    series: { checks: checksFilled, ingest: ingestFilled },
    queue,
    lastRun: run,
    generatedAt: new Date(),
  };
}

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: error.issues.map((i) => i.message).join("; ") });
}

// MySQL corta la consulta por MAX_EXECUTION_TIME (3024) / MariaDB por
// max_statement_time (1969); el pool de reportes lleno tira "Queue limit".
function handleError(req: Request, res: Response, err: unknown): void {
  const code = (err as { errno?: number })?.errno;
  const message = errorMessage(err);
  if (code === 3024 || code === 1969) {
    res.status(503).json({ error: "La consulta tardo demasiado: proba con un rango mas chico" });
  } else if (/Queue limit reached/i.test(message)) {
    res.status(503).json({ error: "El dashboard esta ocupado, reintenta en unos segundos" });
  } else {
    log.error("dashboard: error en consulta", { path: req.path, error: message });
    res.status(500).json({ error: "Error consultando la base" });
  }
}

export const dashboardRouter = Router();

dashboardRouter.get("/dashboard/data", async (req, res) => {
  const range = rangeQuery.safeParse(req.query);
  if (!range.success) return badRequest(res, range.error);
  const { from, to } = range.data;
  try {
    res.json(await cached(`data:${from.getTime()}:${to.getTime()}`, () => buildData(from, to)));
  } catch (err) {
    handleError(req, res, err);
  }
});

dashboardRouter.get("/dashboard/checks", async (req, res) => {
  const range = rangeQuery.safeParse(req.query);
  const q = checksQuery.safeParse(req.query);
  if (!range.success) return badRequest(res, range.error);
  if (!q.success) return badRequest(res, q.error);
  const cursor = q.data.cursor ? decodeCursor(q.data.cursor) : undefined;
  if (cursor === null) return void res.status(400).json({ error: "cursor invalido" });
  const { from, to } = range.data;
  const key = `checks:${from.getTime()}:${to.getTime()}:${q.data.group ?? ""}:${q.data.cursor ?? ""}:${q.data.limit}`;
  try {
    res.json(
      await cached(key, () =>
        listChecks({ from, to, group: q.data.group as keyof typeof OUTCOME_GROUPS | undefined, cursor, limit: q.data.limit })
      )
    );
  } catch (err) {
    handleError(req, res, err);
  }
});

dashboardRouter.get("/dashboard/sms", async (req, res) => {
  const range = rangeQuery.safeParse(req.query);
  const q = smsQuery.safeParse(req.query);
  if (!range.success) return badRequest(res, range.error);
  if (!q.success) return badRequest(res, q.error);
  const cursor = q.data.cursor ? decodeCursor(q.data.cursor) : undefined;
  if (cursor === null) return void res.status(400).json({ error: "cursor invalido" });
  const { from, to } = range.data;
  const key = `sms:${from.getTime()}:${to.getTime()}:${q.data.status ?? ""}:${q.data.cursor ?? ""}:${q.data.limit}`;
  try {
    res.json(await cached(key, () => listSms({ from, to, status: q.data.status, cursor, limit: q.data.limit })));
  } catch (err) {
    handleError(req, res, err);
  }
});
