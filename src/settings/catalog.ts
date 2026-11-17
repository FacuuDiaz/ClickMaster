import { z } from "zod";
import { parseApiDate } from "../edr/apiTime";
import { CAPTURE_MODES, config } from "../config";
import { parseDays } from "../policies/visitHours";

/**
 * Catalogo de lo que se puede editar desde la web. Cada clave apunta a uno
 * o mas campos de `config` (que es mutable): el store escribe ahi el valor
 * y el resto del codigo lo lee en vivo, sin saber de donde vino.
 *
 * Lo que no esta aca se sigue configurando solo por .env: credenciales,
 * base, puerto, pool de reportes y zona horaria (cambiarla corre todas las
 * fechas de la API).
 */
export type SettingGroup = "edr" | "scheduler" | "worker" | "horario" | "checker" | "clicker" | "capture";

export const GROUP_LABELS: Record<SettingGroup, string> = {
  edr: "Fuente Alaris",
  scheduler: "Ingesta automatica",
  worker: "Worker y Chromium",
  horario: "Horario de visitas",
  checker: "Verificacion de links",
  clicker: "Clicks manuales",
  capture: "Capturas de Alaris",
};

export type SettingType = "int" | "number" | "bool" | "string" | "json" | "enum";

export interface SettingDef {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  env: string;
  type: SettingType;
  unit?: string;
  min?: number;
  max?: number;
  nullable?: boolean;
  // Para enum: valor -> etiqueta.
  options?: Record<string, string>;
  // Campos de config que pisa (ej. la concurrencia la comparten worker y checker).
  paths: string[];
  schema: z.ZodType<unknown>;
}

type Base = Omit<SettingDef, "type" | "schema" | "paths" | "key"> & { path: string | string[] };

function def(type: SettingType, b: Base, schema: z.ZodType<unknown>, extra: Partial<SettingDef> = {}): SettingDef {
  const paths = Array.isArray(b.path) ? b.path : [b.path];
  const { path: _path, ...rest } = b;
  return { key: paths[0], ...rest, ...extra, type, paths, schema: b.nullable ? schema.nullable() : schema };
}

function int(b: Base & { min: number; max?: number }): SettingDef {
  let schema = z.number().int().min(b.min);
  if (b.max !== undefined) schema = schema.max(b.max);
  return def("int", b, schema);
}

function bool(b: Base): SettingDef {
  return def("bool", b, z.boolean());
}

function str(b: Base, schema: z.ZodType<unknown> = z.string().trim().min(1).max(512)): SettingDef {
  return def("string", b, schema);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "tiene que ser http(s)");

const apiDateString = z
  .string()
  .trim()
  .refine(
    (v) => parseApiDate(v, config.edr.timezoneOffsetMinutes) !== null,
    "formato YYYY.MM.DD HH:mm:ss (hora de Alaris)"
  );

const jsonObject = z.record(z.unknown());

// Tamanos de ventana que dividen el dia: las ventanas quedan alineadas al reloj.
export const WINDOW_OPTIONS = [5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 720, 1440];

