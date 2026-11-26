# sms-link-checker (ClickMaster)

Servicio automático que cada 30 minutos pide los SMS EDR a la API
(JSON-RPC `Enterprise.Cursor` / `get_sms_edr`), los guarda en `sms_content`
(MySQL 8 / MariaDB) y verifica con Playwright los links que traen en el
campo `text`. Las verificaciones salen de una **cola persistente en MySQL**:
sobreviven a reinicios, se reintentan con límite y cada resultado se guarda
apenas termina su visita.

En el funcionamiento normal no hay que ejecutar nada a mano: el servicio
levanta, pide las ventanas cerradas y drena la cola solo.

```
            cada 60 s: ¿hay una ventana de 30 min cerrada sin pedir?
 ┌───────────┐   ┌──────────────────────────────┐   ┌──────────────────────┐
 │ Scheduler │──>│ Ingesta (lock GET_LOCK)      │──>│ sms_content (prod)   │
 └───────────┘   │ API EDR -> valida de a lotes │   │ sms_processing (cola)│
                 │ -> upsert + trabajo, 1 txn   │   │ sync_runs (corridas) │
                 └──────────────────────────────┘   └──────────┬───────────┘
                                                               │ SKIP LOCKED
                 ┌──────────────────────────────┐              │ lotes chicos
                 │ Worker: CHECK_CONCURRENCY    │<─────────────┘
                 │ visitas en un Chromium       │──> sms_link_checks
                 │ compartido                   │    (un registro por intento)
                 └──────────────────────────────┘
```

## Cómo correr

Todo corre en containers: solo hace falta Docker + `make`. `make help`
lista todos los comandos.

```bash
make up            # crea .env si falta, buildea y levanta app + MySQL (+ mock si COMPOSE_PROFILES=mock)
make health        # base + estado del worker
make sync-status   # última corrida y cursor del scheduler
make queue         # resumen de la cola y de los resultados
make logs          # logs JSON de la app
make down          # baja todo (make clean = baja y BORRA los datos de MySQL)
```

### Local con el mock

Con `COMPOSE_PROFILES=mock` (default en `.env.example`) se levanta `mock-edr`
(`docker/mock-edr/server.js`): una API JSON-RPC de mentira que genera
`MOCK_EDR_PER_MINUTE` SMS por minuto (determinísticos: rangos solapados
devuelven los mismos ids), corta en `MOCK_EDR_MAX_ROWS` filas como la API
real, y sirve las páginas de destino de los links (`/ok`, redirección, 404,
500, vacía, lenta y un dominio inexistente) para ver todos los resultados.

### Contra la API EDR real

En `.env`: `COMPOSE_PROFILES=` (vacío), `EDR_URL`, `EDR_AUTH`,
`EDR_CLIENT_PRODUCT_ID`, `EDR_COUNTRY`. Antes de dejarlo corriendo, validar
la API con una consulta de solo lectura:

```bash
make edr-probe START="2026.10.14 09:00:00" END="2026.10.14 09:05:00"
```

Reporta filas, duración y tamaño de la respuesta, rango real de `edr_date`,
si llegó al tope de filas y si `end_date` es inclusivo. No guarda nada.
**Alaris está restringida por IP: correrlo en el servidor.** Conviene probar
también una ventana completa de 30 minutos, para medir cuánto tarda de
verdad y ajustar `EDR_HTTP_TIMEOUT_MS` con margen.

`EDR_START_DATE` define la primera ventana cuando la base no tiene corridas;
si está vacío arranca por la última ventana cerrada (no hace backfill).

## Dashboard

`http://localhost:3000/` (en el servidor, por túnel SSH:
`ssh -L 3000:localhost:3000 usuario@servidor` y abrir
`http://localhost:3000/` en tu navegador).

- **Rango:** última media hora por defecto; 1 h, 6 h, 24 h, 7 días o un
  rango personalizado (hasta `REPORTS_MAX_RANGE_DAYS`). Los rangos
  relativos se actualizan solos cada 30 s mientras la pestaña está visible.
- **Indicadores del rango:** % de páginas cargadas, verificaciones, errores
  del sitio, errores técnicos, tiempo de carga promedio y SMS ingestados.
  También muestra la cola en este momento (pendientes, en proceso,
  reintentos, atraso) y la última ingesta de Alaris.
- **Gráficos de evolución:** verificaciones por resultado (los 11 resultados
  agrupados en cargada / error del sitio / indeterminado / error técnico),
  SMS ingestados y tiempo de carga promedio. Cada uno tiene tooltip y su
  tabla de datos.
- **Listados paginados** (25 por página, los más recientes primero): links
  verificados, filtrables por resultado, y SMS procesados, filtrables por
  estado.
- Si hay `ADMIN_TOKEN`, la página lo pide una vez y lo guarda en la pestaña.

**Para que no afecte a la ingesta ni al worker:**

| Medida | Qué evita |
|---|---|
| Pool de MySQL propio (`REPORTS_DB_CONNECTION_LIMIT=2`) con cola acotada | Que muchas pestañas abiertas le saquen conexiones a la app: la ingesta y el worker conservan su pool entero |
| Sesiones en `READ ONLY` y `READ COMMITTED` | Escrituras accidentales y vistas viejas abiertas; los `SELECT` de InnoDB no bloquean filas |
| `MAX_EXECUTION_TIME` (`REPORTS_QUERY_TIMEOUT_MS`) | MySQL corta una consulta pesada en vez de dejarla corriendo; el dashboard responde 503 y pide un rango más chico |
| Caché compartida de 15 s con single-flight | N pestañas o refrescos simultáneos = 1 consulta |
| Gráficos *index-only* (`idx_checked_outcome`, `idx_created_at`) | Agregar por tiempo sin leer las filas (link, error, texto) |
| Paginación por keyset (fecha, id), sin `OFFSET` ni `COUNT(*)` | Cada página lee ~25 filas aunque el rango tenga millones |
| Rango máximo y ≤ 60 intervalos por gráfico | Consultas acotadas y respuestas chicas |

