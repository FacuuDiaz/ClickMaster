import { pool } from "./pool";

/**
 * DDL calcado del `DESC sms_content` provisto. Esto solo corre si la tabla
 * NO existe todavia (ej. levantar el proyecto contra una base nueva/de test).
 * Contra la base real de T-mob la tabla ya existe, asi que esto es un no-op
 * (CREATE TABLE IF NOT EXISTS) y jamas se altera la tabla existente:
 * no asumimos ninguna unique key que no este confirmada en produccion,
 * por eso la identidad de cada SMS vive en sms_processing (ver abajo).
 */
const CREATE_SMS_CONTENT = `
  CREATE TABLE IF NOT EXISTS sms_content (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    cdr_delivery_time  DATETIME        NULL,
    client              VARCHAR(64)     NOT NULL,
    client_acc_id       INT             NOT NULL,
    client_message_id   VARCHAR(64)     NOT NULL,
    client_rate         DECIMAL(10,5)   NOT NULL,
    country              VARCHAR(32)     NOT NULL,
    dnis                 VARCHAR(32)     NOT NULL,
    dst_is_successful   TINYINT         NOT NULL,
    dst_part_amount     TINYINT         NOT NULL,
    edr_date             DATETIME        NOT NULL,
    edr_type             TINYINT         NOT NULL,
    mccmnc               VARCHAR(16)     NOT NULL,
    network               VARCHAR(32)     NOT NULL,
    sender_name          VARCHAR(32)     NOT NULL,
    src_is_successful   TINYINT         NOT NULL,
    src_part_amount     TINYINT         NOT NULL,
    status                VARCHAR(64)     NOT NULL,
    tech_details_json   LONGTEXT        NULL,
    translated_text      TEXT            NULL,
    text                  TEXT            NOT NULL,
    vendor                VARCHAR(64)     NULL,
    vendor_acc_id        INT             NULL,
    vendor_message_id    VARCHAR(64)     NOT NULL,
    vendor_rate           DECIMAL(10,5)   NULL,
    KEY idx_client_message_id (client_message_id),
    KEY idx_vendor_message_id (vendor_message_id),
    KEY idx_edr_date (edr_date)
  );
`;

/**
 * Tabla propia (no existe en produccion) donde queda el historial de cada
 * verificacion de link con Playwright: un registro por intento, nunca se
 * pisa. Sin FK real a sms_content a proposito: es una tabla que ya existe en
 * produccion y no sabemos con certeza su engine/charset; una FOREIGN KEY
 * podria fallar en el CREATE TABLE si no son compatibles (ej. MyISAM).
 */
const CREATE_SMS_LINK_CHECKS = `
  CREATE TABLE IF NOT EXISTS sms_link_checks (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sms_content_id     BIGINT UNSIGNED NOT NULL,
    link                VARCHAR(2048)   NOT NULL,
    checked_at          DATETIME        NOT NULL,
    http_status         INT             NULL,
    is_ok               TINYINT(1)      NOT NULL,
    response_time_ms    INT             NULL,
    error_message        VARCHAR(255)    NULL,
    KEY idx_sms_content_id (sms_content_id)
  );
`;

// Columnas agregadas a sms_link_checks para la cola persistente. Se agregan
// con ALTER solo si faltan: la tabla puede existir de la version anterior.
const SMS_LINK_CHECKS_COLUMNS: { name: string; ddl: string }[] = [
  { name: "processing_id", ddl: "processing_id BIGINT UNSIGNED NULL" },
  { name: "attempt", ddl: "attempt INT UNSIGNED NULL" },
  { name: "outcome", ddl: "outcome VARCHAR(32) NULL" },
  { name: "final_url", ddl: "final_url VARCHAR(2048) NULL" },
  { name: "redirects", ddl: "redirects INT UNSIGNED NULL" },
  { name: "started_at", ddl: "started_at DATETIME(3) NULL" },
  { name: "worker_id", ddl: "worker_id VARCHAR(64) NULL" },
];

