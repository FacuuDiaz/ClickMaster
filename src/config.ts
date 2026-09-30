import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}`);
  }
  return value;
}

function percentage(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${name} tiene que ser un numero entre 0 y 100`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),

  db: {
    host: required("DB_HOST"),
    port: Number(process.env.DB_PORT ?? 3306),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: required("DB_NAME"),
  },

  api: {
    url: required("API_URL"),
    token: process.env.API_TOKEN ?? undefined,
  },

  checker: {
    concurrency: Number(process.env.CHECK_CONCURRENCY ?? 8),
    timeoutMs: Number(process.env.LINK_CHECK_TIMEOUT_MS ?? 15000),
    // % de los SMS con link (elegidos al azar en cada corrida) a los que se
    // les hace click. 100 = todos.
    clickPercentage: percentage("CLICK_PERCENTAGE", 100),
  },
};
