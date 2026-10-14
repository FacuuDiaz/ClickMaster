import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { alignDown, nextScheduledWindow, splitRange } from "../../src/edr/windows";

const plan = { windowMinutes: 30, safetyDelayMinutes: 5, offsetMinutes: -180 };
const iso = (d: Date | undefined) => d?.toISOString();

describe("ventanas EDR", () => {
  test("alignDown alinea a la media hora", () => {
    assert.equal(iso(alignDown(new Date("2026-10-14T12:47:13Z"), 30, -180)), "2026-10-14T12:30:00.000Z");
  });

  test("sin cursor arranca por la ultima ventana cerrada (sin backfill)", () => {
    const w = nextScheduledWindow(null, new Date("2026-10-14T12:47:00Z"), plan);
    // horizonte 12:42 -> ultima ventana cerrada 12:00-12:30
    assert.equal(iso(w?.start), "2026-10-14T12:00:00.000Z");
    assert.equal(iso(w?.end), "2026-10-14T12:30:00.000Z");
  });

  test("con cursor sigue desde el cursor aunque este muy atrasado", () => {
    const w = nextScheduledWindow(new Date("2026-10-13T00:00:00Z"), new Date("2026-10-14T12:47:00Z"), plan);
    assert.equal(iso(w?.start), "2026-10-13T00:00:00.000Z");
    assert.equal(iso(w?.end), "2026-10-13T00:30:00.000Z");
  });

  test("respeta el margen de seguridad: no pide una ventana recien cerrada", () => {
    const cursor = new Date("2026-10-14T12:00:00Z");
    assert.equal(nextScheduledWindow(cursor, new Date("2026-10-14T12:33:00Z"), plan), null);
    assert.notEqual(nextScheduledWindow(cursor, new Date("2026-10-14T12:35:00Z"), plan), null);
  });

  test("EDR_START_DATE se interpreta en la hora de la API", () => {
    const w = nextScheduledWindow(null, new Date("2026-10-14T20:00:00Z"), {
      ...plan,
      startDate: "2026.10.14 09:00:00",
    });
    assert.equal(iso(w?.start), "2026-10-14T12:00:00.000Z");
  });

  test("EDR_START_DATE invalida falla con un mensaje claro", () => {
    assert.throws(
      () => nextScheduledWindow(null, new Date(), { ...plan, startDate: "ayer" }),
      /EDR_START_DATE invalida/
    );
  });

  test("splitRange parte al segundo y las mitades se tocan", () => {
    const [a, b] = splitRange({ start: new Date("2026-10-14T12:00:00Z"), end: new Date("2026-10-14T12:00:03Z") });
    assert.equal(iso(a.end), "2026-10-14T12:00:01.000Z");
    assert.equal(iso(b.start), iso(a.end));
    assert.equal(iso(b.end), "2026-10-14T12:00:03.000Z");
  });
});
