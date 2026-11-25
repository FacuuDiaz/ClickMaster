# Contexto: ClickMaster (sms-link-checker)

Servicio Node 20 + TypeScript (Express, Playwright 1.48, mysql2, zod, p-limit) que corre 100% en Docker (`make` + `docker compose`). El README tiene el detalle operativo completo; esto es el mapa para trabajar en el código.

## Flujo
1. **Scheduler** (`service/scheduler.ts`): cada `SCHEDULER_TICK_SECONDS` llama a `runDueWindows()` (`service/ingestService.ts`). Las ventanas son de 30 min, alineadas en hora de la API. El cursor es el `MAX(window_end)` de `sync_runs` (kind=`scheduled`, success/partial). Una ventana fallida nunca se saltea.
2. **Ingesta**: `fetcher/apiClient.ts` hace POST JSON-RPC `Enterprise.Cursor`/`get_sms_edr` (auth en `params.auth`, fechas `YYYY.MM.DD HH:mm:ss` GMT-3, ver `edr/apiTime.ts`). Si la respuesta llega a `EDR_MAX_ROWS_PER_REQUEST` se pagina: se pide de nuevo desde la `edr_date` del ultimo registro hasta el mismo fin (`ingestRange` en `service/ingestService.ts`; los del segundo de corte se descartan por identidad). Si la respuesta viene desordenada, respaldo: partir en mitades (`edr/windows.ts#splitRange`). Los registros se validan con Zod de a lotes (`parser/smsRecordSchema.ts`) y `service/ingestBatch.ts` persiste cada lote en UNA transacción: upsert en `sms_content` (por PK `id`, nunca por UNIQUE) y fila en `sms_processing`.
3. **Lock de ingesta**: `GET_LOCK` de MySQL (`db/locks.ts`), entre instancias y liberado si el proceso muere.
4. **Worker** (`worker/processingWorker.ts`): reclama de `sms_processing` con `FOR UPDATE SKIP LOCKED` + `FORCE INDEX (idx_next_attempt)` (`db/processingRepo.ts`), con reservas `locked_by`/`locked_until`. Visita con `checker/linkChecker.ts` (un Chromium compartido) y guarda cada intento en `sms_link_checks` apenas termina. Clasificación y política de reintentos en `checker/classifyVisit.ts`.
5. **Clicks manuales** (`clicker/clickJob.ts`): pausan el worker (`processingWorker.pause/resume`) para que nunca haya dos Chromium abiertos. Su estado sigue en memoria.
6. **HTTP**: `http/app.ts` (sync, recover, clicks) + `http/reportsRoutes.ts` / `db/reportsRepo.ts` (reportes paginados por keyset). `server.ts` arranca todo y hace el apagado ordenado con SIGTERM.
7. **Dashboard**: `public/` (HTML + JS sin dependencias, graficos SVG a mano) servido en `/` sin token; datos en `http/dashboardRoutes.ts` (`/dashboard/data|checks|sms`, cache con single-flight) → `db/dashboardRepo.ts`. Todo por `db/reportsPool.ts`: pool aparte de 2 conexiones, READ ONLY, `MAX_EXECUTION_TIME`. Las consultas del dashboard nunca usan el pool de la app.
8. **Administracion web** (secciones por hash en `public/`: `common.js` + un JS por seccion). Vista **basica** (Panel `home.js` + Reportes) o **avanzada** (todo), elegida en el sidebar y guardada en `localStorage` (`cm_ui_mode`); `NAV[].basic` marca lo visible en la basica. Es solo UI, no control de acceso:
   - **Configuracion** (`settings/catalog.ts` + `settings/store.ts`, `/admin/settings`): precedencia base (`app_settings`) > `.env` > default. El store escribe sobre `config` (mutable) y solo toca claves con override; el resto del codigo lee `config` en vivo (el worker ya no copia su config al construir). `server.ts` escucha `scheduler.enabled`/`worker.enabled` para prender/apagar. Recarga cada 30 s.
   - **Politicas** (`policies/`, `/admin/policies`): match → primera por prioridad. En la ingesta `select.ts#assign` solo asigna politica y deja los SMS `skipped` + `skip_reason = en_seleccion`; `windowSelect.ts` elige sobre el periodo completo: al final de `ingestWindow` (base `ventana` y `semana_anterior`, cuota diaria de `historical.ts#weeklyBaseline` repartida con `strategies.ts#dayCurve`) y en `sweepClosedDays` desde `runDueWindows` (base `dia_vencido`, dias ya cerrados). Base `dia_anterior` (`previousDay.ts`): objetivo acumulado = X % x SMS de ayer hasta esa hora (`alaris/usageStats.ts`, GET `sms_usage_stats` de la REST API, cacheado en `alaris_usage_days`; respaldo: conteo local) x proporcion con link de hoy. Base `semana_referencia` (`referenceWeek.ts`, `weekStart`): igual pero la referencia es el mismo dia de la semana elegida; con ella activa la ingesta entra en **modo descarte** (`ingestService.ts#discardMode`): junta la ventana en memoria y `discardSelect.ts#selectInMemory` guarda solo los elegidos; activarla pone la ventana en 60 min (`policiesRoutes.ts#ensureHourWindow`). Toda ingesta escribe `ingest_minute_counts` (`db/minuteCountsRepo.ts`, solo minutos completos de la ventana: idempotente); la proporcion con link sale de ahi (`previousDay.ts#linkRatio`). Panel: `public/homeWeek.js` (`/admin/policies/:id/week[/refresh]`). Estrategias puras en `strategies.ts#pickIndices`. Horario por politica (`schedule.ts`, via `next_attempt_at`), topes (contados al elegir) y opciones de visita (las aplica el worker por `policy_id`). 3 de fabrica: `repo.ts#seedDefaultPolicies`. **Una sola activa** (`setActivePolicy`, `ensureSingleActive`); **sin ninguna activa todo queda en espera**: `runDueWindows` devuelve `waiting`, `runManualWindow` tira `NoActivePolicyError` (409), el retome no hace nada y el worker de produccion no reclama (`productionGate`). Cambiar la activa o sus reglas registra un `policy_changes` y `retake.ts#runPendingChanges` (con el lock de ingesta: desde la ruta enseguida y en cada `runDueWindows`) re-asigna y re-elige todo el dia en curso; `windowSelect.ts#reselect` elige sobre todos los SMS del periodo y con `repeat_mode` decide si un ya clickeado cuenta (`igual`) o vuelve a la cola (`doble`). `sms_processing.clicks` = clicks realizados (+1 solo si el sitio respondio 200 en `completeAttempt`; `reselect` reintenta los visitados con clicks = 0). Cantidad por ventana con arrastre del redondeo en el dia (`windowSelect.ts#carriedCount`). Topes por `selected_at` (`idx_policy_selected`), no por `created_at`. `policyInputSchema.enabled` default false.
   - **Cumplimiento** (Reportes → Cumplimiento): `policies/compliance.ts` (objetivo por base, estado, proyeccion) + `db/complianceRepo.ts` (por el pool de reportes), rutas en `http/dashboardRoutes.ts` (`/dashboard/compliance[/hourly]`), UI en `public/compliance.js`.
   - **Horario global de visitas** (`policies/visitHours.ts`, `config.visitHours`): fuera de horario el worker no reclama.
   - **Capturas** (`captures/`, `/admin/captures`): `fetcher/apiClient.ts` guarda respuestas segun `capture.mode`; analisis bajo demanda, una a la vez, con cache de la ultima. Reprocesar = `runManualWindow` con `captureFetcher`.
   - **Historial**: `config_audit` (`db/auditRepo.ts`); toda escritura desde la web audita con el actor (`X-Actor`).

