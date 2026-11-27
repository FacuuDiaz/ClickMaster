import { config } from "../config";
import { formatApiDate } from "../edr/apiTime";
import { log, errorMessage } from "../logger";
import { edrEnvelopeSchema } from "../parser/smsRecordSchema";
import { httpPost, type HttpResponse } from "./httpPost";
import { insertCapture, insertCaptureSafe, setRowsCount, type CaptureOrigin } from "../captures/repo";

export interface EdrRange {
  start: Date;
  end: Date;
}

/** Error de la API con la marca de si vale la pena reintentar. */
export class EdrError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "EdrError";
  }
}

export interface FetchContext {
  // Corrida de ingesta que pide el rango (para asociar la captura).
  runId?: number | null;
}

export type EdrFetcher = (range: EdrRange, ctx?: FetchContext) => Promise<unknown[]>;

let requestId = 0;

function buildRequest(range: EdrRange) {
  const offset = config.edr.timezoneOffsetMinutes;
  const args: Record<string, unknown> = {
    start_date: formatApiDate(range.start, offset),
    end_date: formatApiDate(range.end, offset),
  };
  if (config.edr.clientProductId) args.client_product_id = config.edr.clientProductId;
  if (config.edr.country) {
    args.op_country = "==";
    args.country = config.edr.country;
  }
  // Segun la doc de Alaris, sin orderby_clause "sorting is disabled": el
  // orden no esta garantizado. La paginacion por fecha del ultimo registro
  // (ingestRange) lo necesita, asi que se pide siempre. EDR_EXTRA_ARGS lo
  // puede pisar; si la respuesta llega desordenada, la ingesta lo detecta.
  args.orderby_clause = "edr_date asc";
  Object.assign(args, config.edr.extraArgs);
  return {
    id: ++requestId,
    jsonrpc: "2.0",
    method: config.edr.method,
    params: { name: config.edr.cursorName, auth: config.edr.auth ?? "", args },
  };
}

// Los mensajes de error nunca incluyen el body del request: ahi viaja el auth.
function describeRpcError(error: unknown): string {
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return `codigo ${String(code ?? "?")}: ${String(message ?? "sin mensaje").slice(0, 300)}`;
  }
  return String(error).slice(0, 300);
}

/** Los args del request, sin el auth (que va en params.auth): se pueden guardar. */
export function requestArgs(range: EdrRange): Record<string, unknown> {
  return buildRequest(range).params.args;
}

async function capture(range: EdrRange, ctx: FetchContext, origin: CaptureOrigin, body: string, error: string | null, rows: number | null) {
  return insertCaptureSafe({
    runId: ctx.runId ?? null,
    origin,
    rangeStart: range.start,
    rangeEnd: range.end,
    requestArgs: requestArgs(range),
    body,
    errorMessage: error,
    rowsCount: rows,
  });
}

async function post(range: EdrRange): Promise<HttpResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.edr.bearerToken) headers.Authorization = `Bearer ${config.edr.bearerToken}`;
  try {
    return await httpPost(config.edr.url, JSON.stringify(buildRequest(range)), headers, config.edr.httpTimeoutMs);
  } catch (err) {
    // Timeout, DNS, conexion rechazada o cortada: todo transitorio.
    throw new EdrError(`No se pudo obtener respuesta de la API EDR: ${errorMessage(err)}`, true);
  }
}

/**
 * Pide un rango y guarda la respuesta tal cual como captura, sin ingestar
 * (para inspeccionarla desde la web). Devuelve el id de la captura.
 */
export async function captureRange(range: EdrRange, createdBy: string | null): Promise<{ captureId: number; rows: number | null }> {
  const res = await post(range);
  if (res.status < 200 || res.status >= 300) {
    throw new EdrError(`API EDR respondio HTTP ${res.status} ${res.statusText}`, false);
  }
  let rows: number | null = null;
  try {
    const parsed = edrEnvelopeSchema.safeParse(JSON.parse(res.body));
    if (parsed.success) rows = parsed.data.length;
  } catch {
    // Se guarda igual: justamente sirve para ver que devolvio.
  }
  const captureId = await insertCapture({
    runId: null,
    origin: "manual",
    rangeStart: range.start,
    rangeEnd: range.end,
    requestArgs: requestArgs(range),
    body: res.body,
    rowsCount: rows,
    createdBy,
  });
  return { captureId, rows };
}

async function requestOnce(range: EdrRange, ctx: FetchContext = {}): Promise<unknown[]> {
  const startedAt = Date.now();
  let res: HttpResponse;
  try {
    res = await post(range);
  } catch (err) {
    throw err;
  }

  if (res.status < 200 || res.status >= 300) {
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    const message = `API EDR respondio HTTP ${res.status} ${res.statusText}`;
    if (config.capture.mode !== "off" && res.body) await capture(range, ctx, "error", res.body, message, null);
    throw new EdrError(message, retryable);
  }

  // Modo "todas": se guarda antes del parse (el body ya esta en memoria;
  // asi no conviven la copia comprimida y todos los objetos parseados).
  const capturedId = config.capture.mode === "todas" ? await capture(range, ctx, "ingesta", res.body, null, null) : null;
  // Modo "errores": la respuesta se guarda solo si no se puede usar.
  const captureError = async (message: string) => {
    if (config.capture.mode === "errores") await capture(range, ctx, "error", res.body, message, null);
  };

  // Alaris no pagina: la respuesta entera (~40 MB por 20.000 EDR) queda en
  // memoria como string hasta que termina el parse; despues solo quedan los
  // objetos. No se hace ninguna otra copia completa.
  const bytes = res.body.length;
  let raw: unknown;
  try {
    raw = JSON.parse(res.body);
  } catch (err) {
    const message = `API EDR devolvio un JSON invalido: ${errorMessage(err)}`;
    await captureError(message);
    throw new EdrError(message, true);
  }
  log.info("edr: respuesta recibida", {
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    durationMs: Date.now() - startedAt,
    // ttfbMs = lo que tardo Alaris en empezar a responder; el resto de
    // durationMs es la transferencia (wireBytes, comprimidos si encoding).
    ttfbMs: res.ttfbMs,
    bytes,
    wireBytes: res.wireBytes,
    encoding: res.encoding,
  });

  // JSON-RPC informa los errores con HTTP 200 y un campo "error" en el body.
  if (raw && typeof raw === "object" && "error" in raw && (raw as { error: unknown }).error) {
    const message = `API EDR respondio error JSON-RPC (${describeRpcError((raw as { error: unknown }).error)})`;
    await captureError(message);
    throw new EdrError(message, false);
  }

  const envelope = edrEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    const message = "La respuesta de la API EDR no tiene el formato esperado (result.data)";
    await captureError(message);
    throw new EdrError(message, false);
  }
  // Ya no hace falta el texto: se suelta antes de devolver los objetos.
  res.body = "";
  if (capturedId !== null) await setRowsCount(capturedId, envelope.data.length).catch(() => undefined);
  return envelope.data;
}

/**
 * Pide los EDR de un rango con reintentos (backoff exponencial) para los
 * errores transitorios. Devuelve los registros crudos, sin validar.
 */
export const fetchEdrRange: EdrFetcher = async (range, ctx) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce(range, ctx);
    } catch (err) {
      const retryable = err instanceof EdrError && err.retryable;
      if (!retryable || attempt >= config.edr.maxRetries) throw err;
      const delayMs = Math.min(60_000, 2_000 * 2 ** attempt);
      log.warn("edr: reintento", {
        attempt: attempt + 1,
        delayMs,
        error: errorMessage(err),
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};
