import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../src/db/pool";
import { ensureSchema } from "../../src/db/schema";
import { count, rows, setupTestDb } from "../helpers/db";

before(setupTestDb);
after(() => pool.end());

async function describeTable(table: string): Promise<string> {
  const [create] = await rows(`SHOW CREATE TABLE ${table}`);
  // AUTO_INCREMENT cambia con los datos; el resto es la estructura.
  return String(create["Create Table"]).replace(/ AUTO_INCREMENT=\d+/, "");
}

test("migra sms_link_checks de la version anterior sin perder filas y es idempotente", async () => {
  await pool.query("DROP TABLE IF EXISTS sms_link_checks");
  // Tabla tal como la creaba la version anterior.
  await pool.query(`
    CREATE TABLE sms_link_checks (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      sms_content_id BIGINT UNSIGNED NOT NULL,
      link VARCHAR(2048) NOT NULL,
      checked_at DATETIME NOT NULL,
      http_status INT NULL,
      is_ok TINYINT(1) NOT NULL,
      response_time_ms INT NULL,
      error_message VARCHAR(255) NULL,
      KEY idx_sms_content_id (sms_content_id)
    )`);
  await pool.query(
    `INSERT INTO sms_link_checks (sms_content_id, link, checked_at, http_status, is_ok, response_time_ms)
     VALUES (1, 'https://viejo', NOW(), 200, 1, 50)`
  );

  await ensureSchema();
  await ensureSchema(); // segunda corrida: no-op

  const columns = (await rows("SHOW COLUMNS FROM sms_link_checks")).map((c) => c.Field);
  for (const column of ["processing_id", "attempt", "outcome", "final_url", "redirects", "started_at", "worker_id"]) {
    assert.ok(columns.includes(column), `falta ${column}`);
  }
  assert.equal(await count("SELECT COUNT(*) FROM sms_link_checks WHERE link = 'https://viejo'"), 1);
});

test("ensureSchema nunca altera sms_content", async () => {
  const before = await describeTable("sms_content");
  await ensureSchema();
  assert.equal(await describeTable("sms_content"), before);
  // Y no le agrega ninguna UNIQUE: la identidad vive en sms_processing.
  assert.doesNotMatch(before, /UNIQUE/);
  assert.match(await describeTable("sms_processing"), /UNIQUE KEY `uq_message`/);
});