## Tablas
- `sms_content`: producción. **Nunca alterarla** (ni índices ni UNIQUE). `schema.test.ts` lo verifica.
- `sms_processing`: identidad (UNIQUE `client_message_id, vendor_message_id`) + cola. Estados: pending, processing, retry, success, failed, skipped. `next_attempt_at` solo tiene valor en pending/retry. `skipped` + `en_seleccion` = todavia no se eligio (`idx_held`).
- `sms_link_checks`: un registro por intento. Se migra con ALTERs aditivos si faltan columnas/indices (`idx_checked_outcome` cubre los graficos del dashboard).
- `sync_runs`: una fila por ventana ingerida.
- `app_settings`, `config_audit`, `policies`, `policy_changes`, `edr_captures`, `alaris_usage_days`, `ingest_minute_counts`: administracion web (ver arriba). `sms_processing.policy_id` + `idx_policy_edr` / `idx_policy_created`.

## Restricciones
- Servidor de 1 núcleo / 2 GB: `CHECK_CONCURRENCY` es el límite global de Chromium (default 4).
- Chromium se lanza siempre con `launchBrowser()` (sin los handlers de señales de Playwright).
- Sin transacciones abiertas durante la API ni durante Playwright.
- No agregar infraestructura (Redis, colas): la cola es MySQL.

## Pendiente / a validar
- REST API de Alaris (`sms_usage_stats`): validar contra la real la URL base, que `dcheck` venga en la hora de `EDR_TIMEZONE_OFFSET` y con hora (use_hourly_data=1), que `product_id` sea el mismo `client_product_id` y que el certificado TLS valide (la doc usa `curl -k`).
- API EDR real: `end_date` inclusivo → `make edr-probe`. (Confirmado: las respuestas vienen ordenadas por `edr_date`, asi que la paginacion por ultimo registro es el camino normal; el respaldo de mitades queda solo como red de seguridad.)
- Producción: versión de MySQL/MariaDB (SKIP LOCKED), índice en `sms_content.vendor_message_id`, permisos DDL y `GET_LOCK` detrás de un proxy.
- Throughput: 4 sesiones ≈ 120 visitas/min, menos que 20.000 SMS cada 30 min con `CLICK_PERCENTAGE=100`. Ajustar mirando `queueLagSeconds`.
- Los jobs de clicks manuales siguen en memoria.
- Capturas en modo `todas` contra la API real: tamano del gzip vs `max_allowed_packet` y CPU por ventana.

## API de Alaris
Doc: https://eapi.demo.alarislabs.com/eapi/others.html (`get_sms_edr`). Sin paginacion propia; sin `orderby_clause` el orden no esta garantizado, por eso `buildRequest` manda siempre `orderby_clause: "edr_date asc"`. `client_product_id` figura como number en la doc (la app lo manda como string; `EDR_EXTRA_ARGS` lo puede pisar numerico).

## Comandos
`make up | logs | queue | sync-status | runs | jobs | test | test-volume | edr-probe` (ver `make help`). Los tests corren contra `<DB_NAME>_test`, dentro del container de la app.

## Convenciones
- Código, comentarios, logs y mensajes de error en español, sin tildes en el código.
- Comentarios que explican el *por qué*.
- Logs con `log.info/warn/error/debug` de `src/logger.ts` (JSON por línea, con ids para correlacionar). No usar `console.log`.
- Módulos chicos por responsabilidad (fetcher / parser / edr / db / service / worker / checker / clicker / http).
- Datos externos validados con Zod. Tests con `node:test` + tsx (`test/unit`, `test/integration`, `test/volume`).
- Después de tocar `package.json`, correr `make lock`.
