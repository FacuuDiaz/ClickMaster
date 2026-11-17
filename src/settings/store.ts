import { isDeepStrictEqual } from "util";
import type { RowDataPacket } from "mysql2";
import { config } from "../config";
import { pool, withTransaction } from "../db/pool";
import { insertAudit, parseJsonColumn, type Actor, type AuditEntry } from "../db/auditRepo";
import { errorMessage, log } from "../logger";
import {
  GROUP_LABELS,
  SETTINGS,
  SETTINGS_BY_KEY,
  crossValidate,
  currentValue,
  writePath,
  type SettingDef,
} from "./catalog";

export class SettingsValidationError extends Error {
  constructor(readonly details: string[]) {
    super(`Configuracion invalida: ${details.join("; ")}`);
    this.name = "SettingsValidationError";
  }
}

interface Override {
  value: unknown;
  updatedAt: Date;
  updatedBy: string | null;
}

export type SettingSource = "base" | "env" | "default";

export interface SettingView {
  key: string;
  group: string;
  groupLabel: string;
  label: string;
  description: string;
  env: string;
  type: SettingDef["type"];
  unit: string | null;
  min: number | null;
  max: number | null;
  nullable: boolean;
  options: Record<string, string> | null;
  value: unknown;
  envValue: unknown;
  source: SettingSource;
  updatedAt: Date | null;
  updatedBy: string | null;
}

export interface SettingsChange {
  set?: Record<string, unknown>;
  reset?: string[];
}

const RELOAD_EVERY_MS = 30_000;

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

/**
 * Configuracion editable en caliente. Precedencia: base > .env > default.
 *
 * Los valores se escriben sobre `config` (el mismo objeto que lee todo el
 * codigo), asi nada tiene que cambiar para leer la config "nueva". Solo se
 * tocan las claves que tienen o tuvieron un valor en la base: una clave
 * nunca pisada queda como la dejo .env (y los tests pueden seguir mutando
 * config a mano).
 *
 * Con varias instancias, cada una relee la tabla cada 30 s: un cambio
 * hecho en otra tarda a lo sumo eso en aplicarse aca.
 */
export class SettingsStore {
  // Lo que traia config al arrancar (de .env o default): "volver a .env".
  private readonly envValues = new Map<string, unknown>(SETTINGS.map((d) => [d.key, clone(currentValue(d))]));
  private overrides = new Map<string, Override>();
  private listeners: ((changedKeys: string[]) => void)[] = [];
  private timer: NodeJS.Timeout | null = null;

  /** Se llama con las claves cuyo valor efectivo cambio. */
  onChange(listener: (changedKeys: string[]) => void): void {
    this.listeners.push(listener);
  }

