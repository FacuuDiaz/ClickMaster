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

export interface TransactionOptions {
  // READ COMMITTED no toma gap locks: es lo que necesita el reclamo con
  // SKIP LOCKED para que dos workers no se bloqueen entre si.
  isolation?: "READ COMMITTED";
  // Reintentos ante deadlock / lock wait timeout. Solo para transacciones
  // que se pueden repetir enteras (todo se deshace en el rollback).
  retries?: number;
}

const RETRYABLE_LOCK_ERRORS = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);

function isRetryableLockError(err: unknown): boolean {
  return RETRYABLE_LOCK_ERRORS.has((err as { code?: string })?.code ?? "");
}

/**
 * Corre `fn` en una transaccion corta. No usar para nada que espere a
 * Playwright o a la API: los locks de fila quedarian tomados todo ese rato.
 */
export async function withTransaction<T>(
  fn: (conn: DbConnection) => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      // Aplica solo a la proxima transaccion de esta conexion.
      if (options.isolation) await conn.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolation}`);
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback().catch(() => undefined);
      if (!isRetryableLockError(err) || attempt >= (options.retries ?? 0)) throw err;
      // MySQL ya deshizo la transaccion entera: se repite tras una espera corta al azar.
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 80 * (attempt + 1)));
    } finally {
      conn.release();
    }
  }
}
