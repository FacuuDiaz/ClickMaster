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
    applyIfChanged(saved.changeId);
    res.json({ policies: await policiesCache.refresh(), changeId: saved.changeId });
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
  try {
    const saved = await createPolicy(body.data, actorFrom(req), new Date(), repeatOf(req));
    applyIfChanged(saved.changeId);
    res.status(201).json({ ...policiesCache.byId(saved.id), changeId: saved.changeId });
  } catch (err) {
    fail(req, res, err);
  }
});

policiesRouter.put("/admin/policies/:id", async (req, res) => {
  const id = idParam.safeParse(req.params.id);
  const body = policyInputSchema.safeParse(req.body);
  if (!id.success) return void res.status(404).json({ error: "Politica inexistente" });
  if (!body.success) return invalid(res, body.error);
  try {
    const saved = await updatePolicy(id.data, body.data, actorFrom(req), new Date(), repeatOf(req));
    applyIfChanged(saved.changeId);
    res.json({ ...policiesCache.byId(id.data), changeId: saved.changeId });
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
