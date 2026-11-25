import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { errorMessage, log } from "../logger";
import { actorFrom } from "./adminRoutes";
import {
  PolicyNotFoundError,
  DEFAULT_POLICIES,
  REPEAT_MODES,
  createPolicy,
  deletePolicy,
  listChanges,
  setActivePolicy,
  policiesCache,
  reorderPolicies,
  updatePolicy,
} from "../policies/repo";
import { STRATEGIES, policyInputSchema, type Policy } from "../policies/schema";
import { STRATEGY_INFO, pickIndices } from "../policies/strategies";
import { previewRecent } from "../policies/preview";
import { applyPolicyChangesSoon } from "../service/ingestService";
import { processingWorker } from "../worker/processingWorker";
import { settingsStore } from "../settings/store";
import { auditBestEffort, type Actor } from "../db/auditRepo";
import { isConfigured } from "../alaris/usageStats";
import { ensureWeek, isClosedWeek, lastFullWeek, refDayFor, weekSeries } from "../policies/referenceWeek";
import { countsBetween } from "../db/minuteCountsRepo";
import { linkRatio, referenceVolume } from "../policies/previousDay";
import { periodStarts } from "../policies/schedule";
import { reportsPool } from "../db/reportsPool";

// La base semana_referencia elige sobre la hora entera: ventanas de 60 min.
const REFERENCE_WINDOW_MINUTES = 60;

/**
 * Si quedo activa una semana_referencia, la ventana de ingesta pasa a 60 min
 * (auditado como cualquier cambio de configuracion). Devuelve si la cambio.
 */
async function ensureHourWindow(actor: Actor): Promise<boolean> {
  const active = policiesCache.active()[0];
  const sel = active?.rules.selection;
  if (!sel || sel.action !== "visitar" || sel.base !== "semana_referencia") return false;
  // Los 7 dias se piden ya, en segundo plano (para el grafico del Panel).
  if (sel.weekStart) {
    const weekStart = sel.weekStart;
    void ensureWeek(weekStart, new Date()).catch((err) =>
      log.warn("politicas: no se pudo pedir la semana de referencia", { weekStart, error: errorMessage(err) })
    );
  }
  if (config.scheduler.windowMinutes === REFERENCE_WINDOW_MINUTES) return false;
  await settingsStore.save({ set: { "scheduler.windowMinutes": REFERENCE_WINDOW_MINUTES } }, actor);
  log.info("politicas: semana_referencia activa, la ventana de ingesta pasa a 60 min", { actor: actor.name });
  return true;
}

/** La semana de referencia tiene que estar cerrada (se compara con hoy). */
function weekError(rules: { selection: { base: string; action: string; weekStart: string | null } }): string | null {
  const sel = rules.selection;
  if (sel.action !== "visitar" || sel.base !== "semana_referencia" || !sel.weekStart) return null;
  return isClosedWeek(sel.weekStart, new Date()) ? null : "selection.weekStart: la semana de referencia tiene que haber terminado (7 dias cerrados)";
}

// Como contar un SMS ya clickeado que la politica nueva vuelve a elegir.
const repeatQuery = z.enum(REPEAT_MODES).default("igual");
const repeatOf = (req: Request) => {
  const r = repeatQuery.safeParse((req.body && req.body.repeatMode) ?? req.query.repeatMode);
  return r.success ? r.data : "igual";
};
const applyIfChanged = (changeId: number | null) => {
  if (changeId === null) return;
  applyPolicyChangesSoon();
  // Si estaba en espera (sin politica), que arranque ya.
  processingWorker.wake();
};

function invalid(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: "Politica invalida",
    details: error.issues.map((i) => `${i.path.join(".") || "politica"}: ${i.message}`),
  });
}

