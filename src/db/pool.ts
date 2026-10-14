import mysql from "mysql2/promise";
import { config } from "../config";

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  dateStrings: false,
  timezone: "Z", // las fechas se guardan y leen en UTC
});

// Las fechas de la app viajan en UTC (timezone "Z" de arriba); la sesion
// tambien, asi un NOW() o una comparacion en SQL no depende de la zona
// del servidor de produccion.
pool.on("connection", (conn) => {
  conn.query("SET time_zone = '+00:00'");
});

export type DbConnection = mysql.PoolConnection;

export async function assertDbConnection(): Promise<void> {
  await pool.query("SELECT 1");
}

/**
 * Corre `fn` en una transaccion corta. No usar para nada que espere a
 * Playwright o a la API: los locks de fila quedarian tomados todo ese rato.
 */
export async function withTransaction<T>(fn: (conn: DbConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => undefined);
    throw err;
  } finally {
    conn.release();
  }
}
