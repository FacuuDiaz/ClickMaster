import express from "express";
import { z } from "zod";
import { config } from "./config";
import { assertDbConnection } from "./db/pool";
import { ensureSchema } from "./db/schema";
import { runSync } from "./service/syncService";
import {
  getClickJob,
  getCurrentClickJob,
  isClickJobRunning,
  listClickJobs,
  cancelCurrentClickJob,
  startClickJob,
} from "./clicker/clickJob";

const app = express();
app.use(express.json());

// Estado simple en memoria para no correr dos syncs pisandose.
let syncInProgress = false;

app.get("/health", async (_req, res) => {
  try {
    await assertDbConnection();
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "db_unreachable", error: String(err) });
  }
});

app.post("/sync", async (_req, res) => {
  if (syncInProgress) {
    res.status(409).json({ error: "Ya hay un sync en curso" });
    return;
  }
  // Sync y jobs de clicks no se pisan: los dos levantan Chromium y el
  // container tiene memoria limitada.
  if (isClickJobRunning()) {
    res.status(409).json({ error: "Hay un job de clicks en curso" });
    return;
  }

  syncInProgress = true;
  try {
    const summary = await runSync();
    res.json({ status: "ok", ...summary });
  } catch (err) {
    console.error("Error en /sync:", err);
    res.status(500).json({ status: "error", error: String(err) });
  } finally {
    syncInProgress = false;
  }
});

const clickJobRequestSchema = z.object({
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "La url tiene que ser http(s)"),
  count: z.number().int().min(1).max(config.clicker.maxCount),
});

// Lanza un job que abre `url` `count` veces. Responde enseguida (202);
// el progreso se consulta con GET /clicks o GET /clicks/:id.
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
  if (syncInProgress) {
    res.status(409).json({ error: "Hay un sync en curso" });
    return;
  }

  const job = startClickJob(parsed.data.url, parsed.data.count);
  res.status(202).json(job);
});

app.get("/clicks", (_req, res) => {
  res.json({
    current: getCurrentClickJob(),
    syncInProgress,
    jobs: listClickJobs(),
  });
});

// Cancela el job en curso: no se lanzan visitas nuevas y las abiertas
// terminan su sesion. Se puede lanzar otro cuando `current` sea null.
app.post("/clicks/cancel", (_req, res) => {
  const job = cancelCurrentClickJob();
  if (!job) {
    res.status(404).json({ error: "No hay ningun job de clicks corriendo" });
    return;
  }
  res.json(job);
});

app.get("/clicks/:id", (req, res) => {
  const job = getClickJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job no encontrado" });
    return;
  }
  res.json(job);
});

async function main() {
  await assertDbConnection();
  await ensureSchema();

  app.listen(config.port, () => {
    console.log(`sms-link-checker escuchando en :${config.port}`);
  });
}

main().catch((err) => {
  console.error("No se pudo levantar el servidor:", err);
  process.exit(1);
});
