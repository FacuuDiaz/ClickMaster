import { config } from "./config";
import { errorMessage, log } from "./logger";
import { assertDbConnection, pool } from "./db/pool";
import { ensureSchema } from "./db/schema";
import { createApp } from "./http/app";
import { Scheduler } from "./service/scheduler";
import { processingWorker } from "./worker/processingWorker";

async function main() {
  await assertDbConnection();
  await ensureSchema();

  const server = createApp().listen(config.port, () => {
    log.info("http: escuchando", { port: config.port });
  });

  // Ingesta (scheduler) y verificacion (worker) arrancan solos y van
  // desacoplados: la ingesta llena la cola y el worker la drena a su ritmo.
  const scheduler = new Scheduler(() => processingWorker.wake());
  if (config.scheduler.enabled) scheduler.start();
  else log.warn("scheduler: deshabilitado (SCHEDULER_ENABLED=false)");
  if (config.worker.enabled) await processingWorker.start();
  else log.warn("worker: deshabilitado (WORKER_ENABLED=false)");

  // docker stop manda SIGTERM: se devuelven a la cola los trabajos sin
  // empezar y se espera a las visitas abiertas (stop_grace_period en compose).
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("app: apagando", { signal });
    server.close();
    try {
      await scheduler.stop();
      await processingWorker.stop();
      await pool.end();
    } catch (err) {
      log.error("app: error en el apagado", { error: errorMessage(err) });
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Playwright a veces deja promesas internas rechazadas cuando se cae un
  // target: se loguean en vez de tirar abajo el proceso y todas las visitas.
  process.on("unhandledRejection", (reason) => {
    log.error("app: promesa rechazada sin manejar", { error: errorMessage(reason) });
  });
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  log.error("app: no se pudo levantar el servidor", { error: errorMessage(err) });
  process.exit(1);
});
