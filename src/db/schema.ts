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

  for (const column of SMS_LINK_CHECKS_COLUMNS) {
    if (!(await columnExists("sms_link_checks", column.name))) {
      await pool.query(`ALTER TABLE sms_link_checks ADD COLUMN ${column.ddl}`);
    }
  }
  for (const index of EXTRA_INDEXES) {
    if (!(await indexExists(index.table, index.name))) {
      await pool.query(`ALTER TABLE ${index.table} ${index.ddl}`);
    }
  }
}