function fail(req: Request, res: Response, err: unknown): void {
  if (err instanceof PolicyNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  const code = (err as { errno?: number })?.errno;
  if (code === 3024 || code === 1969) {
    res.status(503).json({ error: "La estimacion tardo demasiado: proba con menos horas" });
    return;
  }
  log.error("politicas: error", { path: req.path, error: errorMessage(err) });
  res.status(500).json({ error: "Error guardando la politica" });
}

const idParam = z.coerce.number().int().positive();

const previewBody = z.object({
  hours: z.number().int().min(1).max(48).default(6),
  // Politica que se esta editando (sin guardar). Sin id = nueva, va al final.
  draft: policyInputSchema.extend({ id: z.number().int().positive().optional() }).optional(),
});

export const policiesRouter = Router();

policiesRouter.get("/admin/policies", async (req, res) => {
  try {
    const policies = await policiesCache.refresh();
    res.json({ policies, defaultPercentage: config.checker.clickPercentage });
  } catch (err) {
    fail(req, res, err);
  }
});

/** Agrega las politicas de fabrica al final (ej. despues de borrarlas todas). */
policiesRouter.post("/admin/policies/defaults", async (req, res) => {
  try {
    for (const input of DEFAULT_POLICIES) applyIfChanged((await createPolicy(input, actorFrom(req), new Date(), repeatOf(req))).changeId);
    res.status(201).json({ policies: await policiesCache.refresh() });
  } catch (err) {
    fail(req, res, err);
  }
});

const strategiesQuery = z.object({
  n: z.coerce.number().int().min(1).max(200).default(40),
  percentage: z.coerce.number().min(0).max(100).default(20),
});

/** Estrategias con un ejemplo de que SMS elige cada una (para el editor). */
policiesRouter.get("/admin/policies/strategies", (req, res) => {
  const q = strategiesQuery.safeParse(req.query);
  if (!q.success) return invalid(res, q.error);
  const { n, percentage } = q.data;
  const k = Math.round((n * percentage) / 100);
  res.json({
    n,
    k,
    strategies: STRATEGIES.map((id) => ({ id, ...STRATEGY_INFO[id], picks: pickIndices(n, k, id) })),
  });
});

/**
 * Deja activa una sola politica (id) o ninguna (null = regla por defecto).
 * El cambio se aplica sobre el contenido del dia en segundo plano.
 */
policiesRouter.post("/admin/policies/active", async (req, res) => {
  const body = z
    .object({ id: z.number().int().positive().nullable(), repeatMode: z.enum(REPEAT_MODES).default("igual") })
    .safeParse(req.body);
  if (!body.success) return invalid(res, body.error);
  try {
    const saved = await setActivePolicy(body.data.id, actorFrom(req), new Date(), body.data.repeatMode);
    await policiesCache.refresh();
    const windowChanged = await ensureHourWindow(actorFrom(req));
    applyIfChanged(saved.changeId);
    res.json({ policies: policiesCache.list(), changeId: saved.changeId, windowChanged });
  } catch (err) {
    fail(req, res, err);
  }
});

/** Ultimos cambios de la politica activa y como quedaron aplicados. */
policiesRouter.get("/admin/policies/changes", async (req, res) => {
  try {
    res.json({ changes: await listChanges(10) });
  } catch (err) {
    fail(req, res, err);
  }
});

policiesRouter.post("/admin/policies", async (req, res) => {
  const body = policyInputSchema.safeParse(req.body);
  if (!body.success) return invalid(res, body.error);
  const bad = weekError(body.data.rules);
  if (bad) return void res.status(400).json({ error: "Politica invalida", details: [bad] });
  try {
    const saved = await createPolicy(body.data, actorFrom(req), new Date(), repeatOf(req));
    const windowChanged = await ensureHourWindow(actorFrom(req));
    applyIfChanged(saved.changeId);
    res.status(201).json({ ...policiesCache.byId(saved.id), changeId: saved.changeId, windowChanged });
  } catch (err) {
    fail(req, res, err);
  }
});

policiesRouter.put("/admin/policies/:id", async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  const body = policyInputSchema.safeParse(req.body);
  if (!id.success) return void res.status(404).json({ error: "Politica inexistente" });
  if (!body.success) return invalid(res, body.error);
  const bad = weekError(body.data.rules);
  if (bad) return void res.status(400).json({ error: "Politica invalida", details: [bad] });
  try {
    const saved = await updatePolicy(id.data, body.data, actorFrom(req), new Date(), repeatOf(req));
    const windowChanged = await ensureHourWindow(actorFrom(req));
    applyIfChanged(saved.changeId);
    res.json({ ...policiesCache.byId(id.data), changeId: saved.changeId, windowChanged });
  } catch (err) {
    fail(req, res, err);
  }
});

policiesRouter.delete("/admin/policies/:id", async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) return void res.status(404).json({ error: "Politica inexistente" });
  try {
    const saved = await deletePolicy(id.data, actorFrom(req), new Date(), repeatOf(req));
    applyIfChanged(saved.changeId);
    res.json({ ok: true, changeId: saved.changeId });
  } catch (err) {
    fail(req, res, err);
  }
});

/** Default del editor para la semana de referencia: la ultima semana completa. */
policiesRouter.get("/admin/policies/reference-week/default", (_req, res) => {
  res.json({ weekStart: lastFullWeek(new Date()), restConfigured: isConfigured() });
});

function referencePolicy(id: number): Policy | null {
  const p = policiesCache.byId(id);
  return p && p.rules.selection.base === "semana_referencia" && p.rules.selection.weekStart ? p : null;
}

/**
 * Semana de referencia de la politica (7 x 24 por hora, con la fuente de cada
 * dia) y hoy: SMS recibidos por hora y objetivo de clicks acumulado.
 */
