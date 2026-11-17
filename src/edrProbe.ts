/**
 * Diagnostico de la API EDR real (make edr-probe): una consulta de solo
 * lectura, sin guardar nada. Sirve para validar lo que no esta documentado
 * de la API: tope de filas, si end_date es inclusivo y el volumen real.
 *
 *   node dist/edrProbe.js "2026.10.14 09:00:00" "2026.10.14 09:05:00"
 *   (sin argumentos: los ultimos 5 minutos cerrados)
 */
import { config } from "./config";
import { formatApiDate, parseApiDate } from "./edr/apiTime";
import { fetchEdrRange } from "./fetcher/apiClient";
import { errorMessage } from "./logger";

async function main() {
  const offset = config.edr.timezoneOffsetMinutes;
  const [startArg, endArg] = process.argv.slice(2);
  const end = endArg ? parseApiDate(endArg, offset) : new Date(Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000);
  const start = startArg ? parseApiDate(startArg, offset) : end && new Date(end.getTime() - 5 * 60_000);
  if (!start || !end) throw new Error('Fechas invalidas: usar "YYYY.MM.DD HH:mm:ss" (hora de la API)');

  const t0 = Date.now();
  const heap0 = process.memoryUsage().heapUsed;
  const data = await fetchEdrRange({ start, end });
  const ms = Date.now() - t0;
  const heapMb = Math.round((process.memoryUsage().heapUsed - heap0) / 1e6);

  const dates = data
    .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>).edr_date : undefined))
    .filter((d): d is string => typeof d === "string")
    .sort();
  const endText = formatApiDate(end, offset);
  const ids = new Set(
    data.map((r) => {
      const rec = r as Record<string, unknown>;
      return `${rec.client_message_id}|${rec.vendor_message_id}`;
    })
  );

  console.log(
    JSON.stringify(
      {
        pedido: {
          start_date: formatApiDate(start, offset),
          end_date: endText,
          client_product_id: config.edr.clientProductId ?? null,
          country: config.edr.country ?? null,
          extraArgs: config.edr.extraArgs,
        },
        filas: data.length,
        identidadesUnicas: ids.size,
        llegoAlTope: config.edr.maxRowsPerRequest > 0 && data.length >= config.edr.maxRowsPerRequest,
        topeConfigurado: config.edr.maxRowsPerRequest,
        // La paginacion por "ultimo registro" necesita que vengan ordenadas por edr_date.
        orden: ordenDe(data),
        edrDatePrimerRegistro: edrOf(data[0]),
        edrDateUltimoRegistro: edrOf(data[data.length - 1]),
        edrDateMin: dates[0] ?? null,
        edrDateMax: dates[dates.length - 1] ?? null,
        // Si hay filas con edr_date == end_date, la API trata end_date como inclusivo.
        filasEnEndDate: dates.filter((d) => d === endText).length,
        duracionMs: ms,
        heapAproxMb: heapMb,
        keysPrimerRegistro: data[0] && typeof data[0] === "object" ? Object.keys(data[0] as object) : [],
      },
      null,
      2
    )
  );
}

function edrOf(r: unknown): string | null {
  const v = r && typeof r === "object" ? (r as Record<string, unknown>).edr_date : null;
  return typeof v === "string" ? v : null;
}

/** "ascendente", "descendente" o "desordenado" (el formato YYYY.MM.DD HH:mm:ss ordena como texto). */
function ordenDe(data: unknown[]): string {
  const values = data.map(edrOf).filter((v): v is string => v !== null);
  let asc = true;
  let desc = true;
  for (let i = 1; i < values.length; i++) {
    if (values[i] < values[i - 1]) asc = false;
    if (values[i] > values[i - 1]) desc = false;
  }
  return asc ? "ascendente" : desc ? "descendente" : "desordenado";
}

main().catch((err) => {
  console.error(`edr-probe: ${errorMessage(err)}`);
  process.exit(1);
});
