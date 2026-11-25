import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { pool } from "../../src/db/pool";
import { reportsPool } from "../../src/db/reportsPool";
import { config } from "../../src/config";
import { createApp } from "../../src/http/app";
import { settingsStore, SettingsValidationError } from "../../src/settings/store";
import { SETTINGS, currentValue, readPath, type SettingDef } from "../../src/settings/catalog";
import { count, resetTables, rows, setupTestDb } from "../helpers/db";

const actor = { name: "tester", ip: "127.0.0.1" };
let server: Server;
let base: string;

// Lo que traia config de .env antes de los tests, para dejarlo igual.
const original = {
  clickPercentage: config.checker.clickPercentage,
  concurrency: config.worker.concurrency,
  dwellMinMs: config.clicker.dwellMinMs,
  dwellMaxMs: config.clicker.dwellMaxMs,
  maxCount: config.clicker.maxCount,
  workerEnabled: config.worker.enabled,
  country: config.edr.country,
};

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

before(async () => {
  await setupTestDb();
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await resetTables();
  await settingsStore.reload();
});

after(async () => {
  await resetTables();
  await settingsStore.reload();
  server.close();
  await pool.end();
  await reportsPool.end();
});

describe("settings store", () => {
  test("un valor guardado pisa a .env en caliente y volver a .env lo restaura", async () => {
    const changed = await settingsStore.save({ set: { "checker.clickPercentage": 42.5 } }, actor);
    assert.deepEqual(changed, ["checker.clickPercentage"]);
    assert.equal(config.checker.clickPercentage, 42.5);

    const view = settingsStore.list().settings.find((s) => s.key === "checker.clickPercentage");
    assert.equal(view?.source, "base");
    assert.equal(view?.updatedBy, "tester");
    assert.equal(view?.envValue, original.clickPercentage);

    await settingsStore.save({ reset: ["checker.clickPercentage"] }, actor);
    assert.equal(config.checker.clickPercentage, original.clickPercentage);
    assert.equal(await count("SELECT COUNT(*) FROM app_settings"), 0);

    const audit = await rows("SELECT action, ref, actor FROM config_audit ORDER BY id");
    assert.deepEqual(
      audit.map((a) => [a.action, a.ref, a.actor]),
      [
        ["update", "checker.clickPercentage", "tester"],
        ["reset", "checker.clickPercentage", "tester"],
      ]
    );
  });

  test("una clave con varios destinos (concurrencia) actualiza worker y checker", async () => {
    await settingsStore.save({ set: { "worker.concurrency": 2 } }, actor);
    assert.equal(config.worker.concurrency, 2);
    assert.equal(config.checker.concurrency, 2);
    await settingsStore.save({ reset: ["worker.concurrency"] }, actor);
    assert.equal(config.worker.concurrency, original.concurrency);
  });

  test("valida todo el lote: si algo es invalido no se guarda nada", async () => {
    await assert.rejects(
      settingsStore.save(
        {
          set: {
            "checker.clickPercentage": 10,
            "worker.concurrency": 99,
            "no.existe": 1,
            "clicker.dwellMinMs": original.dwellMaxMs + 1,
          },
        },
        actor
      ),
      (err: unknown) => {
        assert.ok(err instanceof SettingsValidationError);
        assert.equal(err.details.length, 2, err.details.join(" | "));
        return true;
      }
    );
    assert.equal(await count("SELECT COUNT(*) FROM app_settings"), 0);
    assert.equal(config.checker.clickPercentage, original.clickPercentage);

    // La regla cruzada (min <= max) se mira sobre el estado final.
    await assert.rejects(
      settingsStore.save({ set: { "clicker.dwellMinMs": original.dwellMaxMs + 1 } }, actor),
      /permanencia minima/
    );
  });

  test("el tamano de ventana solo acepta valores que dividen el dia", async () => {
    const original = config.scheduler.windowMinutes;
    await assert.rejects(settingsStore.save({ set: { "scheduler.windowMinutes": 45 } }, actor), SettingsValidationError);
    await settingsStore.save({ set: { "scheduler.windowMinutes": 15 } }, actor);
    assert.equal(config.scheduler.windowMinutes, 15);
    await settingsStore.save({ reset: ["scheduler.windowMinutes"] }, actor);
    assert.equal(config.scheduler.windowMinutes, original);
  });

  test("cada clave del catalogo se guarda, se aplica, sobrevive a releer y vuelve a .env", async () => {
    // Textos validos y distintos de los de .env (las reglas cruzadas tambien se cumplen).
    const TEXT: Record<string, string> = {
      "edr.url": "http://mock-edr:8081/eapi/",
      "edr.method": "Enterprise.Otro",
      "edr.cursorName": "get_sms_edr_v2",
      "edr.clientProductId": "1300",
      "edr.country": "Chile",
      "alarisRest.url": "https://alaris.invalid/rest",
      "alarisRest.productId": "1300",
      "scheduler.startDate": "2026.11.01 00:00:00",
      "visitHours.days": "lun-mie",
      "visitHours.from": "08:00",
      "visitHours.to": "20:00",
    };
    const candidate = (def: SettingDef): unknown => {
      const now = currentValue(def);
      if (def.key in TEXT) return TEXT[def.key];
      if (def.options) return Object.keys(def.options).map((k) => (def.type === "enum" ? k : Number(k))).find((v) => v !== now);
      if (def.type === "bool") return !now;
      if (def.type === "json") return { probe: 1 };
      if (def.type === "int" || def.type === "number") {
        const n = Number(now);
        const up = def.type === "int" ? n + 1 : n + 0.5;
        return def.max === undefined || up <= def.max ? up : n - 1;
      }
      throw new Error(`sin valor de prueba para ${def.key} (${def.type})`);
    };

    for (const def of SETTINGS) {
      const before = currentValue(def);
      const value = candidate(def);
      assert.notDeepEqual(value, before, `${def.key}: el valor de prueba tiene que ser distinto`);
      await settingsStore.save({ set: { [def.key]: value } }, actor);
      // Se aplica en todos los campos de config que pisa.
      for (const path of def.paths) assert.deepEqual(readPath(path), value, `${def.key} -> ${path}`);
      // Releer de la base (como otra instancia) no lo cambia.
      await settingsStore.reload();
      for (const path of def.paths) assert.deepEqual(readPath(path), value, `${def.key} despues de releer`);
      const view = settingsStore.list().settings.find((x) => x.key === def.key);
      assert.equal(view?.source, "base", def.key);
      assert.deepEqual(view?.value, value, def.key);
      // Volver a .env restaura el valor original.
      await settingsStore.save({ reset: [def.key] }, actor);
      assert.deepEqual(currentValue(def), before, `${def.key} al volver a .env`);
    }
    assert.equal(await count("SELECT COUNT(*) FROM app_settings"), 0);
  });

  test("un texto que parece numero (producto 1300) se guarda y se aplica como texto", async () => {
    const original = config.edr.clientProductId;
    assert.deepEqual(await settingsStore.save({ set: { "edr.clientProductId": "1300" } }, actor), ["edr.clientProductId"]);
    assert.equal(config.edr.clientProductId, "1300");
    // Releer de la base (otra instancia) no lo convierte en numero ni lo descarta.
    await settingsStore.reload();
    assert.equal(config.edr.clientProductId, "1300");
    const view = settingsStore.list().settings.find((x) => x.key === "edr.clientProductId");
    assert.equal(view?.source, "base");
    assert.equal(view?.value, "1300");
    const res = await http("GET", "/admin/audit?entity=setting");
    assert.equal(res.body.items[0].newValue, "1300");
    await settingsStore.save({ reset: ["edr.clientProductId"] }, actor);
    assert.equal(config.edr.clientProductId, original);
  });

  test("los opcionales aceptan null y quedan undefined en config", async () => {
    await settingsStore.save({ set: { "edr.country": null } }, actor);
    assert.equal(config.edr.country, undefined);
    await settingsStore.save({ reset: ["edr.country"] }, actor);
    assert.equal(config.edr.country, original.country);
  });

  test("toma los cambios hechos por otra instancia al releer", async () => {
    await pool.query(
      "INSERT INTO app_settings (setting_key, value, updated_at, updated_by) VALUES (?, ?, NOW(3), 'otra')",
      ["clicker.maxCount", JSON.stringify(7)]
    );
    const seen: string[][] = [];
    settingsStore.onChange((keys) => seen.push(keys));
    assert.deepEqual(await settingsStore.reload(), ["clicker.maxCount"]);
    assert.equal(config.clicker.maxCount, 7);
    assert.deepEqual(seen, [["clicker.maxCount"]]);
    // Sin cambios no avisa de nuevo.
    assert.deepEqual(await settingsStore.reload(), []);
  });
});