policiesRouter.get("/admin/policies/:id/week", async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  const policy = id.success ? referencePolicy(id.data) : null;
  if (!policy) return void res.status(404).json({ error: "La politica no es de semana de referencia" });
  try {
    const now = new Date();
    const weekStart = policy.rules.selection.weekStart as string;
    const days = await weekSeries(weekStart, reportsPool);
    const today = periodStarts(now, config.edr.timezoneOffsetMinutes).day;
    const hours: { hour: number; received: number; eligible: number }[] = [];
    for (let h = 0; h < 24; h++) {
      const start = new Date(today.getTime() + h * 3_600_000);
      if (start >= now) break;
      const c = await countsBetween(start, new Date(start.getTime() + 3_600_000), policy.id, reportsPool);
      hours.push({ hour: h, received: c.total, eligible: c.eligible });
    }
    const [visited] = await reportsPool.query<import("mysql2").RowDataPacket[]>(
      `SELECT COUNT(*) AS approved, COALESCE(SUM(clicks > 0), 0) AS clicked FROM sms_processing FORCE INDEX (idx_policy_edr)
        WHERE policy_id = ? AND edr_date >= ? AND edr_date < ? AND status <> 'skipped'`,
      [policy.id, today, now]
    );
    const total = days.reduce((a, d) => a + d.total, 0);
    // Objetivo de clicks acumulado hasta ahora (lo mismo que calcula la seleccion).
    const refDay = refDayFor(now, weekStart);
    const ref = await referenceVolume(refDay, new Date(refDay.getTime() + (now.getTime() - today.getTime())), reportsPool);
    const ratio = await linkRatio(policy.id, today, now, async () => 0, false, reportsPool);
    const target = Math.round((policy.rules.selection.percentage / 100) * ratio * ref.volume);
    res.json({
      policyId: policy.id,
      name: policy.name,
      percentage: policy.rules.selection.percentage,
      weekStart,
      restConfigured: isConfigured(),
      days,
      total,
      dailyAverage: Math.round(total / 7),
      today: {
        day: today,
        refDay,
        hours,
        target,
        linkRatio: ratio,
        approved: Number(visited[0].approved),
        clicked: Number(visited[0].clicked),
      },
    });
  } catch (err) {
    fail(req, res, err);
  }
});

/** Vuelve a pedir a Alaris los 7 dias de la semana de referencia. */
policiesRouter.post("/admin/policies/:id/week/refresh", async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  const policy = id.success ? referencePolicy(id.data) : null;
  if (!policy) return void res.status(404).json({ error: "La politica no es de semana de referencia" });
  if (!isConfigured()) {
    return void res.status(409).json({ error: "Falta configurar la REST API de Alaris (ALARIS_REST_URL, ALARIS_REST_AUTH y el producto)" });
  }
  try {
    const weekStart = policy.rules.selection.weekStart as string;
    const ok = await ensureWeek(weekStart, new Date(), { force: true });
    void auditBestEffort({ entity: "action", action: "semana_referencia", ref: String(policy.id), newValue: { weekStart, diasConDatos: ok } }, actorFrom(req));
    res.json({ weekStart, daysWithData: ok });
  } catch (err) {
    fail(req, res, err);
  }
});

policiesRouter.post("/admin/policies/reorder", async (req, res) => {
  const body = z.object({ ids: z.array(z.number().int().positive()).max(500) }).safeParse(req.body);
  if (!body.success) return invalid(res, body.error);
  try {
    await reorderPolicies(body.data.ids, actorFrom(req));
    res.json({ policies: policiesCache.list() });
  } catch (err) {
    fail(req, res, err);
  }
});

// Cuantos SMS de las ultimas N horas tomaria cada politica y cuantos se
// visitarian, con la politica en edicion aplicada. No guarda nada.
policiesRouter.post("/admin/policies/preview", async (req, res) => {
  const body = previewBody.safeParse(req.body ?? {});
  if (!body.success) return invalid(res, body.error);
  try {
    let policies: Policy[] = await policiesCache.refresh();
    const draft = body.data.draft;
    if (draft) {
      // Como hay una sola activa, se estima como si la politica en edicion
      // fuera LA activa (este prendida o no): las demas no cuentan.
      const asPolicy: Policy = {
        id: draft.id ?? -1,
        name: draft.name,
        enabled: true,
        priority: Number.MAX_SAFE_INTEGER,
        rules: draft.rules,
        createdAt: new Date(),
        updatedAt: new Date(),
        updatedBy: null,
      };
      policies = [...policies.filter((p) => p.id !== draft.id).map((p) => ({ ...p, enabled: false })), asPolicy];
    }
    res.json(await previewRecent(policies, config.checker.clickPercentage, body.data.hours));
  } catch (err) {
    fail(req, res, err);
  }
});