// Columnas de sms_processing agregadas despues (tabla propia, nunca sms_content).
// `backfill`: se corre una sola vez, justo despues de agregar la columna,
// para que los datos de antes de la migracion no queden en cero.
const SMS_PROCESSING_COLUMNS: { name: string; ddl: string; backfill?: string }[] = [
  // Politica que se le asigno al ingestarlo (sin FK: la politica se puede borrar).
  { name: "policy_id", ddl: "policy_id INT UNSIGNED NULL" },
  // Clicks realizados sobre el SMS: suma 1 por cada visita a la que el sitio
  // respondio 200 (errores del sitio y timeouts no cuentan). Pasa de 1 si una politica
  // nueva lo vuelve a elegir con "cuenta como otro click".
  {
    name: "clicks",
    ddl: "clicks INT UNSIGNED NOT NULL DEFAULT 0",
    // Las visitas anteriores estan en sms_link_checks: se cuentan sus 200.
    backfill: `UPDATE sms_processing p
                 JOIN (SELECT processing_id, COUNT(*) AS n FROM sms_link_checks
                        WHERE http_status = 200 AND processing_id IS NOT NULL GROUP BY processing_id) c
                   ON c.processing_id = p.id
                  SET p.clicks = c.n`,
  },
  // Cuando se eligio para visitar (o se volvio a encolar para otro click).
  // Los topes por hora/dia cuentan por este momento, no por la ingesta: en
  // "dia vencido" se aprueban hoy SMS que entraron ayer.
  {
    name: "selected_at",
    ddl: "selected_at DATETIME(3) NULL",
    // Antes se elegian al ingestar: la mejor aproximacion es created_at.
    backfill: "UPDATE sms_processing SET selected_at = created_at WHERE status <> 'skipped' AND selected_at IS NULL",
  },
];

// Indices que se agregan con ALTER si faltan (tablas que pueden venir de
// una version anterior). Todos sobre tablas auxiliares, nunca sms_content.
const EXTRA_INDEXES: { table: string; name: string; ddl: string }[] = [
  { table: "sms_link_checks", name: "idx_processing_id", ddl: "ADD KEY idx_processing_id (processing_id)" },
  // Listado del dashboard por (checked_at, id) y purga por retencion.
  { table: "sms_link_checks", name: "idx_checked_at", ddl: "ADD KEY idx_checked_at (checked_at)" },
  // Cubre los graficos del dashboard: se agregan por tiempo y resultado
  // leyendo solo el indice, sin tocar las filas (que traen link y error).
  {
    table: "sms_link_checks",
    name: "idx_checked_outcome",
    ddl: "ADD KEY idx_checked_outcome (checked_at, outcome, response_time_ms)",
  },
  // SMS ingestados por tiempo de ingreso (grafico y listado del dashboard).
  { table: "sms_processing", name: "idx_created_at", ddl: "ADD KEY idx_created_at (created_at)" },
  // Volumen historico por politica (porcentaje relativo a dias anteriores).
  { table: "sms_processing", name: "idx_policy_edr", ddl: "ADD KEY idx_policy_edr (policy_id, edr_date)" },
  // Topes por hora/dia de cada politica (por momento de seleccion).
  { table: "sms_processing", name: "idx_policy_created", ddl: "ADD KEY idx_policy_created (policy_id, created_at)" },
  { table: "sms_processing", name: "idx_policy_selected", ddl: "ADD KEY idx_policy_selected (policy_id, selected_at)" },
  // SMS en_seleccion por periodo: se eligen al cerrar la ventana o el dia.
  { table: "sms_processing", name: "idx_held", ddl: "ADD KEY idx_held (skip_reason, edr_date)" },
];

/**
 * Identidad + cola de verificacion: una fila por SMS (client_message_id,
 * vendor_message_id). La UNIQUE vive aca y no en sms_content porque no se
 * puede tocar la tabla de produccion. Guarda la referencia estable al SMS
 * (sms_content_id) y el estado del trabajo; el texto y el link se leen de
 * sms_content cuando hace falta, no se duplican.
 *
 * next_attempt_at solo tiene valor mientras el trabajo se puede reclamar
 * (pending / retry); en el resto de los estados es NULL. Asi el indice
 * idx_next_attempt sirve directo para "los proximos N listos", sin filesort.
 */
const CREATE_SMS_PROCESSING = `
  CREATE TABLE IF NOT EXISTS sms_processing (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sms_content_id     BIGINT UNSIGNED NOT NULL,
    client_message_id  VARCHAR(64)     NOT NULL,
    vendor_message_id  VARCHAR(64)     NOT NULL,
    ingest_run_id      BIGINT UNSIGNED NULL,
    edr_date           DATETIME        NOT NULL,
    status             ENUM('pending','processing','retry','success','failed','skipped') NOT NULL,
    skip_reason        VARCHAR(32)     NULL,
    attempts           INT UNSIGNED    NOT NULL DEFAULT 0,
    next_attempt_at    DATETIME(3)     NULL,
    locked_by          VARCHAR(64)     NULL,
    locked_until       DATETIME(3)     NULL,
    created_at         DATETIME(3)     NOT NULL,
    last_attempt_at    DATETIME(3)     NULL,
    finished_at        DATETIME(3)     NULL,
    last_outcome       VARCHAR(32)     NULL,
    last_error         VARCHAR(255)    NULL,
    UNIQUE KEY uq_message (client_message_id, vendor_message_id),
    KEY idx_next_attempt (next_attempt_at),
    KEY idx_status_edr_date (status, edr_date),
    KEY idx_edr_date (edr_date),
    KEY idx_sms_content_id (sms_content_id),
    KEY idx_ingest_run_id (ingest_run_id)
  );
`;