`REPORTS_DB_USER`/`REPORTS_DB_PASSWORD` permiten usar un usuario de MySQL
de solo lectura para el dashboard (opcional: la sesión igual es `READ ONLY`).

## Administración desde la web

La misma página tiene secciones (sidebar a la izquierda). Todas usan el mismo
`ADMIN_TOKEN` opcional que el resto de los endpoints. "Tu nombre" (abajo a
la izquierda) queda en el historial de cambios: es trazabilidad, no autenticación.

Arriba del sidebar se elige la **vista**:

- **Básica** (la de arranque): solo **Panel** y **Reportes**. El Panel muestra
  en una pantalla si está corriendo, un botón **Iniciar/Detener** (pausa o
  reanuda ingesta y worker juntos, igual que en Operación), la petición a
  Alaris (producto, país, cada cuánto se consulta y porcentaje a visitar) y
  "pedir un rango ahora" (`/sync`).
- **Avanzada**: todas las secciones de abajo (y también el Panel).

La vista se recuerda por navegador (`localStorage`). **No es un control de
acceso**: cualquiera puede pasar a la avanzada; lo único que protege la
administración sigue siendo `ADMIN_TOKEN` y publicar la app solo en 127.0.0.1.

| Sección | Qué permite |
|---|---|
| **Panel** | Lo básico en una pantalla (ver arriba) |
| **Configuración** | Editar en caliente fuente Alaris (URL, producto, país, args extra, timeouts, tope de filas), cada cuánto se consulta a Alaris (tamaño de ventana), ingesta automática, worker, porcentaje por defecto, clicks y capturas. Muestra de dónde sale cada valor (web / `.env` / default) y permite volver al de `.env`. Credenciales, base, puerto y zona horaria siguen solo en `.env` (sección **Entorno**) |
| **Políticas** | Reglas de qué SMS visitar, cuántos, cuándo y cómo (ver abajo), con vista previa sobre las últimas horas |
| **Capturas** | Respuestas de Alaris guardadas temporalmente: resumen, registros, simular políticas, reprocesar, conservar o descartar |
| **Operación** | Pausar/reanudar ingesta y worker (queda guardado), pedir una ventana a mano, recuperar reservas y lanzar/seguir/cancelar clicks manuales |
| **Historial** | Quién cambió qué y cuándo (configuración, políticas, acciones, capturas) |

**Fuente Alaris por variables o por curl:** en Configuración → Fuente Alaris
se puede editar campo por campo o ver/editar la petición completa como un
`curl` (URL, método, cursor, producto, país, argumentos extra, `--max-time`
y `--retry`). Las dos vistas editan lo mismo y se guardan juntas. Las fechas
(`<inicio>`/`<fin>`) las pone la ingesta y la credencial sale de `.env`.

**Entorno (.env):** lo que solo se cambia en `.env` se puede ver por
variables (tarjetas con explicación) o como archivo `.env` (solo lectura,
secretos ocultos, las que no están en el archivo aparecen comentadas con su
default).

**Cada cuánto se consulta a Alaris:** es el tamaño de ventana
(`EDR_WINDOW_MINUTES`, editable: 5, 10, 15, 20, 30 min, 1 a 12 h o 1 día).
Se hace una consulta por ventana apenas cierra más el margen. Al cambiarlo,
la ventana siguiente se recorta hasta el próximo borde alineado: no quedan
huecos ni rangos repetidos.

**Precedencia de la configuración:** base (`app_settings`) > `.env` > default.
Lo guardado desde la web se aplica sin reiniciar; con varias instancias,
cada una relee la tabla cada 30 s.

### Políticas

Se evalúan por prioridad y **gana la primera que coincide**. Un SMS con
link que no coincide con ninguna usa el porcentaje por defecto
(`CLICK_PERCENTAGE`, al azar sobre cada ventana).

**Primero llega todo, después se elige.** Durante la ingesta cada SMS nuevo
queda `skipped` con `skip_reason = en_seleccion` y su `policy_id`. Cuando el
período llegó completo (`src/policies/windowSelect.ts`) se elige cuáles
visitar: los elegidos pasan a `pending` y el resto a `fuera_de_muestra` (o
`tope_politica`). Si algo falla, siguen `en_seleccion` y se eligen en el
reintento de la ventana o en el barrido de días cerrados de cada chequeo del
scheduler.

Cada política define:

- **Qué SMS toma:** listas de clientes, senders, países, redes, MCC/MNC,
  vendors y dominios del link (`*.dominio.com` incluye subdominios). Vacío = todos.
