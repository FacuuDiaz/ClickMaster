/**
 * Logs estructurados: una linea JSON por evento, con campos para
 * correlacionar (runId, window, jobId, smsContentId, attempt...).
 * Se lee LOG_LEVEL directo de process.env y no de config para que el
 * logger se pueda usar en modulos que no cargan la config (ej. tests).
 */
type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): number {
  const level = process.env.LOG_LEVEL as Level | undefined;
  return LEVELS[level ?? "info"] ?? LEVELS.info;
}

function write(level: Level, msg: string, fields?: Fields): void {
  if (LEVELS[level] < minLevel()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (msg: string, fields?: Fields) => write("debug", msg, fields),
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
