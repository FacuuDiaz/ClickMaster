import express from "express";
import { config } from "./config";
import { assertDbConnection } from "./db/pool";
import { ensureSchema } from "./db/schema";
import { runSync } from "./service/syncService";

const app = express();

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
