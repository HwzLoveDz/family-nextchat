import "server-only";
import { createHash } from "node:crypto";
import { FamilyApiError } from "./errors";

export type ProviderCredential = {
  name: string;
  key: string;
  tier: "priority" | "fallback";
};

/** Stable opaque identity. Never expose any prefix or suffix of a credential. */
export function providerCredentialId(credential: ProviderCredential): string {
  return createHash("sha256").update(credential.key).digest("hex").slice(0, 32);
}

export async function effectiveProviderKeys(): Promise<ProviderCredential[]> {
  const credentials = configuredProviderKeys();
  if (!credentials.length) return [];
  const { resolveRuntimeProviderKeys } = await import("./provider-policy");
  return resolveRuntimeProviderKeys(credentials);
}

const MAX_PRIORITY_KEYS = 8;
const MAX_CONFIG_BYTES = 65_536;
const MAX_ERROR_BYTES = 8192;
const QUOTA_CODES = new Set([
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "insufficient_quota",
  "billing_hard_limit_reached",
]);
const invalidConfiguration = () =>
  new FamilyApiError(
    503,
    "模型密钥池配置无效，请联系管理员。",
    "PROVIDER_KEYS_INVALID",
  );

function credentialName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 64 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
    throw invalidConfiguration();
  return value.trim();
}

function credentialKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 4096 ||
    /\s|[\u0000-\u001f\u007f-\u009f]/.test(value.trim())
  )
    throw invalidConfiguration();
  return value.trim();
}

/** Read server configuration per request; an exhausted key is never cached. */
export function configuredProviderKeys(): ProviderCredential[] {
  const fallbackSetting = process.env.FAMILY_OPENAI_FALLBACK_ENABLED;
  if (
    fallbackSetting !== undefined &&
    fallbackSetting !== "0" &&
    fallbackSetting !== "1"
  )
    throw invalidConfiguration();

  const credentials: ProviderCredential[] = [];
  const secrets = new Set<string>();
  const names = new Map<string, string>();
  const add = (credential: ProviderCredential) => {
    // Priority candidates are visited first, so a duplicate fallback cannot
    // create another attempt or claim to provide an independent allowance.
    if (secrets.has(credential.key)) return;
    if (names.has(credential.name)) throw invalidConfiguration();
    secrets.add(credential.key);
    names.set(credential.name, credential.key);
    credentials.push(credential);
  };

  const raw = process.env.FAMILY_OPENAI_PRIORITY_KEYS;
  if (raw !== undefined) {
    let parsed: unknown;
    if (Buffer.byteLength(raw, "utf8") > MAX_CONFIG_BYTES)
      throw invalidConfiguration();
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalidConfiguration();
    }
    if (!Array.isArray(parsed) || parsed.length > MAX_PRIORITY_KEYS)
      throw invalidConfiguration();
    for (const entry of parsed) {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        Object.keys(entry).length !== 2 ||
        !Object.hasOwn(entry, "name") ||
        !Object.hasOwn(entry, "key")
      )
        throw invalidConfiguration();
      add({
        name: credentialName(entry.name),
        key: credentialKey(entry.key),
        tier: "priority",
      });
    }
  }

  if (fallbackSetting !== "0") {
    // Do not even read the legacy secret when fallback has been disabled.
    const legacy = process.env.OPENAI_API_KEY;
    if (legacy !== undefined && legacy.trim())
      add({
        name: credentialName(
          process.env.FAMILY_OPENAI_FALLBACK_NAME ?? "原有密钥",
        ),
        key: credentialKey(legacy),
        tier: "fallback",
      });
  }
  return credentials;
}

export function providerKeySummary(): Pick<
  ProviderCredential,
  "name" | "tier"
>[] {
  return configuredProviderKeys().map(({ name, tier }) => ({ name, tier }));
}

export function hasProviderKeys(): boolean {
  try {
    return configuredProviderKeys().length > 0;
  } catch {
    return false;
  }
}

export class ProviderQuotaExhaustedError extends FamilyApiError {
  constructor() {
    super(
      429,
      "模型服务的可用额度已用完，请联系管理员。",
      "PROVIDER_QUOTA_EXHAUSTED",
    );
    this.name = "ProviderQuotaExhaustedError";
  }
}

/** Status and structured error codes are evidence; human-readable text is not. */
export function isQuotaExhaustedError(status: number, error: unknown): boolean {
  return status === 429 && isQuotaExhaustedDetails(error);
}

/** Callers must separately prove rejection before a request/session was accepted. */
export function isQuotaExhaustedDetails(error: unknown): boolean {
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const { code, type } = error as { code?: unknown; type?: unknown };
  if (typeof code === "string" && QUOTA_CODES.has(code)) return true;
  return code == null && type === "insufficient_quota";
}

function assertNotAborted(signal: AbortSignal): void {
  // Never forward a caller-supplied reason, which could contain credentials.
  if (signal.aborted) throw new DOMException("请求已取消。", "AbortError");
}

/** Inspect only a rejected HTTP handshake, before any successful stream opens. */
export async function rejectExhaustedQuota(
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  assertNotAborted(signal);
  if (response.status !== 429 || !response.body) return;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    return;
  }
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("请求已取消。", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let quota = false;
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      assertNotAborted(signal);
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_ERROR_BYTES) return;
      chunks.push(value);
    }
    assertNotAborted(signal);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, bytes),
    );
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body))
      quota = isQuotaExhaustedError(
        response.status,
        (body as { error?: unknown }).error,
      );
  } catch {
    // Malformed/oversize/transport failures are not evidence of quota exhaustion.
    assertNotAborted(signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Cancellation must not wait on an unresponsive upstream's cancel promise.
    try {
      void reader.cancel().catch(() => {});
    } catch {
      /* Cleanup errors never expose an upstream object. */
    }
    try {
      reader.releaseLock();
    } catch {
      /* An already-detached reader requires no further cleanup. */
    }
  }
  assertNotAborted(signal);
  if (quota) throw new ProviderQuotaExhaustedError();
}

export async function withProviderKey<T>(
  attempt: (credential: ProviderCredential) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  assertNotAborted(signal);
  const credentials = await effectiveProviderKeys();
  if (!credentials.length)
    throw new FamilyApiError(
      503,
      "模型服务尚未配置，请联系管理员。",
      "MODEL_NOT_CONFIGURED",
    );
  for (const credential of credentials) {
    assertNotAborted(signal);
    let result: T;
    try {
      result = await attempt(credential);
    } catch (failure) {
      assertNotAborted(signal);
      if (!(failure instanceof ProviderQuotaExhaustedError)) throw failure;
      await observeRuntime(credential, "quota_limited");
      assertNotAborted(signal);
      continue;
    }
    assertNotAborted(signal);
    // Telemetry cannot turn an accepted paid attempt into another attempt.
    // Chat attempts return the upstream Response before the caller handles
    // non-quota failures. A resolved fetch alone is not successful acceptance.
    if (!(result instanceof Response) || result.ok)
      await observeRuntime(credential, "accepted");
    assertNotAborted(signal);
    return result;
  }
  throw new ProviderQuotaExhaustedError();
}

async function observeRuntime(
  credential: ProviderCredential,
  state: "accepted" | "quota_limited",
): Promise<void> {
  try {
    const { recordProviderRuntime } = await import("./provider-observations");
    await recordProviderRuntime(
      providerCredentialId(credential),
      state,
      new Date(),
    );
  } catch {
    // Best-effort, awaited and bounded by the DB pool. No credential or raw
    // error is logged, and a failed observation never masks the paid result.
  }
}
