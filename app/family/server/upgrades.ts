import "server-only";
import { getPool, transaction } from "./db";
import { FamilyApiError } from "./errors";

export const FAMILY_APPLICATION_SCHEMA_VERSION = 2;

/** Application-only, additive upgrade. The caller owns the transaction and schema lock. */
export const FAMILY_APPLICATION_UPGRADE_SQL = String.raw`
ALTER TABLE family_chat ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE family_generation ADD COLUMN IF NOT EXISTS actual_model text;
ALTER TABLE family_generation ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'send'
  CHECK (mode IN ('send','edit','retry','regenerate'));
ALTER TABLE family_generation ADD COLUMN IF NOT EXISTS source_generation_id uuid
  REFERENCES family_generation(id);
ALTER TABLE family_generation ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
ALTER TABLE family_generation ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz;
CREATE TABLE IF NOT EXISTS family_schema_version (
  id integer PRIMARY KEY CHECK (id = 1),
  version integer NOT NULL CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO family_schema_version(id,version) VALUES(1,2)
ON CONFLICT(id) DO UPDATE
  SET version=GREATEST(family_schema_version.version,EXCLUDED.version),updated_at=now();`;

/** Used only by explicit administrator migration and the full bootstrap transaction. */
export async function ensureFamilyApplicationUpgrade(): Promise<void> {
  await transaction(async (client) => {
    // Share the full bootstrap lock, so its auth/application DDL cannot interleave.
    await client.query("SELECT pg_advisory_xact_lock(714209830)");
    const schema = process.env.FAMILY_DATABASE_SCHEMA;
    if (schema) {
      // getPool has already rejected production overrides; independently validate
      // the only identifier interpolated into application migration SQL.
      if (!/^family_test_[a-f0-9]{16}$/.test(schema))
        throw new Error("INVALID_TEST_SCHEMA");
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    }
    await client.query(FAMILY_APPLICATION_UPGRADE_SQL);
  });
}

/** Read-only readiness check, including databases initialized by earlier deployments. */
export async function applicationUpgradeStatus(): Promise<{
  schemaReady: boolean;
  schemaVersion: number;
}> {
  const pool = getPool();
  const metadata = (
    await pool.query(`SELECT
      to_regclass('family_schema_version') IS NOT NULL AS version_table_exists,
      (SELECT count(*) = 6 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (table_name,column_name,data_type,is_nullable) IN (
            ('family_chat','model','text','YES'),
            ('family_generation','actual_model','text','YES'),
            ('family_generation','mode','text','NO'),
            ('family_generation','source_generation_id','uuid','YES'),
            ('family_generation','superseded_at','timestamp with time zone','YES'),
            ('family_generation','cancel_requested_at','timestamp with time zone','YES')
          )) AS columns_ready`)
  ).rows[0];
  if (metadata?.version_table_exists !== true)
    return { schemaReady: false, schemaVersion: 0 };
  const row = (
    await pool.query("SELECT version FROM family_schema_version WHERE id=1")
  ).rows[0];
  const version = row?.version;
  const schemaVersion =
    Number.isSafeInteger(version) && version >= 0 ? version : 0;
  return {
    schemaReady:
      metadata.columns_ready === true &&
      schemaVersion >= FAMILY_APPLICATION_SCHEMA_VERSION,
    schemaVersion,
  };
}

/** Normal requests may inspect readiness, but can never mutate the schema. */
export async function requireFamilyApplicationUpgrade(): Promise<void> {
  if (!(await applicationUpgradeStatus()).schemaReady)
    throw new FamilyApiError(
      503,
      "网站功能需要升级，请联系管理员在管理页面完成升级。",
      "APPLICATION_UPGRADE_REQUIRED",
    );
}
