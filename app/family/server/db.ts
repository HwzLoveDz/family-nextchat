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
  const schema = process.env.FAMILY_DATABASE_SCHEMA;
  if (schema && !/^family_test_[a-f0-9]{16}$/.test(schema))
    throw new Error("INVALID_TEST_SCHEMA");
  if (
    schema &&
    (process.env.VERCEL_ENV === "production" ||
      (process.env.NODE_ENV === "production" &&
        process.env.VERCEL_ENV !== "preview"))
  )
    throw new Error("TEST_SCHEMA_FORBIDDEN_IN_PRODUCTION");
  // PgBouncer cannot preserve the startup search_path needed for strict schema
  // isolation. Preview/local fixtures must use the integration's direct DSN.
  const databaseUrl = schema
    ? process.env.DATABASE_URL_UNPOOLED
    : process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error(
      schema
        ? "FAMILY_TEST_UNPOOLED_DATABASE_REQUIRED"
        : "FAMILY_DATABASE_UNAVAILABLE",
    );
  if (!pool) {
    pool = new Pool({
      connectionString: verifiedPostgresConnectionString(databaseUrl),
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
