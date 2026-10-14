/**
 * Ingesta por consola sin levantar el server HTTP (make sync-once): procesa
 * las ventanas programadas que ya cerraron y sale. No visita links: eso lo
 * hace el worker del server cuando levanta.
 */
import { assertDbConnection, pool } from "./db/pool";
import { ensureSchema } from "./db/schema";
import { runDueWindows } from "./service/ingestService";
import { errorMessage, log } from "./logger";

async function main() {
  await assertDbConnection();
  await ensureSchema();

  const result = await runDueWindows();
  if (!result) {
    log.warn("cli: otra ingesta tiene el lock, no se hizo nada");
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(result, null, 2));
    if (result.runs.some((r) => r.status === "failed")) process.exitCode = 1;
  }
  await pool.end();
}

main().catch((err) => {
  log.error("cli: error corriendo la ingesta", { error: errorMessage(err) });
  process.exit(1);
});