describe("rutas /admin", () => {
  test("GET y PUT /admin/settings, con el actor en el historial", async () => {
    const list = await http("GET", "/admin/settings");
    assert.equal(list.status, 200);
    assert.ok(list.body.settings.some((s: any) => s.key === "edr.url"));
    // Las credenciales nunca se exponen: solo si estan configuradas.
    assert.ok(!JSON.stringify(list.body).includes(String(config.edr.auth)));

    const bad = await http("PUT", "/admin/settings", { set: { "worker.claimBatchSize": 0 } });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details[0].startsWith("worker.claimBatchSize"));

    const ok = await http(
      "PUT",
      "/admin/settings",
      { set: { "clicker.maxCount": 5 } },
      { "X-Actor": encodeURIComponent("Ana Lopez") }
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.changed, ["clicker.maxCount"]);

    // El tope de clicks se lee en cada request.
    const tooMany = await http("POST", "/clicks", { url: "https://example.com", count: 6 });
    assert.equal(tooMany.status, 400);

    const audit = await http("GET", "/admin/audit?entity=setting");
    assert.equal(audit.body.items[0].actor, "Ana Lopez");
    assert.equal(audit.body.items[0].newValue, 5);
    assert.equal(audit.body.items[0].oldValue, original.maxCount);
  });

  test("pausar y reanudar el worker queda guardado como configuracion", async () => {
    const paused = await http("POST", "/admin/actions/worker/pause");
    assert.equal(paused.status, 200);
    assert.equal(config.worker.enabled, false);
    const status = await http("GET", "/admin/status");
    assert.equal(status.body.worker.enabled, false);
    assert.ok(status.body.queue);

    await http("POST", "/admin/actions/worker/resume");
    assert.equal(config.worker.enabled, true);
    assert.equal((await http("POST", "/admin/actions/otra/pause")).status, 404);

    await settingsStore.save({ reset: ["worker.enabled"] }, actor);
    assert.equal(config.worker.enabled, original.workerEnabled);
  });

  test("el historial pagina por keyset", async () => {
    for (let i = 1; i <= 5; i++) {
      await settingsStore.save({ set: { "clicker.maxCount": i } }, actor);
    }
    const first = await http("GET", "/admin/audit?limit=2");
    assert.equal(first.body.items.length, 2);
    assert.equal(first.body.items[0].newValue, 5);
    const second = await http("GET", `/admin/audit?limit=2&beforeId=${first.body.nextBeforeId}`);
    assert.deepEqual(second.body.items.map((i: any) => i.newValue), [3, 2]);
  });
});
