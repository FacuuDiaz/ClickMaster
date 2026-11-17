import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { errorMessage, log } from "../logger";
import { auditBestEffort } from "../db/auditRepo";
import { parseApiDate } from "../edr/apiTime";
import { actorFrom } from "./adminRoutes";
import { captureRange, EdrError } from "../fetcher/apiClient";
import { captureFetcher, forgetCapture, loadCapture, rowsPage, summaryOf } from "../captures/analyze";
import { captureUsage, deleteCapture, getCapture, listCaptures, markReprocessed, setKeep } from "../captures/repo";
import { estimate } from "../policies/preview";
import { factsOf } from "../policies/match";
import { policiesCache } from "../policies/repo";
import { NoActivePolicyError, runManualWindow } from "../service/ingestService";
import { processingWorker } from "../worker/processingWorker";

const idParam = z.coerce.number().int().positive();

const date = z.string().transform((value, ctx) => {
  const d = parseApiDate(value, config.edr.timezoneOffsetMinutes) ?? new Date(value);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fecha invalida" });
    return z.NEVER;
  }
  return d;
});

const rangeBody = z
  .object({ start: date, end: date })
  .refine((r) => r.end > r.start, "end tiene que ser posterior a start")
  .refine((r) => r.end.getTime() - r.start.getTime() <= 24 * 3_600_000, "el rango no puede superar 24 h");

function fail(req: Request, res: Response, err: unknown): void {
  log.error("capturas: error", { path: req.path, error: errorMessage(err) });
  res.status(500).json({ error: errorMessage(err) });
}

async function withCapture(req: Request, res: Response): Promise<number | null> {
  const id = idParam.safeParse(req.params.id);
  if (!id.success || !(await getCapture(id.data))) {
    res.status(404).json({ error: "Captura inexistente" });
    return null;
  }
  return id.data;
}

// Un solo pedido manual a Alaris a la vez: cada uno puede tardar minutos y ~40 MB.
let capturing = false;

export const capturesRouter = Router();

capturesRouter.get("/admin/captures", async (req, res) => {
  const q = z
    .object({ beforeId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) })
    .safeParse(req.query);
  if (!q.success) return void res.status(400).json({ error: "parametros invalidos" });
  try {
    const page = await listCaptures(q.data.beforeId, q.data.limit);
    res.json({ ...page, usage: await captureUsage(), mode: config.capture.mode, retentionHours: config.capture.retentionHours, capturing });
  } catch (err) {
    fail(req, res, err);
  }
});

// Pide un rango a Alaris y lo guarda como captura, sin ingestar.
capturesRouter.post("/admin/captures", async (req, res) => {
  const body = rangeBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: body.error.issues.map((i) => i.message).join("; ") });
  if (capturing) return void res.status(409).json({ error: "Ya hay un pedido de captura en curso" });
  // En espera (sin politica activa) no se le pide nada a Alaris.
  await policiesCache.refresh();
  if (policiesCache.active().length === 0) return void res.status(409).json({ error: new NoActivePolicyError().message, waiting: true });
  capturing = true;
  const actor = actorFrom(req);
  try {
    const result = await captureRange(body.data, actor.name);
    void auditBestEffort(
      { entity: "capture", action: "capture", ref: String(result.captureId), newValue: { start: body.data.start, end: body.data.end, rows: result.rows } },
      actor
    );
    res.status(201).json(result);
  } catch (err) {
    const status = err instanceof EdrError ? 502 : 500;
    log.warn("capturas: fallo el pedido manual", { error: errorMessage(err) });
    res.status(status).json({ error: errorMessage(err) });
  } finally {
    capturing = false;
  }
});

capturesRouter.get("/admin/captures/:id", async (req, res) => {
  const id = await withCapture(req, res);
  if (id === null) return;
  try {
    res.json(await summaryOf(id));
  } catch (err) {
    fail(req, res, err);
  }
});

