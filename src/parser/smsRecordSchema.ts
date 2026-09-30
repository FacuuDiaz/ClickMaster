import { z } from "zod";

/**
 * Espejo de la estructura de sms_content. Ajustar los nombres de campo
 * si el JSON que devuelve la API usa otras keys (ej. camelCase) -- este
 * es el unico lugar que habria que tocar en ese caso.
 */
export const smsRecordSchema = z.object({
  cdr_delivery_time: z.string().datetime().nullish(),
  client: z.string().max(64),
  client_acc_id: z.number().int(),
  client_message_id: z.string().max(64),
  client_rate: z.number(),
  country: z.string().max(32),
  dnis: z.string().max(32),
  dst_is_successful: z.number().int(),
  dst_part_amount: z.number().int(),
  edr_date: z.string().datetime(),
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
  vendor_message_id: z.string().max(64),
  vendor_rate: z.number().nullish(),
});

export type SmsRecord = z.infer<typeof smsRecordSchema>;

export const smsPayloadSchema = z.array(smsRecordSchema);
