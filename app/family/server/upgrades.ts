import "server-only";
import { getPool, transaction } from "./db";
import { FamilyApiError } from "./errors";

export const FAMILY_APPLICATION_SCHEMA_VERSION = 8;

/** Application-only, additive upgrade. The caller owns the transaction and schema lock. */
export const FAMILY_APPLICATION_UPGRADE_SQL = String.raw`
ALTER TABLE family_chat ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE family_chat ADD COLUMN IF NOT EXISTS pinned_at timestamptz;
CREATE INDEX IF NOT EXISTS family_chat_workspace_order ON family_chat(user_id,pinned_at DESC NULLS LAST,updated_at DESC,id DESC);
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
ALTER TABLE family_generation ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text'
  CHECK(kind IN ('text','realtime'));
CREATE TABLE IF NOT EXISTS family_realtime_call (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id),
  -- Audit survives logout/session revocation; this is a trusted ID, not a cookie/token.
  session_id text NOT NULL,
  chat_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL,
  model text NOT NULL,
  voice text NOT NULL CHECK(voice IN ('marin','cedar','coral','sage')),
  vad text NOT NULL CHECK(vad IN ('natural','fast')),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','ended')),
  connection_id uuid,
  lease_expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  end_reason text,
  turn_count integer NOT NULL DEFAULT 0 CHECK(turn_count BETWEEN 0 AND 100),
  input_audio_seconds double precision CHECK(input_audio_seconds IS NULL OR (input_audio_seconds>=0 AND input_audio_seconds<=3600)),
  UNIQUE(user_id,request_id), UNIQUE(id,user_id),
  FOREIGN KEY(chat_id,user_id) REFERENCES family_chat(id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS family_realtime_one_user ON family_realtime_call(user_id) WHERE state='active';
CREATE UNIQUE INDEX IF NOT EXISTS family_realtime_one_chat ON family_realtime_call(chat_id) WHERE state='active';
CREATE INDEX IF NOT EXISTS family_realtime_expiry ON family_realtime_call(state,lease_expires_at);
CREATE TABLE IF NOT EXISTS family_realtime_turn (
  id uuid PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES family_realtime_call(id),
  connection_id uuid NOT NULL,
  input_item_id text NOT NULL CHECK(length(input_item_id) BETWEEN 1 AND 200),
  generation_id uuid NOT NULL UNIQUE REFERENCES family_generation(id),
  user_message_id uuid NOT NULL REFERENCES family_message(id),
  assistant_message_id uuid NOT NULL REFERENCES family_message(id),
  response_id text CHECK(length(response_id) BETWEEN 1 AND 200),
  output_item_id text CHECK(length(output_item_id) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','complete','partial','error')),
  transcript_recorded boolean NOT NULL DEFAULT false,
  interrupted boolean NOT NULL DEFAULT false,
  heard_complete boolean NOT NULL DEFAULT false,
  UNIQUE(call_id,input_item_id), UNIQUE(call_id,response_id), UNIQUE(id,call_id)
);
CREATE TABLE IF NOT EXISTS family_realtime_usage (
  id uuid PRIMARY KEY,
  call_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  user_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('response','transcribe')),
  provider_id text CHECK(length(provider_id) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','complete','partial','error')),
  requested_model text NOT NULL,
  actual_model text,
  input_tokens bigint CHECK(input_tokens IS NULL OR input_tokens>=0),
  output_tokens bigint CHECK(output_tokens IS NULL OR output_tokens>=0),
  usage_source text NOT NULL DEFAULT 'unknown' CHECK(usage_source IN ('unknown','reported')),
  reported_audio_seconds double precision CHECK(reported_audio_seconds IS NULL OR (reported_audio_seconds>=0 AND reported_audio_seconds<=1800)),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(turn_id,kind), UNIQUE(call_id,kind,provider_id),
  FOREIGN KEY(call_id,user_id) REFERENCES family_realtime_call(id,user_id),
  FOREIGN KEY(turn_id,call_id) REFERENCES family_realtime_turn(id,call_id),
  CHECK((usage_source='unknown' AND input_tokens IS NULL AND output_tokens IS NULL)
    OR (usage_source='reported' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS family_realtime_usage_owner ON family_realtime_usage(user_id,created_at);
CREATE TABLE IF NOT EXISTS family_realtime_playback (
  call_id uuid NOT NULL REFERENCES family_realtime_call(id),
  connection_id uuid NOT NULL,
  output_item_id text NOT NULL CHECK(length(output_item_id) BETWEEN 1 AND 200),
  played_ms integer NOT NULL CHECK(played_ms BETWEEN 0 AND 1800000),
  heard_complete boolean NOT NULL DEFAULT false,
  interrupted boolean NOT NULL DEFAULT false,
  PRIMARY KEY(call_id,connection_id,output_item_id)
);
CREATE TABLE IF NOT EXISTS family_provider_policy (
  id integer PRIMARY KEY CHECK(id=1),
  revision integer NOT NULL CHECK(revision>=0),
  order_ids jsonb NOT NULL CHECK(jsonb_typeof(order_ids)='array'),
  disabled_ids jsonb NOT NULL CHECK(jsonb_typeof(disabled_ids)='array'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES "user"(id)
);
CREATE TABLE IF NOT EXISTS family_provider_observation (
  provider_id text PRIMARY KEY CHECK(provider_id ~ '^[a-f0-9]{32}$'),
  balance_state text NOT NULL DEFAULT 'unchecked' CHECK(balance_state IN ('available','permission_denied','unsupported','unavailable','unchecked')),
  balance_remaining_usd numeric CHECK(balance_remaining_usd IS NULL OR balance_remaining_usd BETWEEN -1000000000000 AND 1000000000000),
  balance_checked_at timestamptz,
  refresh_started_at timestamptz,
  runtime_state text NOT NULL DEFAULT 'unobserved' CHECK(runtime_state IN ('unobserved','accepted','quota_limited')),
  runtime_observed_at timestamptz
);
ALTER TABLE family_generation ADD COLUMN IF NOT EXISTS image_size text;
ALTER TABLE family_generation ADD COLUMN IF NOT EXISTS image_quality text;
CREATE TABLE IF NOT EXISTS family_generated_image (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id),
  chat_id uuid NOT NULL,
  generation_id uuid NOT NULL UNIQUE REFERENCES family_generation(id),
  message_id uuid NOT NULL UNIQUE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 160),
  media_type text NOT NULL CHECK(media_type='image/jpeg'),
  byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 4194304),
  width integer NOT NULL CHECK(width BETWEEN 1 AND 1536),
  height integer NOT NULL CHECK(height BETWEEN 1 AND 1536),
  model text NOT NULL CHECK(length(model) BETWEEN 1 AND 100),
  data bytea NOT NULL CHECK(octet_length(data)=byte_size),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(chat_id,user_id) REFERENCES family_chat(id,user_id),
  FOREIGN KEY(message_id,chat_id) REFERENCES family_message(id,chat_id)
);
CREATE INDEX IF NOT EXISTS family_generated_image_owner ON family_generated_image(user_id,created_at);
CREATE TABLE IF NOT EXISTS family_schema_version (
  id integer PRIMARY KEY CHECK (id = 1),
  version integer NOT NULL CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO family_schema_version(id,version) VALUES(1,8)
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
      (SELECT count(*) = 123 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (table_name,column_name,data_type,is_nullable) IN (
            ('family_generation','image_size','text','YES'),
            ('family_generation','image_quality','text','YES'),
            ('family_generated_image','id','uuid','NO'),
            ('family_generated_image','user_id','text','NO'),
            ('family_generated_image','chat_id','uuid','NO'),
            ('family_generated_image','generation_id','uuid','NO'),
            ('family_generated_image','message_id','uuid','NO'),
            ('family_generated_image','name','text','NO'),
            ('family_generated_image','media_type','text','NO'),
            ('family_generated_image','byte_size','integer','NO'),
            ('family_generated_image','width','integer','NO'),
            ('family_generated_image','height','integer','NO'),
            ('family_generated_image','model','text','NO'),
            ('family_generated_image','data','bytea','NO'),
            ('family_generated_image','created_at','timestamp with time zone','NO'),
            ('family_chat','model','text','YES'),
            ('family_chat','pinned_at','timestamp with time zone','YES'),
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
            ('family_message_attachment','position','integer','NO'),
            ('family_generation','kind','text','NO'),
            ('family_realtime_call','id','uuid','NO'),
            ('family_realtime_call','user_id','text','NO'),
            ('family_realtime_call','session_id','text','NO'),
            ('family_realtime_call','chat_id','uuid','NO'),
            ('family_realtime_call','request_id','uuid','NO'),
            ('family_realtime_call','request_hash','text','NO'),
            ('family_realtime_call','model','text','NO'),
            ('family_realtime_call','voice','text','NO'),
            ('family_realtime_call','vad','text','NO'),
            ('family_realtime_call','state','text','NO'),
            ('family_realtime_call','connection_id','uuid','YES'),
            ('family_realtime_call','lease_expires_at','timestamp with time zone','NO'),
            ('family_realtime_call','started_at','timestamp with time zone','NO'),
            ('family_realtime_call','expires_at','timestamp with time zone','NO'),
            ('family_realtime_call','ended_at','timestamp with time zone','YES'),
            ('family_realtime_call','end_reason','text','YES'),
            ('family_realtime_call','turn_count','integer','NO'),
            ('family_realtime_call','input_audio_seconds','double precision','YES'),
            ('family_realtime_turn','id','uuid','NO'),
            ('family_realtime_turn','call_id','uuid','NO'),
            ('family_realtime_turn','connection_id','uuid','NO'),
            ('family_realtime_turn','input_item_id','text','NO'),
            ('family_realtime_turn','generation_id','uuid','NO'),
            ('family_realtime_turn','user_message_id','uuid','NO'),
            ('family_realtime_turn','assistant_message_id','uuid','NO'),
            ('family_realtime_turn','response_id','text','YES'),
            ('family_realtime_turn','output_item_id','text','YES'),
            ('family_realtime_turn','state','text','NO'),
            ('family_realtime_turn','transcript_recorded','boolean','NO'),
            ('family_realtime_turn','interrupted','boolean','NO'),
            ('family_realtime_turn','heard_complete','boolean','NO'),
            ('family_realtime_usage','id','uuid','NO'),
            ('family_realtime_usage','call_id','uuid','NO'),
            ('family_realtime_usage','turn_id','uuid','NO'),
            ('family_realtime_usage','user_id','text','NO'),
            ('family_realtime_usage','kind','text','NO'),
            ('family_realtime_usage','provider_id','text','YES'),
            ('family_realtime_usage','state','text','NO'),
            ('family_realtime_usage','requested_model','text','NO'),
            ('family_realtime_usage','actual_model','text','YES'),
            ('family_realtime_usage','input_tokens','bigint','YES'),
            ('family_realtime_usage','output_tokens','bigint','YES'),
            ('family_realtime_usage','usage_source','text','NO'),
            ('family_realtime_usage','reported_audio_seconds','double precision','YES'),
            ('family_realtime_usage','created_at','timestamp with time zone','NO'),
            ('family_realtime_usage','finished_at','timestamp with time zone','YES'),
            ('family_realtime_playback','call_id','uuid','NO'),
            ('family_realtime_playback','connection_id','uuid','NO'),
            ('family_realtime_playback','output_item_id','text','NO'),
            ('family_realtime_playback','played_ms','integer','NO'),
            ('family_realtime_playback','heard_complete','boolean','NO'),
            ('family_realtime_playback','interrupted','boolean','NO'),
            ('family_provider_policy','id','integer','NO'),
            ('family_provider_policy','revision','integer','NO'),
            ('family_provider_policy','order_ids','jsonb','NO'),
            ('family_provider_policy','disabled_ids','jsonb','NO'),
            ('family_provider_policy','updated_at','timestamp with time zone','NO'),
            ('family_provider_policy','updated_by','text','YES'),
            ('family_provider_observation','provider_id','text','NO'),
            ('family_provider_observation','balance_state','text','NO'),
            ('family_provider_observation','balance_remaining_usd','numeric','YES'),
            ('family_provider_observation','balance_checked_at','timestamp with time zone','YES'),
            ('family_provider_observation','refresh_started_at','timestamp with time zone','YES'),
            ('family_provider_observation','runtime_state','text','NO'),
            ('family_provider_observation','runtime_observed_at','timestamp with time zone','YES')
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
