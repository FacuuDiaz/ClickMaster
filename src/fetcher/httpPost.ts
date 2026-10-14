import http from "http";
import https from "https";

export interface HttpResponse {
  status: number;
  statusText: string;
  body: string;
}

export class HttpTimeoutError extends Error {}

/**
 * POST con el modulo http/https de Node en vez de fetch. Alaris puede
 * tardar varios minutos en devolver ~20.000 EDR y el fetch nativo (undici)
 * corta solo a los 5 minutos sin headers o sin body (headersTimeout /
 * bodyTimeout), sin importar el AbortSignal. Aca el unico limite es
 * `timeoutMs`, sobre el request completo.
 */
export function httpPost(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<HttpResponse> {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          clearTimeout(timer);
          // Buffer -> string una sola vez; los chunks se sueltan al salir.
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    const timer = setTimeout(() => {
      req.destroy(new HttpTimeoutError(`sin respuesta completa despues de ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end(body);
  });
}
