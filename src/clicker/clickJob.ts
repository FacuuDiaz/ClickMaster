import { randomUUID } from "crypto";
import { chromium } from "playwright";
import pLimit from "p-limit";
import { config } from "../config";
import { visitUrl } from "../checker/linkChecker";

export type ClickJobStatus = "queued" | "running" | "cancelling" | "cancelled" | "done" | "failed";

export interface ClickJob {
  id: string;
  url: string;
  total: number;
  completed: number;
  ok: number;
  failed: number;
  status: ClickJobStatus;
  // Si el job vino de un archivo (POST /clicks/batch): a que lote pertenece
  // y que posicion ocupa (1-based) entre las lineas validas.
  batch: { id: string; index: number; size: number } | null;
  startedAt: Date | null; // null mientras esta en cola
  finishedAt: Date | null;
  // Ultimo error de navegacion (o el que tiro abajo el job entero), para
  // tener una pista rapida desde la pantalla de progreso.
  lastError: string | null;
}

// Estado en memoria: se pierde al reiniciar el container. Alcanza para
// mirar el progreso; si hace falta historial persistente, guardarlo en la base.
const MAX_HISTORY = 20;
const jobs: ClickJob[] = [];
// Jobs esperando turno (de un lote): corren de a uno, en orden.
const queue: ClickJob[] = [];
let current: ClickJob | null = null;

export function isClickJobRunning(): boolean {
  return current !== null || queue.length > 0;
}

export function getCurrentClickJob(): ClickJob | null {
  return current;
}

export function getClickJob(id: string): ClickJob | undefined {
  return jobs.find((job) => job.id === id) ?? queue.find((job) => job.id === id);
}

export function listClickJobs(): ClickJob[] {
  return jobs;
}

export function listQueuedClickJobs(): ClickJob[] {
  return queue;
}

function addToHistory(job: ClickJob): void {
  jobs.unshift(job);
  jobs.splice(MAX_HISTORY);
}

/**
 * Pide cancelar el job en curso y descarta los que estaban en cola: no
 * arranca ninguna visita nueva y las que ya estan abiertas terminan su
 * sesion (a lo sumo unos segundos). El job en curso queda en "cancelling"
 * hasta que cierran y despues en "cancelled"; los de la cola pasan
 * directo a "cancelled".
 * Devuelve el job en curso (o null si no habia ninguno) y cuantos se
 * sacaron de la cola.
 */
export function cancelCurrentClickJob(): { job: ClickJob; cancelledQueued: number } | null {
  if (!current) return null;
  if (current.status === "running") {
    current.status = "cancelling";
    console.log(`[clicks ${current.id}] cancelacion pedida en ${current.completed}/${current.total}`);
  }

  const dropped = queue.splice(0);
  for (const job of dropped) {
    job.status = "cancelled";
    job.finishedAt = new Date();
    addToHistory(job);
  }
  if (dropped.length > 0) {
    console.log(`[clicks] ${dropped.length} jobs en cola cancelados`);
  }

  return { job: current, cancelledQueued: dropped.length };
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
  return enqueue([{ url, count }], null)[0];
}

/**
 * Encola un job por item (ej. cada linea de clicks_to_do.txt). Corren uno
 * detras del otro, en el orden recibido, igual que si se lanzara cada uno
 * con startClickJob apenas termina el anterior. Devuelve enseguida.
 */
export function startClickBatch(items: { url: string; count: number }[]): ClickJob[] {
  return enqueue(items, randomUUID());
}

function enqueue(items: { url: string; count: number }[], batchId: string | null): ClickJob[] {
  if (isClickJobRunning()) {
    throw new Error("Ya hay un job de clicks en curso");
  }

  const created = items.map(
    (item, i): ClickJob => ({
      id: randomUUID(),
      url: item.url,
      total: item.count,
      completed: 0,
      ok: 0,
      failed: 0,
      status: "queued",
      batch: batchId ? { id: batchId, index: i + 1, size: items.length } : null,
      startedAt: null,
      finishedAt: null,
      lastError: null,
    })
  );

  queue.push(...created);
  if (batchId) {
    console.log(`[clicks] lote ${batchId}: ${created.length} jobs encolados`);
  }
  void drainQueue();
  return created;
}

async function drainQueue(): Promise<void> {
  // Sin awaits entre que termina un job y arranca el siguiente:
  // isClickJobRunning() nunca ve un hueco en el medio.
  for (let job = queue.shift(); job; job = queue.shift()) {
    job.status = "running";
    job.startedAt = new Date();
    addToHistory(job);
    current = job;
    const step = job.batch ? ` (lote ${job.batch.index}/${job.batch.size})` : "";
    console.log(`[clicks ${job.id}] inicio${step}: ${job.total} visitas a ${job.url}`);

    try {
      await runClickJob(job);
      // cancelCurrentClickJob() puede haberlo pasado a "cancelling" durante el
      // await; TS no lo ve y lo sigue tomando como "running".
      const status = job.status as ClickJobStatus;
      job.status = status === "cancelling" ? "cancelled" : "done";
    } catch (err) {
      console.error(`Error en el job de clicks ${job.id}:`, err);
      job.status = "failed";
      job.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      job.finishedAt = new Date();
      current = null;
      console.log(
        `[clicks ${job.id}] fin (${job.status}): ${job.ok} ok, ${job.failed} fallos de ${job.total}`
      );
    }
  }
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
