import { config } from "../config";
import { smsPayloadSchema, type SmsRecord } from "../parser/smsRecordSchema";

export async function fetchSmsRecords(): Promise<SmsRecord[]> {
  const res = await fetch(config.api.url, {
    headers: config.api.token
      ? { Authorization: `Bearer ${config.api.token}` }
      : undefined,
  });

  if (!res.ok) {
    throw new Error(`API respondio ${res.status} ${res.statusText}`);
  }

  const raw = await res.json();
  // Lanza con detalle si el JSON no matchea el esquema esperado, en vez
  // de dejar pasar datos corruptos hacia la base.
  return smsPayloadSchema.parse(raw);
}
