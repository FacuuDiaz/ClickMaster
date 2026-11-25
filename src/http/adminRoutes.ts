import { policiesCache } from "../policies/repo";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../config";
import { errorMessage, log } from "../logger";
import { listAudit, type Actor } from "../db/auditRepo";
import { lastRun, queueSnapshot } from "../db/dashboardRepo";
import { formatOffset } from "../edr/apiTime";
import { settingsStore, SettingsValidationError } from "../settings/store";
import { processingWorker } from "../worker/processingWorker";
import { getCurrentClickJob, listQueuedClickJobs } from "../clicker/clickJob";
import type { Scheduler } from "../service/scheduler";

/**
 * Quien hace el cambio: el nombre que el usuario escribe en la web (header
 * X-Actor) y la IP. Es trazabilidad para el historial, no autenticacion: la
 * barrera sigue siendo ADMIN_TOKEN + la app publicada solo en 127.0.0.1.
 */
export function actorFrom(req: Request): Actor {
  const raw = req.header("x-actor");
  let name: string | null = null;
  if (raw) {
    try {
      name = decodeURIComponent(raw).trim().slice(0, 64) || null;
    } catch {
      name = raw.trim().slice(0, 64) || null;
    }
  }
  return { name, ip: (req.ip ?? "").slice(0, 64) || null };
}

interface EnvItem {
  env: string;
  label: string;
  // null = secreto: solo se informa si esta configurado.
  value: string | null;
  configured: boolean;
  description: string;
  // Texto tal cual esta en .env (null si no esta: usa el default). Nunca para secretos.
  raw: string | null;
}

/**
 * Lo que solo se configura en .env (no esta en el catalogo editable). Los
 * secretos nunca salen: solo si estan configurados.
 */
function envGroups(): { group: string; description: string; items: EnvItem[] }[] {
  const plain = (env: string, label: string, value: unknown, description: string): EnvItem => ({
    env,
    label,
    value: value === undefined || value === null || value === "" ? "(vacio)" : String(value),
    configured: value !== undefined && value !== null && value !== "",
    description,
    raw: process.env[env] ?? null,
  });
  const secret = (env: string, label: string, value: unknown, description: string): EnvItem => ({
    env,
    label,
    value: null,
    configured: Boolean(value),
    description,
    raw: null,
  });
  return [
    {
      group: "Base de datos",
      description: "Donde vive todo: SMS, cola, resultados y la configuracion de la web. Cambiarla apunta la app a otra base.",
      items: [
        plain("DB_HOST", "Servidor", config.db.host, "\"mysql\" = el MySQL del docker-compose; si no, el host de una base externa."),
        plain("DB_PORT", "Puerto", config.db.port, "Puerto de MySQL."),
        plain("DB_NAME", "Base", config.db.database, "Nombre de la base. Los tests usan <DB_NAME>_test."),
        plain("DB_USER", "Usuario", config.db.user, "Necesita SELECT/INSERT/UPDATE en sms_content y CREATE/ALTER para las tablas propias."),
        secret("DB_PASSWORD", "Contrasena", config.db.password, "Contrasena de ese usuario."),
        plain("DB_CONNECTION_LIMIT", "Conexiones de la app", config.db.connectionLimit, "Pool de la ingesta y el worker."),
        secret("DB_ROOT_PASSWORD", "Contrasena root", process.env.DB_ROOT_PASSWORD, "Solo para el MySQL del docker-compose y los tests."),
      ],
    },
    {
      group: "Credenciales de Alaris",
      description: "Autenticacion contra la API EDR. Son secretas y nunca se guardan en la base ni en las capturas.",
      items: [
        secret("EDR_AUTH", "Credencial (params.auth)", config.edr.auth, "Base64 de usuario:clave. Sin ella la app no arranca contra la API real."),
        secret("API_TOKEN", "Bearer opcional", config.edr.bearerToken, "Solo si Alaris pide ademas un header Authorization."),
        secret("ALARIS_REST_AUTH", "REST API (Basic)", config.alarisRest.auth, "usuario:clave (o su base64) de la REST API de la plataforma, para sms_usage_stats (base \"dia anterior\"). Sin ella se usa el conteo local de ayer."),
      ],
    },
    {
      group: "Zona horaria de Alaris",
      description: "Como se leen las fechas de Alaris. Cambiarla con datos ya ingestados corre todas las ventanas (puede dejar huecos o repetir rangos). El tamano de ventana se cambia desde Configuracion.",
      items: [
        plain("EDR_TIMEZONE_OFFSET", "Zona horaria de Alaris", formatOffset(config.edr.timezoneOffsetMinutes), "Las fechas de la API no traen zona: se interpretan con este offset (sin horario de verano)."),
      ],
    },
    {
      group: "Servidor web y seguridad",
      description: "Como se publica la app y quien puede usarla.",
      items: [
        plain("PORT", "Puerto interno", config.port, "Puerto de Express dentro del container."),
        plain("APP_PORT", "Puerto publicado", process.env.APP_PORT ?? "3000", "Puerto en 127.0.0.1 del servidor (no queda expuesto a internet)."),
        secret("ADMIN_TOKEN", "Token de administrador", config.adminToken, "Si esta, todo salvo /health pide \"Authorization: Bearer\". La web lo pide una vez por pestana."),
        plain("LOG_LEVEL", "Nivel de logs", config.logLevel, "info en produccion; debug loguea cada visita."),
      ],
    },
    {
      group: "Dashboard y reportes",
      description: "Pool de MySQL propio y de solo lectura, para que mirar reportes nunca frene la ingesta ni el worker.",
      items: [
        plain("REPORTS_DB_CONNECTION_LIMIT", "Conexiones", config.reports.dbConnectionLimit, "Maximo de conexiones del dashboard, por mas pestanas que haya."),
        plain("REPORTS_DB_USER", "Usuario de solo lectura", config.reports.dbUser ?? "(el de la app)", "Opcional; la sesion igual se abre en READ ONLY."),
        secret("REPORTS_DB_PASSWORD", "Contrasena", config.reports.dbPassword, "Del usuario de solo lectura."),
        plain("REPORTS_QUERY_TIMEOUT_MS", "Tiempo maximo por consulta", `${config.reports.queryTimeoutMs} ms`, "MySQL corta la consulta si se pasa."),
        plain("REPORTS_CACHE_SECONDS", "Cache", `${config.reports.cacheSeconds} s`, "Pedidos iguales en esta ventana comparten la consulta."),
        plain("REPORTS_MAX_RANGE_DAYS", "Rango maximo", `${config.reports.maxRangeDays} dias`, "Lo maximo que se puede pedir en Reportes."),
      ],
    },
    {
      group: "Docker",
      description: "Lo lee docker compose al levantar los containers.",
      items: [
        plain("COMPOSE_PROFILES", "Perfiles", process.env.COMPOSE_PROFILES, "\"mock\" levanta la API de Alaris de mentira (solo desarrollo)."),
        plain("MOCK_API_HOST_PORT", "Puerto del mock", process.env.MOCK_API_HOST_PORT, "Solo con el perfil mock."),
      ],
    },
  ];
}

