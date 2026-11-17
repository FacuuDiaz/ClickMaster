import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { pool, withTransaction, type DbConnection } from "../db/pool";
import { insertAudit, parseJsonColumn, type Actor } from "../db/auditRepo";
import { errorMessage, log } from "../logger";
import { config } from "../config";
import { periodStarts } from "./schedule";
import { policyInputSchema, rulesSchema, type Policy, type PolicyInput } from "./schema";

function mapPolicy(r: RowDataPacket): Policy | null {
  const rules = rulesSchema.safeParse(parseJsonColumn(r.rules));
  if (!rules.success) {
    // No deberia pasar (se valida al guardar); si pasa, la politica no se aplica.
    log.error("politicas: reglas invalidas en la base, se ignora", { policyId: Number(r.id) });
    return null;
  }
  return {
    id: Number(r.id),
    name: r.name,
    enabled: Boolean(r.enabled),
    priority: Number(r.priority),
    rules: rules.data,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export async function listPolicies(conn: DbConnection | typeof pool = pool): Promise<Policy[]> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id, name, enabled, priority, rules, created_at, updated_at, updated_by FROM policies ORDER BY priority, id"
  );
  return rows.map(mapPolicy).filter((p): p is Policy => p !== null);
}

export class PolicyNotFoundError extends Error {}

async function lockedPolicy(conn: DbConnection, id: number): Promise<Policy> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id, name, enabled, priority, rules, created_at, updated_at, updated_by FROM policies WHERE id = ? FOR UPDATE",
    [id]
  );
  const policy = rows.length ? mapPolicy(rows[0]) : null;
  if (!policy) throw new PolicyNotFoundError(`No existe la politica ${id}`);
  return policy;
}

const snapshot = (p: { name: string; enabled: boolean; rules: unknown; priority?: number }) => ({
  name: p.name,
  enabled: p.enabled,
  rules: p.rules,
});

// ---------- Una sola activa y cambios en tiempo de ejecucion ----------

/**
 * Que hacer si, al retomar el contenido del dia, la politica nueva vuelve a
 * elegir un SMS que ya se clickeo: "igual" = el click hecho cuenta (no se
 * visita de nuevo); "doble" = se visita otra vez (sms_processing.clicks = 2).
 */
export const REPEAT_MODES = ["igual", "doble"] as const;
export type RepeatMode = (typeof REPEAT_MODES)[number];

const sameRules = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function activeLocked(conn: DbConnection): Promise<Policy | null> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id, name, enabled, priority, rules, created_at, updated_at, updated_by FROM policies WHERE enabled = 1 ORDER BY priority, id FOR UPDATE"
  );
  return rows.length ? mapPolicy(rows[0]) : null;
}

/** Apaga todas menos `keepId` (auditado). */
async function deactivateOthers(conn: DbConnection, keepId: number | null, actor: Actor, now: Date): Promise<void> {
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id, name FROM policies WHERE enabled = 1 AND id <> ? FOR UPDATE",
    [keepId ?? 0]
  );
  if (rows.length === 0) return;
  await conn.query("UPDATE policies SET enabled = 0, updated_at = ?, updated_by = ? WHERE id IN (?)", [now, actor.name, rows.map((r) => r.id)]);
  await insertAudit(
    rows.map((r) => ({ entity: "policy" as const, action: "deactivate", ref: `${r.id}: ${r.name}`, oldValue: { enabled: true }, newValue: { enabled: false } })),
    actor,
    now,
    conn
  );
}

/**
 * Registra un cambio de la politica activa: se aplica (retake.ts) sobre el
 * contenido del dia en curso, desde las 00:00 en hora de Alaris. Un cambio
 * pendiente anterior queda reemplazado: solo importa el ultimo.
 */
async function recordChange(
  conn: DbConnection,
  from: { id: number; name: string } | null,
  to: { id: number; name: string } | null,
  repeat: RepeatMode,
  actor: Actor,
  now: Date
): Promise<number> {
  await conn.query("UPDATE policy_changes SET status = 'reemplazado' WHERE status = 'pendiente'");
  const [result] = await conn.query<ResultSetHeader>(
    `INSERT INTO policy_changes
       (created_at, actor, from_policy_id, to_policy_id, from_name, to_name, repeat_mode, period_start, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')`,
    [now, actor.name, from?.id ?? null, to?.id ?? null, from?.name ?? null, to?.name ?? null, repeat,
      periodStarts(now, config.edr.timezoneOffsetMinutes).day]
  );
  await insertAudit(
    [{ entity: "policy", action: "change", ref: `${from?.name ?? "por defecto"} -> ${to?.name ?? "por defecto"}`, newValue: { repeat } }],
    actor,
    now,
    conn
  );
  return result.insertId;
}

