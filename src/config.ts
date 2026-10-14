import "dotenv/config";

function required(name: string, fallbackName?: string): string {
  const value = process.env[name] || (fallbackName ? process.env[fallbackName] : undefined);
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

function int(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} tiene que ser un entero entre ${min} y ${max}`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

function percentage(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} tiene que ser un numero entre 0 y 100`);
  }
  return value;
}

// "-03:00" -> -180. La API manda y recibe fechas sin zona, en hora local.
function timezoneOffsetMinutes(name: string, fallback: string): number {
  const raw = process.env[name] || fallback;
  const match = raw.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) {
    throw new Error(`${name} tiene que tener el formato +HH:MM o -HH:MM`);
  }
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value ? value : undefined;
}

const checkConcurrency = int("CHECK_CONCURRENCY", 4, 1, 32);
const linkCheckTimeoutMs = int("LINK_CHECK_TIMEOUT_MS", 15000, 1000);

// Sin auth Alaris responde error en cada corrida: mejor no arrancar y
// decirlo claro. El mock local no lo necesita.
function edrAuth(url: string): string | undefined {
  const auth = optional("EDR_AUTH");
  if (!auth && !/mock-edr|127\.0\.0\.1|localhost/.test(url)) {
    throw new Error("Falta la variable de entorno EDR_AUTH (el \"auth\" del JSON-RPC de Alaris)");
  }
  return auth;
}

// Argumentos extra (o que pisan a los de arriba) para el "args" del JSON-RPC,
// como objeto JSON. Ej: {"client_product_id": 1286} para mandarlo numerico.
function jsonObject(name: string): Record<string, unknown> {
  const raw = process.env[name];
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} tiene que ser un objeto JSON valido`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} tiene que ser un objeto JSON`);
  }
  return parsed as Record<string, unknown>;
}

const edrUrl = required("EDR_URL", "API_URL");

