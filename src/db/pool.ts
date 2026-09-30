import mysql from "mysql2/promise";
import { config } from "../config";

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: false,
  timezone: "Z", // las fechas se guardan y leen en UTC
});

export async function assertDbConnection(): Promise<void> {
  await pool.query("SELECT 1");
}
