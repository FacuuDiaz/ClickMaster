/**
 * Corrida manual sin levantar el server HTTP -- util para probar en local
 * (npm run sync:once) sin tener que pegarle a /sync con curl.
 */
import { assertDbConnection } from "./db/pool";
import { ensureSchema } from "./db/schema";
import { runSync } from "./service/syncService";

async function main() {
  await assertDbConnection();
  await ensureSchema();

  const summary = await runSync();
  console.log("Sync completado:", summary);
  process.exit(0);
}

main().catch((err) => {
  console.error("Error corriendo el sync:", err);
  process.exit(1);
});
