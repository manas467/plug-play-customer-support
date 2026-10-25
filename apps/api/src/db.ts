import pg from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://support:support@localhost:5433/support_platform" });
export async function query<T = any>(sql: string, params: unknown[] = []) {
  return pool.query<T>(sql, params);
}
