import { pool } from "./pool";

/**
 * DDL calcado del `DESC sms_content` provisto. Esto solo corre si la tabla
 * NO existe todavia (ej. levantar el proyecto contra una base nueva/de test).
 * Contra la base real de T-mob la tabla ya existe, asi que esto es un no-op
 * (CREATE TABLE IF NOT EXISTS) y jamas se altera la tabla existente:
 * no asumimos ninguna unique key que no este confirmada en produccion,
 * por eso el upsert se resuelve a nivel aplicacion (ver smsContentRepo.ts).
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
 * verificacion de link con Playwright. Un registro por chequeo, asi el dia
 * de manana el scheduler puede re-chequear el mismo link sin pisar nada.
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
    -- Sin FK real a sms_content a proposito: es una tabla que ya existe en
    -- produccion y no sabemos con certeza su engine/charset. Una FOREIGN KEY
    -- fallaria en el CREATE TABLE si no son compatibles (ej. MyISAM). El
    -- indice ya alcanza para los JOIN que vas a necesitar.
  );
`;

export async function ensureSchema(): Promise<void> {
  await pool.query(CREATE_SMS_CONTENT);
  await pool.query(CREATE_SMS_LINK_CHECKS);
}
