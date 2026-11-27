import http from "http";
import https from "https";
import zlib from "zlib";
import type { Readable } from "stream";

export interface HttpResponse {
  status: number;
  statusText: string;
  body: string;
  // Content-Encoding con que llego (gzip, deflate) o null si vino plano.
  encoding: string | null;
  // Bytes recibidos por la red (comprimidos si vino con encoding).
  wireBytes: number;
  // Desde que se mando el pedido hasta que llegaron los headers: lo que
  // tardo el servidor en empezar a responder. El resto es transferencia.
  ttfbMs: number;
}

export class HttpTimeoutError extends Error {}

/**
 * POST con el modulo http/https de Node en vez de fetch. Alaris puede
 * tardar varios minutos en devolver ~20.000 EDR y el fetch nativo (undici)
 * corta solo a los 5 minutos sin headers o sin body (headersTimeout /
 * bodyTimeout), sin importar el AbortSignal. Aca el unico limite es
 * `timeoutMs`, sobre el request completo.
 *
 * Se pide la respuesta comprimida (gzip/deflate): Alaris devuelve ~40 MB de
 * JSON por pedido y sin comprimir la transferencia era el cuello de botella
 * (~200 KB/s, ~4 min por pedido). Si el servidor no comprime, llega plano y
 * se usa igual.
 */
export function httpPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<HttpResponse> {
  return httpRequest("POST", url, body, headers, timeoutMs);
}

/** Igual que httpPost, para cualquier metodo (la REST API de Alaris es GET). */
export function httpRequest(
  method: string,
  url: string,
  body: string | null,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<HttpResponse> {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  const sentAt = Date.now();
  const allHeaders: Record<string, string> = { "Accept-Encoding": "gzip, deflate", ...headers };
  if (body !== null) allHeaders["Content-Length"] = String(Buffer.byteLength(body));

  return new Promise((resolve, reject) => {
    const req = client.request(target, { method, headers: allHeaders }, (res) => {
      const ttfbMs = Date.now() - sentAt;
      const raw = String(res.headers["content-encoding"] ?? "").trim().toLowerCase();
      const encoding = raw === "gzip" || raw === "x-gzip" ? "gzip" : raw === "deflate" ? "deflate" : null;
      let wireBytes = 0;
      res.on("data", (chunk: Buffer) => {
        wireBytes += chunk.length;
      });
      // Se descomprime en streaming: nunca estan juntas la copia comprimida entera y la plana.
      const stream: Readable = encoding === "gzip" ? res.pipe(zlib.createGunzip()) : encoding === "deflate" ? res.pipe(zlib.createInflate()) : res;
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      const fail = (err: Error) => {
        clearTimeout(timer);
        req.destroy();
        reject(err);
      };
      res.on("error", fail);
      if (stream !== res) stream.on("error", (err) => fail(new Error(`respuesta ${encoding} invalida: ${err.message}`)));
      stream.on("end", () => {
        clearTimeout(timer);
        // Buffer -> string una sola vez; los chunks se sueltan al salir.
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
          encoding,
          wireBytes,
          ttfbMs,
        });
      });
    });

    const timer = setTimeout(() => {
      req.destroy(new HttpTimeoutError(`sin respuesta completa despues de ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (body === null) req.end();
    else req.end(body);
  });
}