export const SETTINGS: SettingDef[] = [
  // ---------- Fuente Alaris ----------
  str({ path: "edr.url", group: "edr", label: "URL de la API", env: "EDR_URL",
    description: "Endpoint JSON-RPC de Alaris. Esta restringida por IP: solo responde desde el servidor." }, httpUrl),
  str({ path: "edr.method", group: "edr", label: "Metodo JSON-RPC", env: "EDR_METHOD",
    description: "Campo method del request." }),
  str({ path: "edr.cursorName", group: "edr", label: "Cursor", env: "EDR_CURSOR_NAME",
    description: "params.name del request." }),
  str({ path: "edr.clientProductId", group: "edr", label: "Producto (client_product_id)", env: "EDR_CLIENT_PRODUCT_ID", nullable: true,
    description: "Filtra los EDR por producto. Vacio = todos los productos." }, z.string().trim().min(1).max(32)),
  str({ path: "edr.country", group: "edr", label: "Pais", env: "EDR_COUNTRY", nullable: true,
    description: "Filtra por pais (op_country \"==\"). Vacio = sin filtro." }, z.string().trim().min(1).max(32)),
  def("json", { path: "edr.extraArgs", group: "edr", label: "Argumentos extra", env: "EDR_EXTRA_ARGS",
    description: "Objeto JSON que se suma a args del request y pisa a los de arriba." }, jsonObject),
  int({ path: "edr.httpTimeoutMs", group: "edr", label: "Timeout del request", env: "EDR_HTTP_TIMEOUT_MS", unit: "ms", min: 1000,
    description: "Tiempo maximo para recibir la respuesta completa (puede tardar minutos)." }),
  int({ path: "edr.maxRetries", group: "edr", label: "Reintentos", env: "EDR_MAX_RETRIES", min: 0, max: 10,
    description: "Reintentos ante errores transitorios. Cada uno puede volver a tardar minutos." }),
  int({ path: "edr.maxRowsPerRequest", group: "edr", label: "Tope de filas por respuesta", env: "EDR_MAX_ROWS_PER_REQUEST", min: 0,
    description: "Lo maximo que Alaris devuelve por consulta (20.000). Si una respuesta llega a este numero, se pide la pagina siguiente desde la fecha del ultimo registro hasta el mismo fin. 0 = sin tope (nunca pagina)." }),
  int({ path: "edr.maxPagesPerWindow", group: "edr", label: "Paginas maximas por ventana", env: "EDR_MAX_PAGES_PER_WINDOW", min: 1, max: 10000,
    description: "Corte de seguridad: si una ventana necesita mas consultas que esto, falla y se reintenta. 50 paginas = hasta 1.000.000 de SMS por ventana." }),
  int({ path: "edr.minSplitSeconds", group: "edr", label: "Rango minimo al partir (respaldo)", env: "EDR_MIN_SPLIT_SECONDS", unit: "s", min: 1,
    description: "Solo si Alaris devuelve una respuesta en el tope DESORDENADA: en ese caso no se puede seguir desde el ultimo registro y el rango se parte en mitades hasta este minimo." }),

  // ---------- Ingesta automatica ----------
  bool({ path: "scheduler.enabled", group: "scheduler", label: "Ingesta automatica activa", env: "SCHEDULER_ENABLED",
    description: "Apagada, no se piden ventanas nuevas (se retoman donde quedaron al prenderla)." }),
  def("int", { path: "scheduler.windowMinutes", group: "scheduler", label: "Cada cuanto se consulta a Alaris", env: "EDR_WINDOW_MINUTES", unit: "min",
    description: "Tamano de cada ventana: se hace una consulta por ventana, apenas cierra (mas el margen). Ventanas mas chicas = SMS mas frescos y respuestas mas livianas, pero mas consultas. Al cambiarlo, la proxima ventana se recorta hasta alinearse: no quedan huecos ni repetidos." },
    z.number().int().refine((v) => WINDOW_OPTIONS.includes(v), "tiene que ser uno de los valores de la lista"),
    { options: Object.fromEntries(WINDOW_OPTIONS.map((m) => [String(m), m < 60 ? `cada ${m} min` : m === 60 ? "cada 1 hora" : m < 1440 ? `cada ${m / 60} horas` : "una vez por dia"])) }),
  int({ path: "scheduler.tickSeconds", group: "scheduler", label: "Frecuencia de chequeo interno", env: "SCHEDULER_TICK_SECONDS", unit: "s", min: 5,
    description: "Cada cuanto se fija si ya cerro una ventana para pedirla. No cambia cada cuanto se consulta a Alaris: solo cuanto tarda en darse cuenta (y en retomar despues de un reinicio)." }),
  int({ path: "scheduler.safetyDelayMinutes", group: "scheduler", label: "Margen despues del cierre", env: "EDR_SAFETY_DELAY_MINUTES", unit: "min", min: 0,
    description: "Espera despues de que cierra una ventana antes de pedirla (EDR que llegan tarde)." }),
  int({ path: "scheduler.overlapMinutes", group: "scheduler", label: "Solapamiento", env: "EDR_OVERLAP_MINUTES", unit: "min", min: 0,
    description: "Cada consulta arranca este tanto antes para levantar EDR tardios (se deduplican)." }),
  int({ path: "scheduler.maxWindowsPerTick", group: "scheduler", label: "Ventanas atrasadas por chequeo", env: "EDR_MAX_WINDOWS_PER_TICK", min: 1,
    description: "Cuantas ventanas pendientes se piden seguidas en un mismo chequeo." }),
  str({ path: "scheduler.startDate", group: "scheduler", label: "Primera ventana", env: "EDR_START_DATE", nullable: true,
    description: "Solo si la base no tiene corridas: desde donde arrancar (hora de Alaris). Vacio = ultima ventana cerrada." }, apiDateString),
  int({ path: "scheduler.retentionDays", group: "scheduler", label: "Retencion de resultados", env: "RESULTS_RETENTION_DAYS", unit: "dias", min: 0,
    description: "Borra verificaciones y corridas con mas de N dias. 0 = no borrar nunca." }),
  int({ path: "ingest.dbBatchSize", group: "scheduler", label: "Lote de escritura", env: "INGEST_DB_BATCH_SIZE", min: 1, max: 2000,
    description: "SMS por transaccion al guardar una respuesta." }),

  // ---------- Worker ----------
  bool({ path: "worker.enabled", group: "worker", label: "Worker activo", env: "WORKER_ENABLED",
    description: "Apagado, no se visitan links (la cola se sigue llenando)." }),
  int({ path: ["worker.concurrency", "checker.concurrency"], group: "worker", label: "Sesiones de Chromium en paralelo", env: "CHECK_CONCURRENCY", min: 1, max: 8,
    description: "Limite global (worker y clicks manuales). Servidor de 1 nucleo / 2 GB: no pasar de 4-6." }),
  int({ path: "worker.claimBatchSize", group: "worker", label: "Lote de reclamo", env: "WORKER_CLAIM_BATCH_SIZE", min: 1, max: 500,
    description: "Trabajos que se reclaman de la cola por vez." }),
  int({ path: "worker.pollIntervalMs", group: "worker", label: "Espera con la cola vacia", env: "WORKER_POLL_INTERVAL_MS", unit: "ms", min: 100,
    description: "Cada cuanto vuelve a mirar la cola si no habia trabajo." }),
  int({ path: "worker.leaseMs", group: "worker", label: "Duracion de la reserva", env: "WORKER_LEASE_MS", unit: "ms", min: 10000,
    description: "Si un trabajo queda reservado mas que esto, otro worker lo recupera." }),
  int({ path: "worker.maxAttempts", group: "worker", label: "Intentos maximos", env: "JOB_MAX_ATTEMPTS", min: 1, max: 20,
    description: "Intentos por SMS antes de quedar fallido (solo errores transitorios se reintentan)." }),
  int({ path: "worker.retryBaseDelayMs", group: "worker", label: "Espera base entre reintentos", env: "JOB_RETRY_BASE_DELAY_MS", unit: "ms", min: 0,
    description: "Se duplica en cada intento." }),
  int({ path: "worker.browserIdleCloseMs", group: "worker", label: "Cerrar Chromium inactivo", env: "WORKER_BROWSER_IDLE_CLOSE_MS", unit: "ms", min: 1000,
    description: "Sin trabajo durante este tiempo, se cierra Chromium para liberar RAM." }),
  int({ path: "worker.recoveryIntervalMs", group: "worker", label: "Recuperar reservas vencidas cada", env: "WORKER_RECOVERY_INTERVAL_MS", unit: "ms", min: 1000,
    description: "Frecuencia con la que se devuelven a la cola los trabajos de workers caidos." }),

  // ---------- Verificacion ----------
  def("number", { path: "checker.clickPercentage", group: "checker", label: "Porcentaje a visitar (por defecto)", env: "CLICK_PERCENTAGE", unit: "%",
    min: 0, max: 100,
    description: "Para los SMS con link que no coinciden con ninguna politica: se elige al azar este % del total de cada ventana. 4 sesiones verifican ~3.600 cada 30 min." },
    z.number().min(0).max(100)),
  int({ path: "checker.timeoutMs", group: "checker", label: "Timeout de cada visita", env: "LINK_CHECK_TIMEOUT_MS", unit: "ms", min: 1000,
    description: "Tiempo maximo para que la pagina llegue a domcontentloaded." }),

  // ---------- Clicks manuales ----------
  int({ path: "clicker.maxCount", group: "clicker", label: "Tope de visitas por job", env: "CLICK_JOB_MAX_COUNT", min: 1,
    description: "Maximo que se puede pedir en un solo job de clicks." }),
  int({ path: "clicker.dwellMinMs", group: "clicker", label: "Permanencia minima", env: "CLICK_DWELL_MIN_MS", unit: "ms", min: 0,
    description: "Cada sesion se queda en la pagina un tiempo al azar entre el minimo y el maximo." }),
  int({ path: "clicker.dwellMaxMs", group: "clicker", label: "Permanencia maxima", env: "CLICK_DWELL_MAX_MS", unit: "ms", min: 0,
    description: "Tiene que ser mayor o igual a la minima." }),
  bool({ path: "clicker.blockResources", group: "clicker", label: "Bloquear imagenes, fuentes y video", env: "CLICK_BLOCK_RESOURCES",
    description: "Menos CPU/RAM por sesion. Los pixeles de tracking que son imagenes no se disparan." }),

  // ---------- Horario de visitas ----------
  bool({ path: "visitHours.enabled", group: "horario", label: "Visitar solo en horario", env: "VISIT_HOURS_ENABLED",
    description: "Prendido, el worker solo visita links dentro de los dias y horas de abajo; fuera de horario los SMS elegidos esperan en la cola. No afecta a la ingesta (se siguen trayendo y eligiendo) ni a los clicks manuales." }),
  str({ path: "visitHours.days", group: "horario", label: "Dias", env: "VISIT_DAYS",
    description: "\"lun-vie\", \"lun,mie,vie\", \"lun-sab\" o \"todos\"." },
    z.string().trim().min(1).max(64).refine((v) => parseDays(v) !== null, "dias invalidos: usar lun, mar, mie, jue, vie, sab, dom (ej. lun-vie)")),
  str({ path: "visitHours.from", group: "horario", label: "Desde", env: "VISIT_FROM",
    description: "Hora de Alaris, formato HH:MM." }, z.string().trim().regex(HHMM, "formato HH:MM")),
  str({ path: "visitHours.to", group: "horario", label: "Hasta", env: "VISIT_TO",
    description: "Hora de Alaris, formato HH:MM (24:00 = fin del dia). Tiene que ser posterior a \"Desde\"." }, z.string().trim().regex(HHMM, "formato HH:MM")),

  // ---------- Capturas ----------
  def("enum", { path: "capture.mode", group: "capture", label: "Que respuestas guardar", env: "EDR_CAPTURE_MODE",
    description: "Copias temporales de lo que devuelve Alaris, para inspeccionar, simular politicas y reprocesar. \"Todas\" suma ~5 MB comprimidos y ~1 s de CPU por ventana." },
    z.enum(CAPTURE_MODES), {
      options: { off: "Ninguna", errores: "Solo errores y registros invalidos", todas: "Todas las respuestas" },
    }),
  int({ path: "capture.retentionHours", group: "capture", label: "Se borran despues de", env: "EDR_CAPTURE_RETENTION_HOURS", unit: "h", min: 1, max: 720,
    description: "Las capturas marcadas como conservadas no vencen." }),
  int({ path: "capture.maxTotalMb", group: "capture", label: "Espacio maximo", env: "EDR_CAPTURE_MAX_TOTAL_MB", unit: "MB", min: 10, max: 100000,
    description: "Comprimido, en la base. Si se pasa, se borran las mas viejas no conservadas." }),
];

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

