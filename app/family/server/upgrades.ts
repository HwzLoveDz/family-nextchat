import "server-only";
import { getPool, transaction } from "./db";
import { FamilyApiError } from "./errors";

export const FAMILY_APPLICATION_SCHEMA_VERSION = 4;

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
CREATE TABLE IF NOT EXISTS family_voice_usage (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id),
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('transcribe','speech')),
  state text NOT NULL CHECK (state IN ('running','complete','error')),
  requested_model text,
  actual_model text,
  chat_id uuid REFERENCES family_chat(id),
  message_id uuid REFERENCES family_message(id),
  part_index integer CHECK (part_index IS NULL OR (part_index >= 0 AND part_index <= 9)),
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  usage_source text NOT NULL DEFAULT 'unknown' CHECK (usage_source IN ('unknown','reported')),
  audio_seconds double precision CHECK (audio_seconds IS NULL OR (audio_seconds >= 0 AND audio_seconds <= 75)),
  reported_audio_seconds double precision CHECK (reported_audio_seconds IS NULL OR (reported_audio_seconds >= 0 AND reported_audio_seconds <= 75)),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(user_id,request_id),
  CHECK ((usage_source='unknown' AND input_tokens IS NULL AND output_tokens IS NULL)
    OR (usage_source='reported' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS family_voice_usage_owner ON family_voice_usage(user_id,started_at);
CREATE UNIQUE INDEX IF NOT EXISTS family_chat_id_owner ON family_chat(id,user_id);
CREATE UNIQUE INDEX IF NOT EXISTS family_message_id_chat ON family_message(id,chat_id);
CREATE TABLE IF NOT EXISTS family_attachment (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id),
  chat_id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK(kind IN ('image','text','pdf')),
  media_type text NOT NULL,
  byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 1000000),
  data bytea NOT NULL CHECK(octet_length(data)=byte_size),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  text_content text,
  width integer CHECK(width BETWEEN 1 AND 2048),
  height integer CHECK(height BETWEEN 1 AND 2048),
  pages integer CHECK(pages BETWEEN 1 AND 10),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id,chat_id),
  FOREIGN KEY(chat_id,user_id) REFERENCES family_chat(id,user_id),
  CHECK((kind='image' AND media_type='image/jpeg' AND width IS NOT NULL AND height IS NOT NULL AND pages IS NULL AND text_content IS NULL)
    OR (kind='text' AND media_type='text/plain; charset=utf-8' AND text_content IS NOT NULL AND width IS NULL AND height IS NULL AND pages IS NULL)
    OR (kind='pdf' AND media_type='application/pdf' AND pages IS NOT NULL AND width IS NULL AND height IS NULL AND text_content IS NULL))
);
CREATE INDEX IF NOT EXISTS family_attachment_owner ON family_attachment(user_id);
CREATE TABLE IF NOT EXISTS family_message_attachment (
  message_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  position integer NOT NULL CHECK(position BETWEEN 0 AND 2),
  PRIMARY KEY(message_id,attachment_id),
  UNIQUE(message_id,position),
  FOREIGN KEY(message_id,chat_id) REFERENCES family_message(id,chat_id),
  FOREIGN KEY(attachment_id,chat_id) REFERENCES family_attachment(id,chat_id)
);
CREATE INDEX IF NOT EXISTS family_message_attachment_file ON family_message_attachment(attachment_id);
CREATE TABLE IF NOT EXISTS family_schema_version (
  id integer PRIMARY KEY CHECK (id = 1),
  version integer NOT NULL CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO family_schema_version(id,version) VALUES(1,4)
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
      (SELECT count(*) = 41 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (table_name,column_name,data_type,is_nullable) IN (
            ('family_chat','model','text','YES'),
            ('family_generation','actual_model','text','YES'),
            ('family_generation','mode','text','NO'),
            ('family_generation','source_generation_id','uuid','YES'),
            ('family_generation','superseded_at','timestamp with time zone','YES'),
            ('family_generation','cancel_requested_at','timestamp with time zone','YES'),
            ('family_voice_usage','id','uuid','NO'),
            ('family_voice_usage','user_id','text','NO'),
            ('family_voice_usage','request_id','uuid','NO'),
            ('family_voice_usage','kind','text','NO'),
            ('family_voice_usage','state','text','NO'),
            ('family_voice_usage','requested_model','text','YES'),
            ('family_voice_usage','actual_model','text','YES'),
            ('family_voice_usage','chat_id','uuid','YES'),
            ('family_voice_usage','message_id','uuid','YES'),
            ('family_voice_usage','part_index','integer','YES'),
            ('family_voice_usage','input_tokens','bigint','YES'),
            ('family_voice_usage','output_tokens','bigint','YES'),
            ('family_voice_usage','usage_source','text','NO'),
            ('family_voice_usage','audio_seconds','double precision','YES'),
            ('family_voice_usage','reported_audio_seconds','double precision','YES'),
            ('family_voice_usage','started_at','timestamp with time zone','NO'),
            ('family_voice_usage','finished_at','timestamp with time zone','YES'),
            ('family_attachment','id','uuid','NO'),
            ('family_attachment','user_id','text','NO'),
            ('family_attachment','chat_id','uuid','NO'),
            ('family_attachment','name','text','NO'),
            ('family_attachment','kind','text','NO'),
            ('family_attachment','media_type','text','NO'),
            ('family_attachment','byte_size','integer','NO'),
            ('family_attachment','data','bytea','NO'),
            ('family_attachment','sha256','text','NO'),
            ('family_attachment','text_content','text','YES'),
            ('family_attachment','width','integer','YES'),
            ('family_attachment','height','integer','YES'),
            ('family_attachment','pages','integer','YES'),
            ('family_attachment','created_at','timestamp with time zone','NO'),
            ('family_message_attachment','message_id','uuid','NO'),
            ('family_message_attachment','attachment_id','uuid','NO'),
            ('family_message_attachment','chat_id','uuid','NO'),
            ('family_message_attachment','position','integer','NO')
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
