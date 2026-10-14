import { config } from "../config";
import { log, errorMessage } from "../logger";
import { pool } from "../db/pool";
import { lastCompletedScheduledEnd } from "../db/syncRunsRepo";
import { runDueWindows } from "./ingestService";

const RETENTION_EVERY_MS = 60 * 60 * 1000;
const RETENTION_CHUNK = 5000;

/**
 * Scheduler interno: cada SCHEDULER_TICK_SECONDS se fija si hay ventanas
 * EDR cerradas sin pedir y las ingesta. No ejecuta visitas: solo llena la
 * cola, que los workers drenan a su ritmo. Los ticks nunca se pisan (el
 * proximo se agenda cuando termina el anterior) y entre instancias los
 * coordina el lock de ingesta.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private ticking: Promise<void> | null = null;
  private lastRetentionAt = 0;

  constructor(private readonly onJobsCreated: () => void = () => undefined) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    log.info("scheduler: iniciado", {
      windowMinutes: config.scheduler.windowMinutes,
      tickSeconds: config.scheduler.tickSeconds,
      safetyDelayMinutes: config.scheduler.safetyDelayMinutes,
      overlapMinutes: config.scheduler.overlapMinutes,
    });
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.ticking;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.ticking = this.tick().finally(() => {
        this.ticking = null;
        this.schedule(config.scheduler.tickSeconds * 1000);
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    try {
      const result = await runDueWindows();
      if (result === null) {
        log.debug("scheduler: otra ingesta tiene el lock, se saltea el tick");
      } else if (result.runs.some((r) => r.jobsCreated > 0)) {
        this.onJobsCreated();
      }
    } catch (err) {
      log.error("scheduler: error en el tick", { error: errorMessage(err) });
    }

    if (config.scheduler.retentionDays > 0 && Date.now() - this.lastRetentionAt > RETENTION_EVERY_MS) {
      this.lastRetentionAt = Date.now();
      await purgeOldResults(config.scheduler.retentionDays).catch((err) =>
        log.error("scheduler: error purgando resultados viejos", { error: errorMessage(err) })
      );
    }
  }
}

/**
 * Borra historial viejo de verificaciones y corridas, de a pedazos para no
 * tener un DELETE largo bloqueando. sms_processing NO se purga: es la
 * identidad que evita duplicados si la API vuelve a mandar un SMS.
 */
export async function purgeOldResults(retentionDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  // La ultima corrida programada exitosa es el cursor de ventanas: nunca se borra.
  const cursor = (await lastCompletedScheduledEnd()) ?? new Date(0);
  const targets = [
    { sql: "DELETE FROM sms_link_checks WHERE checked_at < ?", params: [cutoff] },
    { sql: "DELETE FROM sync_runs WHERE started_at < ? AND window_end < ?", params: [cutoff, cursor] },
  ];
  let total = 0;
  for (const target of targets) {
    for (;;) {
      const [result] = await pool.query<import("mysql2").ResultSetHeader>(
        `${target.sql} LIMIT ${RETENTION_CHUNK}`,
        target.params
      );
      total += result.affectedRows;
      if (result.affectedRows < RETENTION_CHUNK) break;
    }
  }
  if (total > 0) log.info("scheduler: resultados viejos purgados", { deleted: total, retentionDays });
  return total;
}
