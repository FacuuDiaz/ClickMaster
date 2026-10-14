import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { errorMessage, log } from "../logger";
import { getJob, getRun, ingestStatus, listJobs, listRuns, processingSummary } from "../db/reportsRepo";
import { processingWorker } from "../worker/processingWorker";
import { parseApiDate } from "../edr/apiTime";

/** Acepta ISO 8601 o el formato de la API ("2026.10.14 09:00:00", hora de la API). */
const dateParam = z
  .string()
  .transform((value, ctx) => {
    const date = parseApiDate(value, config.edr.timezoneOffsetMinutes) ?? new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fecha invalida" });
      return z.NEVER;
    }
    return date;
  })
  .optional();

const pagination = {
  limit: z.coerce.number().int().min(1).max(500).default(50),
  beforeId: z.coerce.number().int().positive().optional(),
};

const runsQuery = z.object({
  ...pagination,
  status: z.enum(["running", "success", "partial", "failed"]).optional(),
  kind: z.enum(["scheduled", "manual"]).optional(),
});

const summaryQuery = z.object({ from: dateParam, to: dateParam });

const jobsQuery = z.object({
  ...pagination,
  status: z.enum(["pending", "processing", "retry", "success", "failed", "skipped"]).optional(),
  outcome: z.string().max(32).optional(),
  from: dateParam,
  to: dateParam,
  country: z.string().max(32).optional(),
  clientProductId: z.string().max(32).optional(),
  runId: z.coerce.number().int().positive().optional(),
  smsContentId: z.coerce.number().int().positive().optional(),
});

const idParam = z.coerce.number().int().positive();

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: error.issues.map((i) => `${i.path.join(".") || "valor"}: ${i.message}`).join("; "),
  });
}

// Los handlers async de Express 4 no propagan rechazos: se atrapan aca.
function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      log.error("http: error en endpoint", { path: req.path, error: errorMessage(err) });
      res.status(500).json({ error: "Error interno consultando la base" });
    });
  };
}

export const reportsRouter = Router();

reportsRouter.get(
  "/sync/runs",
  handler(async (req, res) => {
    const q = runsQuery.safeParse(req.query);
    if (!q.success) return badRequest(res, q.error);
    res.json(await listRuns(q.data));
  })
);

reportsRouter.get(
  "/sync/status",
  handler(async (_req, res) => {
    res.json(await ingestStatus());
  })
);

reportsRouter.get(
  "/sync/runs/:id",
  handler(async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return badRequest(res, id.error);
    const run = await getRun(id.data);
    if (!run) {
      res.status(404).json({ error: "Corrida no encontrada" });
      return;
    }
    res.json(run);
  })
);

reportsRouter.get(
  "/processing/summary",
  handler(async (req, res) => {
    const q = summaryQuery.safeParse(req.query);
    if (!q.success) return badRequest(res, q.error);
    res.json({
      ...(await processingSummary(q.data, config.worker.maxAttempts)),
      worker: processingWorker.status(),
    });
  })
);

reportsRouter.get(
  "/processing/jobs",
  handler(async (req, res) => {
    const q = jobsQuery.safeParse(req.query);
    if (!q.success) return badRequest(res, q.error);
    res.json(await listJobs(q.data));
  })
);

reportsRouter.get(
  "/processing/jobs/:id",
  handler(async (req, res) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) return badRequest(res, id.error);
    const job = await getJob(id.data);
    if (!job) {
      res.status(404).json({ error: "Trabajo no encontrado" });
      return;
    }
    res.json(job);
  })
);
