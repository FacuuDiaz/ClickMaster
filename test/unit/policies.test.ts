import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { rulesSchema, type Policy } from "../../src/policies/schema";
import { domainOf, factsOf, matchPolicy } from "../../src/policies/match";
import { isAllowedAt, nextAllowedAt, periodStarts, spreadTimes } from "../../src/policies/schedule";
import { assign, HELD } from "../../src/policies/select";
import { STRATEGIES } from "../../src/policies/schema";
import { dayCurve, pickIndices } from "../../src/policies/strategies";
import { parseDays } from "../../src/policies/visitHours";

const OFFSET = -180; // GMT-3

function policy(id: number, rules: unknown, enabled = true): Policy {
  return {
    id,
    name: `p${id}`,
    enabled,
    priority: id,
    rules: rulesSchema.parse(rules),
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: null,
  };
}

const facts = (over: Partial<Record<string, string>> = {}) =>
  factsOf({ client: "ACME", sender_name: "SND", country: "Brazil", network: "Claro", mccmnc: "724005", vendor: "V", text: "Hola https://www.Promo.example.com/x", ...over });

describe("politicas: coincidencia", () => {
  test("factsOf acepta keys con prefijo t# y saca el dominio sin www", () => {
    const f = factsOf({ "t#client": "X", text: "ver https://WWW.Ejemplo.com/a?b=1" });
    assert.equal(f.client, "X");
    assert.equal(f.domain, "ejemplo.com");
    assert.equal(domainOf(null), null);
    assert.equal(factsOf({ text: "sin link" }).link, null);
  });

  test("listas vacias = todo; las listas no distinguen mayusculas", () => {
    assert.ok(matchPolicy([policy(1, {})], facts()));
    assert.ok(matchPolicy([policy(1, { match: { clients: ["acme"] } })], facts()));
    assert.equal(matchPolicy([policy(1, { match: { clients: ["otro"] } })], facts()), null);
  });

  test("dominios: exacto o *.dominio con subdominios", () => {
    const f = facts();
    assert.equal(matchPolicy([policy(1, { match: { domains: ["example.com"] } })], f), null);
    assert.ok(matchPolicy([policy(1, { match: { domains: ["*.example.com"] } })], f));
    assert.ok(matchPolicy([policy(1, { match: { domains: ["promo.example.com"] } })], f));
    assert.ok(matchPolicy([policy(1, { match: { domains: ["*.promo.example.com"] } })], f));
  });

  test("gana la primera activa por orden; las inactivas no cuentan", () => {
    const list = [policy(1, { match: { clients: ["ACME"] } }, false), policy(2, { match: { senders: ["SND"] } }), policy(3, {})];
    assert.equal(matchPolicy(list, facts())?.id, 2);
  });
});

