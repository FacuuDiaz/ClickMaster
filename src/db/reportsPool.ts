import mysql from "mysql2/promise";
import { config } from "../config";

/**
 * Pool aparte para el dashboard y los reportes. Separado del pool de la app
 * a proposito:
 * - Pocas conexiones (REPORTS_DB_CONNECTION_LIMIT, default 2): por muchas
 *   pestanas abiertas que haya, el dashboard nunca usa mas que eso, y la
 *   ingesta y el worker siguen con su pool entero.
 * - queueLimit: si se juntan demasiados pedidos esperando, fallan rapido en
 *   vez de acumularse en memoria.
 * - Cada sesion en READ ONLY, READ COMMITTED (no mantiene vistas viejas
 *   abiertas) y con un tope de tiempo por consulta del lado del servidor.
 */
export const reportsPool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.reports.dbUser ?? config.db.user,
  password: config.reports.dbPassword ?? config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.reports.dbConnectionLimit,
  queueLimit: 20,
  dateStrings: false,
  timezone: "Z",
});

reportsPool.on("connection", (promiseConn) => {
  // mysql2 tipa el evento con la conexion de promesas, pero en ejecucion
  // llega la conexion clasica (de callbacks): se usa esa, con callback, asi
  // un SET que el motor no soporte no tira un error sin manejar.
  const conn = promiseConn as unknown as import("mysql2").Connection;
  const ignore = () => undefined;
  conn.query("SET time_zone = '+00:00'", ignore);
  conn.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED", ignore);
  conn.query("SET SESSION TRANSACTION READ ONLY", ignore);
  // MySQL: milisegundos. MariaDB no tiene MAX_EXECUTION_TIME sino
  // max_statement_time (segundos): se prueban las dos y la que no exista falla sola.
  conn.query(`SET SESSION MAX_EXECUTION_TIME = ${config.reports.queryTimeoutMs}`, ignore);
  conn.query(`SET SESSION max_statement_time = ${config.reports.queryTimeoutMs / 1000}`, ignore);
});