- **Cuántos visita** (`no visitar`, o un X % sobre una base):
  - **De cada ventana:** X % de los SMS de la ventana, elegido al terminar de ingestarla.
  - **Día vencido:** X % de todos los SMS del día anterior, elegidos entre los
    SMS de ese día cuando el día cerró. Los de hoy no se visitan hasta mañana.
  - **Mismo día de la semana anterior:** cuota del día = X % del total del
    mismo día de la semana anterior (o el promedio de 1-4 semanas). Se visita
    entre los SMS de hoy, repartida en las ventanas del día según la
    estrategia. Sin datos de esa semana usa X % de cada ventana. La referencia
    se cuenta por `policy_id`; si la política es nueva y toma todos los SMS, se
    usa el total de SMS con link.
  - **Día anterior (curva horaria de ayer):** al llegar a la hora H de hoy se
    apunta a X % de los SMS que mandó el producto ayer hasta la hora H, por la
    proporción de SMS de la política (con link) entre todos los ingeridos hoy.
    Lo de ayer sale de `sms_usage_stats` de la REST API de Alaris (`count_ok`,
    cubos horarios, `ALARIS_REST_URL` + `ALARIS_REST_AUTH`; se guarda en
    `alaris_usage_days`, se repite hasta 3 h después del cierre del día y, si
    falla, a los 15 min). Sin REST API o si falla, usa lo ingerido ayer. Se
    visita entre los SMS de hoy; lo que falte en una hora pasa a la siguiente.
  - **Semana de referencia (por día y hora):** se elige una semana cerrada
    (`weekStart`) y se bajan sus 7 días de `sms_usage_stats` hora por hora.
    A cada hora de hoy le toca X % de lo que hubo a esa misma hora el mismo día
    de la semana de referencia (martes con martes), por la proporción con link
    de hoy. Con esta política activa la ventana de ingesta pasa a 60 min y
    **solo se guardan los SMS elegidos**: la ventana se junta en memoria, se
    elige con la estrategia y el resto se descarta (queda contado en
    `ingest_minute_counts`). El Panel muestra el gráfico de la semana con lo de
    hoy encima del día equivalente y un botón para volver a bajarla. Un cambio
    de política a mitad del día solo puede re-elegir entre lo guardado.
- **Cuáles visita (estrategia),** sobre los SMS del período ordenados por
  `edr_date` (`src/policies/strategies.ts`): intercalado (parejo), aleatorio,
  primeros, últimos, progresivo (más seguidos hacia el final), regresivo (al
  revés) y fibonacci (saltos 1,1,2,3,5,8 que se reinician). El editor muestra
  un ejemplo de cada una (`GET /admin/policies/strategies`).
- **Cuándo:** días y franjas horarias (hora de Alaris). Fuera de horario el
  SMS queda `pending` con `next_attempt_at` en la próxima franja.
  **Repartir los clicks** (`schedule.spread`, apagado por defecto): en vez de
  mandar a la cola todos los elegidos de una ventana con el mismo
  `next_attempt_at`, se reparten parejo a lo largo de la ventana siguiente
  (`EDR_WINDOW_MINUTES`; 60 min con semana de referencia), sin contar el
  tiempo fuera de franja. Se sigue haciendo un solo `get_edr` por ventana.
- **Topes:** máximo de aprobados por hora y por día; el excedente queda
  `skipped` con `skip_reason = tope_politica`.
- **Cómo visita:** permanencia, timeout, intentos máximos y bloqueo de
  recursos (pisan a los globales).

**Una sola activa.** Prender una apaga la que estaba (también lo garantiza el
servidor: `setActivePolicy`, y al arrancar `ensureSingleActive` deja solo la
primera si había varias). **Sin ninguna activa el sistema queda en espera:**
la ingesta automática y la manual (`/sync`, reprocesar y pedir capturas → 409) no le
piden nada a Alaris, no se elige nada (ni día vencido ni retome) y el worker no
toma SMS de la cola. Las ventanas no se saltean: al activar una, la ingesta
retoma desde el cursor. `/admin/status` lo muestra en `policy.active = null` y
`worker.waiting = "sin_politica"`. Los clicks manuales de una URL (no son SMS)
siguen funcionando. Con una activa, los SMS que no coinciden con ella usan la
regla por defecto.

**Cambios en ejecución.** Activar otra, desactivar la activa, borrarla o
editar sus reglas registra un cambio en `policy_changes` y lo aplica en
segundo plano (`src/policies/retake.ts`, con el lock de ingesta) sobre **todo
el contenido del día en curso** (desde las 00:00, hora de Alaris):

1. Re-asigna los SMS de hoy (leyendo `sms_content`) a la política nueva. Los
   salteados vuelven a `en_seleccion`; lo que ya está en cola o clickeado
   conserva su estado.
2. Vuelve a elegir las ventanas de hoy que ya llegaron (base "día vencido": se
   elige mañana al cerrar el día, sobre todos los SMS de hoy).

Antes de confirmar, la web muestra un aviso para elegir qué pasa si la regla
nueva vuelve a elegir un SMS ya clickeado (`repeat_mode`):

- **Cuenta igual** (`igual`): no se visita de nuevo; ese click cuenta para la cuota.
- **Cuenta como otro click** (`doble`): vuelve a la cola (`attempts = 0`) y se
  visita otra vez.

`sms_processing.clicks` guarda los **clicks realizados** de cada SMS: suma 1
por cada visita a la que el sitio respondió **200** (la respuesta final,
después de las redirecciones). Un error del sitio (404, 500…), un timeout o un
DNS caído no cuentan (el intento igual queda en `sms_link_checks`). Un SMS
re-clickeado queda con 2. Si la regla nueva elige un SMS visitado que nunca
tuvo un 200 (`clicks = 0`), se vuelve a intentar en cualquier modo. Se ve en Reportes → Registros (columna Clicks).

**Redondeo con arrastre.** La cantidad de cada ventana se calcula sobre el
acumulado del día de la política (`carriedCount`): 10 ventanas de 2 SMS al
20 % dan 4 visitas en el día, no 0.

Los topes por hora/día cuentan por el momento en que se eligió el SMS
(`sms_processing.selected_at`), no por cuándo se ingestó: así "día vencido" y
el retome del día los respetan. Una política creada sin `enabled` nace
apagada. La vista previa estima como si la política en edición fuera la activa.

**Panel (vista básica):** además de la petición a Alaris, permite elegir la
política activa (o "ninguna": en espera) y cambiar su porcentaje; activar otra
o cambiar el porcentaje pasa por el mismo aviso de cambio en ejecución.

Endpoints: `POST /admin/policies/active {id|null, repeatMode}`,
`GET /admin/policies/changes`; `POST`/`PUT`/`DELETE` de políticas aceptan
`repeatMode` y devuelven `changeId` si fue un cambio en ejecución.

