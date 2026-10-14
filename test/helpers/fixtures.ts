import { formatApiDate } from "../../src/edr/apiTime";

const OFFSET = -180;

/**
 * Registro crudo como lo manda la API real: keys con "t#", fechas
 * "YYYY.MM.DD HH:mm:ss" en GMT-3. `seq` define la identidad.
 */
export function rawRecord(seq: number, edrDate: Date, overrides: Record<string, unknown> = {}) {
  return {
    cdr_delivery_time: formatApiDate(new Date(edrDate.getTime() + 5000), OFFSET),
    client: "TEST CLIENT",
    client_acc_id: 282,
    client_message_id: `c-${seq}`,
    client_rate: 0.008,
    country: "Brazil",
    dnis: `55679${String(seq).padStart(8, "0")}`,
    dst_is_successful: 1,
    dst_part_amount: 1,
    edr_date: formatApiDate(edrDate, OFFSET),
    edr_type: 1,
    mccmnc: "724005",
    network: "[BR] Claro",
    sender_name: "4650655",
    src_is_successful: 1,
    src_part_amount: 1,
    status: "DELIVRD",
    "t#tech_details_json": '{"dstNpi":"1/1/1"}',
    "t#translated_text": null,
    text: `Oferta ${seq}: https://cutt.ly/t${seq}`,
    vendor: "VENDOR",
    vendor_acc_id: 7,
    vendor_message_id: `v-${seq}`,
    vendor_rate: 0.004,
    ...overrides,
  };
}

/**
 * Fuente sintetica de EDR: `perMinute` SMS por minuto, deterministicos por
 * tiempo (rangos solapados devuelven los mismos registros). 1 de cada
 * `noLinkEvery` no tiene link.
 */
export function syntheticSource(perMinute: number, noLinkEvery = 10) {
  const stepMs = 60_000 / perMinute;
  return (range: { start: Date; end: Date }): unknown[] => {
    const out: unknown[] = [];
    // Las fechas de la API no tienen milisegundos: cada slot se redondea al segundo.
    for (let ms = Math.ceil(range.start.getTime() / stepMs) * stepMs; ms <= range.end.getTime(); ms += stepMs) {
      const seq = Math.round(ms / stepMs);
      const date = new Date(Math.floor(ms / 1000) * 1000);
      if (date < range.start) continue;
      out.push(rawRecord(seq, date, seq % noLinkEvery === 0 ? { text: `Su codigo es ${seq}` } : {}));
    }
    return out;
  };
}
