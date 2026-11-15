import pg, { type QueryResultRow } from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://support:support@localhost:5433/support_platform", max: 15, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, query_timeout: 15000, statement_timeout: 15000 });
export async function query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []) {
  return pool.query<T>(sql, params);
}