**Políticas de fábrica.** La primera vez (tabla vacía y sin historial de
políticas) se cargan tres, todas sobre todos los SMS, al 20 % e intercaladas:
de cada ventana (activa), día vencido y mismo día de la semana anterior
(apagadas: como toman todo, solo cuenta la primera activa). Si se borran
todas, la lista ofrece volver a cargarlas (`POST /admin/policies/defaults`).

**Horario de visitas global** (Configuración → Horario de visitas,
`VISIT_HOURS_ENABLED`, `VISIT_DAYS`, `VISIT_FROM`, `VISIT_TO`): fuera de él el
worker no toma SMS de la cola. No frena la ingesta ni la selección ni los
clicks manuales. Se suma al horario propio de cada política.

### Cumplimiento (Reportes → Cumplimiento)

Por día (de los SMS, hora de Alaris) y por política: **objetivo** contra
**SMS clickeados** (con al menos un 200), con el desglose de lo que falta (en
cola, en selección, recortados por tope, visitados sin 200, sin elegir).

- Objetivo con las reglas actuales de la política: *por ventana* y *por
  defecto* = X % de los SMS del día; *día vencido* = X % de los SMS del día,
  que se eligen y visitan al día siguiente; *semana anterior* = X % del mismo
  día de la semana anterior; *día anterior* = X % de los SMS de ayer por la
  proporción con link del día; *semana de referencia* = X % del mismo día de
  la semana de referencia por la proporción con link (de los contadores por
  minuto).
- Plazo: fin del día (día vencido: fin del día siguiente). Si al ritmo del
  worker en la última hora la cola no termina dentro de las horas de visita que
  quedan (respeta el horario global), aparece un aviso.
- "Ver avance por hora": elegidos y clickeados acumulados contra el objetivo
  (con tabla de datos).
- Endpoints (pool de reportes, solo lectura, con caché; los días cerrados se
  cachean 10 min): `GET /dashboard/compliance?days=7`,
  `GET /dashboard/compliance/hourly?day=AAAA-MM-DD&policy=<id|ninguna>`.
- Al migrar, `clicks` se completa desde los 200 de `sms_link_checks` y
  `selected_at` con `created_at` (una sola vez, al agregar cada columna).

### Capturas de Alaris

`EDR_CAPTURE_MODE` (editable desde la web): `off`, `errores` (default:
respuestas que fallan + registros inválidos de corridas `partial`) o `todas`
(cada respuesta completa, ~5 MB comprimidos y ~1 s de CPU por ventana).
Vencen a las `EDR_CAPTURE_RETENTION_HOURS` (las conservadas no) y se borran
las más viejas si pasan de `EDR_CAPTURE_MAX_TOTAL_MB`. Nunca guardan el
auth. También se puede **pedir y capturar un rango** sin ingestarlo.
Reprocesar una captura es igual que una ventana manual: idempotente.

## Comandos de operación

| Comando | Qué hace |
|---|---|
| `make sync` | Ingesta ya las ventanas cerradas pendientes (lo mismo que el scheduler) |
| `make ingest-window START=... END=...` | Ingesta una ventana puntual (diagnóstico / reproceso). No mueve el cursor |
| `make sync-once` | Igual que `make sync` pero por consola, sin HTTP |
| `make runs [STATUS=failed]` / `make run ID=` | Historial de corridas / detalle con trabajos por estado |
| `make queue [FROM= TO=]` | Pendientes, en proceso, éxitos, fallos, reintentos, errores técnicos, lag de la cola |
| `make jobs [STATUS= OUTCOME= BEFORE=]` / `make job ID=` | Trabajos paginados / un trabajo con el SMS y todos sus intentos |
| `make recover` | Devuelve a la cola las reservas vencidas (también lo hace solo cada minuto) |
| `make recover-force` | Devuelve a la cola **todo** lo que esté en `processing`. Solo con una instancia |
| `make edr-probe` | Consulta de diagnóstico a la API EDR |
| `make test` / `make test-volume` | Tests / prueba de volumen de 20.000 SMS |
| `make db-shell` / `make db-checks` | Consola MySQL / últimos intentos |

Las fechas de `FROM`, `TO`, `START` y `END` van en hora de la API
(`YYYY.MM.DD HH:mm:ss`) o en ISO 8601.

### Endpoints

Todos menos `/health` piden `Authorization: Bearer <ADMIN_TOKEN>` si
`ADMIN_TOKEN` está seteado (el Makefile lo manda solo). La app queda
publicada solo en `127.0.0.1:3000`.

| Método y ruta | Descripción |
|---|---|
| `GET /health` | Base + estado del worker |
| `POST /sync` | Sin body: ventanas pendientes. Con `{"start","end"}`: ventana manual. `409` si hay otra ingesta |
| `GET /sync/status` | Última corrida y cursor |
| `GET /sync/runs?status=&kind=&limit=&beforeId=` | Corridas, paginadas |
| `GET /sync/runs/:id` | Corrida + trabajos por estado |
| `GET /processing/summary?from=&to=` | Conteos por estado y outcome, reintentos, agotados, lag, última hora |
| `GET /processing/jobs?status=&outcome=&from=&to=&country=&clientProductId=&runId=&smsContentId=&limit=&beforeId=` | Trabajos, paginados (máx. 500 por página) |
| `GET /processing/jobs/:id` | Trabajo + SMS + historial de intentos |
| `POST /processing/recover` | `{"force": true}` opcional |
| `/clicks...` | Clicks manuales (abajo) |
| `GET/PUT /admin/settings`, `GET /admin/status`, `POST /admin/actions/{scheduler,worker}/{pause,resume}`, `GET /admin/audit` | Configuración, estado, acciones e historial |
| `GET/POST /admin/policies`, `PUT/DELETE /admin/policies/:id`, `POST /admin/policies/reorder`, `POST /admin/policies/preview` | Políticas |
| `GET/POST /admin/captures`, `GET/DELETE /admin/captures/:id`, `GET .../rows`, `POST .../simulate`, `.../reprocess`, `.../keep` | Capturas |

