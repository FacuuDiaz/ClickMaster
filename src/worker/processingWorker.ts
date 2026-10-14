import os from "os";
import { randomUUID } from "crypto";
import type { Browser } from "playwright";
import { config } from "../config";
import { log, errorMessage } from "../logger";
import {
  claimJobs,
  completeAttempt,
  confirmLease,
  countReadyJobs,
  finishWithoutVisit,
  recoverExpiredLeases,
  releaseJobs,
  type AttemptResult,
  type ClaimedJob,
} from "../db/processingRepo";
import { extractLink } from "../parser/extractLink";
import { launchBrowser, visitUrl, type VisitResult } from "../checker/linkChecker";
import { retryPolicy } from "../checker/classifyVisit";

/** Espera con despertador: wait() vuelve por timeout o por notify(). */
class Signal {
  private waiters: (() => void)[] = [];

  wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }
}

export interface WorkerSettings {
  concurrency: number;
  claimBatchSize: number;
  pollIntervalMs: number;
  leaseMs: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  browserIdleCloseMs: number;
  recoveryIntervalMs: number;
}

export interface WorkerDeps {
  settings?: Partial<WorkerSettings>;
  // Reemplazable en tests para no levantar Chromium.
  visit?: (url: string) => Promise<VisitResult>;
}

interface WorkerStats {
  claimed: number;
  success: number;
  retry: number;
  failed: number;
  skipped: number;
  lostLease: number;
  dbErrors: number;
  visitMsTotal: number;
  visits: number;
}

function emptyStats(): WorkerStats {
  return { claimed: 0, success: 0, retry: 0, failed: 0, skipped: 0, lostLease: 0, dbErrors: 0, visitMsTotal: 0, visits: 0 };
}

const SUMMARY_INTERVAL_MS = 60_000;

/**
 * Consume la cola persistente (sms_processing) con concurrencia limitada.
 *
 * - Reclama de a lotes chicos (WORKER_CLAIM_BATCH_SIZE) solo cuando el
 *   buffer local esta vacio: en memoria nunca hay mas que `concurrency`
 *   visitas en curso + un lote esperando. Nada de cargar los 20.000.
 * - Un solo Chromium compartido, un BrowserContext por visita; se cierra
 *   si no hay trabajo para devolver la RAM.
 * - Cada resultado se guarda apenas termina su visita, sin esperar al resto.
 * - Lo puede pausar un job de clicks manual: deja de reclamar, devuelve a
 *   la cola lo que tenia en el buffer, espera las visitas abiertas y cierra
 *   Chromium. Asi nunca hay dos componentes con navegadores a la vez.
 */
export class ProcessingWorker {
  readonly workerId = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly hostPrefix = `${os.hostname()}:`;
  private readonly settings: WorkerSettings;
  private readonly visitFn: (url: string) => Promise<VisitResult>;

  private running = false;
  private pauseHolders = 0;
  private active = 0;
  private buffer: ClaimedJob[] = [];
  private readonly signal = new Signal();
  private loopDone: Promise<void> | null = null;
  private timers: NodeJS.Timeout[] = [];

  private browser: Browser | null = null;
  private browserLaunch: Promise<Browser> | null = null;
  private lastActivity = Date.now();

  private stats = emptyStats();
  private totals = emptyStats();

  constructor(deps: WorkerDeps = {}) {
    this.settings = {
      concurrency: config.worker.concurrency,
      claimBatchSize: config.worker.claimBatchSize,
      pollIntervalMs: config.worker.pollIntervalMs,
      leaseMs: config.worker.leaseMs,
      maxAttempts: config.worker.maxAttempts,
      retryBaseDelayMs: config.worker.retryBaseDelayMs,
      browserIdleCloseMs: config.worker.browserIdleCloseMs,
      recoveryIntervalMs: config.worker.recoveryIntervalMs,
      ...deps.settings,
    };
    this.visitFn = deps.visit ?? ((url) => this.visitWithSharedBrowser(url));
  }

  get isRunning(): boolean {
    return this.running;
  }