describe("politicas: horario", () => {
  // 2026-11-16 es lunes. 12:00Z = 09:00 en GMT-3.
  const monday9 = new Date("2026-11-16T12:00:00Z");
  const schedule = rulesSchema.parse({ schedule: { days: [1, 2, 3, 4, 5], ranges: [{ from: "10:00", to: "12:00" }, { from: "14:00", to: "18:00" }] } }).schedule;

  test("isAllowedAt mira el dia y la franja en la hora de Alaris", () => {
    assert.equal(isAllowedAt(schedule, monday9, OFFSET), false);
    assert.equal(isAllowedAt(schedule, new Date("2026-11-16T13:30:00Z"), OFFSET), true); // 10:30 local
    assert.equal(isAllowedAt(schedule, new Date("2026-11-16T15:00:00Z"), OFFSET), false); // 12:00 local (fin excluido)
  });

  test("nextAllowedAt devuelve el inicio de la proxima franja, saltando dias no permitidos", () => {
    assert.equal(nextAllowedAt(schedule, monday9, OFFSET).toISOString(), "2026-11-16T13:00:00.000Z");
    assert.equal(nextAllowedAt(schedule, new Date("2026-11-16T16:00:00Z"), OFFSET).toISOString(), "2026-11-16T17:00:00.000Z");
    // Viernes 19:00 local -> lunes 10:00 local.
    assert.equal(nextAllowedAt(schedule, new Date("2026-11-20T22:00:00Z"), OFFSET).toISOString(), "2026-11-23T13:00:00.000Z");
    // Dentro de una franja: el mismo momento.
    const inside = new Date("2026-11-16T18:00:00Z");
    assert.equal(nextAllowedAt(schedule, inside, OFFSET), inside);
  });

  test("spreadTimes reparte parejo dentro de la franja", () => {
    const allDay = rulesSchema.parse({}).schedule;
    const start = new Date("2026-11-16T14:05:00Z");
    const times = spreadTimes(allDay, start, 60 * 60_000, 4, OFFSET).map((d) => d.toISOString());
    assert.deepEqual(times, ["2026-11-16T14:05:00.000Z", "2026-11-16T14:20:00.000Z", "2026-11-16T14:35:00.000Z", "2026-11-16T14:50:00.000Z"]);
    assert.equal(spreadTimes(allDay, start, 3_600_000, 400, OFFSET).length, 400);
    assert.deepEqual(spreadTimes(allDay, start, 3_600_000, 0, OFFSET), []);
  });

  test("spreadTimes salta el tiempo fuera de franja", () => {
    // 11:30 local, franja hasta 12:00: 30 min aca y los otros 30 desde las 14:00.
    const times = spreadTimes(schedule, new Date("2026-11-16T14:30:00Z"), 60 * 60_000, 4, OFFSET).map((d) => d.toISOString());
    assert.deepEqual(times, ["2026-11-16T14:30:00.000Z", "2026-11-16T14:45:00.000Z", "2026-11-16T17:00:00.000Z", "2026-11-16T17:15:00.000Z"]);
    // Fuera de horario: arranca en la proxima franja.
    assert.equal(spreadTimes(schedule, monday9, 60 * 60_000, 2, OFFSET)[0].toISOString(), "2026-11-16T13:00:00.000Z");
  });

  test("spread es opcional y apagado por defecto", () => {
    assert.equal(rulesSchema.parse({}).schedule.spread, false);
    assert.equal(rulesSchema.parse({ schedule: { spread: true } }).schedule.spread, true);
  });

  test("periodStarts alinea a la hora y al dia locales", () => {
    const { hour, day } = periodStarts(new Date("2026-11-16T02:30:00Z"), OFFSET); // 23:30 del domingo local
    assert.equal(hour.toISOString(), "2026-11-16T02:00:00.000Z");
    assert.equal(day.toISOString(), "2026-11-15T03:00:00.000Z");
  });

  test("las franjas no pueden cruzar la medianoche y hace falta al menos un dia", () => {
    assert.equal(rulesSchema.safeParse({ schedule: { ranges: [{ from: "22:00", to: "02:00" }] } }).success, false);
    assert.equal(rulesSchema.safeParse({ schedule: { days: [] } }).success, false);
  });
});

describe("politicas: asignacion en la ingesta", () => {
  const items = (n: number, over: Partial<Record<string, string>> = {}) =>
    Array.from({ length: n }, (_, i) => ({ key: `${over.client ?? "k"}-${i}`, facts: facts(over) }));

  test("sin link -> sin_link; no_visitar -> politica; el resto queda en_seleccion con su politica", () => {
    const policies = [policy(1, { match: { clients: ["NO"] }, selection: { action: "no_visitar" } }), policy(2, { match: { clients: ["SI"] } })];
    const all = [...items(2, { client: "NO" }), ...items(3, { client: "SI" }), ...items(2, { client: "OTRO" }), { key: "x", facts: facts({ text: "sin link" }) }];
    const d = assign(all, policies);
    assert.deepEqual(d.get("NO-0"), { policyId: 1, status: "skipped", skipReason: "politica" });
    assert.deepEqual(d.get("SI-2"), { policyId: 2, status: "skipped", skipReason: HELD });
    assert.deepEqual(d.get("OTRO-0"), { policyId: null, status: "skipped", skipReason: HELD });
    assert.equal(d.get("x")?.skipReason, "sin_link");
  });
});

describe("politicas: esquema de seleccion", () => {
  test("defaults: 20% de cada ventana, intercalado", () => {
    const sel = rulesSchema.parse({}).selection;
    assert.deepEqual(sel, { action: "visitar", percentage: 20, base: "ventana", weeks: 1, strategy: "intercalado", weekStart: null });
  });

  test("convierte el formato anterior (percentage: { mode, ... })", () => {
    assert.deepEqual(rulesSchema.parse({ selection: { percentage: { mode: "fijo", value: 35 } } }).selection, {
      action: "visitar", percentage: 35, base: "ventana", weeks: 1, strategy: "aleatorio", weekStart: null,
    });
    const hist = rulesSchema.parse({ selection: { percentage: { mode: "historico", value: 250, reference: "semana_anterior", fallback: 5 } } }).selection;
    assert.equal(hist.base, "semana_anterior");
    assert.equal(hist.percentage, 100);
  });

  test("rechaza porcentajes fuera de 0-100 y bases/estrategias desconocidas", () => {
    assert.equal(rulesSchema.safeParse({ selection: { percentage: 150 } }).success, false);
    assert.equal(rulesSchema.safeParse({ selection: { base: "mes" } }).success, false);
    assert.equal(rulesSchema.safeParse({ selection: { strategy: "magia" } }).success, false);
  });
});