const settingsBody = z.object({
  set: z.record(z.unknown()).optional(),
  reset: z.array(z.string()).optional(),
});

const auditQuery = z.object({
  entity: z.enum(["setting", "policy", "action", "capture"]).optional(),
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const TOGGLES: Record<string, string> = {
  scheduler: "scheduler.enabled",
  worker: "worker.enabled",
};

function zodError(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
}

export interface AdminDeps {
  scheduler?: Scheduler;
}

export function createAdminRouter(deps: AdminDeps = {}): Router {
  const router = Router();

  router.get("/admin/settings", (_req, res) => {
    res.json(settingsStore.list());
  });

  router.get("/admin/env", (_req, res) => {
    res.json({ groups: envGroups() });
  });

  router.put("/admin/settings", async (req, res) => {
    const body = settingsBody.safeParse(req.body);
    if (!body.success) return zodError(res, body.error);
    try {
      const changed = await settingsStore.save(body.data, actorFrom(req));
      res.json({ changed, ...settingsStore.list() });
    } catch (err) {
      if (err instanceof SettingsValidationError) {
        res.status(400).json({ error: "Configuracion invalida", details: err.details });
        return;
      }
      log.error("admin: error guardando configuracion", { error: errorMessage(err) });
      res.status(500).json({ error: "No se pudo guardar la configuracion" });
    }
  });

  router.get("/admin/status", async (_req, res) => {
    const current = getCurrentClickJob();
    let queue = null;
    let run = null;
    try {
      queue = await queueSnapshot();
      run = await lastRun();
    } catch (err) {
      log.warn("admin: no se pudo leer la cola", { error: errorMessage(err) });
    }
    res.json({
      scheduler: { enabled: config.scheduler.enabled, ...(deps.scheduler?.status() ?? { running: false }) },
      worker: { enabled: config.worker.enabled, ...processingWorker.status() },
      clicks: { current, queued: listQueuedClickJobs().length },
      // Sin politica activa todo queda en espera (no se ingesta ni se visita).
      policy: (() => {
        const active = policiesCache.active()[0];
        return { active: active ? { id: active.id, name: active.name } : null };
      })(),
      queue,
      lastRun: run,
      generatedAt: new Date(),
    });
  });

  // Apagar/prender queda guardado como configuracion: sobrevive a un
  // reinicio y lo ven todas las instancias (y queda en el historial).
  router.post("/admin/actions/:target/:op", async (req, res) => {
    const key = TOGGLES[req.params.target];
    if (!key || !["pause", "resume"].includes(req.params.op)) {
      res.status(404).json({ error: "Accion desconocida" });
      return;
    }
    try {
      await settingsStore.save({ set: { [key]: req.params.op === "resume" } }, actorFrom(req));
      res.json({ ok: true, [key]: req.params.op === "resume" });
    } catch (err) {
      log.error("admin: error en accion", { key, error: errorMessage(err) });
      res.status(500).json({ error: "No se pudo aplicar la accion" });
    }
  });

  router.get("/admin/audit", async (req, res) => {
    const q = auditQuery.safeParse(req.query);
    if (!q.success) return zodError(res, q.error);
    try {
      res.json(await listAudit(q.data));
    } catch (err) {
      log.error("admin: error leyendo historial", { error: errorMessage(err) });
      res.status(500).json({ error: "No se pudo leer el historial" });
    }
  });

  return router;
}