export interface SaveResult {
  id: number;
  // Cambio registrado (hay que aplicarlo) o null si no cambio nada en ejecucion.
  changeId: number | null;
}

/** Las nuevas van al final. Si se crea activa, apaga a la que estaba. */
export async function createPolicy(input: PolicyInput, actor: Actor, now = new Date(), repeat: RepeatMode = "igual"): Promise<SaveResult> {
  const out = await withTransaction(async (conn) => {
    const previous = input.enabled ? await activeLocked(conn) : null;
    const [max] = await conn.query<RowDataPacket[]>("SELECT COALESCE(MAX(priority), 0) AS p FROM policies FOR UPDATE");
    const [result] = await conn.query<ResultSetHeader>(
      `INSERT INTO policies (name, enabled, priority, rules, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.name, input.enabled, Number(max[0].p) + 1, JSON.stringify(input.rules), now, now, actor.name]
    );
    const id = result.insertId;
    await insertAudit(
      [{ entity: "policy", action: "create", ref: `${id}: ${input.name}`, newValue: snapshot(input) }],
      actor,
      now,
      conn
    );
    let changeId: number | null = null;
    if (input.enabled) {
      await deactivateOthers(conn, id, actor, now);
      changeId = await recordChange(conn, previous, { id, name: input.name }, repeat, actor, now);
    }
    return { id, changeId };
  });
  await policiesCache.refresh();
  return out;
}

/**
 * Editar. Es un cambio en ejecucion si se activa, se desactiva o se cambian
 * las reglas de la activa.
 */
export async function updatePolicy(id: number, input: PolicyInput, actor: Actor, now = new Date(), repeat: RepeatMode = "igual"): Promise<SaveResult> {
  const out = await withTransaction(async (conn) => {
    const previous = await activeLocked(conn);
    const old = await lockedPolicy(conn, id);
    await conn.query(
      "UPDATE policies SET name = ?, enabled = ?, rules = ?, updated_at = ?, updated_by = ? WHERE id = ?",
      [input.name, input.enabled, JSON.stringify(input.rules), now, actor.name, id]
    );
    await insertAudit(
      [{ entity: "policy", action: "update", ref: `${id}: ${input.name}`, oldValue: snapshot(old), newValue: snapshot(input) }],
      actor,
      now,
      conn
    );
    let changeId: number | null = null;
    if (input.enabled) {
      await deactivateOthers(conn, id, actor, now);
      if (!old.enabled || !sameRules(old.rules, input.rules)) {
        changeId = await recordChange(conn, previous, { id, name: input.name }, repeat, actor, now);
      }
    } else if (old.enabled) {
      changeId = await recordChange(conn, old, null, repeat, actor, now);
    }
    return { id, changeId };
  });
  await policiesCache.refresh();
  return out;
}

/** Deja activa solo `id` (o ninguna: regla por defecto). */
export async function setActivePolicy(id: number | null, actor: Actor, now = new Date(), repeat: RepeatMode = "igual"): Promise<SaveResult> {
  const out = await withTransaction(async (conn) => {
    const previous = await activeLocked(conn);
    const target = id === null ? null : await lockedPolicy(conn, id);
    if ((previous?.id ?? null) === (target?.id ?? null)) return { id: id ?? 0, changeId: null };
    await deactivateOthers(conn, target?.id ?? null, actor, now);
    if (target) {
      await conn.query("UPDATE policies SET enabled = 1, updated_at = ?, updated_by = ? WHERE id = ?", [now, actor.name, target.id]);
      await insertAudit(
        [{ entity: "policy", action: "activate", ref: `${target.id}: ${target.name}`, oldValue: { enabled: false }, newValue: { enabled: true } }],
        actor,
        now,
        conn
      );
    }
    const changeId = await recordChange(conn, previous, target, repeat, actor, now);
    return { id: id ?? 0, changeId };
  });
  await policiesCache.refresh();
  return out;
}

/**
 * Los SMS que ya tenian esta politica conservan el policy_id (historial):
 * el dashboard los muestra como "politica borrada". Borrar la activa es un
 * cambio en ejecucion (pasa a la regla por defecto).
 */
export async function deletePolicy(id: number, actor: Actor, now = new Date(), repeat: RepeatMode = "igual"): Promise<SaveResult> {
  const out = await withTransaction(async (conn) => {
    const old = await lockedPolicy(conn, id);
    await conn.query("DELETE FROM policies WHERE id = ?", [id]);
    await insertAudit([{ entity: "policy", action: "delete", ref: `${id}: ${old.name}`, oldValue: snapshot(old) }], actor, now, conn);
    const changeId = old.enabled ? await recordChange(conn, old, null, repeat, actor, now) : null;
    return { id, changeId };
  });
  await policiesCache.refresh();
  return out;
}

/**
 * Datos de versiones anteriores pueden tener varias activas: queda solo la
 * primera por prioridad (sin retomar nada: es como estaba decidiendo).
 */
export async function ensureSingleActive(now = new Date()): Promise<number> {
  const turnedOff = await withTransaction(async (conn) => {
    const first = await activeLocked(conn);
    if (!first) return 0;
    const [rows] = await conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM policies WHERE enabled = 1 AND id <> ?", [first.id]);
    const n = Number(rows[0].n);
    if (n > 0) await deactivateOthers(conn, first.id, { name: "sistema", ip: null }, now);
    return n;
  });
  if (turnedOff > 0) log.warn("politicas: habia mas de una activa, quedo solo la primera", { turnedOff });
  return turnedOff;
}

export interface PolicyChange {
  id: number;
  createdAt: Date;
  actor: string | null;
  fromPolicyId: number | null;
  toPolicyId: number | null;
  fromName: string | null;
  toName: string | null;
  repeatMode: RepeatMode;
  periodStart: Date;
  status: "pendiente" | "aplicando" | "aplicado" | "reemplazado" | "error";
  appliedAt: Date | null;
  result: unknown;
  error: string | null;
}

export async function listChanges(limit = 10): Promise<PolicyChange[]> {
  const [rows] = await pool.query<RowDataPacket[]>("SELECT * FROM policy_changes ORDER BY id DESC LIMIT ?", [limit]);
  return rows.map((r) => ({
    id: Number(r.id),
    createdAt: r.created_at,
    actor: r.actor,
    fromPolicyId: r.from_policy_id === null ? null : Number(r.from_policy_id),
    toPolicyId: r.to_policy_id === null ? null : Number(r.to_policy_id),
    fromName: r.from_name,
    toName: r.to_name,
    repeatMode: r.repeat_mode,
    periodStart: r.period_start,
    status: r.status,
    appliedAt: r.applied_at,
    result: parseJsonColumn(r.result),
    error: r.error,
  }));
}

/** Modo de repetidos del ultimo cambio aplicado a la politica que cubre `at`. */
export async function repeatModeFor(policyId: number | null, at: Date): Promise<RepeatMode> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT repeat_mode FROM policy_changes
      WHERE to_policy_id <=> ? AND period_start <= ? AND status IN ('aplicando', 'aplicado')
      ORDER BY id DESC LIMIT 1`,
    [policyId, at]
  );
  return rows.length ? rows[0].repeat_mode : "igual";
}

/** `ids` en el orden nuevo (primero = mayor prioridad). Tienen que estar todas. */
export async function reorderPolicies(ids: number[], actor: Actor, now = new Date()): Promise<void> {
  await withTransaction(async (conn) => {
    const current = await listPolicies(conn);
    const known = new Set(current.map((p) => p.id));
    if (ids.length !== known.size || !ids.every((id) => known.has(id)) || new Set(ids).size !== ids.length) {
      throw new PolicyNotFoundError("El orden tiene que incluir todas las politicas una sola vez");
    }
    for (const [i, id] of ids.entries()) {
      await conn.query("UPDATE policies SET priority = ? WHERE id = ?", [i + 1, id]);
    }
    await insertAudit(
      [{ entity: "policy", action: "reorder", oldValue: current.map((p) => p.id), newValue: ids }],
      actor,
      now,
      conn
    );
  });
  await policiesCache.refresh();
}

// ---------- Politicas de fabrica ----------

/**
 * Las 3 que trae la lista la primera vez. Las tres toman todos los SMS, asi
 * que solo manda la primera activa: la 2 y la 3 arrancan apagadas como
 * alternativas listas para usar.
 */
export const DEFAULT_POLICIES: PolicyInput[] = [
  {
    name: "20% de cada ventana",
    enabled: true,
    rules: { selection: { percentage: 20, base: "ventana", strategy: "intercalado" } },
  },
  {
    name: "20% del dia vencido",
    enabled: false,
    rules: { selection: { percentage: 20, base: "dia_vencido", strategy: "intercalado" } },
  },
  {
    name: "20% del mismo dia de la semana anterior",
    enabled: false,
    rules: { selection: { percentage: 20, base: "semana_anterior", weeks: 1, strategy: "intercalado" } },
  },
].map((p) => policyInputSchema.parse(p));

/**
 * Carga las politicas de fabrica si nunca se crearon politicas: tabla vacia
 * y sin historial de politicas (si alguien las borro todas a proposito, no
 * vuelven). Devuelve cuantas creo.
 */
export async function seedDefaultPolicies(now = new Date()): Promise<number> {
  const created = await withTransaction(async (conn) => {
    const [[policies], [audit]] = await Promise.all([
      conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM policies FOR UPDATE"),
      conn.query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM config_audit WHERE entity = 'policy'"),
    ]);
    if (Number(policies[0].n) > 0 || Number(audit[0].n) > 0) return 0;
    const actor: Actor = { name: "sistema", ip: null };
    for (const [i, input] of DEFAULT_POLICIES.entries()) {
      const [result] = await conn.query<ResultSetHeader>(
        `INSERT INTO policies (name, enabled, priority, rules, created_at, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [input.name, input.enabled, i + 1, JSON.stringify(input.rules), now, now, actor.name]
      );
      await insertAudit(
        [{ entity: "policy", action: "create", ref: `${result.insertId}: ${input.name}`, newValue: snapshot(input) }],
        actor,
        now,
        conn
      );
    }
    return DEFAULT_POLICIES.length;
  });
  if (created > 0) log.info("politicas: se cargaron las politicas de fabrica", { created });
  return created;
}

// ---------- Conteos para historico y topes ----------

/** SMS con link asignados a la politica, por edr_date (incluye los no muestreados). */
export async function countPolicySms(
  policyId: number,
  start: Date,
  end: Date,
  db: { query: typeof pool.query } = pool
): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM sms_processing FORCE INDEX (idx_policy_edr)
      WHERE policy_id = ? AND edr_date >= ? AND edr_date < ?`,
    [policyId, start, end]
  );
  return Number(rows[0].n);
}

/**
 * Elegidos para visitar por la politica desde `since` (por momento de
 * seleccion, no de ingesta). Para los topes por hora y por dia.
 */
export async function countApprovedSince(conn: DbConnection, policyId: number, since: Date): Promise<number> {
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM sms_processing FORCE INDEX (idx_policy_selected)
      WHERE policy_id = ? AND selected_at >= ? AND status <> 'skipped'`,
    [policyId, since]
  );
  return Number(rows[0].n);
}

// ---------- Cache en memoria ----------

const RELOAD_EVERY_MS = 30_000;

/**
 * Politicas en memoria para la ingesta y el worker. Se recargan al
 * guardar, al empezar cada ventana de ingesta y cada 30 s (otras instancias).
 */
class PoliciesCache {
  private all: Policy[] = [];
  private byIdMap = new Map<number, Policy>();
  private timer: NodeJS.Timeout | null = null;

  async refresh(): Promise<Policy[]> {
    this.all = await listPolicies();
    this.byIdMap = new Map(this.all.map((p) => [p.id, p]));
    return this.all;
  }

  /** Activas, por prioridad. */
  active(): Policy[] {
    return this.all.filter((p) => p.enabled);
  }

  list(): Policy[] {
    return this.all;
  }

  byId(id: number | null): Policy | null {
    return id === null ? null : this.byIdMap.get(id) ?? null;
  }

  startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.refresh().catch((err) => log.error("politicas: no se pudieron releer", { error: errorMessage(err) }));
    }, RELOAD_EVERY_MS);
    this.timer.unref();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const policiesCache = new PoliciesCache();
