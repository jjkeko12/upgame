import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const g = globalThis as typeof globalThis & {
  __gamePool?: Pool;
  __gameDb?: NodePgDatabase;
};

/**
 * The pool is created on first use, not at import time, so `next build`
 * works on machines that have no DATABASE_URL (CI, Docker build stages).
 */
export function getPool(): Pool {
  if (!g.__gamePool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    g.__gamePool = new Pool({
      connectionString: url,
      max: 10,
      // Set DATABASE_SSL=true for hosted Postgres that requires TLS.
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
  }
  return g.__gamePool;
}

function getDb(): NodePgDatabase {
  if (!g.__gameDb) g.__gameDb = drizzle(getPool());
  return g.__gameDb;
}

export const db: NodePgDatabase = new Proxy({} as NodePgDatabase, {
  get(_target, prop) {
    const real = getDb();
    const value = Reflect.get(real, prop, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
