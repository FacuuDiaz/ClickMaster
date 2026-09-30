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

async function checkOne(
  browser: Browser,
  target: LinkCheckTarget
): Promise<LinkCheckResult> {
  const context = await browser.newContext();
  const startedAt = Date.now();

  try {
    const page = await context.newPage();
    const response = await page.goto(target.link, {
      timeout: config.checker.timeoutMs,
      waitUntil: "domcontentloaded",
    });

    const httpStatus = response?.status() ?? null;
    const ok = response !== null && response.ok();

    return {
      smsContentId: target.smsContentId,
      link: target.link,
      checkedAt: new Date(),
      httpStatus,
      ok,
      responseTimeMs: Date.now() - startedAt,
      errorMessage: ok ? null : `HTTP ${httpStatus ?? "sin respuesta"}`,
    };
  } catch (err) {
    return {
      smsContentId: target.smsContentId,
      link: target.link,
      checkedAt: new Date(),
      httpStatus: null,
      ok: false,
      responseTimeMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await context.close();
  }
}