export const config = {
  port: int("PORT", 3000, 1, 65535),
  logLevel: (process.env.LOG_LEVEL ?? "info") as "debug" | "info" | "warn" | "error",
  // Si esta seteado, los endpoints que no son /health piden
  // "Authorization: Bearer <ADMIN_TOKEN>". La app igual queda en 127.0.0.1.
  adminToken: optional("ADMIN_TOKEN"),

  db: {
    host: required("DB_HOST"),
    port: int("DB_PORT", 3306, 1, 65535),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: required("DB_NAME"),
    connectionLimit: int("DB_CONNECTION_LIMIT", 10, 2, 100),
  },

  edr: {
    // API_URL queda como alias para no romper .env viejos.
    url: edrUrl,
    // Va en params.auth del JSON-RPC. Nunca se loguea ni se devuelve.
    auth: edrAuth(edrUrl),
    // Bearer opcional, solo si la API real lo pide ademas del auth del body.
    bearerToken: optional("API_TOKEN"),
    method: process.env.EDR_METHOD || "Enterprise.Cursor",
    cursorName: process.env.EDR_CURSOR_NAME || "get_sms_edr",
    clientProductId: optional("EDR_CLIENT_PRODUCT_ID"),
    country: optional("EDR_COUNTRY"),
    extraArgs: jsonObject("EDR_EXTRA_ARGS"),
    timezoneOffsetMinutes: timezoneOffsetMinutes("EDR_TIMEZONE_OFFSET", "-03:00"),
    // Alaris puede tardar varios minutos en devolver ~20.000 EDR.
    httpTimeoutMs: int("EDR_HTTP_TIMEOUT_MS", 600000, 1000),
    // Cada reintento puede volver a tardar minutos: pocos.
    maxRetries: int("EDR_MAX_RETRIES", 1, 0, 10),
    // Tope de filas que devuelve la API por consulta. Si una respuesta llega
    // a este numero se asume truncada y la ventana se parte en dos.
    // 0 = sin tope (nunca se parte).
    maxRowsPerRequest: int("EDR_MAX_ROWS_PER_REQUEST", 20000, 0),
    // Una rafaga real de un solo producto supero 20.000 SMS en ~36 s: el
    // rango minimo tiene que poder bajar a pocos segundos.
    minSplitSeconds: int("EDR_MIN_SPLIT_SECONDS", 1, 1),
  },

  ingest: {
    // 25 columnas por fila: 2000 filas = 50k placeholders, debajo del limite de 65535.
    dbBatchSize: int("INGEST_DB_BATCH_SIZE", 500, 1, 2000),
  },

  scheduler: {
    enabled: bool("SCHEDULER_ENABLED", true),
    windowMinutes: int("EDR_WINDOW_MINUTES", 30, 1, 24 * 60),
    // Cada cuanto se fija si hay una ventana lista para pedir. No es el tamano
    // de la ventana: con tick corto, despues de un reinicio se retoma enseguida.
    tickSeconds: int("SCHEDULER_TICK_SECONDS", 60, 5),
    // Margen despues del cierre de la ventana antes de pedirla, para que la
    // API ya tenga los EDR que llegan tarde.
    safetyDelayMinutes: int("EDR_SAFETY_DELAY_MINUTES", 5, 0),
    // Cada consulta arranca este tanto antes del inicio de la ventana para
    // levantar EDR tardios o actualizados de la anterior (se deduplican).
    overlapMinutes: int("EDR_OVERLAP_MINUTES", 0, 0),
    // Si no hay corridas previas, desde donde arrancar (hora de la API,
    // "YYYY.MM.DD HH:mm:ss"). Sin valor: arranca por la ultima ventana cerrada.
    startDate: optional("EDR_START_DATE"),
    maxWindowsPerTick: int("EDR_MAX_WINDOWS_PER_TICK", 6, 1),
    // 0 = no borrar nunca. Solo purga sms_link_checks y sync_runs viejos.
    retentionDays: int("RESULTS_RETENTION_DAYS", 0, 0),
  },

  worker: {
    enabled: bool("WORKER_ENABLED", true),
    concurrency: checkConcurrency,
    claimBatchSize: int("WORKER_CLAIM_BATCH_SIZE", checkConcurrency * 2, 1, 500),
    pollIntervalMs: int("WORKER_POLL_INTERVAL_MS", 5000, 100),
    // La reserva tiene que cubrir la espera en el buffer local + la visita.
    leaseMs: int("WORKER_LEASE_MS", 5 * 60 * 1000, 10000),
    maxAttempts: int("JOB_MAX_ATTEMPTS", 3, 1, 20),
    retryBaseDelayMs: int("JOB_RETRY_BASE_DELAY_MS", 60000, 0),
    // Chromium sin trabajo se cierra para liberar RAM.
    browserIdleCloseMs: int("WORKER_BROWSER_IDLE_CLOSE_MS", 60000, 1000),
    recoveryIntervalMs: int("WORKER_RECOVERY_INTERVAL_MS", 60000, 1000),
  },

  checker: {
    concurrency: checkConcurrency,
    timeoutMs: linkCheckTimeoutMs,
    // % de los SMS con link (elegidos al azar en cada lote de ingesta) que
    // se encolan para chequear. El resto queda como "skipped".
    clickPercentage: percentage("CLICK_PERCENTAGE", 100),
  },

  clicker: {
    // Tope de visitas por job de clicks manual (POST /clicks).
    maxCount: int("CLICK_JOB_MAX_COUNT", 1000, 1),
    // Cada sesion de browser se queda en la pagina un tiempo al azar en
    // este rango antes de cerrarse y dejar lugar a la siguiente.
    dwellMinMs: int("CLICK_DWELL_MIN_MS", 3000, 0),
    dwellMaxMs: int("CLICK_DWELL_MAX_MS", 7000, 0),
    // No descargar imagenes, fuentes ni video en las visitas: permite mas
    // sesiones en paralelo con poca CPU/RAM. Ojo: los pixeles de tracking
    // que sean imagenes no se disparan (los que son JS si).
    blockResources: process.env.CLICK_BLOCK_RESOURCES === "true",
  },
};
