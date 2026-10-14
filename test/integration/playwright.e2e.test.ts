import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { visitUrl } from "../../src/checker/linkChecker";
import { processingWorker } from "../../src/worker/processingWorker";
import { startClickJob, getClickJob } from "../../src/clicker/clickJob";
import { config } from "../../src/config";
import { pool } from "../../src/db/pool";

// Sitio local para las visitas reales con Chromium: no sale a internet.
let server: http.Server;
let base: string;
let browser: Browser;

before(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case "/ok":
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<html><body><h1>Hola</h1></body></html>");
      case "/redir":
        res.writeHead(302, { Location: "/ok" });
        return res.end();
      case "/vacia":
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("");
      case "/lenta":
        setTimeout(() => res.end("tarde"), 5000);
        return;
      case "/500":
        res.writeHead(500);
        return res.end("error");
      default:
        res.writeHead(404);
        return res.end("no");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser.close();
  server.closeAllConnections();
  server.close();
  await pool.end();
});

describe("visitas reales con Playwright", () => {
  test("pagina que carga con contenido", async () => {
    const r = await visitUrl(browser, `${base}/ok`);
    assert.equal(r.outcome, "cargada");
    assert.equal(r.httpStatus, 200);
    assert.equal(r.finalUrl, null);
  });

  test("redireccion: guarda la URL final y la cantidad de saltos", async () => {
    const r = await visitUrl(browser, `${base}/redir`);
    assert.equal(r.outcome, "cargada");
    assert.equal(r.finalUrl, `${base}/ok`);
    assert.equal(r.redirects, 1);
  });

  test("200 sin contenido no se da por visto: indeterminado", async () => {
    const r = await visitUrl(browser, `${base}/vacia`);
    assert.equal(r.httpStatus, 200);
    assert.equal(r.outcome, "indeterminado");
  });

  test("404 y 500", async () => {
    assert.equal((await visitUrl(browser, `${base}/nada`)).outcome, "http_4xx");
    assert.equal((await visitUrl(browser, `${base}/500`)).outcome, "http_5xx");
  });

  test("timeout de navegacion", async () => {
    const r = await visitUrl(browser, `${base}/lenta`, { timeoutMs: 1000 });
    assert.equal(r.outcome, "timeout");
    assert.equal(r.ok, false);
  });

  test("conexion rechazada", async () => {
    // Un puerto que estuvo abierto y se cerro (el 1 Chromium lo bloquea como ERR_UNSAFE_PORT).
    const tmp = http.createServer();
    await new Promise<void>((resolve) => tmp.listen(0, "127.0.0.1", resolve));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise((resolve) => tmp.close(resolve));
    const r = await visitUrl(browser, `http://127.0.0.1:${port}/`);
    assert.equal(r.outcome, "conexion");
  });

  test("con el navegador cerrado no lanza: error_interno", async () => {
    const closed = await chromium.launch({ headless: true });
    await closed.close();
    const r = await visitUrl(closed, `${base}/ok`);
    assert.equal(r.outcome, "error_interno");
  });
});

describe("coordinacion con los clicks manuales", () => {
  test("un job de clicks pausa el worker antes de abrir Chromium y lo reanuda al final", async () => {
    config.clicker.dwellMinMs = 0;
    config.clicker.dwellMaxMs = 0;
    const events: string[] = [];
    const originalPause = processingWorker.pause.bind(processingWorker);
    const originalResume = processingWorker.resume.bind(processingWorker);
    processingWorker.pause = async (reason: string) => {
      events.push(`pause:${reason}`);
      await originalPause(reason);
    };
    processingWorker.resume = () => {
      events.push("resume");
      originalResume();
    };
    try {
      const job = startClickJob(`${base}/ok`, 2);
      for (let i = 0; i < 200 && !["done", "failed"].includes(getClickJob(job.id)?.status ?? ""); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const done = getClickJob(job.id);
      assert.equal(done?.status, "done");
      assert.equal(done?.ok, 2);
      assert.deepEqual(events, ["pause:clicks manuales", "resume"]);
      assert.equal(processingWorker.status().paused, false);
    } finally {
      processingWorker.pause = originalPause;
      processingWorker.resume = originalResume;
    }
  });
});
