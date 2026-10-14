import type { RowDataPacket } from "mysql2";
import { pool } from "./pool";
import { config } from "../config";

/**
 * Lock de coordinacion con GET_LOCK de MySQL/MariaDB: vale para todas las
 * instancias que usen la misma base y se libera solo si la conexion se
 * cae (container que muere, red que se corta), asi un proceso muerto
 * nunca deja el lock tomado para siempre. La conexion queda reservada
 * mientras dura `fn`.
 *
 * Devuelve null si el lock lo tiene otro (no espera).
 */
export async function withNamedLock<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  // Los nombres de GET_LOCK son globales al servidor: se prefijan con la base.
  const lockName = `${config.db.database}:${name}`.slice(0, 64);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query<RowDataPacket[]>("SELECT GET_LOCK(?, 0) AS acquired", [lockName]);
    if (Number(rows[0].acquired) !== 1) return null;
    try {
      return await fn();
    } finally {
      await conn.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => undefined);
    }
  } finally {
    conn.release();
  }
}

export async function isNamedLockFree(name: string): Promise<boolean> {
  const lockName = `${config.db.database}:${name}`.slice(0, 64);
  const [rows] = await pool.query<RowDataPacket[]>("SELECT IS_FREE_LOCK(?) AS free", [lockName]);
  return Number(rows[0].free) === 1;
}
