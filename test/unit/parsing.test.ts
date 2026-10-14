import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { edrEnvelopeSchema, validateRecords } from "../../src/parser/smsRecordSchema";
import { extractLink } from "../../src/parser/extractLink";
import { sampleByPercentage } from "../../src/checker/sampleTargets";
import { parseClickList } from "../../src/clicker/parseClickList";
import { formatApiDate, parseApiDate } from "../../src/edr/apiTime";
import { rawRecord } from "../helpers/fixtures";

describe("respuesta JSON-RPC de EDR", () => {
  test("extrae result.data del sobre JSON-RPC", () => {
    const parsed = edrEnvelopeSchema.parse({ jsonrpc: "2.0", id: 1, result: { data: [1, 2] } });
    assert.deepEqual(parsed, [1, 2]);
  });

  test("acepta tambien un array plano", () => {
    assert.deepEqual(edrEnvelopeSchema.parse([{ a: 1 }]), [{ a: 1 }]);
  });

  test("rechaza respuestas sin result.data", () => {
    assert.equal(edrEnvelopeSchema.safeParse({ result: {} }).success, false);
    assert.equal(edrEnvelopeSchema.safeParse({ jsonrpc: "2.0", error: { code: 1 } }).success, false);
    assert.equal(edrEnvelopeSchema.safeParse("hola").success, false);
  });
});

describe("normalizacion de registros EDR", () => {
  test("saca el prefijo t# y convierte fechas GMT-3 a UTC", () => {
    const raw = rawRecord(1, new Date("2026-09-30T15:18:55Z"));
    assert.equal(raw.edr_date, "2026.09.30 12:18:55");
    const { valid, invalid } = validateRecords([raw]);
    assert.equal(invalid.length, 0);
    const record = valid[0];
    assert.equal(record.tech_details_json, '{"dstNpi":"1/1/1"}');
    assert.equal(record.translated_text, null);
    assert.equal(new Date(record.edr_date).toISOString(), "2026-09-30T15:18:55.000Z");
  });

  test("acepta fechas ISO ya normalizadas", () => {
    const raw = { ...rawRecord(2, new Date()), edr_date: "2026-10-01T10:00:00Z", cdr_delivery_time: null };
    const { valid } = validateRecords([raw]);
    assert.equal(valid.length, 1);
  });

  test("separa los invalidos con su indice sin tirar el lote", () => {
    const good = rawRecord(3, new Date());
    const badDate = { ...rawRecord(4, new Date()), edr_date: "30/09/2026" };
    const missingId = { ...rawRecord(5, new Date()), vendor_message_id: undefined };
    const { valid, invalid } = validateRecords([good, badDate, missingId], 100);
    assert.equal(valid.length, 1);
    assert.deepEqual(
      invalid.map((i) => i.index),
      [101, 102]
    );
    assert.match(invalid[0].error, /edr_date/);
  });
});

describe("fechas de la API", () => {
  test("parse y format son inversos y respetan el offset", () => {
    const date = parseApiDate("2026.10.14 09:00:00", -180) as Date;
    assert.equal(date.toISOString(), "2026-10-14T12:00:00.000Z");
    assert.equal(formatApiDate(date, -180), "2026.10.14 09:00:00");
  });

  test("cruza el cambio de dia", () => {
    assert.equal(formatApiDate(new Date("2026-10-15T01:30:00Z"), -180), "2026.10.14 22:30:00");
  });

  test("devuelve null con un formato desconocido", () => {
    assert.equal(parseApiDate("2026-10-14 09:00:00", -180), null);
  });
});

describe("extractLink", () => {
  test("toma la primera URL y le saca la puntuacion final", () => {
    assert.equal(extractLink("Mira https://cutt.ly/abc. Gracias"), "https://cutt.ly/abc");
    assert.equal(extractLink("(http://x.com/a?b=1)"), "http://x.com/a?b=1");
  });

  test("devuelve null si no hay link", () => {
    assert.equal(extractLink("Su codigo es 048277"), null);
  });
});

describe("sampleByPercentage", () => {
  test("devuelve la cantidad exacta redondeada, sin repetir", () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const sample = sampleByPercentage(items, 30);
    assert.equal(sample.length, 300);
    assert.equal(new Set(sample).size, 300);
    assert.equal(sampleByPercentage(items, 0).length, 0);
    assert.equal(sampleByPercentage(items, 100).length, 1000);
  });
});

describe("parseClickList", () => {
  test("parsea url,cantidad e ignora comentarios", () => {
    const result = parseClickList("# hola\nhttps://a.com/x?y=1,2,5\n\nhttps://b.com,3\n");
    assert.deepEqual(result, {
      ok: true,
      items: [
        { url: "https://a.com/x?y=1,2", count: 5 },
        { url: "https://b.com", count: 3 },
      ],
    });
  });

  test("rechaza el archivo entero con los errores por linea", () => {
    const result = parseClickList("https://a.com,5\nftp://b.com,1\nhttps://c.com,abc");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errors.length, 2);
  });
});
