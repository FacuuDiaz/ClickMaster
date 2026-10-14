import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { errorMessage, log } from "../logger";
import { assertDbConnection } from "../db/pool";
import { runDueWindows, runManualWindow } from "../service/ingestService";
import { processingWorker } from "../worker/processingWorker";
import { parseApiDate } from "../edr/apiTime";
import {
  getClickJob,
  getCurrentClickJob,
  isClickJobRunning,
  listClickJobs,
  listQueuedClickJobs,
  cancelCurrentClickJob,
  startClickBatch,
  startClickJob,
} from "../clicker/clickJob";
import { parseClickList } from "../clicker/parseClickList";
import { reportsRouter } from "./reportsRoutes";

/**
 * Si ADMIN_TOKEN esta seteado, todo salvo /health pide Bearer. La app
 * igual queda publicada solo en 127.0.0.1 (docker-compose.yml); el token
 * es una segunda barrera si algun dia se expone detras de un proxy.
 */
function requireAdminToken(req: Request, res: Response, next: NextFunction): void {
  if (!config.adminToken || req.path === "/health") return next();
  if (req.headers.authorization === `Bearer ${config.adminToken}`) return next();
  res.status(401).json({ error: "Falta o es invalido el token (Authorization: Bearer ...)" });
}

const apiDate = z.string().transform((value, ctx) => {
  const date = parseApiDate(value, config.edr.timezoneOffsetMinutes) ?? new Date(value);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fecha invalida (YYYY.MM.DD HH:mm:ss o ISO)" });
    return z.NEVER;
  }
  return date;
});

const manualWindowSchema = z
  .object({ start: apiDate, end: apiDate })
  .refine((w) => w.end > w.start, "end tiene que ser posterior a start")
  .refine((w) => w.end.getTime() - w.start.getTime() <= 24 * 60 * 60 * 1000, "la ventana no puede superar 24 h");

const clickJobRequestSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "La url tiene que ser http(s)"),
  count: z.number().int().min(1).max(config.clicker.maxCount),
});

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requireAdminToken);

  app.get("/health", async (_req, res) => {
    try {
      await assertDbConnection();
      res.json({ status: "ok", worker: processingWorker.status() });
    } catch (err) {
      res.status(503).json({ status: "db_unreachable", error: errorMessage(err) });
    }
  });

  // Ingesta manual. Sin body: procesa las ventanas programadas que ya
  // cerraron (lo mismo que hace el scheduler). Con {start, end}: una
  // ventana puntual, que no mueve el cursor del scheduler. No corre
  // Playwright: los SMS quedan en la cola y los procesa el worker.
  app.post("/sync", async (req, res) => {
    const hasWindow = req.body && (req.body.start || req.body.end);
    try {
      if (hasWindow) {
        const parsed = manualWindowSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
          return;
        }
        const run = await runManualWindow(parsed.data);
        if (!run) {
          res.status(409).json({ error: "Ya hay una ingesta en curso" });
          return;
        }
        processingWorker.wake();
        res.status(run.status === "failed" ? 502 : 200).json(run);
        return;
      }

      const result = await runDueWindows();
      if (!result) {
        res.status(409).json({ error: "Ya hay una ingesta en curso" });
        return;
      }
      processingWorker.wake();
      const failed = result.runs.some((r) => r.status === "failed");
      res.status(failed ? 502 : 200).json(result);
    } catch (err) {
      log.error("http: error en /sync", { error: errorMessage(err) });
      res.status(500).json({ status: "error", error: errorMessage(err) });
    }
  });

  // Recuperacion controlada: devuelve a la cola las reservas vencidas. Con
  // {"force": true} tambien las vigentes (pausa el worker local antes). Solo
  // usar force con UNA instancia: las reservas de otra instancia viva se
  // volverian a procesar.
  app.post("/processing/recover", async (req, res) => {
    const force = req.body?.force === true;
    try {
      if (force) await processingWorker.pause("recuperacion manual");
      const recovered = await processingWorker.recover({ force });
      res.json({ recovered, force });
    } catch (err) {
      res.status(500).json({ error: errorMessage(err) });
    } finally {
      if (force) processingWorker.resume();
    }
  });

  app.use(reportsRouter);

  // Lanza un job que abre `url` `count` veces. Responde enseguida (202);
  // el progreso se consulta con GET /clicks o GET /clicks/:id. Pausa la
  // cola automatica mientras corre (ver clicker/clickJob.ts).
  app.post("/clicks", (req, res) => {
    const parsed = clickJobRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      return;
    }
    if (isClickJobRunning()) {
      res.status(409).json({ error: "Ya hay un job de clicks en curso" });
      return;
    }

    const job = startClickJob(parsed.data.url, parsed.data.count);
    res.status(202).json(job);
  });

  // Lanza un job por linea de un archivo tipo clicks_to_do.txt (`url,cantidad`
  // por linea), mandado como text/plain. Corren de a uno, en orden. Si alguna
  // linea es invalida responde 400 con todos los errores y no encola nada.
  app.post("/clicks/batch", express.text({ type: "*/*", limit: "1mb" }), (req, res) => {
    const parsed = parseClickList(typeof req.body === "string" ? req.body : "");
    if (!parsed.ok) {
      res.status(400).json({ error: "Archivo invalido", details: parsed.errors });
      return;
    }
    if (isClickJobRunning()) {
      res.status(409).json({ error: "Ya hay un job de clicks en curso" });
      return;
    }

    const jobs = startClickBatch(parsed.items);
    res.status(202).json({
      batchId: jobs[0].batch?.id,
      jobs: jobs.length,
      totalVisits: jobs.reduce((sum, job) => sum + job.total, 0),
      items: jobs.map((job) => ({ id: job.id, url: job.url, count: job.total })),
    });
  });

  app.get("/clicks", (_req, res) => {
    res.json({
      current: getCurrentClickJob(),
      queued: listQueuedClickJobs(),
      worker: processingWorker.status(),
      jobs: listClickJobs(),
    });
  });

  // Cancela el job en curso y los que esperan en cola: no se lanzan visitas
  // nuevas y las abiertas terminan su sesion. Se puede lanzar otro cuando
  // `current` sea null.
  app.post("/clicks/cancel", (_req, res) => {
    const cancelled = cancelCurrentClickJob();
    if (!cancelled) {
      res.status(404).json({ error: "No hay ningun job de clicks corriendo" });
      return;
    }
    res.json({ ...cancelled.job, cancelledQueued: cancelled.cancelledQueued });
  });

  app.get("/clicks/:id", (req, res) => {
    const job = getClickJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Job no encontrado" });
      return;
    }
    res.json(job);
  });

  return app;
}