/**
 * Una fila por corrida de ingesta (una ventana EDR). kind = scheduled son
 * las del scheduler: el cursor de ventanas sale de la ultima exitosa de
 * ese tipo. Las manuales (una ventana puntual) no lo mueven.
 */
const CREATE_SYNC_RUNS = `
  CREATE TABLE IF NOT EXISTS sync_runs (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    kind               ENUM('scheduled','manual') NOT NULL,
    window_start       DATETIME        NOT NULL,
    window_end         DATETIME        NOT NULL,
    query_start        DATETIME        NOT NULL,
    status             ENUM('running','success','partial','failed') NOT NULL,
    started_at         DATETIME(3)     NOT NULL,
    finished_at        DATETIME(3)     NULL,
    heartbeat_at       DATETIME(3)     NULL,
    api_requests       INT UNSIGNED    NOT NULL DEFAULT 0,
    records_received   INT UNSIGNED    NOT NULL DEFAULT 0,
    records_invalid    INT UNSIGNED    NOT NULL DEFAULT 0,
    sms_new            INT UNSIGNED    NOT NULL DEFAULT 0,
    sms_existing       INT UNSIGNED    NOT NULL DEFAULT 0,
    jobs_created       INT UNSIGNED    NOT NULL DEFAULT 0,
    jobs_skipped       INT UNSIGNED    NOT NULL DEFAULT 0,
    errors             INT UNSIGNED    NOT NULL DEFAULT 0,
    error_message      VARCHAR(1024)   NULL,
    client_product_id  VARCHAR(32)     NULL,
    country            VARCHAR(32)     NULL,
    KEY idx_kind_status_end (kind, status, window_end),
    KEY idx_window_start (window_start),
    KEY idx_status (status)
  );
`;

/**
 * Configuracion editable desde la web. Solo guarda lo que se piso: una
 * clave sin fila toma el valor de .env (o el default). Borrar la fila es
 * "volver a .env". El valor va como JSON para conservar el tipo.
 */
const CREATE_APP_SETTINGS = `
  CREATE TABLE IF NOT EXISTS app_settings (
    setting_key  VARCHAR(64)  NOT NULL PRIMARY KEY,
    value        JSON         NOT NULL,
    updated_at   DATETIME(3)  NOT NULL,
    updated_by   VARCHAR(64)  NULL
  );
`;

/**
 * Historial de cambios hechos desde la web (configuracion, politicas,
 * acciones operativas, capturas). Solo se inserta, nunca se actualiza.
 * actor es el nombre que escribe el usuario: trazabilidad, no autenticacion.
 */
const CREATE_CONFIG_AUDIT = `
  CREATE TABLE IF NOT EXISTS config_audit (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    at         DATETIME(3)     NOT NULL,
    actor      VARCHAR(64)     NULL,
    ip         VARCHAR(64)     NULL,
    entity     VARCHAR(16)     NOT NULL,
    action     VARCHAR(32)     NOT NULL,
    ref        VARCHAR(128)    NULL,
    old_value  JSON            NULL,
    new_value  JSON            NULL,
    KEY idx_entity_id (entity, id)
  );
`;

/**
 * Politicas de seleccion/visita. Las reglas van en un JSON validado con
 * zod (src/policies/schema.ts). priority: menor = se evalua antes.
 */
const CREATE_POLICIES = `
  CREATE TABLE IF NOT EXISTS policies (
    id          INT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(100)  NOT NULL,
    enabled     TINYINT(1)    NOT NULL DEFAULT 1,
    priority    INT           NOT NULL,
    rules       JSON          NOT NULL,
    created_at  DATETIME(3)   NOT NULL,
    updated_at  DATETIME(3)   NOT NULL,
    updated_by  VARCHAR(64)   NULL,
    KEY idx_priority (priority)
  );
`;

