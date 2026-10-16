# Contexto: ClickMaster (sms-link-checker)

Servicio Node 20 + TypeScript (Express, Playwright 1.48, mysql2, zod, p-limit) que corre 100% en Docker (`make` + `docker compose`). El README tiene el detalle operativo completo; esto es el mapa para trabajar en el código.

## Flujo
1. **Scheduler** (`service/scheduler.ts`): cada `SCHEDULER_TICK_SECONDS` llama a `runDueWindows()` (`service/ingestService.ts`). Las ventanas son de 30 min, alineadas en hora de la API. El cursor es el `MAX(window_end)` de `sync_runs` (kind=`scheduled`, success/partial). Una ventana fallida nunca se saltea.
2. **Ingesta**: `fetcher/apiClient.ts` hace POST JSON-RPC `Enterprise.Cursor`/`get_sms_edr` (auth en `params.auth`, fechas `YYYY.MM.DD HH:mm:ss` GMT-3, ver `edr/apiTime.ts`). Si la respuesta llega a `EDR_MAX_ROWS_PER_REQUEST` se parte el rango (`edr/windows.ts`). Los registros se validan con Zod de a lotes (`parser/smsRecordSchema.ts`) y `service/ingestBatch.ts` persiste cada lote en UNA transacción: upsert en `sms_content` (por PK `id`, nunca por UNIQUE) y fila en `sms_processing`.
3. **Lock de ingesta**: `GET_LOCK` de MySQL (`db/locks.ts`), entre instancias y liberado si el proceso muere.
4. **Worker** (`worker/processingWorker.ts`): reclama de `sms_processing` con `FOR UPDATE SKIP LOCKED` + `FORCE INDEX (idx_next_attempt)` (`db/processingRepo.ts`), con reservas `locked_by`/`locked_until`. Visita con `checker/linkChecker.ts` (un Chromium compartido) y guarda cada intento en `sms_link_checks` apenas termina. Clasificación y política de reintentos en `checker/classifyVisit.ts`.
5. **Clicks manuales** (`clicker/clickJob.ts`): pausan el worker (`processingWorker.pause/resume`) para que nunca haya dos Chromium abiertos. Su estado sigue en memoria.
6. **HTTP**: `http/app.ts` (sync, recover, clicks) + `http/reportsRoutes.ts` / `db/reportsRepo.ts` (reportes paginados por keyset). `server.ts` arranca todo y hace el apagado ordenado con SIGTERM.
7. **Dashboard**: `public/` (HTML + JS sin dependencias, graficos SVG a mano) servido en `/` sin token; datos en `http/dashboardRoutes.ts` (`/dashboard/data|checks|sms`, cache con single-flight) → `db/dashboardRepo.ts`. Todo por `db/reportsPool.ts`: pool aparte de 2 conexiones, READ ONLY, `MAX_EXECUTION_TIME`. Las consultas del dashboard nunca usan el pool de la app.

## Tablas
- `sms_content`: producción. **Nunca alterarla** (ni índices ni UNIQUE). `schema.test.ts` lo verifica.
- `sms_processing`: identidad (UNIQUE `client_message_id, vendor_message_id`) + cola. Estados: pending, processing, retry, success, failed, skipped. `next_attempt_at` solo tiene valor en pending/retry.
- `sms_link_checks`: un registro por intento. Se migra con ALTERs aditivos si faltan columnas/indices (`idx_checked_outcome` cubre los graficos del dashboard).
- `sync_runs`: una fila por ventana ingerida.

## Restricciones
- Servidor de 1 núcleo / 2 GB: `CHECK_CONCURRENCY` es el límite global de Chromium (default 4).
- Chromium se lanza siempre con `launchBrowser()` (sin los handlers de señales de Playwright).
- Sin transacciones abiertas durante la API ni durante Playwright.
- No agregar infraestructura (Redis, colas): la cola es MySQL.

## Pendiente / a validar
- API EDR real: tope de filas, `end_date` inclusivo, paginación → `make edr-probe`.
- Producción: versión de MySQL/MariaDB (SKIP LOCKED), índice en `sms_content.vendor_message_id`, permisos DDL y `GET_LOCK` detrás de un proxy.
- Throughput: 4 sesiones ≈ 120 visitas/min, menos que 20.000 SMS cada 30 min con `CLICK_PERCENTAGE=100`. Ajustar mirando `queueLagSeconds`.
- Los jobs de clicks manuales siguen en memoria.

## Comandos
`make up | logs | queue | sync-status | runs | jobs | test | test-volume | edr-probe` (ver `make help`). Los tests corren contra `<DB_NAME>_test`, dentro del container de la app.

## Convenciones
- Código, comentarios, logs y mensajes de error en español, sin tildes en el código.
- Comentarios que explican el *por qué*.
- Logs con `log.info/warn/error/debug` de `src/logger.ts` (JSON por línea, con ids para correlacionar). No usar `console.log`.
- Módulos chicos por responsabilidad (fetcher / parser / edr / db / service / worker / checker / clicker / http).
- Datos externos validados con Zod. Tests con `node:test` + tsx (`test/unit`, `test/integration`, `test/volume`).
- Después de tocar `package.json`, correr `make lock`.