describe("politicas: estrategias", () => {
  const draw = (idx: number[], n: number) => Array.from({ length: n }, (_, i) => (idx.includes(i) ? "#" : ".")).join("");

  test("ejemplo de 40 SMS al 20%: cada estrategia elige 8 distintos en orden", () => {
    for (const st of STRATEGIES) {
      const idx = pickIndices(40, 8, st);
      assert.equal(idx.length, 8, st);
      assert.equal(new Set(idx).size, 8, st);
      assert.deepEqual([...idx].sort((a, b) => a - b), idx, st);
      assert.ok(idx.every((i) => i >= 0 && i < 40), st);
    }
    assert.equal(draw(pickIndices(40, 8, "primeros"), 40), "########................................");
    assert.equal(draw(pickIndices(40, 8, "ultimos"), 40), "................................########");
    assert.equal(draw(pickIndices(40, 8, "intercalado"), 40), "..#....#....#....#....#....#....#....#..");
    assert.equal(draw(pickIndices(40, 8, "progresivo"), 40), "..........#......#....#...#...#..#..#.#.");
    assert.equal(draw(pickIndices(40, 8, "fibonacci"), 40), "##.#...#....#........#..............#.#.");
  });

  test("progresivo concentra al final y regresivo al principio", () => {
    const half = (idx: number[]) => idx.filter((i) => i >= 500).length;
    assert.ok(half(pickIndices(1000, 200, "progresivo")) > 130);
    assert.ok(half(pickIndices(1000, 200, "regresivo")) < 70);
  });

  test("bordes: 0, todos, mas que n y porcentajes altos sin repetir", () => {
    assert.deepEqual(pickIndices(10, 0, "intercalado"), []);
    assert.deepEqual(pickIndices(3, 5, "fibonacci"), [0, 1, 2]);
    for (const st of STRATEGIES) {
      const idx = pickIndices(10, 9, st, () => 0.5);
      assert.equal(new Set(idx).size, 9, st);
      assert.ok(idx.every((i) => i < 10), st);
    }
  });

  test("aleatorio usa el generador recibido", () => {
    let x = 0;
    const seq = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
    const a = pickIndices(100, 20, "aleatorio", seq);
    x = 0;
    assert.deepEqual(pickIndices(100, 20, "aleatorio", seq), a);
  });

  test("reparto diario: intercalado lineal, progresivo cuadratico, fibonacci por ventana", () => {
    assert.equal(dayCurve("intercalado", 0.5, 23, 48), 0.5);
    assert.equal(dayCurve("progresivo", 0.5, 23, 48), 0.25);
    assert.equal(dayCurve("regresivo", 0.5, 23, 48), 0.75);
    assert.equal(dayCurve("fibonacci", 1, 47, 48), 1);
    assert.ok(dayCurve("fibonacci", 0.1, 0, 48) < dayCurve("fibonacci", 0.2, 5, 48));
  });
});

describe("horario global de visitas", () => {
  test("parseDays entiende rangos, listas, vuelta de semana y 'todos'", () => {
    assert.deepEqual(parseDays("lun-vie"), [1, 2, 3, 4, 5]);
    assert.deepEqual(parseDays("Lun, Mié ,vie"), [1, 3, 5]);
    assert.deepEqual(parseDays("vie-lun"), [0, 1, 5, 6]);
    assert.deepEqual(parseDays("todos"), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(parseDays("lunes-x"), null);
    assert.equal(parseDays(""), null);
  });
});

describe("sms_usage_stats", () => {
  test("parseUsage suma count_ok por hora del dia y rechaza respuestas que no son lista", async () => {
    const { parseUsage } = await import("../../src/alaris/usageStats");
    const dayStart = new Date("2026-11-15T03:00:00Z"); // 00:00 GMT-3
    const usage = parseUsage(
      JSON.stringify([
        { dcheck: "2026.11.15 00:00:00", count_ok: "3", is_total: 0 },
        { dcheck: "2026.11.15 23:00:00", count_ok: 4, is_total: 0 },
        { dcheck: "2026.11.16 00:00:00", count_ok: 100, is_total: 0 },
        { country: "Total", count_ok: 107, is_total: 1 },
      ]),
      dayStart
    );
    assert.equal(usage.hourly[0], 3);
    assert.equal(usage.hourly[23], 4);
    assert.equal(usage.total, 7);
    assert.throws(() => parseUsage(JSON.stringify({ error: "x" }), dayStart), /se esperaba una lista/);
  });
});