capturesRouter.get("/admin/captures/:id/rows", async (req, res) => {
  const id = await withCapture(req, res);
  if (id === null) return;
  const q = z
    .object({
      offset: z.coerce.number().int().min(0).default(0),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      q: z.string().max(100).optional(),
    })
    .safeParse(req.query);
  if (!q.success) return void res.status(400).json({ error: "parametros invalidos" });
  try {
    const loaded = await loadCapture(id);
    if (!loaded) return void res.status(404).json({ error: "Captura inexistente" });
    res.json(rowsPage(loaded.records, q.data.offset, q.data.limit, q.data.q));
  } catch (err) {
    fail(req, res, err);
  }
});

// Cuantos SMS de la captura tomaria cada politica (las de ahora) y cuantos
// se visitarian. No escribe nada.
capturesRouter.post("/admin/captures/:id/simulate", async (req, res) => {
  const id = await withCapture(req, res);
  if (id === null) return;
  try {
    const loaded = await loadCapture(id);
    if (!loaded) return void res.status(404).json({ error: "Captura inexistente" });
    const policies = await policiesCache.refresh();
    const result = await estimate(
      loaded.records.map((r) => factsOf(r)),
      policies,
      config.checker.clickPercentage,
      { start: loaded.meta.rangeStart, end: loaded.meta.rangeEnd }
    );
    res.json({ ...result, truncated: false, hours: null });
  } catch (err) {
    fail(req, res, err);
  }
});

// Ingesta la captura como una ventana manual (mismo camino que /sync con
// rango): idempotente, los SMS que ya estaban no se duplican.
capturesRouter.post("/admin/captures/:id/reprocess", async (req, res) => {
  const id = await withCapture(req, res);
  if (id === null) return;
  try {
    const loaded = await loadCapture(id);
    if (!loaded) return void res.status(404).json({ error: "Captura inexistente" });
    if (loaded.meta.origin === "invalidos" || loaded.records.length === 0) {
      return void res.status(400).json({ error: loaded.parseError ?? "Esta captura no tiene registros para reprocesar" });
    }
    let run;
    try {
      run = await runManualWindow({ start: loaded.meta.rangeStart, end: loaded.meta.rangeEnd }, { fetcher: captureFetcher(loaded.records) });
    } catch (err) {
      if (err instanceof NoActivePolicyError) return void res.status(409).json({ error: err.message, waiting: true });
      throw err;
    }
    if (!run) return void res.status(409).json({ error: "Ya hay una ingesta en curso" });
    processingWorker.wake();
    if (run.status !== "failed") await markReprocessed(id, run.runId);
    forgetCapture(id);
    void auditBestEffort(
      { entity: "capture", action: "reprocess", ref: String(id), newValue: { runId: run.runId, status: run.status, smsNew: run.smsNew, jobsCreated: run.jobsCreated } },
      actorFrom(req)
    );
    res.status(run.status === "failed" ? 502 : 200).json(run);
  } catch (err) {
    fail(req, res, err);
  }
});

capturesRouter.post("/admin/captures/:id/keep", async (req, res) => {
  const id = await withCapture(req, res);
  if (id === null) return;
  const keep = req.body?.keep !== false;
  try {
    await setKeep(id, keep);
    forgetCapture(id);
    void auditBestEffort({ entity: "capture", action: keep ? "keep" : "unkeep", ref: String(id) }, actorFrom(req));
    res.json(await getCapture(id));
  } catch (err) {
    fail(req, res, err);
  }
});

capturesRouter.delete("/admin/captures/:id", async (req, res) => {
  const id = await withCapture(req, res);
  if (id === null) return;
  try {
    await deleteCapture(id);
    forgetCapture(id);
    void auditBestEffort({ entity: "capture", action: "discard", ref: String(id) }, actorFrom(req));
    res.json({ ok: true });
  } catch (err) {
    fail(req, res, err);
  }
});
