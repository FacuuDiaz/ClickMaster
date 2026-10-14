/**
 * Clasificacion de una visita de Playwright. Un HTTP 200 NO prueba que un
 * usuario haya visto bien la pagina: "cargada" significa que respondio
 * 2xx/3xx, el DOM llego a domcontentloaded y el body tiene contenido. Lo
 * que no se puede afirmar se marca "indeterminado".
 *
 * | outcome        | que paso                                         | politica    |
 * |----------------|--------------------------------------------------|-------------|
 * | cargada        | 2xx/3xx + DOM con contenido                      | exito       |
 * | indeterminado  | sin respuesta, body vacio o el DOM no se pudo    | transitorio |
 * |                | leer (ej. redireccion por JS en el medio)        |             |
 * | http_4xx       | 4xx (salvo 408 y 429)                            | definitivo  |
 * | http_429_408   | rate limit o request timeout del servidor        | transitorio |
 * | http_5xx       | error del servidor                               | transitorio |
 * | timeout        | no llego a domcontentloaded a tiempo             | transitorio |
 * | dns            | el dominio no resolvio (puede ser un DNS caido)  | transitorio |
 * | conexion       | rechazada, reseteada, inalcanzable, sin red      | transitorio |
 * | certificado    | certificado o handshake TLS invalido             | definitivo  |
 * | navegacion     | demasiadas redirecciones, descarga, URL invalida | definitivo  |
 * | error_interno  | Chromium se cerro o crasheo                      | transitorio |
 *
 * Transitorio = se reintenta hasta JOB_MAX_ATTEMPTS. Definitivo = failed.
 */
export type VisitOutcome =
  | "cargada"
  | "indeterminado"
  | "http_4xx"
  | "http_429_408"
  | "http_5xx"
  | "timeout"
  | "dns"
  | "conexion"
  | "certificado"
  | "navegacion"
  | "error_interno";

export type RetryPolicy = "exito" | "transitorio" | "definitivo";

const POLICY: Record<VisitOutcome, RetryPolicy> = {
  cargada: "exito",
  indeterminado: "transitorio",
  http_4xx: "definitivo",
  http_429_408: "transitorio",
  http_5xx: "transitorio",
  timeout: "transitorio",
  dns: "transitorio",
  conexion: "transitorio",
  certificado: "definitivo",
  navegacion: "definitivo",
  error_interno: "transitorio",
};

export function retryPolicy(outcome: VisitOutcome): RetryPolicy {
  return POLICY[outcome];
}

/** Clasifica una respuesta que si llego. */
export function classifyResponse(httpStatus: number | null, hasContent: boolean | null): VisitOutcome {
  if (httpStatus === null) return "indeterminado";
  if (httpStatus === 408 || httpStatus === 429) return "http_429_408";
  if (httpStatus >= 500) return "http_5xx";
  if (httpStatus >= 400) return "http_4xx";
  return hasContent ? "cargada" : "indeterminado";
}

/** Clasifica el error que tiro page.goto / Chromium. */
export function classifyError(message: string): VisitOutcome {
  const m = message;
  if (/Timeout \d+ms exceeded|TimeoutError|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/i.test(m)) return "timeout";
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ENOTFOUND/i.test(m)) return "dns";
  if (/ERR_CERT_|ERR_SSL_|ERR_BAD_SSL|SSL_PROTOCOL|certificate/i.test(m)) return "certificado";
  if (
    /ERR_CONNECTION_|ERR_ADDRESS_UNREACHABLE|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_|ERR_EMPTY_RESPONSE|ERR_PROXY_|ECONNREFUSED|ECONNRESET/i.test(
      m
    )
  ) {
    return "conexion";
  }
  if (/Target (page, context or browser )?(has been )?closed|Browser (has been )?closed|crash/i.test(m)) {
    return "error_interno";
  }
  if (/ERR_TOO_MANY_REDIRECTS|ERR_ABORTED|Download is starting|ERR_INVALID_URL|ERR_UNSAFE|ERR_BLOCKED/i.test(m)) {
    return "navegacion";
  }
  // Un net::ERR_ desconocido es un problema de la red o del sitio; cualquier
  // otra cosa (bug, Chromium raro) se trata como interno y se reintenta.
  return /net::ERR_/.test(m) ? "conexion" : "error_interno";
}
