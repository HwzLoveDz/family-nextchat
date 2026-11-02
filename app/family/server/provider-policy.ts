import "server-only";
import { getPool, transaction } from "./db";
import { FamilyApiError } from "./errors";
import { audit } from "./accounts";
import {
  configuredProviderKeys,
  providerCredentialId,
  type ProviderCredential,
} from "./provider-keys";
export { providerCredentialId } from "./provider-keys";

const ID = /^[a-f0-9]{32}$/;
const MAX_KEYS = 9;

export interface ProviderPolicyKey {
  id: string;
  name: string;
  tier: "priority" | "fallback";
  enabled: boolean;
  position: number;
}
export interface ProviderPolicyState {
  revision: number;
  updatedAt: string | null;
  keys: ProviderPolicyKey[];
}
interface SavedPolicy {
  revision: number;
  order: string[];
  disabled: string[];
  updatedAt: string;
}

const unavailable = () =>
  new FamilyApiError(
    503,
    "API 使用顺序暂时无法读取，请稍后重试。",
    "PROVIDER_POLICY_UNAVAILABLE",
  );
const invalid = () =>
  new FamilyApiError(
    400,
    "API 使用顺序或启用设置无效。",
    "PROVIDER_POLICY_INVALID",
  );
const conflict = () =>
  new FamilyApiError(
    409,
    "API 配置已更新，请刷新后重新调整。",
    "PROVIDER_POLICY_CONFLICT",
  );

function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_KEYS ||
    value.some((id) => typeof id !== "string" || !ID.test(id)) ||
    new Set(value).size !== value.length
  )
    throw invalid();
  return [...value];
}
function decode(row: Record<string, any> | undefined): SavedPolicy | null {
  if (!row) return null;
  try {
    if (!Number.isSafeInteger(row.revision) || row.revision < 0)
      throw invalid();
    const order = ids(row.order_ids);
    const disabled = ids(row.disabled_ids);
    if (disabled.some((id) => !order.includes(id))) throw invalid();
    const updatedAt = new Date(row.updated_at).toISOString();
    return { revision: row.revision, order, disabled, updatedAt };
  } catch {
    // Database corruption is never permission to ignore an explicit policy.
    throw unavailable();
  }
}

function ordered(
  credentials: ProviderCredential[],
  saved: SavedPolicy | null,
): ProviderCredential[] {
  if (!saved) return [...credentials];
  const byId = new Map(
    credentials.map((key) => [providerCredentialId(key), key]),
  );
  // A newly configured credential gets the same new-key priority as before.
  // Rotation/removal cannot keep stale credentials or resurrect an env-disabled fallback.
  const newcomers = credentials.filter(
    (key) =>
      key.tier === "priority" &&
      !saved.order.includes(providerCredentialId(key)),
  );
  return [
    ...newcomers,
    ...saved.order.flatMap((id) => {
      const key = byId.get(id);
      return key ? [key] : [];
    }),
    // A newly enabled legacy fallback must never jump ahead of priority keys.
    ...credentials.filter(
      (key) =>
        key.tier === "fallback" &&
        !saved.order.includes(providerCredentialId(key)),
    ),
  ];
}

function summary(
  credentials: ProviderCredential[],
  saved: SavedPolicy | null,
): ProviderPolicyState {
  return {
    revision: saved?.revision ?? 0,
    updatedAt: saved?.updatedAt ?? null,
    keys: ordered(credentials, saved).map((key, index) => ({
      id: providerCredentialId(key),
      name: key.name,
      tier: key.tier,
      enabled: !saved?.disabled.includes(providerCredentialId(key)),
      position: index,
    })),
  };
}

async function read(): Promise<SavedPolicy | null> {
  try {
    const result = await getPool().query(
      "SELECT revision,order_ids,disabled_ids,updated_at FROM family_provider_policy WHERE id=1",
    );
    return decode(result.rows[0]);
  } catch {
    throw unavailable();
  }
}

/** Admin-only caller. Only opaque IDs and public labels leave this module. */
export async function getProviderPolicyState(): Promise<ProviderPolicyState> {
  const credentials = configuredProviderKeys();
  return summary(credentials, await read());
}

/** Called once for each newly started text/voice/upstream connection. */
export async function resolveRuntimeProviderKeys(
  credentials: ProviderCredential[],
): Promise<ProviderCredential[]> {
  const saved = await read();
  const enabled = ordered(credentials, saved).filter(
    (key) => !saved?.disabled.includes(providerCredentialId(key)),
  );
  if (credentials.length && !enabled.length)
    throw new FamilyApiError(
      503,
      "当前没有启用的 API，请联系管理员调整。",
      "PROVIDER_KEYS_DISABLED",
    );
  return enabled;
}

export async function saveProviderPolicy(
  order: string[],
  disabled: string[],
  expectedRevision: number,
  userId: string,
): Promise<ProviderPolicyState> {
  const requestedOrder = ids(order);
  const requestedDisabled = ids(disabled);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision >= 2_147_483_647 ||
    requestedDisabled.some((id) => !requestedOrder.includes(id))
  )
    throw invalid();
  const credentials = configuredProviderKeys();
  const currentIds = credentials.map(providerCredentialId);
  // A stale browser cannot silently omit a newly configured key, invent a key,
  // change a credential, or re-enable a fallback excluded by server config.
  if (
    requestedOrder.length !== currentIds.length ||
    requestedOrder.some((id) => !currentIds.includes(id))
  )
    throw conflict();
  if (
    !requestedOrder.length ||
    requestedDisabled.length >= requestedOrder.length
  )
    throw new FamilyApiError(
      400,
      "请至少保留一个启用的 API。",
      "PROVIDER_KEYS_DISABLED",
    );
  try {
    return await transaction(async (client) => {
      // The row may not exist yet. A transaction lock covers the initial insert
      // and ordinary edits without relying on an unlocked SELECT-then-INSERT.
      await client.query("SELECT pg_advisory_xact_lock(714209837)");
      const admin = await client.query(
        `SELECT id FROM "user" WHERE id=$1 AND role='admin' AND status='approved' FOR SHARE`,
        [userId],
      );
      if (!admin.rowCount)
        throw new FamilyApiError(403, "需要管理员权限。", "ADMIN_REQUIRED");
      const previous = decode(
        (
          await client.query(
            "SELECT revision,order_ids,disabled_ids,updated_at FROM family_provider_policy WHERE id=1 FOR UPDATE",
          )
        ).rows[0],
      );
      if ((previous?.revision ?? 0) !== expectedRevision) throw conflict();
      const result = await client.query(
        `INSERT INTO family_provider_policy(id,revision,order_ids,disabled_ids,updated_by)
         VALUES(1,$1,$2::jsonb,$3::jsonb,$4)
         ON CONFLICT(id) DO UPDATE SET revision=EXCLUDED.revision,
           order_ids=EXCLUDED.order_ids,disabled_ids=EXCLUDED.disabled_ids,
           updated_at=now(),updated_by=EXCLUDED.updated_by
         RETURNING revision,order_ids,disabled_ids,updated_at`,
        [
          expectedRevision + 1,
          JSON.stringify(requestedOrder),
          JSON.stringify(requestedDisabled),
          userId,
        ],
      );
      await audit(
        userId,
        "provider.policy.update",
        undefined,
        undefined,
        client,
      );
      return summary(credentials, decode(result.rows[0]));
    });
  } catch (failure) {
    if (failure instanceof FamilyApiError) throw failure;
    throw unavailable();
  }
}