// ---------- Acceso por ruta sobre config ----------

type Obj = Record<string, unknown>;

export function readPath(path: string): unknown {
  return path.split(".").reduce<unknown>((obj, part) => (obj as Obj)?.[part], config);
}

export function writePath(path: string, value: unknown): void {
  const parts = path.split(".");
  const last = parts.pop() as string;
  const target = parts.reduce<unknown>((obj, part) => (obj as Obj)[part], config) as Obj;
  target[last] = value;
}

/** Valor que trae hoy config (de .env o el default del codigo). Null por undefined. */
export function currentValue(def: SettingDef): unknown {
  const value = readPath(def.paths[0]);
  return value === undefined ? null : value;
}

/**
 * Reglas que cruzan claves: se validan sobre el estado completo que
 * quedaria despues del cambio, no clave por clave.
 */
export function crossValidate(get: (key: string) => unknown, hasEdrAuth: boolean): string[] {
  const errors: string[] = [];
  const dwellMin = get("clicker.dwellMinMs") as number;
  const dwellMax = get("clicker.dwellMaxMs") as number;
  if (dwellMin > dwellMax) errors.push("clicker.dwellMinMs: la permanencia minima no puede superar a la maxima");
  if (String(get("visitHours.from")) >= String(get("visitHours.to"))) {
    errors.push("visitHours.to: el horario tiene que terminar despues de empezar");
  }
  const url = String(get("edr.url"));
  if (!hasEdrAuth && !/mock-edr|127\.0\.0\.1|localhost/.test(url)) {
    errors.push("edr.url: sin EDR_AUTH en .env solo se puede apuntar al mock local");
  }
  return errors;
}
