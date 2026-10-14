import { config } from "../config";
import { formatApiDate } from "../edr/apiTime";
import { log, errorMessage } from "../logger";
import { edrEnvelopeSchema } from "../parser/smsRecordSchema";
import { httpPost, type HttpResponse } from "./httpPost";

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

export type EdrFetcher = (range: EdrRange) => Promise<unknown[]>;

let requestId = 0;

function buildRequest(range: EdrRange) {
  const offset = config.edr.timezoneOffsetMinutes;
  const args: Record<string, string> = {
    start_date: formatApiDate(range.start, offset),
    end_date: formatApiDate(range.end, offset),
  };
  if (config.edr.clientProductId) args.client_product_id = config.edr.clientProductId;
  if (config.edr.country) {
    args.op_country = "==";
    args.country = config.edr.country;
  }
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

async function requestOnce(range: EdrRange): Promise<unknown[]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.edr.bearerToken) headers.Authorization = `Bearer ${config.edr.bearerToken}`;

  const startedAt = Date.now();
  let res: HttpResponse;
  try {
    res = await httpPost(config.edr.url, JSON.stringify(buildRequest(range)), headers, config.edr.httpTimeoutMs);
  } catch (err) {
    // Timeout, DNS, conexion rechazada o cortada: todo transitorio.
    throw new EdrError(`No se pudo obtener respuesta de la API EDR: ${errorMessage(err)}`, true);
  }

  if (res.status < 200 || res.status >= 300) {
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw new EdrError(`API EDR respondio HTTP ${res.status} ${res.statusText}`, retryable);
  }

  // Alaris no pagina: la respuesta entera (~40 MB por 20.000 EDR) queda en
  // memoria como string hasta que termina el parse; despues solo quedan los
  // objetos. No se hace ninguna otra copia completa.
  const bytes = res.body.length;
  let raw: unknown;
  try {
    raw = JSON.parse(res.body);
  } catch (err) {
    throw new EdrError(`API EDR devolvio un JSON invalido: ${errorMessage(err)}`, true);
  }
  res.body = "";
  log.info("edr: respuesta recibida", {
    start: range.start.toISOString(),
    end: range.end.toISOString(),
    durationMs: Date.now() - startedAt,
    bytes,
  });

  // JSON-RPC informa los errores con HTTP 200 y un campo "error" en el body.
  if (raw && typeof raw === "object" && "error" in raw && (raw as { error: unknown }).error) {
    throw new EdrError(
      `API EDR respondio error JSON-RPC (${describeRpcError((raw as { error: unknown }).error)})`,
      false
    );
  }

  const envelope = edrEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new EdrError("La respuesta de la API EDR no tiene el formato esperado (result.data)", false);
  }
  return envelope.data;
}

/**
 * Pide los EDR de un rango con reintentos (backoff exponencial) para los
 * errores transitorios. Devuelve los registros crudos, sin validar.
 */
export const fetchEdrRange: EdrFetcher = async (range) => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestOnce(range);
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
