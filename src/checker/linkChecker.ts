import { chromium, type Browser, type Page } from "playwright";
import { config } from "../config";
import { classifyError, classifyResponse, type VisitOutcome } from "./classifyVisit";

/**
 * Chromium headless para el worker y los clicks manuales. Playwright por
 * defecto mata el navegador apenas llega SIGTERM/SIGINT: eso cortaba las
 * visitas en curso en el `docker stop` y tiraba el proceso. Las senales las
 * maneja server.ts (apagado ordenado), que cierra el navegador al final.
 */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true, handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false });
}

export interface VisitOptions {
  // Cuanto quedarse en la pagina despues de que carga, antes de cerrar.
  dwellMs?: number;
  // Aborta imagenes, fuentes y video/audio: baja CPU, RAM y red por sesion.
  // El documento (y su JS) se sigue cargando normal.
  blockResources?: boolean;
  timeoutMs?: number;
}

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

export interface VisitResult {
  httpStatus: number | null;
  // Respuesta HTTP 2xx/3xx. NO alcanza para decir que la pagina se vio bien:
  // para eso esta `outcome` (ver classifyVisit.ts).
  ok: boolean;
  outcome: VisitOutcome;
  responseTimeMs: number;
  // URL final, solo si es distinta de la pedida (hubo redireccion).
  finalUrl: string | null;
  redirects: number;
  errorMessage: string | null;
}

// Una redireccion por JS justo despues de domcontentloaded destruye el
// contexto en el medio del evaluate: se espera a que cargue la nueva y se
// prueba una vez mas.
async function pageHasContent(page: Page): Promise<boolean | null> {
  // Como string: corre en el navegador y el proyecto no compila con los tipos del DOM.
  const probe = async () =>
    (await page.evaluate(
      "!!document.body && (document.body.innerText.trim().length > 0 || document.body.children.length > 0)"
    )) === true;
  try {
    return await probe();
  } catch {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 });
      return await probe();
    } catch {
      return null;
    }
  }
}

/**
 * Abre `url` en un BrowserContext nuevo (sin cookies ni cache compartidas
 * con otras visitas). Si carga, se queda `dwellMs` en la pagina antes de
 * cerrar el context. Nunca lanza: los errores de navegacion vuelven
 * clasificados en `outcome` y con el detalle en `errorMessage`.
 */
export async function visitUrl(
  browser: Browser,
  url: string,
  { dwellMs = 0, blockResources = false, timeoutMs = config.checker.timeoutMs }: VisitOptions = {}
): Promise<VisitResult> {
  const startedAt = Date.now();
  let context;
  try {
    context = await browser.newContext();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      httpStatus: null,
      ok: false,
      outcome: "error_interno",
      responseTimeMs: Date.now() - startedAt,
      finalUrl: null,
      redirects: 0,
      errorMessage: message,
    };
  }

  try {
    if (blockResources) {
      await context.route("**/*", (route) =>
        BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())
          ? route.abort()
          : route.continue()
      );
    }

    const page = await context.newPage();
    const response = await page.goto(url, { timeout: timeoutMs, waitUntil: "domcontentloaded" });

    const httpStatus = response?.status() ?? null;
    const ok = response !== null && response.ok();
    // Se mide antes de la espera: es el tiempo de carga, no el de la sesion.
    const responseTimeMs = Date.now() - startedAt;

    let redirects = 0;
    for (let req = response?.request().redirectedFrom(); req; req = req.redirectedFrom()) {
      redirects++;
    }
    const finalUrl = page.url() !== url ? page.url() : null;
    const hasContent = ok ? await pageHasContent(page) : null;
    const outcome = classifyResponse(httpStatus, hasContent);

    if (dwellMs > 0) {
      await page.waitForTimeout(dwellMs);
    }

    let errorMessage: string | null = null;
    if (!ok) errorMessage = `HTTP ${httpStatus ?? "sin respuesta"}`;
    else if (outcome === "indeterminado") errorMessage = "La pagina respondio pero no se pudo confirmar contenido en el DOM";

    return { httpStatus, ok, outcome, responseTimeMs, finalUrl, redirects, errorMessage };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      httpStatus: null,
      ok: false,
      outcome: classifyError(message),
      responseTimeMs: Date.now() - startedAt,
      finalUrl: null,
      redirects: 0,
      errorMessage: message,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}
