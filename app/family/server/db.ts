import "server-only";
import { Pool, type PoolClient } from "pg";

let pool: Pool | undefined;
/** Neon-only service: pin certificate and hostname verification regardless of URI defaults. */
export function verifiedPostgresConnectionString(raw: string): string {
  const url = new URL(raw);
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !url.hostname
  ) {
    throw new Error("INVALID_POSTGRES_DESTINATION");
  }
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.delete("uselibpqcompat");
  return url.toString();
}
export function getPool(): Pool {
  if (!process.env.DATABASE_URL) throw new Error("FAMILY_DATABASE_UNAVAILABLE");
  const schema = process.env.FAMILY_DATABASE_SCHEMA;
  if (schema && !/^family_test_[a-f0-9]{16}$/.test(schema))
    throw new Error("INVALID_TEST_SCHEMA");
  if (!pool) {
    pool = new Pool({
      connectionString: verifiedPostgresConnectionString(
        process.env.DATABASE_URL,
      ),
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 8_000,
      idle_in_transaction_session_timeout: 20_000,
      allowExitOnIdle: true,
      ...(schema ? { options: `-c search_path=${schema}` } : {}),
    });
    // Idle socket failures are handled by pg's pool; never print connection details.
    pool.on("error", () => {});
  }
  return pool;
}
export async function transaction<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
export async function closeFamilyDatabase() {
  if (pool) await pool.end();
  pool = undefined;
}
