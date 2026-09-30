import { randomUUID } from "crypto";
import { chromium } from "playwright";
import pLimit from "p-limit";
import { config } from "../config";
import { visitUrl } from "../checker/linkChecker";

export type ClickJobStatus = "running" | "cancelling" | "cancelled" | "done" | "failed";

export interface ClickJob {
  id: string;
  url: string;
  total: number;
  completed: number;
  ok: number;
  failed: number;
  status: ClickJobStatus;
  startedAt: Date;
  finishedAt: Date | null;
  // Ultimo error de navegacion (o el que tiro abajo el job entero), para
  // tener una pista rapida desde la pantalla de progreso.
  lastError: string | null;
}

// Estado en memoria: se pierde al reiniciar el container. Alcanza para
// mirar el progreso; si hace falta historial persistente, guardarlo en la base.
const MAX_HISTORY = 20;
const jobs: ClickJob[] = [];
let current: ClickJob | null = null;

export function isClickJobRunning(): boolean {
  return current !== null;
}

export function getCurrentClickJob(): ClickJob | null {
  return current;
}

export function getClickJob(id: string): ClickJob | undefined {
  return jobs.find((job) => job.id === id);
}

export function listClickJobs(): ClickJob[] {
  return jobs;
}

/**
 * Pide cancelar el job en curso: no arranca ninguna visita nueva y las que
 * ya estan abiertas terminan su sesion (a lo sumo unos segundos). El job
 * queda en "cancelling" hasta que cierran y despues en "cancelled".
 * Devuelve el job, o null si no habia ninguno corriendo.
 */
export function cancelCurrentClickJob(): ClickJob | null {
  if (!current) return null;
  if (current.status === "running") {
    current.status = "cancelling";
    console.log(`[clicks ${current.id}] cancelacion pedida en ${current.completed}/${current.total}`);
  }
  return current;
}

function randomDwellMs(): number {
  const { dwellMinMs, dwellMaxMs } = config.clicker;
  return dwellMinMs + Math.floor(Math.random() * (dwellMaxMs - dwellMinMs + 1));
}

/**
 * Arranca un job que abre `url` `count` veces (un BrowserContext nuevo por
 * visita, CHECK_CONCURRENCY en paralelo). Cada sesion se queda en la pagina
 * entre CLICK_DWELL_MIN_MS y CLICK_DWELL_MAX_MS y despues se cierra, y el
 * slot pasa a la siguiente visita. Devuelve enseguida: el progreso
 * se consulta despues con getClickJob / getCurrentClickJob.
 * Solo corre un job a la vez; el que llama tiene que chequear
 * isClickJobRunning() antes.
 */
export function startClickJob(url: string, count: number): ClickJob {
  if (current) {
    throw new Error("Ya hay un job de clicks en curso");
  }

  const job: ClickJob = {
    id: randomUUID(),
    url,
    total: count,
    completed: 0,
    ok: 0,
    failed: 0,
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
    lastError: null,
  };

  jobs.unshift(job);
  jobs.splice(MAX_HISTORY);
  current = job;
  console.log(`[clicks ${job.id}] inicio: ${count} visitas a ${url}`);

  runClickJob(job)
    .then(() => {
      job.status = job.status === "cancelling" ? "cancelled" : "done";
    })
    .catch((err) => {
      console.error(`Error en el job de clicks ${job.id}:`, err);
      job.status = "failed";
      job.lastError = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      job.finishedAt = new Date();
      current = null;
      console.log(
        `[clicks ${job.id}] fin (${job.status}): ${job.ok} ok, ${job.failed} fallos de ${job.total}`
      );
    });

  return job;
}

async function runClickJob(job: ClickJob): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const limit = pLimit(config.checker.concurrency);

  try {
    await Promise.all(
      Array.from({ length: job.total }, () =>
        limit(async () => {
          // Las visitas que quedaron en cola despues de cancelar se saltean.
          if (job.status === "cancelling") return;
          const visit = await visitUrl(browser, job.url, {
            dwellMs: randomDwellMs(),
            blockResources: config.clicker.blockResources,
          });
          job.completed++;
          if (visit.ok) {
            job.ok++;
          } else {
            job.failed++;
            job.lastError = visit.errorMessage;
          }
          console.log(
            `[clicks ${job.id}] ${job.completed}/${job.total} ` +
              (visit.ok ? `ok (HTTP ${visit.httpStatus})` : `fallo: ${visit.errorMessage?.split("\n")[0]}`)
          );
        })
      )
    );
  } finally {
    await browser.close();
  }
}
