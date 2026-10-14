import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { classifyError, classifyResponse, retryPolicy } from "../../src/checker/classifyVisit";

describe("clasificacion de visitas", () => {
  test("respuestas HTTP", () => {
    assert.equal(classifyResponse(200, true), "cargada");
    assert.equal(classifyResponse(200, false), "indeterminado");
    assert.equal(classifyResponse(200, null), "indeterminado");
    assert.equal(classifyResponse(null, null), "indeterminado");
    assert.equal(classifyResponse(404, null), "http_4xx");
    assert.equal(classifyResponse(429, null), "http_429_408");
    assert.equal(classifyResponse(503, null), "http_5xx");
  });

  test("errores de Chromium", () => {
    assert.equal(classifyError("page.goto: Timeout 15000ms exceeded."), "timeout");
    assert.equal(classifyError("page.goto: net::ERR_NAME_NOT_RESOLVED at http://x.invalid"), "dns");
    assert.equal(classifyError("net::ERR_CERT_DATE_INVALID"), "certificado");
    assert.equal(classifyError("net::ERR_CONNECTION_REFUSED"), "conexion");
    assert.equal(classifyError("net::ERR_TOO_MANY_REDIRECTS"), "navegacion");
    assert.equal(classifyError("Download is starting"), "navegacion");
    assert.equal(classifyError("Target page, context or browser has been closed"), "error_interno");
    assert.equal(classifyError("net::ERR_SOMETHING_NEW"), "conexion");
    assert.equal(classifyError("algo raro"), "error_interno");
  });

  test("politica de reintentos", () => {
    assert.equal(retryPolicy("cargada"), "exito");
    assert.equal(retryPolicy("timeout"), "transitorio");
    assert.equal(retryPolicy("http_5xx"), "transitorio");
    assert.equal(retryPolicy("http_4xx"), "definitivo");
    assert.equal(retryPolicy("certificado"), "definitivo");
  });
});
