# sms-link-checker

Pipeline local: pide CDRs de SMS a una API, los carga (upsert) en `sms_content`
(MySQL 8 / MariaDB), extrae el
link embebido en el campo `text` de cada uno, y los verifica todos en
paralelo con Playwright (solo health-check: status HTTP, no scraping).
El resultado de cada verificación queda en una tabla nueva, `sms_link_checks`,
con historial completo (útil para cuando se agregue el scheduler periódico).

## Cómo correr

Todo corre en containers: solo hace falta Docker + `make` (no Node ni MySQL nativos).
`make help` lista todos los comandos.

### Local (app + MySQL 8 + API mock)

```bash
make up          # crea .env y package-lock.json si faltan, buildea y levanta todo
make health      # {"status":"ok"}
make sync        # dispara un sync (POST /sync)
make db-checks   # ultimos chequeos guardados
make logs        # logs de la app
make down        # baja todo (clean = baja y borra los datos de MySQL)
```

- MySQL queda expuesto en el host en `localhost:3307` (user/pass en `.env`).
- La API mock (`docker/mock-api/cdrs.json`, servida por nginx en `localhost:8080`)
  trae 4 SMS: un link OK, un 404, un dominio inexistente y uno sin link.
  `docker/mock-api/cdrs-dump.json` tiene los 20.000 CDRs del dump real
  (`API_URL=http://mock-api/cdrs-dump.json`).
  Para usar la API real, cambiar `API_URL`/`API_TOKEN` en `.env`.
- `make lock` regenera `package-lock.json` dentro de un container de Node
  (correrlo cada vez que se toque `package.json`).

### Servidor

Usa `docker-compose.prod.yml`: solo la app, conectada a la red externa
`tmob_network` donde ya está la base.

1. Copiar el repo (con `package-lock.json`) y crear `.env` con `DB_HOST` =
   nombre del container de la base, credenciales reales y `API_URL`/`API_TOKEN` reales.
2. `make prod-up`
3. `make health` / `make prod-sync` / `make prod-logs`

El puerto queda en `127.0.0.1:3000` a propósito (`/sync` no tiene auth).

## Muestreo de clicks

`CLICK_PERCENTAGE` (0-100, default 100) define a qué porcentaje de los SMS
con link se les hace click en cada corrida. La muestra es aleatoria y de
cantidad exacta (redondeada): con 1000 SMS con link y `CLICK_PERCENTAGE=30`
se chequean exactamente 300. Todos los SMS se cargan igual en `sms_content`;
los SMS sin link no cuentan para el porcentaje. La respuesta de `/sync`
incluye `linksFound`, `linksSelected` y `clickPercentage`.

## Clicks manuales (URL × cantidad)

Además del sync, se puede pedir que una URL se abra N veces. Cada visita usa un
`BrowserContext` nuevo (sin cookies compartidas), se queda en la página un
tiempo al azar entre `CLICK_DWELL_MIN_MS` y `CLICK_DWELL_MAX_MS` (default
3–7 s), se cierra y el slot pasa a la siguiente. Corren `CHECK_CONCURRENCY`
sesiones en paralelo.

- **Duración:** ≈ `COUNT × 5 s ÷ CHECK_CONCURRENCY` (17114 visitas con 8 en
  paralelo ≈ 3 h). En el servidor (1 núcleo, 2 GB) no conviene pasar de 8;
  con `CLICK_BLOCK_RESOURCES=true` (no baja imágenes, fuentes ni video)
  se puede probar 10–12. Los píxeles de tracking que sean imágenes no se
  disparan con esa opción.
- **Lanzar:** `make clicks URL=https://... COUNT=50`
  (o `POST /clicks` con `{"url": "...", "count": 50}`, responde `202` al instante).
- **Progreso:** `make clicks-status` (`GET /clicks`: job en curso + últimos 20;
  `GET /clicks/:id` para uno) o `make logs`, que muestra cada visita
  (`[clicks <id>] 12/50 ok (HTTP 200)`). Cuando `current` es `null` ya se
  puede lanzar otro.
- **Cancelar:** `make clicks-cancel` (`POST /clicks/cancel`). No arranca más
  visitas; las abiertas terminan su sesión (unos segundos) y el job pasa de
  `cancelling` a `cancelled`.
- Un job a la vez y nunca en paralelo con `/sync` (los dos levantan Chromium
  y el container tiene 2 GB): si hay algo corriendo responde `409`.
  `CLICK_JOB_MAX_COUNT` (default 1000) es el tope de `count`.
- El estado de los jobs vive en memoria (se pierde si se reinicia el
  container); no se guarda nada en la base.

## Decisiones de diseño (por si hay que revisarlas)

- **Upsert a nivel aplicación, no con `ON DUPLICATE KEY`:** la tabla
  `sms_content` ya existe en producción y no confirmamos que tenga una unique
  key sobre `(client_message_id, vendor_message_id)`. Por eso el repo hace
  `SELECT` primero y decide `INSERT` o `UPDATE` (`src/db/smsContentRepo.ts`).
  Si en algún momento se agrega esa unique key en la base real, se puede
  simplificar a un solo `INSERT ... ON DUPLICATE KEY UPDATE`.
- **`CREATE TABLE IF NOT EXISTS` para `sms_content`:** es un no-op contra la
  base real (ya existe), pero deja el proyecto levantable contra una base
  nueva/de test sin pasos manuales.
- **`sms_link_checks` sin `FOREIGN KEY` real:** referencia a `sms_content.id`
  solo por índice, no por constraint, porque no sabemos con certeza el
  engine/charset de la tabla real y una FK podría fallar en el `CREATE TABLE`
  si no son compatibles.
- **Extracción del link:** regex simple sobre `text` (`src/parser/extractLink.ts`).
  Queda como función separada porque se va a reusar cuando exista el
  scheduler (ese proceso va a leer filas ya guardadas, no el JSON de la API).
- **Concurrencia de Playwright:** un solo `Browser` para toda la corrida, un
  `BrowserContext` por link, limitado por `CHECK_CONCURRENCY` vía `p-limit`
  (`src/checker/linkChecker.ts`) — sin delays artificiales entre navegadores,
  arranca el siguiente apenas se libera un slot. Default 8, pensado para
  ajustarse mirando el uso real de memoria del container (Chromium headless
  es pesado en RAM, más que en CPU).

## Pendiente / a confirmar con el equipo

- **Formato de la API real** (confirmado con un dump de 20.000 CDRs,
  `dumps/respuesta.json`): responde JSON-RPC (`{"result":{"data":[...]}}`),
  prefija algunas keys con `t#` (`t#tech_details_json`, `t#translated_text`) y
  manda fechas como `2026.09.30 12:18:55`. `src/parser/smsRecordSchema.ts`
  normaliza todo eso (y sigue aceptando el array plano con fechas ISO de los
  mocks). Las fechas de la API vienen sin zona, en hora local GMT-3: se
  convierten y se guardan en UTC (`2026.09.30 12:18:55` → `15:18:55` UTC).
- **Autenticación real contra la API externa** (`src/fetcher/apiClient.ts`
  asume Bearer token opcional vía `API_TOKEN`; si es otro esquema de auth,
  cambiar ahí).
- **Scheduler periódico:** todavía no implementado a propósito (se pidió
  dejarlo para después). Cuando se agregue, el punto de entrada natural es
  llamar a `runSync()` (`src/service/syncService.ts`) desde un cron interno
  o un trigger externo que le pegue a `POST /sync` — no hace falta tocar el
  resto del pipeline.