La paginación es por keyset: cada respuesta trae `nextBeforeId`, que se
pasa como `beforeId` para la página siguiente (`null` = no hay más).

## Cómo funciona

### Ventanas e ingesta

- El scheduler (`src/service/scheduler.ts`) revisa cada
  `SCHEDULER_TICK_SECONDS` si hay ventanas de `EDR_WINDOW_MINUTES` ya
  cerradas, contando `EDR_SAFETY_DELAY_MINUTES` de margen para EDR que
  llegan tarde. Las ventanas se alinean a la media hora en hora de la API
  (09:00–09:30, 09:30–10:00…).
- **El cursor sale de la base, no del reloj:** es el `window_end` de la
  última corrida programada exitosa (`sync_runs`). Después de un reinicio o
  de una caída de la API se piden todas las ventanas atrasadas en orden
  (hasta `EDR_MAX_WINDOWS_PER_TICK` por tick). Una ventana fallida nunca se
  saltea: se reintenta en el próximo tick.
- `EDR_OVERLAP_MINUTES` hace que cada consulta arranque antes del inicio de
  su ventana, para levantar EDR tardíos o actualizados (por ejemplo, SENT →
  DELIVRD). El solapamiento no duplica nada.
- A la API se le manda `start_date` y `end_date` exactos. Como no se sabe si
  `end_date` es inclusivo, el segundo del borde puede venir en dos ventanas:
  la deduplicación lo absorbe (es mejor duplicar un segundo que perderlo).
- **Una ingesta a la vez:** el lock es un `GET_LOCK` de MySQL, que vale para
  todas las instancias y se libera solo si el proceso muere (se cae la
  conexión). Las corridas que quedaron en `running` de un proceso muerto se
  marcan `failed` y la ventana se repite.
- La ingesta no corre Playwright: llena la cola y termina.

Estados de una corrida (`sync_runs.status`): `success`; `partial` (hubo
registros que no pasaron la validación: se guardó el resto y se reportan en
`records_invalid` / `error_message`, y el cursor avanza porque repetir la
ventana no los arregla); `failed` (error de la API o de la base: el cursor
no avanza).

### Memoria y límites reales de la API EDR

- **Alaris no pagina:** devuelve todo el rango en un solo JSON, y con
  ~20.000 SMS la respuesta puede tardar varios minutos. Por eso el cliente
  (`src/fetcher/httpPost.ts`) usa el módulo `http`/`https` de Node y no
  `fetch`: el `fetch` nativo corta solo a los 5 minutos sin headers o sin
  body, sin importar el timeout pedido. El único límite es
  `EDR_HTTP_TIMEOUT_MS` (10 min por defecto), sobre la respuesta completa.
  Cada respuesta loguea su duración y tamaño (`edr: respuesta recibida`).
  El JSON queda una vez en memoria (unos 40 MB por cada
  20.000 SMS reales, más los objetos parseados). No se hace ninguna otra
  copia completa: los registros se validan con Zod **de a lotes**
  (`INGEST_DB_BATCH_SIZE`) y el array original se va vaciando a medida que
  se persiste, así el GC libera la respuesta mientras se procesa.