/**
 * Copias temporales de respuestas de Alaris (ver src/captures/). El body va
 * comprimido con gzip (~10x). rows_count y summary se completan al primer
 * analisis: capturar no agrega un parse extra a la ingesta.
 * expires_at NULL = conservada (no vence).
 */
/**
 * Cambios de la politica activa en tiempo de ejecucion (activar otra,
 * desactivarla o editar sus reglas). Cada cambio retoma el contenido del dia
 * desde period_start (re-asigna y vuelve a elegir); repeat_mode dice que
 * hacer si se vuelve a elegir un SMS ya clickeado: igual = cuenta el click
 * hecho, doble = se visita de nuevo (clicks = 2).
 */
const CREATE_POLICY_CHANGES = `
  CREATE TABLE IF NOT EXISTS policy_changes (
    id              INT UNSIGNED  NOT NULL AUTO_INCREMENT PRIMARY KEY,
    created_at      DATETIME(3)   NOT NULL,
    actor           VARCHAR(64)   NULL,
    from_policy_id  INT UNSIGNED  NULL,
    to_policy_id    INT UNSIGNED  NULL,
    from_name       VARCHAR(100)  NULL,
    to_name         VARCHAR(100)  NULL,
    repeat_mode     ENUM('igual','doble') NOT NULL,
    period_start    DATETIME(3)   NOT NULL,
    status          ENUM('pendiente','aplicando','aplicado','reemplazado','error') NOT NULL,
    applied_at      DATETIME(3)   NULL,
    result          JSON          NULL,
    error           VARCHAR(512)  NULL,
    KEY idx_status (status),
    KEY idx_to_period (to_policy_id, period_start)
  );
`;

const CREATE_EDR_CAPTURES = `
  CREATE TABLE IF NOT EXISTS edr_captures (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    run_id        BIGINT UNSIGNED NULL,
    origin        VARCHAR(16)     NOT NULL,
    range_start   DATETIME        NOT NULL,
    range_end     DATETIME        NOT NULL,
    request_args  JSON            NOT NULL,
    error_message VARCHAR(1024)   NULL,
    rows_count    INT UNSIGNED    NULL,
    bytes         INT UNSIGNED    NOT NULL,
    gz_bytes      INT UNSIGNED    NOT NULL,
    body_gz       LONGBLOB        NOT NULL,
    summary       JSON            NULL,
    status        VARCHAR(16)     NOT NULL,
    note          VARCHAR(255)    NULL,
    created_at    DATETIME(3)     NOT NULL,
    created_by    VARCHAR(64)     NULL,
    expires_at    DATETIME(3)     NULL,
    KEY idx_expires (expires_at),
    KEY idx_run (run_id)
  );
`;

async function columnExists(table: string, column: string): Promise<boolean> {
  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows.length > 0;
}

async function indexExists(table: string, index: string): Promise<boolean> {
  const [rows] = await pool.query<import("mysql2").RowDataPacket[]>(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, index]
  );
  return rows.length > 0;
}

/**
 * Crea las tablas auxiliares y migra sms_link_checks. Todo es aditivo e
 * idempotente: se puede correr en cada arranque. sms_content nunca se altera.
 */
export async function ensureSchema(): Promise<void> {
  await pool.query(CREATE_SMS_CONTENT);
  await pool.query(CREATE_SMS_LINK_CHECKS);
  await pool.query(CREATE_SMS_PROCESSING);
  await pool.query(CREATE_SYNC_RUNS);
  await pool.query(CREATE_APP_SETTINGS);
  await pool.query(CREATE_CONFIG_AUDIT);
  await pool.query(CREATE_POLICIES);
  await pool.query(CREATE_EDR_CAPTURES);
  await pool.query(CREATE_POLICY_CHANGES);

  for (const column of SMS_LINK_CHECKS_COLUMNS) {
    if (!(await columnExists("sms_link_checks", column.name))) {
      await pool.query(`ALTER TABLE sms_link_checks ADD COLUMN ${column.ddl}`);
    }
  }
  for (const column of SMS_PROCESSING_COLUMNS) {
    if (!(await columnExists("sms_processing", column.name))) {
      await pool.query(`ALTER TABLE sms_processing ADD COLUMN ${column.ddl}`);
      if (column.backfill) await pool.query(column.backfill);
    }
  }
  for (const index of EXTRA_INDEXES) {
    if (!(await indexExists(index.table, index.name))) {
      await pool.query(`ALTER TABLE ${index.table} ${index.ddl}`);
    }
  }
}
