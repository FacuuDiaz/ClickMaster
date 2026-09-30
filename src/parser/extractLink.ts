/**
 * Extrae la primera URL http(s) encontrada dentro de un texto.
 * Se usa en dos contextos: (a) al procesar el JSON recien llegado de la
 * API, antes de insertar en sms_content, y (b) el dia de manana, cuando
 * el scheduler re-lea filas ya guardadas desde la base para re-chequear
 * el link sin depender de la API externa.
 */
const URL_REGEX = /https?:\/\/[^\s"'<>]+/i;

export function extractLink(text: string): string | null {
  const match = text.match(URL_REGEX);
  if (!match) return null;
  // saca puntuacion final que suele quedar pegada a la url (. , ) etc.)
  return match[0].replace(/[.,;)\]]+$/, "");
}
