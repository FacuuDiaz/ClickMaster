import { chromium, type Browser } from "playwright";
import pLimit from "p-limit";
import { config } from "../config";

export interface LinkCheckTarget {
  smsContentId: number;
  link: string;
}

export interface LinkCheckResult {
  smsContentId: number;
  link: string;
  checkedAt: Date;
  httpStatus: number | null;
  ok: boolean;
  responseTimeMs: number | null;
  errorMessage: string | null;
}

/**
 * Verifica en paralelo que cada link cargue (health check, no scraping).
 *
 * - Un solo Browser para toda la corrida (se lanza una vez y se cierra al
 *   final, evita el costo de levantar Chromium por cada link).
 * - N BrowserContext concurrentes, uno por link, limitados por
 *   CHECK_CONCURRENCY via p-limit: apenas se libera un slot arranca el
 *   siguiente inmediatamente -- sin sleeps ni delays artificiales entre
 *   navegadores.
 * - Cada context se cierra apenas termina su chequeo, asi la memoria no
 *   se va acumulando durante la corrida.
 */
export async function checkLinks(
  targets: LinkCheckTarget[]
): Promise<LinkCheckResult[]> {
  if (targets.length === 0) return [];

  const browser = await chromium.launch({ headless: true });
  const limit = pLimit(config.checker.concurrency);

  try {
    const results = await Promise.all(
      targets.map((target) => limit(() => checkOne(browser, target)))
    );
    return results;
  } finally {
    await browser.close();
  }
}

export interface VisitOptions {
  // Cuanto quedarse en la pagina despues de que carga, antes de cerrar.
  dwellMs?: number;
  // Aborta imagenes, fuentes y video/audio: baja CPU, RAM y red por sesion.
  // El documento (y su JS) se sigue cargando normal.
  blockResources?: boolean;
}

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

export interface VisitResult {
  httpStatus: number | null;
  ok: boolean;
  responseTimeMs: number;
  errorMessage: string | null;
}

/**
 * Abre `url` en un BrowserContext nuevo (sin cookies ni cache compartidas
 * con otras visitas). Si carga, se queda `dwellMs` en la pagina antes de
 * cerrar el context. Nunca lanza: los errores de navegacion vuelven en
 * `errorMessage`.
 */
export async function visitUrl(
  browser: Browser,
  url: string,
  { dwellMs = 0, blockResources = false }: VisitOptions = {}
): Promise<VisitResult> {
  const context = await browser.newContext();
  const startedAt = Date.now();

  try {
    if (blockResources) {
      await context.route("**/*", (route) =>
        BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())
          ? route.abort()
          : route.continue()
      );
    }

    const page = await context.newPage();
    const response = await page.goto(url, {
      timeout: config.checker.timeoutMs,
      waitUntil: "domcontentloaded",
    });

    const httpStatus = response?.status() ?? null;
    const ok = response !== null && response.ok();
    // Se mide antes de la espera: es el tiempo de carga, no el de la sesion.
    const responseTimeMs = Date.now() - startedAt;

    if (dwellMs > 0) {
      await page.waitForTimeout(dwellMs);
    }

    return {
      httpStatus,
      ok,
      responseTimeMs,
      errorMessage: ok ? null : `HTTP ${httpStatus ?? "sin respuesta"}`,
    };
  } catch (err) {
    return {
      httpStatus: null,
      ok: false,
      responseTimeMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await context.close();
  }
}

async function checkOne(
  browser: Browser,
  target: LinkCheckTarget
): Promise<LinkCheckResult> {
  const visit = await visitUrl(browser, target.link);
  return {
    smsContentId: target.smsContentId,
    link: target.link,
    checkedAt: new Date(),
    ...visit,
  };
}
