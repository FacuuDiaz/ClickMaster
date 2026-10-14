import { z } from "zod";
import { config } from "../config";
import { formatOffset } from "../edr/apiTime";

/**
 * La API real manda fechas como "2026.09.30 12:18:55", sin zona, en hora
 * local (EDR_TIMEZONE_OFFSET, default GMT-3). Se normalizan a ISO 8601 con
 * offset ("2026-09-30T12:18:55-03:00") y despues se guardan en UTC como el
 * resto (ver timezone en db/pool.ts). Si ya vienen en ISO se dejan como estan.
 */
const API_DATE_REGEX = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}:\d{2}:\d{2})$/;

function normalizeDate(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const match = value.match(API_DATE_REGEX);
  if (!match) return value;
  const [, year, month, day, time] = match;
  return `${year}-${month}-${day}T${time}${formatOffset(config.edr.timezoneOffsetMinutes)}`;
}

const apiDate = z.preprocess(normalizeDate, z.string().datetime({ offset: true }));

/**
 * La API real prefija algunas keys con "t#" (ej. "t#tech_details_json",
 * "t#translated_text"). Se saca el prefijo para que matcheen con las
 * columnas de sms_content.
 */
function stripKeyPrefixes(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, v]) => [key.replace(/^t#/, ""), v])
  );
}

/**
 * Espejo de la estructura de sms_content. Ajustar los nombres de campo
 * si el JSON que devuelve la API usa otras keys (ej. camelCase) -- este
 * es el unico lugar que habria que tocar en ese caso.
 */
export const smsRecordSchema = z.preprocess(
  stripKeyPrefixes,
  z.object({
    cdr_delivery_time: apiDate.nullish(),
    client: z.string().max(64),
    client_acc_id: z.number().int(),
    client_message_id: z.string().min(1).max(64),
    client_rate: z.number(),
    country: z.string().max(32),
    dnis: z.string().max(32),
    dst_is_successful: z.number().int(),
    dst_part_amount: z.number().int(),
    edr_date: apiDate,
    edr_type: z.number().int(),
    mccmnc: z.string().max(16),
    network: z.string().max(32),
    sender_name: z.string().max(32),
    src_is_successful: z.number().int(),
    src_part_amount: z.number().int(),
    status: z.string().max(64),
    tech_details_json: z.string().nullish(),
    translated_text: z.string().nullish(),
    text: z.string(),
    vendor: z.string().max(64).nullish(),
    vendor_acc_id: z.number().int().nullish(),
    vendor_message_id: z.string().min(1).max(64),
    vendor_rate: z.number().nullish(),
  })
);

export type SmsRecord = z.infer<typeof smsRecordSchema>;

/**
 * Sobre de la respuesta: JSON-RPC {"jsonrpc":"2.0","result":{"data":[...]},"id":1}
 * o un array plano. Los registros NO se validan aca sino de a lotes en la
 * ingesta (validateRecords): asi nunca hay en memoria una segunda copia
 * completa ya normalizada de toda la respuesta.
 */
export const edrEnvelopeSchema = z.union([
  z.array(z.unknown()),
  z
    .object({ result: z.object({ data: z.array(z.unknown()) }) })
    .transform((payload) => payload.result.data),
]);

export interface InvalidRecord {
  index: number;
  error: string;
}

/** Valida un lote; los invalidos se devuelven aparte en vez de tirar todo el lote. */
export function validateRecords(
  raw: unknown[],
  offset = 0
): { valid: SmsRecord[]; invalid: InvalidRecord[] } {
  const valid: SmsRecord[] = [];
  const invalid: InvalidRecord[] = [];
  raw.forEach((item, i) => {
    const parsed = smsRecordSchema.safeParse(item);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      invalid.push({
        index: offset + i,
        error: parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      });
    }
  });
  return { valid, invalid };
}
