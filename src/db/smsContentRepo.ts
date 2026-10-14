import type { RowDataPacket } from "mysql2";
import type { DbConnection } from "./pool";
import type { SmsRecord } from "../parser/smsRecordSchema";

/**
 * Persistencia por lotes en sms_content SIN depender de una unique key en
 * la tabla (en produccion no esta confirmada). La identidad del SMS
 * (client_message_id, vendor_message_id) la resuelve sms_processing; aca
 * solo se escribe por PRIMARY KEY (id), que si existe seguro.
 */

// Orden de columnas compartido por el INSERT de nuevos y el upsert por id.
const DATA_COLUMNS = [
  "cdr_delivery_time",
  "client",
  "client_acc_id",
  "client_message_id",
  "client_rate",
  "country",
  "dnis",
  "dst_is_successful",
  "dst_part_amount",
  "edr_date",
  "edr_type",
  "mccmnc",
  "network",
  "sender_name",
  "src_is_successful",
  "src_part_amount",
  "status",
  "tech_details_json",
  "translated_text",
  "text",
  "vendor",
  "vendor_acc_id",
  "vendor_message_id",
  "vendor_rate",
] as const;

// Las identidades nunca se actualizan: son las que ubican la fila.
const UPDATABLE_COLUMNS = DATA_COLUMNS.filter(
  (c) => c !== "client_message_id" && c !== "vendor_message_id"
);

// La API manda fechas ISO 8601 ya normalizadas y MySQL/MariaDB rechazan ese
// formato en columnas DATETIME: se pasan como Date y mysql2 las serializa
// en UTC (ver timezone en pool.ts).
function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function toRow(record: SmsRecord): unknown[] {
  return [
    toDate(record.cdr_delivery_time),
    record.client,
    record.client_acc_id,
    record.client_message_id,
    record.client_rate,
    record.country,
    record.dnis,
    record.dst_is_successful,
    record.dst_part_amount,
    toDate(record.edr_date),
    record.edr_type,
    record.mccmnc,
    record.network,
    record.sender_name,
    record.src_is_successful,
    record.src_part_amount,
    record.status,
    record.tech_details_json ?? null,
    record.translated_text ?? null,
    record.text,
    record.vendor ?? null,
    record.vendor_acc_id ?? null,
    record.vendor_message_id,
    record.vendor_rate ?? null,
  ];
}

export function messageKey(clientMessageId: string, vendorMessageId: string): string {
  return `${clientMessageId}\u0000${vendorMessageId}`;
}

/**
 * Busca en sms_content filas con esas identidades (ej. cargadas por la
 * version anterior, que no tenia sms_processing). Una sola consulta por
 * lote, por el indice de vendor_message_id. Si hubiera duplicados viejos
 * se toma el id mas alto, siempre el mismo.
 */
export async function findSmsContentIds(
  conn: DbConnection,
  keys: { clientMessageId: string; vendorMessageId: string }[]
): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  if (keys.length === 0) return found;

  const wanted = new Set(keys.map((k) => messageKey(k.clientMessageId, k.vendorMessageId)));
  const vendorIds = [...new Set(keys.map((k) => k.vendorMessageId))];
  const [rows] = await conn.query<RowDataPacket[]>(
    `SELECT id, client_message_id, vendor_message_id FROM sms_content WHERE vendor_message_id IN (?)`,
    [vendorIds]
  );
  for (const row of rows) {
    const key = messageKey(row.client_message_id, row.vendor_message_id);
    if (!wanted.has(key)) continue;
    const id = Number(row.id);
    if (id > (found.get(key) ?? 0)) found.set(key, id);
  }
  return found;
}

/** INSERT multi-fila de SMS nuevos. Los ids se resuelven despues con findSmsContentIds. */
export async function insertSmsContent(conn: DbConnection, records: SmsRecord[]): Promise<void> {
  if (records.length === 0) return;
  await conn.query(`INSERT INTO sms_content (${DATA_COLUMNS.join(", ")}) VALUES ?`, [
    records.map(toRow),
  ]);
}

/**
 * Actualiza SMS ya existentes (ej. el status paso de SENT a DELIVRD) en una
 * sola sentencia: INSERT con el id + ON DUPLICATE KEY UPDATE, que dispara
 * por la PRIMARY KEY. Si los valores no cambiaron MySQL no escribe nada.
 * Se usa VALUES() y no el alias "AS new" para seguir siendo compatible con
 * MariaDB.
 */
export async function updateSmsContent(
  conn: DbConnection,
  rows: { id: number; record: SmsRecord }[]
): Promise<void> {
  if (rows.length === 0) return;
  const assignments = UPDATABLE_COLUMNS.map((c) => `${c} = VALUES(${c})`).join(", ");
  await conn.query(
    `INSERT INTO sms_content (id, ${DATA_COLUMNS.join(", ")}) VALUES ?
     ON DUPLICATE KEY UPDATE ${assignments}`,
    [rows.map(({ id, record }) => [id, ...toRow(record)])]
  );
}
