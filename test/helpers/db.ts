import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import { config } from "../../src/config";
import { pool } from "../../src/db/pool";
import { ensureSchema } from "../../src/db/schema";

// Los tests truncan tablas: jamas contra una base que no sea de test.
function assertTestDatabase(): void {
  if (!config.db.database.endsWith("_test")) {
    throw new Error(`Los tests solo corren contra una base *_test (DB_NAME=${config.db.database})`);
  }
}

export async function setupTestDb(): Promise<void> {
  assertTestDatabase();
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
  });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${config.db.database}\``);
  await conn.end();
  await ensureSchema();
}

export async function resetTables(): Promise<void> {
  assertTestDatabase();
  for (const table of ["sms_link_checks", "sms_processing", "sync_runs", "sms_content"]) {
    await pool.query(`TRUNCATE TABLE ${table}`);
  }
}

export async function count(sql: string, params: unknown[] = []): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return Number(Object.values(rows[0])[0]);
}

export async function rows<T = RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [result] = await pool.query<RowDataPacket[]>(sql, params);
  return result as T[];
}