- **Tope de filas: Alaris corta en 20.000 filas por consulta.** Con el
  producto 1286, `2026.10.02 00:45:00`–`00:46:30` trajo 20.000 justas, todas
  de una ráfaga de ~36 s, en ~40 s y ~40 MB. Si una respuesta llega a
  `EDR_MAX_ROWS_PER_REQUEST`:
  - **Ordenada por fecha**: la app manda siempre
    `orderby_clause: "edr_date asc"` (según la
    [doc de la EAPI](https://eapi.demo.alarislabs.com/eapi/others.html), sin
    ese argumento "sorting is disabled" y el orden no está garantizado;
    también soporta descendente). Se procesa y se pide
    la página siguiente **desde la fecha del último registro hasta el mismo
    fin** (descendente: mismo inicio hasta esa fecha). 60.000 SMS en 30 min
    = 3 consultas. Los registros del segundo de corte vuelven a llegar y se
    descartan por identidad. Tope de páginas por rango:
    `EDR_MAX_PAGES_PER_WINDOW` (50).
  - **Desordenada** (no debería pasar; red de seguridad): no hay un "último" confiable, así que se descarta y el
    rango se pide en dos mitades hasta `EDR_MIN_SPLIT_SECONDS` (respaldo:
    más lento, correcto con cualquier orden). Queda un `warn` en el log.
  - Si en un mismo segundo hay más registros que el tope (o la respuesta
    desordenada sigue en el tope en el rango mínimo), la corrida falla con un
    error explícito y se reintenta: nunca se pierden datos en silencio.
  - Ráfaga de 25.030 SMS con tope 20.000 (`make test-volume`): 2 consultas
    (partiendo en mitades eran 11).
- Prueba de volumen (`make test-volume`, 20.000 SMS sintéticos, MySQL local):
  ~2,3 s de ingesta, 325 consultas SQL (40 lotes de 500), pico de heap de
  ~80 MB. Una re-ingesta solapada no crea nada. Reclamar 16 trabajos con
  18.000 pendientes tarda ~4 ms.

**Lo que dice la doc de `get_sms_edr`** ([others.html](https://eapi.demo.alarislabs.com/eapi/others.html)):
no tiene paginación propia (sin `first_rec`/`rec_count`), no documenta el
tope de filas, si `end_date` es inclusivo ni la zona horaria. Tiene más
filtros que se pueden sumar en "Argumentos extra" (o en el curl): `is_last`,
`src_is_successful`, `dst_is_successful`, `vendor_product_id`, `edr_type`,
`status`/`op_status`, `sender_name`, `mccmnc`, `network`, `code_word`, etc.
Los operadores `op_*` aceptan `==`, `!=`, `>`, `<`, `>=`, `<=`, `=@`
(contiene), `!@`, `=~` (regex) y `!~`.

### Persistencia de SMS e identidad

- `sms_content` **no se modifica** (ni columnas, ni índices, ni UNIQUE). El
  test `schema.test.ts` lo verifica.
- La identidad de un SMS es `(client_message_id, vendor_message_id)`. En el
  dump real `vendor_message_id` es único y `client_message_id` se repite
  (402 veces en 20.000: multiparte o reruteos). Como en producción no está
  confirmada una UNIQUE, la UNIQUE vive en la tabla auxiliar
  `sms_processing`, que hace de identidad estable (`sms_content_id`) y de
  cola a la vez.
- Por lote, en **una sola transacción**: se buscan las identidades en
  `sms_processing`; las que no están se buscan en `sms_content` (filas de la
  versión anterior); los nuevos se insertan multi-fila; los existentes se
  actualizan en una sola sentencia `INSERT ... ON DUPLICATE KEY UPDATE` por
  la PRIMARY KEY (`id`), que sí existe seguro; y se crean los trabajos. Son
  como máximo 6 consultas por lote, sin importar su tamaño. Si algo falla
  se hace rollback del lote entero: nunca queda un SMS nuevo sin su trabajo.
- Un SMS que vuelve (ventana repetida, solapada o cambio de status) se
  actualiza en `sms_content` y **no** genera otro trabajo ni pisa el estado
  del que ya tiene.
- **Limitación:** si otro proceso, externo a esta app, inserta en
  `sms_content` en paralelo con las mismas identidades, podría quedar un
  duplicado en esa tabla. Sin una UNIQUE en producción no hay forma de
  impedirlo. Dentro de la app no pasa: lo evita el lock de ingesta.

### Cola de verificación (`sms_processing`)

```
pending ──claim──> processing ──cargada──────────────> success
retry   ──claim──┘      │──fallo transitorio────────> retry (backoff exponencial)
                        │──fallo definitivo / agotado─> failed
                        └──reserva vencida───────────> retry / failed
skipped: sin link (sin_link) o fuera de la muestra de CLICK_PERCENTAGE (fuera_de_muestra)
```

- **Reclamo:** `SELECT ... FOR UPDATE SKIP LOCKED` en una transacción corta
  en READ COMMITTED, forzando el índice `idx_next_attempt`. Sin el índice
  forzado, MySQL elegía full scan y bloqueaba toda la tabla. En REPEATABLE
  READ, el `FOR UPDATE` toma gap locks y dos workers reclamando a la vez
  terminaban en deadlock. Igual, las transacciones de la cola y de la
  ingesta se reintentan solas ante un deadlock. Dos workers nunca agarran la misma fila. Se
  reclaman lotes chicos (`WORKER_CLAIM_BATCH_SIZE`) solo cuando el buffer
  local está vacío: en memoria nunca hay más que `CHECK_CONCURRENCY` visitas
  en curso más un lote esperando.
- **Reserva:** `locked_by` + `locked_until` (`WORKER_LEASE_MS`). Se confirma
  y se extiende justo antes de abrir el navegador. Durante la visita no hay
  ningún lock de base.
- **Resultado:** cada visita, al terminar, hace una transacción corta que
  inserta el intento en `sms_link_checks` (siempre, para la trazabilidad) y
  actualiza el trabajo, solo si la reserva sigue siendo de ese worker.
- `next_attempt_at` solo tiene valor en `pending`/`retry`: así el índice
  devuelve directamente los próximos listos.

### Qué significa cada resultado (`outcome`)

Un HTTP 200 **no** prueba que alguien haya visto bien la página. `cargada`
significa: respondió 2xx/3xx, llegó a `domcontentloaded` y el `body` tiene
contenido. Lo que no se puede afirmar se marca `indeterminado`.

| outcome | qué pasó | política |
|---|---|---|
| `cargada` | 2xx/3xx + DOM con contenido | éxito |
| `indeterminado` | sin respuesta, body vacío o DOM ilegible | transitorio |
| `http_4xx` | 4xx salvo 408/429 | definitivo |
| `http_429_408` | rate limit / request timeout | transitorio |
| `http_5xx` | error del servidor | transitorio |
| `timeout` | no cargó en `LINK_CHECK_TIMEOUT_MS` | transitorio |
| `dns` | el dominio no resolvió (puede ser un DNS caído) | transitorio |
| `conexion` | rechazada, reseteada, inalcanzable | transitorio |
| `certificado` | TLS inválido | definitivo |
| `navegacion` | demasiadas redirecciones, descarga, URL inválida, puerto bloqueado | definitivo |
| `error_interno` | Chromium cerrado o crasheado | transitorio |
| `reserva_vencida` | el worker murió durante la visita | transitorio |

Transitorio = se reintenta hasta `JOB_MAX_ATTEMPTS`, con
`JOB_RETRY_BASE_DELAY_MS × 2^(intento-1)` de espera. Definitivo = `failed`
directo. Cada intento guarda `http_status`, `final_url` (si hubo
redirección), `redirects`, tiempos, `worker_id` y el error técnico.

### Recuperación e idempotencia

| Situación | Qué pasa |
|---|---|
| El container se cae después de pedir a EDR, antes de persistir todo | La corrida queda `running`, la próxima ingesta la marca `failed` y repite la ventana. Lo ya persistido se deduplica |
| Un lote se inserta a medias | Imposible: cada lote es una transacción (rollback completo) |
| Un SMS se guarda pero su trabajo no se crea | Imposible dentro de la app (misma transacción). Los SMS de la versión anterior sin trabajo reciben uno cuando la API los vuelve a mandar |
| Un worker reclama y muere | Al arrancar, el proceso nuevo del mismo container libera al toque las reservas del anterior (mismo hostname). Las de otros containers vuelven al vencer `locked_until` (chequeo cada minuto) |
| Playwright termina pero MySQL falla al guardar | Se reintenta 3 veces. Si sigue fallando se loguea el resultado y el trabajo vuelve por vencimiento de reserva: se visita de nuevo en vez de quedar con un estado inventado |
| Un worker lento termina después de que otro recuperó su trabajo | Su intento se guarda en el historial, pero no pisa el estado: gana el worker actual |
| La API devuelve registros de una ventana anterior o repetidos | Se actualizan sin crear trabajos nuevos |
| El scheduler quiere arrancar mientras otra ingesta corre | `GET_LOCK` no se consigue: el tick se saltea (`/sync` responde `409`) |
| `docker stop` | El worker devuelve a la cola lo que no empezó, espera las visitas abiertas (`stop_grace_period: 30s`) y cierra Chromium |

Garantía real: **al menos una vez**. No se puede prometer exactamente una
visita de punta a punta: un worker que muere después de visitar pero antes
de guardar genera una segunda visita. La identidad estable, el reclamo con
SKIP LOCKED y las reservas hacen que en la práctica sea una sola.

### Coordinación con los clicks manuales

Worker y clicks comparten el límite global `CHECK_CONCURRENCY` y nunca
tienen Chromium abierto a la vez. Un job de clicks pausa el worker: deja de
reclamar, devuelve lo que tenía sin empezar (sin gastar el intento), espera
sus visitas abiertas y cierra su navegador. Cuando termina la cola de clicks
el worker sigue. La ingesta no usa Chromium y puede correr en paralelo con
los clicks. Los trabajos automáticos nunca se pierden por un job manual.

### Observabilidad

Los logs son una línea JSON por evento, con `runId`, `windowStart`, `jobId`,
`smsContentId`, `attempt` y `workerId` para correlacionar. Cada corrida loguea
un resumen (`ingesta: fin`: duración, registros, nuevos, existentes,
trabajos, errores). El worker loguea un resumen por minuto (`worker:
resumen`: visitas, éxitos, reintentos, fallos, duración promedio, listos en
cola, errores de base). Cada visita individual va en nivel `debug`
(`LOG_LEVEL=debug`). Si una misma ventana falla 3 veces o más, el log de
error lleva `"alert": true`.

## Configuración

Todas las variables, con su default y explicación, están en `.env.example`.
La mayoría se puede pisar desde la web (sección Configuración) sin
reiniciar. Las principales:

| Variable | Default | Para qué |
|---|---|---|
| `EDR_URL`, `EDR_AUTH` | — | API EDR. `EDR_AUTH` va en `params.auth`; nunca se loguea ni se devuelve |
| `EDR_CLIENT_PRODUCT_ID`, `EDR_COUNTRY` | vacío | Filtros del request (si están vacíos no se mandan) |
| `EDR_TIMEZONE_OFFSET` | `-03:00` | Zona de las fechas de la API |
| `EDR_WINDOW_MINUTES` / `EDR_SAFETY_DELAY_MINUTES` / `EDR_OVERLAP_MINUTES` | 30 / 5 / 0 | Ventanas |
| `EDR_MAX_ROWS_PER_REQUEST` / `EDR_MAX_PAGES_PER_WINDOW` / `EDR_MIN_SPLIT_SECONDS` | 20000 / 50 / 1 | Tope de la API; al llegar se pide la página siguiente desde el último registro (0 = sin tope). Rango mínimo solo para respuestas desordenadas |
| `EDR_HTTP_TIMEOUT_MS` / `EDR_MAX_RETRIES` | 600000 / 1 | Tiempo máximo para recibir la respuesta completa de Alaris (puede tardar minutos) / reintentos |
| `INGEST_DB_BATCH_SIZE` | 500 | Filas por transacción (máx. 2000) |
| `CHECK_CONCURRENCY` | 4 | Sesiones de Chromium simultáneas (worker y clicks) |
| `LINK_CHECK_TIMEOUT_MS` | 15000 | Timeout de cada visita |
| `WORKER_CLAIM_BATCH_SIZE` / `WORKER_LEASE_MS` | 2×concurrencia / 5 min | Lote reclamado y duración de la reserva |
| `JOB_MAX_ATTEMPTS` / `JOB_RETRY_BASE_DELAY_MS` | 3 / 60000 | Reintentos |
| `CLICK_PERCENTAGE` | 100 | % de SMS con link que se encolan cuando no coinciden con ninguna política (muestra al azar por lote) |
| `EDR_CAPTURE_MODE` / `EDR_CAPTURE_RETENTION_HOURS` / `EDR_CAPTURE_MAX_TOTAL_MB` | errores / 24 / 500 | Capturas de respuestas de Alaris |
| `RESULTS_RETENTION_DAYS` | 0 | Purga de `sms_link_checks` y `sync_runs`; `sms_processing` nunca se purga |
| `SCHEDULER_ENABLED` / `WORKER_ENABLED` | true | Para apagar una de las dos partes |
| `ADMIN_TOKEN` | vacío | Bearer para los endpoints |

## Tablas

| Tabla | Dueño | Qué guarda |
|---|---|---|
| `sms_content` | producción (no se altera) | Los SMS. `CREATE TABLE IF NOT EXISTS` solo para bases nuevas o de test |
| `sms_processing` | esta app | Identidad (UNIQUE `client_message_id, vendor_message_id`) + estado del trabajo |
| `sms_link_checks` | esta app | Un registro por intento. Se migra con `ALTER ... ADD COLUMN` solo si faltan columnas (aditivo) |
| `sync_runs` | esta app | Una fila por corrida de ingesta (ventana, contadores, estado, error) |
| `app_settings` | esta app | Configuración pisada desde la web (solo las claves editadas) |
| `config_audit` | esta app | Historial de cambios y acciones hechas desde la web |
| `policies` | esta app | Políticas; las reglas van en un JSON validado con zod |
| `edr_captures` | esta app | Respuestas de Alaris guardadas temporalmente (gzip) |

Todo lo auxiliar se crea o migra al arrancar (`src/db/schema.ts`), de
forma aditiva e idempotente. No hay FK a `sms_content` a propósito: no
conocemos con certeza su engine/charset en producción.

## Clicks manuales (URL × cantidad)

Además de la cola automática, se puede pedir que una URL se abra N veces.
Cada visita usa un `BrowserContext` nuevo (sin cookies compartidas), se queda
en la página un tiempo al azar entre `CLICK_DWELL_MIN_MS` y
`CLICK_DWELL_MAX_MS` (default 3–7 s), se cierra y el slot pasa a la
siguiente. Corren `CHECK_CONCURRENCY` sesiones en paralelo, con el worker
automático pausado mientras tanto.

- **Duración:** ≈ `COUNT × 5 s ÷ CHECK_CONCURRENCY`. Con
  `CLICK_BLOCK_RESOURCES=true` no se bajan imágenes, fuentes ni video (menos
  RAM por sesión), pero los píxeles de tracking que sean imágenes no se
  disparan.
- **Lanzar:** `make clicks URL=https://... COUNT=50` (o `POST /clicks` con
  `{"url": "...", "count": 50}`, que responde `202` al instante).
- **Desde un archivo:** `make clicks-file` (o `FILE=otro.txt`) lee
  `clicks_to_do.txt`, una línea `url,cantidad` por job (las líneas vacías y
  las que empiezan con `#` se ignoran). Se valida todo antes de arrancar: si
  alguna línea está mal responde `400` y no encola nada. Los jobs corren de a
  uno, en orden.
- **Progreso:** `make clicks-summary`, `make clicks-status` (`GET /clicks`)
  o `make logs` (`clicks: visita`).
- **Cancelar:** `make clicks-cancel` (`POST /clicks/cancel`).
- Un job (o lote) a la vez: si hay uno corriendo responde `409`.
  `CLICK_JOB_MAX_COUNT` es el tope de `count`.
- El estado de los jobs de clicks vive en memoria (se pierde si se reinicia
  el container).

## Tests

```bash
make test          # unitarios + integración (MySQL real) + E2E con Chromium
make test-volume   # 20.000 SMS sintéticos: tiempo, consultas SQL, memoria, dedup
```

Corren dentro del container de la app, contra una base `<DB_NAME>_test` que
crean como root (los helpers se niegan a truncar cualquier base que no
termine en `_test`). La API EDR siempre es un mock: los tests no salen a
internet. Cubren: parseo y normalización JSON-RPC, fechas y zonas horarias,
respuestas inválidas y reintentos HTTP, deduplicación entre ventanas
solapadas, persistencia por lotes, creación idempotente de trabajos,
reclamo concurrente con varios workers, reservas vencidas, reintentos y
límite de intentos, recuperación después de reinicios, SMS sin link,
timeouts y errores reales de Playwright, coordinación con los clicks,
lock de ingesta, paginación de reportes y la migración del esquema.

## Migración desde la versión anterior

- `POST /sync` ya no visita links: ingesta las ventanas pendientes y deja los
  SMS en la cola. Ya no hace falta llamarlo; lo hace el scheduler.
- `API_URL` sigue funcionando como alias de `EDR_URL`, pero el cliente ahora
  hace `POST` JSON-RPC: un JSON estático servido por GET ya no sirve.
- El mock nginx (`mock-api`) se reemplazó por `mock-edr`.
- `sms_link_checks` gana columnas nuevas (los registros viejos quedan con
  `NULL`). Las filas de `sms_content` cargadas por la versión anterior se
  reconocen por su identidad y no se duplican.
- `CHECK_CONCURRENCY` bajó su default de 8 a 4 (servidor de 1 núcleo / 2 GB).
- `.env`, `dumps/` y `docker/mock-api/cdrs-dump.json` dejaron de estar
  versionados (siguen en disco y en el historial de git).

## A validar contra producción

- **API EDR:** tope de filas por respuesta, si `end_date` es inclusivo, si
  existe algún parámetro de paginación o límite (`make edr-probe`), y el
  esquema de auth (hoy `params.auth`, más un Bearer opcional por `API_TOKEN`).
- **MySQL de producción:** versión (SKIP LOCKED requiere MySQL 8.0.1+ o
  MariaDB 10.6+), que exista el índice sobre
  `sms_content.vendor_message_id` (lo usa la deduplicación con filas
  viejas), permisos para `CREATE TABLE` y `ALTER TABLE` sobre las tablas
  auxiliares, y que `GET_LOCK` funcione (con un proxy tipo ProxySQL puede no
  hacerlo).
- **Volumen real:** ~40 MB de JSON por cada 20.000 SMS. Si una ventana trae
  bastante más que eso, conviene bajar `EDR_WINDOW_MINUTES` en vez de
  depender solo de la partición automática.
- **Ritmo del worker:** con 4 sesiones y visitas de ~2 s, el worker procesa
  unas 120 visitas por minuto (≈3.600 cada 30 min). Con 20.000 SMS por
  ventana y `CLICK_PERCENTAGE=100` la cola **crece más rápido de lo que se
  drena**. Hay que ajustar `CLICK_PERCENTAGE` o la concurrencia mirando
  `queueLagSeconds` en `make queue`.