  /** Lee app_settings y aplica. Devuelve las claves que cambiaron. */
  async reload(): Promise<string[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
      "SELECT setting_key, value, updated_at, updated_by FROM app_settings"
    );
    const next = new Map<string, Override>();
    for (const row of rows) {
      const def = SETTINGS_BY_KEY.get(row.setting_key);
      // Claves viejas (sacadas del catalogo) se ignoran: no hay donde aplicarlas.
      if (!def) continue;
      const parsed = def.schema.safeParse(parseJsonColumn(row.value));
      if (!parsed.success) {
        log.warn("settings: valor invalido en la base, se ignora", { key: def.key });
        continue;
      }
      next.set(def.key, { value: parsed.data, updatedAt: row.updated_at, updatedBy: row.updated_by });
    }
    return this.apply(next);
  }

  private apply(next: Map<string, Override>): string[] {
    const changed: string[] = [];
    for (const def of SETTINGS) {
      let target: unknown;
      if (next.has(def.key)) target = next.get(def.key)?.value;
      else if (this.overrides.has(def.key)) target = this.envValues.get(def.key);
      else continue;
      if (isDeepStrictEqual(currentValue(def), target ?? null)) continue;
      // Los opcionales de config son undefined, no null.
      for (const path of def.paths) writePath(path, target === null ? undefined : clone(target));
      changed.push(def.key);
    }
    this.overrides = next;

    if (changed.length > 0) {
      log.info("settings: configuracion aplicada", { changed });
      for (const listener of this.listeners) {
        try {
          listener(changed);
        } catch (err) {
          log.error("settings: error en un listener", { error: errorMessage(err) });
        }
      }
    }
    return changed;
  }

  list(): { settings: SettingView[]; groups: Record<string, string> } {
    const settings = SETTINGS.map((def): SettingView => {
      const override = this.overrides.get(def.key);
      return {
        key: def.key,
        group: def.group,
        groupLabel: GROUP_LABELS[def.group],
        label: def.label,
        description: def.description,
        env: def.env,
        type: def.type,
        unit: def.unit ?? null,
        min: def.min ?? null,
        max: def.max ?? null,
        nullable: def.nullable ?? false,
        options: def.options ?? null,
        value: currentValue(def),
        envValue: this.envValues.get(def.key) ?? null,
        source: override ? "base" : process.env[def.env] ? "env" : "default",
        updatedAt: override?.updatedAt ?? null,
        updatedBy: override?.updatedBy ?? null,
      };
    });
    return { settings, groups: GROUP_LABELS };
  }

  /**
   * Valida y guarda un lote de cambios: todo o nada. `set` pisa con un
   * valor; `reset` vuelve al valor de .env. Cada cambio queda en el historial.
   */
  async save(change: SettingsChange, actor: Actor, now = new Date()): Promise<string[]> {
    const set = change.set ?? {};
    const reset = change.reset ?? [];
    const errors: string[] = [];
    const parsed = new Map<string, unknown>();

    for (const [key, raw] of Object.entries(set)) {
      const def = SETTINGS_BY_KEY.get(key);
      if (!def) {
        errors.push(`${key}: no es una configuracion editable`);
        continue;
      }
      const result = def.schema.safeParse(raw);
      if (!result.success) {
        errors.push(`${key}: ${result.error.issues.map((i) => i.message).join(", ")}`);
        continue;
      }
      parsed.set(key, result.data);
    }
    for (const key of reset) {
      if (!SETTINGS_BY_KEY.has(key)) errors.push(`${key}: no es una configuracion editable`);
      if (key in set) errors.push(`${key}: no se puede pisar y resetear a la vez`);
    }
    if (errors.length === 0) {
      const after = (key: string): unknown => {
        if (parsed.has(key)) return parsed.get(key);
        if (reset.includes(key)) return this.envValues.get(key);
        return currentValue(SETTINGS_BY_KEY.get(key) as SettingDef);
      };
      errors.push(...crossValidate(after, Boolean(config.edr.auth)));
    }
    if (errors.length > 0) throw new SettingsValidationError(errors);

    const audit: AuditEntry[] = [];
    await withTransaction(async (conn) => {
      for (const [key, value] of parsed) {
        const override = this.overrides.get(key);
        if (override && isDeepStrictEqual(override.value, value)) continue;
        await conn.query(
          `INSERT INTO app_settings (setting_key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`,
          [key, JSON.stringify(value), now, actor.name]
        );
        audit.push({
          entity: "setting",
          action: "update",
          ref: key,
          oldValue: currentValue(SETTINGS_BY_KEY.get(key) as SettingDef),
          newValue: value,
        });
      }
      for (const key of reset) {
        if (!this.overrides.has(key)) continue;
        await conn.query("DELETE FROM app_settings WHERE setting_key = ?", [key]);
        audit.push({
          entity: "setting",
          action: "reset",
          ref: key,
          oldValue: currentValue(SETTINGS_BY_KEY.get(key) as SettingDef),
          newValue: this.envValues.get(key) ?? null,
        });
      }
      await insertAudit(audit, actor, now, conn);
    });

    if (audit.length > 0) {
      log.info("settings: cambios guardados", { actor: actor.name, keys: audit.map((a) => a.ref) });
    }
    return this.reload();
  }

  startPolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.reload().catch((err) => log.error("settings: no se pudo releer", { error: errorMessage(err) }));
    }, RELOAD_EVERY_MS);
    this.timer.unref();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const settingsStore = new SettingsStore();