  status() {
    return {
      workerId: this.workerId,
      running: this.running,
      paused: this.pauseHolders > 0,
      active: this.active,
      buffered: this.buffer.length,
      browserOpen: this.browser !== null,
      concurrency: this.settings.concurrency,
      // Desde que arranco el proceso (lo acumulado + el periodo en curso).
      totals: Object.fromEntries(
        (Object.keys(this.totals) as (keyof WorkerStats)[]).map((k) => [k, this.totals[k] + this.stats[k]])
      ),
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Reservas de un proceso anterior de este mismo container: ese proceso
    // ya no existe, no hace falta esperar a que venzan.
    await this.recover({ ownerPrefix: this.hostPrefix });

    this.timers.push(setInterval(() => void this.recover(), this.settings.recoveryIntervalMs));
    this.timers.push(setInterval(() => void this.logSummary(), SUMMARY_INTERVAL_MS));
    this.loopDone = this.loop();
    log.info("worker: iniciado", { workerId: this.workerId, ...this.settings });
  }

  /** Apagado ordenado: devuelve el buffer a la cola y espera las visitas abiertas. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.signal.notify();
    await this.loopDone;
    await this.releaseBuffer();
    await this.waitIdle();
    await this.closeBrowser();
    log.info("worker: detenido", { workerId: this.workerId });
  }

  /**
   * Deja de reclamar trabajos y libera Chromium. Vuelve cuando no queda
   * ninguna visita abierta. Se puede llamar aunque el worker no este corriendo.
   */
  async pause(reason: string): Promise<void> {
    this.pauseHolders++;
    this.signal.notify();
    log.info("worker: pausa pedida", { reason, active: this.active, buffered: this.buffer.length });
    await this.releaseBuffer();
    await this.waitIdle();
    await this.closeBrowser();
  }

  resume(): void {
    this.pauseHolders = Math.max(0, this.pauseHolders - 1);
    if (this.pauseHolders === 0) log.info("worker: reanudado");
    this.signal.notify();
  }

  /** Avisa que puede haber trabajo nuevo (ej. termino una ingesta). */
  wake(): void {
    this.signal.notify();
  }

  async recover(options: { ownerPrefix?: string; force?: boolean } = {}): Promise<number> {
    try {
      const recovered = await recoverExpiredLeases(new Date(), this.settings.maxAttempts, {
        ...options,
        excludeOwner: this.workerId,
      });
      if (recovered > 0) {
        log.warn("worker: reservas vencidas recuperadas", { recovered, ...options });
        this.signal.notify();
      }
      return recovered;
    } catch (err) {
      this.stats.dbErrors++;
      log.error("worker: error recuperando reservas", { error: errorMessage(err) });
      return 0;
    }
  }

  private get paused(): boolean {
    return this.pauseHolders > 0;
  }

  private async loop(): Promise<void> {
    const s = this.settings;
    while (this.running) {
      if (this.paused) {
        await this.signal.wait(1000);
        continue;
      }

      if (this.buffer.length === 0 && this.active < s.concurrency) {
        let jobs: ClaimedJob[];
        try {
          jobs = await claimJobs(this.workerId, s.claimBatchSize, new Date(), s.leaseMs);
        } catch (err) {
          this.stats.dbErrors++;
          log.error("worker: error reclamando trabajos", { error: errorMessage(err) });
          await this.signal.wait(s.pollIntervalMs);
          continue;
        }
        if (!this.running || this.paused) {
          // Se pauso mientras reclamaba: lo reclamado vuelve a la cola.
          this.buffer.push(...jobs);
          await this.releaseBuffer();
          continue;
        }
        this.buffer.push(...jobs);
        this.stats.claimed += jobs.length;
        if (jobs.length === 0) {
          await this.closeBrowserIfIdle();
          await this.signal.wait(s.pollIntervalMs);
          continue;
        }
      }

      while (this.buffer.length > 0 && this.active < s.concurrency && this.running && !this.paused) {
        const job = this.buffer.shift() as ClaimedJob;
        this.active++;
        void this.runJob(job).finally(() => {
          this.active--;
          this.lastActivity = Date.now();
          this.signal.notify();
        });
      }

      if (this.active >= s.concurrency) {
        await this.signal.wait(s.pollIntervalMs);
      }
    }
  }

  private async runJob(job: ClaimedJob): Promise<void> {
    const s = this.settings;
    const ctx = { jobId: job.id, smsContentId: job.smsContentId, attempt: job.attempt, runId: job.ingestRunId };
    try {
      // La reserva se confirma (y se extiende) recien al arrancar: el
      // trabajo pudo haber esperado en el buffer y otro worker quizas lo
      // recupero si vencio.
      const leased = await confirmLease(job.id, this.workerId, new Date(Date.now() + s.leaseMs));
      if (!leased) {
        this.stats.lostLease++;
        log.warn("worker: reserva perdida, no se visita", ctx);
        return;
      }

      if (job.text === null) {
        await finishWithoutVisit(job.id, this.workerId, "failed", "el SMS ya no existe en sms_content", new Date());
        this.stats.failed++;
        return;
      }
      const link = extractLink(job.text);
      if (!link) {
        await finishWithoutVisit(job.id, this.workerId, "skipped", "sin_link", new Date());
        this.stats.skipped++;
        return;
      }

      const startedAt = new Date();
      const visit = await this.visitFn(link);
      const finishedAt = new Date();
      this.stats.visits++;
      this.stats.visitMsTotal += finishedAt.getTime() - startedAt.getTime();

      const policy = retryPolicy(visit.outcome);
      let nextStatus: AttemptResult["nextStatus"];
      let nextAttemptAt: Date | null = null;
      if (policy === "exito") {
        nextStatus = "success";
      } else if (policy === "transitorio" && job.attempt < s.maxAttempts) {
        nextStatus = "retry";
        nextAttemptAt = new Date(finishedAt.getTime() + s.retryBaseDelayMs * 2 ** (job.attempt - 1));
      } else {
        nextStatus = "failed";
      }

      const attempt: AttemptResult = {
        jobId: job.id,
        workerId: this.workerId,
        smsContentId: job.smsContentId,
        attempt: job.attempt,
        link,
        startedAt,
        finishedAt,
        httpStatus: visit.httpStatus,
        ok: visit.ok,
        outcome: visit.outcome,
        responseTimeMs: visit.responseTimeMs,
        finalUrl: visit.finalUrl,
        redirects: visit.redirects,
        errorMessage: visit.errorMessage,
        nextStatus,
        nextAttemptAt,
      };
      const applied = await this.persistWithRetry(attempt, ctx);
      if (applied) {
        this.stats[nextStatus === "success" ? "success" : nextStatus === "retry" ? "retry" : "failed"]++;
      } else {
        this.stats.lostLease++;
        log.warn("worker: el intento se guardo pero la reserva ya no era de este worker", ctx);
      }
      log.debug("worker: visita", {
        ...ctx,
        link,
        outcome: visit.outcome,
        httpStatus: visit.httpStatus,
        responseTimeMs: visit.responseTimeMs,
        nextStatus,
      });
    } catch (err) {
      // El trabajo queda en processing hasta que venza la reserva y lo
      // recupere recoverExpiredLeases (vuelve a retry o failed).
      this.stats.dbErrors++;
      log.error("worker: error procesando trabajo", { ...ctx, error: errorMessage(err) });
    }
  }

  /**
   * Si Playwright termino pero MySQL no responde, se reintenta la escritura
   * unas veces antes de rendirse. Si igual falla, el error se loguea con el
   * resultado (trazabilidad) y el trabajo se recupera por vencimiento de
   * reserva: se vuelve a visitar en vez de quedar con un estado inventado.
   */
  private async persistWithRetry(attempt: AttemptResult, ctx: Record<string, unknown>): Promise<boolean> {
    for (let i = 0; ; i++) {
      try {
        return await completeAttempt(attempt);
      } catch (err) {
        if (i >= 2) {
          log.error("worker: no se pudo guardar el resultado", {
            ...ctx,
            outcome: attempt.outcome,
            httpStatus: attempt.httpStatus,
            error: errorMessage(err),
          });
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
  }

  private async releaseBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;
    const ids = this.buffer.map((j) => j.id);
    this.buffer = [];
    try {
      const released = await releaseJobs(ids, this.workerId, new Date());
      log.info("worker: trabajos devueltos a la cola", { released });
    } catch (err) {
      // Si no se pudieron devolver vuelven solos cuando venza la reserva.
      this.stats.dbErrors++;
      log.error("worker: error devolviendo trabajos a la cola", { error: errorMessage(err), jobs: ids.length });
    }
  }

  private async waitIdle(): Promise<void> {
    while (this.active > 0) {
      await this.signal.wait(500);
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.browserLaunch) {
      this.browserLaunch = launchBrowser()
        .then((browser) => {
          this.browser = browser;
          browser.on("disconnected", () => {
            if (this.browser === browser) this.browser = null;
          });
          log.info("worker: chromium iniciado");
          return browser;
        })
        .finally(() => {
          this.browserLaunch = null;
        });
    }
    return this.browserLaunch;
  }

  private async visitWithSharedBrowser(url: string): Promise<VisitResult> {
    let browser: Browser;
    try {
      browser = await this.getBrowser();
    } catch (err) {
      return {
        httpStatus: null,
        ok: false,
        outcome: "error_interno",
        responseTimeMs: 0,
        finalUrl: null,
        redirects: 0,
        errorMessage: `No se pudo iniciar Chromium: ${errorMessage(err)}`,
      };
    }
    return visitUrl(browser, url);
  }

  private async closeBrowserIfIdle(): Promise<void> {
    if (this.browser && this.active === 0 && Date.now() - this.lastActivity > this.settings.browserIdleCloseMs) {
      await this.closeBrowser();
      log.info("worker: chromium cerrado por inactividad");
    }
  }

  private async closeBrowser(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    await browser?.close().catch(() => undefined);
  }

  private async logSummary(): Promise<void> {
    const s = this.stats;
    this.stats = emptyStats();
    for (const key of Object.keys(s) as (keyof WorkerStats)[]) this.totals[key] += s[key];

    let ready: number | null = null;
    try {
      ready = await countReadyJobs(new Date());
    } catch {
      // Solo es para el resumen.
    }
    if (s.visits === 0 && s.claimed === 0 && !ready) return;
    log.info("worker: resumen", {
      periodSeconds: SUMMARY_INTERVAL_MS / 1000,
      ...s,
      avgVisitMs: s.visits ? Math.round(s.visitMsTotal / s.visits) : null,
      readyInQueue: ready,
      active: this.active,
      paused: this.paused,
    });
  }
}

// Instancia unica del proceso (server, clicks y endpoints la comparten).
export const processingWorker = new ProcessingWorker();
