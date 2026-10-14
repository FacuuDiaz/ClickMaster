import { withTransaction } from "../db/pool";
import {
  findSmsContentIds,
  insertSmsContent,
  messageKey,
  updateSmsContent,
} from "../db/smsContentRepo";
import { findProcessingIdentities, insertJobs, type NewJob } from "../db/processingRepo";
import { extractLink } from "../parser/extractLink";
import { sampleByPercentage } from "../checker/sampleTargets";
import type { SmsRecord } from "../parser/smsRecordSchema";

export interface BatchResult {
  smsNew: number;
  smsExisting: number;
  jobsCreated: number;
  jobsSkipped: number;
}

/**
 * Persiste un lote de SMS validados y crea sus trabajos en UNA transaccion:
 * si algo falla no queda un SMS nuevo sin su fila en sms_processing (y al
 * repetir la ventana se rehace igual, todo es idempotente).
 *
 * Cantidad de consultas por lote, sin importar su tamano: hasta 6
 * (identidades, legacy, insert, ids nuevos, update, jobs).
 *
 * Supone que no hay otra ingesta escribiendo las mismas identidades en
 * paralelo: lo garantiza el lock de ingesta (db/locks.ts). Un proceso
 * externo que inserte en sms_content a la vez podria dejar un duplicado
 * en esa tabla; sin una UNIQUE en produccion no hay forma de impedirlo.
 */
export async function persistSmsBatch(
  records: SmsRecord[],
  ingestRunId: number | null,
  clickPercentage: number,
  now: Date
): Promise<BatchResult> {
  // Si la misma identidad viene dos veces en el lote gana la ultima (la mas nueva de la API).
  const byKey = new Map<string, SmsRecord>();
  for (const record of records) {
    byKey.set(messageKey(record.client_message_id, record.vendor_message_id), record);
  }
  const unique = [...byKey.entries()];
  if (unique.length === 0) return { smsNew: 0, smsExisting: 0, jobsCreated: 0, jobsSkipped: 0 };

  return withTransaction(async (conn) => {
    const identities = unique.map(([, r]) => ({
      clientMessageId: r.client_message_id,
      vendorMessageId: r.vendor_message_id,
    }));
    const known = await findProcessingIdentities(conn, identities);

    // Sin fila en sms_processing: o es nuevo, o lo cargo la version anterior.
    const unknown = unique.filter(([key]) => !known.has(key));
    const legacy = await findSmsContentIds(
      conn,
      unknown.map(([, r]) => ({ clientMessageId: r.client_message_id, vendorMessageId: r.vendor_message_id }))
    );

    const toInsert = unknown.filter(([key]) => !legacy.has(key));
    await insertSmsContent(conn, toInsert.map(([, r]) => r));
    const inserted = await findSmsContentIds(
      conn,
      toInsert.map(([, r]) => ({ clientMessageId: r.client_message_id, vendorMessageId: r.vendor_message_id }))
    );
    for (const [key] of toInsert) {
      if (!inserted.has(key)) {
        throw new Error("No se encontro el id de un SMS recien insertado en sms_content");
      }
    }

    // Los ya existentes se actualizan (ej. cambio de status SENT -> DELIVRD).
    // Nunca se les crea otro trabajo.
    const toUpdate = unique
      .filter(([key]) => known.has(key) || legacy.has(key))
      .map(([key, record]) => ({ id: (known.get(key) ?? legacy.get(key)) as number, record }));
    await updateSmsContent(conn, toUpdate);

    // Trabajos para los que no tenian: nuevos + los de la version anterior.
    const needJob = unknown.map(([key, record]) => ({
      key,
      record,
      smsContentId: (legacy.get(key) ?? inserted.get(key)) as number,
      link: extractLink(record.text),
    }));
    const withLink = needJob.filter((j) => j.link !== null);
    const sampled = new Set(sampleByPercentage(withLink, clickPercentage).map((j) => j.key));

    const jobs: NewJob[] = needJob.map((j) => {
      const pending = j.link !== null && sampled.has(j.key);
      return {
        smsContentId: j.smsContentId,
        clientMessageId: j.record.client_message_id,
        vendorMessageId: j.record.vendor_message_id,
        ingestRunId,
        edrDate: new Date(j.record.edr_date),
        status: pending ? "pending" : "skipped",
        skipReason: pending ? null : j.link === null ? "sin_link" : "fuera_de_muestra",
      };
    });
    await insertJobs(conn, jobs, now);

    const jobsCreated = jobs.filter((j) => j.status === "pending").length;
    return {
      smsNew: toInsert.length,
      smsExisting: toUpdate.length,
      jobsCreated,
      jobsSkipped: jobs.length - jobsCreated,
    };
  });
}
