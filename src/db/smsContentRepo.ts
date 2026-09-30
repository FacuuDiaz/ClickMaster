import { pool } from "./pool";
import type { SmsRecord } from "../parser/smsRecordSchema";

// La API manda fechas ISO 8601 ("...T10:00:00Z") y MySQL/MariaDB rechazan
// ese formato en columnas DATETIME: se pasan como Date y mysql2 las
// serializa en UTC (ver timezone en pool.ts).
function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/**
 * Upsert a nivel aplicacion por (client_message_id, vendor_message_id).
 * No dependemos de una unique key en la tabla (puede no existir en la
 * tabla real de produccion): primero buscamos, despues insertamos o
 * actualizamos segun corresponda.
 */
export async function upsertSmsContent(record: SmsRecord): Promise<number> {
  const [rows] = await pool.query<any[]>(
    `SELECT id FROM sms_content WHERE client_message_id = ? AND vendor_message_id = ? LIMIT 1`,
    [record.client_message_id, record.vendor_message_id]
  );

  if (Array.isArray(rows) && rows.length > 0) {
    const id = rows[0].id as number;
    await pool.query(
      `UPDATE sms_content SET
         cdr_delivery_time = ?, client = ?, client_acc_id = ?, client_rate = ?,
         country = ?, dnis = ?, dst_is_successful = ?, dst_part_amount = ?,
         edr_date = ?, edr_type = ?, mccmnc = ?, network = ?, sender_name = ?,
         src_is_successful = ?, src_part_amount = ?, status = ?,
         tech_details_json = ?, translated_text = ?, text = ?, vendor = ?,
         vendor_acc_id = ?, vendor_rate = ?
       WHERE id = ?`,
      [
        toDate(record.cdr_delivery_time),
        record.client,
        record.client_acc_id,
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
        record.vendor_rate ?? null,
        id,
      ]
    );
    return id;
  }

  const [result] = await pool.query<any>(
    `INSERT INTO sms_content (
       cdr_delivery_time, client, client_acc_id, client_message_id, client_rate,
       country, dnis, dst_is_successful, dst_part_amount, edr_date, edr_type,
       mccmnc, network, sender_name, src_is_successful, src_part_amount, status,
       tech_details_json, translated_text, text, vendor, vendor_acc_id,
       vendor_message_id, vendor_rate
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
    ]
  );

  return result.insertId as number;
}
