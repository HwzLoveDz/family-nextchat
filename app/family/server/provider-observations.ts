import "server-only";
import { getPool } from "./db";
import type { ProviderCredential } from "./provider-keys";
import { providerCredentialId } from "./provider-policy";
import type {
  ProviderBalance,
  ProviderRuntimeObservation,
} from "../provider-admin-types";

const BILLING_URL = "https://api.openai.com/dashboard/billing/credit_grants";
const EMPTY_BALANCE: ProviderBalance = {
  state: "unchecked",
  remainingUSD: null,
  checkedAt: null,
  scope: "organization",
};
const EMPTY_ACTIVITY: ProviderRuntimeObservation = {
  state: "unobserved",
  checkedAt: null,
};
type Observation = {
  balance: ProviderBalance;
  activity: ProviderRuntimeObservation;
};

/** Billing failures are not evidence that a model key is invalid or empty. */
export async function probeProviderBalance(
  credential: ProviderCredential,
  signal?: AbortSignal,
): Promise<ProviderBalance | null> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 4000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const answer = (
    state: ProviderBalance["state"],
    remainingUSD: number | null = null,
  ): ProviderBalance => ({
    state,
    remainingUSD,
    checkedAt: new Date().toISOString(),
    scope: "organization",
  });
  try {
    if (signal?.aborted) return null;
    const response = await fetch(BILLING_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.key}`,
        Accept: "application/json",
      },
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    });
    if ([401, 403].includes(response.status))
      return answer("permission_denied");
    if ([404, 405, 410].includes(response.status)) return answer("unsupported");
    if (!response.ok || !response.body) return answer("unavailable");
    reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) return answer("unavailable");
      parts.push(part.value);
    }
    const data: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(parts, size),
      ),
    );
    const currency =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as { currency?: unknown }).currency
        : undefined;
    if (currency !== undefined && currency !== "usd" && currency !== "USD")
      return answer("unsupported");
    const remaining =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as { total_available?: unknown }).total_available
        : undefined;
    if (
      typeof remaining !== "number" ||
      !Number.isFinite(remaining) ||
      Math.abs(remaining) > 1e12
    )
      return answer("unsupported");
    return answer("available", remaining);
  } catch {
    return signal?.aborted ? null : answer("unavailable");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        /* The aborted stream may already be detached. */
      }
    }
  }
}

export async function providerObservations(
  credentials: ProviderCredential[],
): Promise<Map<string, Observation>> {
  const ids = credentials.map(providerCredentialId);
  const rows = ids.length
    ? (
        await getPool().query(
          "SELECT provider_id,balance_state,balance_remaining_usd,balance_checked_at,runtime_state,runtime_observed_at FROM family_provider_observation WHERE provider_id=ANY($1::text[])",
          [ids],
        )
      ).rows
    : [];
  const result = new Map<string, Observation>();
  for (const id of ids)
    result.set(id, {
      balance: { ...EMPTY_BALANCE },
      activity: { ...EMPTY_ACTIVITY },
    });
  for (const row of rows) {
    if (!result.has(row.provider_id)) continue;
    const amount =
      row.balance_remaining_usd === null
        ? null
        : Number(row.balance_remaining_usd);
    result.set(row.provider_id, {
      balance: {
        state: row.balance_state,
        remainingUSD:
          row.balance_state === "available" &&
          amount !== null &&
          Number.isFinite(amount)
            ? amount
            : null,
        checkedAt: row.balance_checked_at?.toISOString() ?? null,
        scope: "organization",
      },
      activity: {
        state: row.runtime_state,
        checkedAt: row.runtime_observed_at?.toISOString() ?? null,
      },
    });
  }
  return result;
}

/** Persist actual request evidence, never a speculative paid probe. */
export async function recordProviderRuntime(
  id: string,
  state: "accepted" | "quota_limited",
  checkedAt: Date,
): Promise<void> {
  await getPool().query(
    `INSERT INTO family_provider_observation(provider_id,runtime_state,runtime_observed_at) VALUES($1,$2,$3)
    ON CONFLICT(provider_id) DO UPDATE SET runtime_state=EXCLUDED.runtime_state,runtime_observed_at=EXCLUDED.runtime_observed_at
    WHERE family_provider_observation.runtime_observed_at IS NULL OR family_provider_observation.runtime_observed_at<=EXCLUDED.runtime_observed_at`,
    [id, state, checkedAt],
  );
}

/** Database lease bounds polling across tabs and serverless instances. No timers survive this request. */
export async function refreshProviderBalances(
  credentials: ProviderCredential[],
  force: boolean,
  signal?: AbortSignal,
): Promise<void> {
  const pending = [...credentials];
  const worker = async () => {
    for (
      let credential = pending.shift();
      credential;
      credential = pending.shift()
    ) {
      if (signal?.aborted) return;
      const id = providerCredentialId(credential);
      await getPool().query(
        "INSERT INTO family_provider_observation(provider_id) VALUES($1) ON CONFLICT DO NOTHING",
        [id],
      );
      const lease = new Date();
      const claimed = await getPool().query(
        `UPDATE family_provider_observation SET refresh_started_at=$2
        WHERE provider_id=$1 AND (refresh_started_at IS NULL OR refresh_started_at<now()-interval '35 seconds')
          AND (balance_checked_at IS NULL OR balance_checked_at<now()-
            CASE WHEN $3::boolean THEN interval '30 seconds' WHEN balance_state IN ('permission_denied','unsupported') THEN interval '10 minutes' ELSE interval '60 seconds' END)
        RETURNING provider_id`,
        [id, lease, force],
      );
      if (!claimed.rowCount) continue;
      try {
        const balance = await probeProviderBalance(credential, signal);
        if (balance)
          await getPool().query(
            `UPDATE family_provider_observation SET balance_state=$3,balance_remaining_usd=$4,balance_checked_at=$5
          WHERE provider_id=$1 AND refresh_started_at=$2`,
            [id, lease, balance.state, balance.remainingUSD, balance.checkedAt],
          );
      } finally {
        await getPool().query(
          "UPDATE family_provider_observation SET refresh_started_at=NULL WHERE provider_id=$1 AND refresh_started_at=$2",
          [id, lease],
        );
      }
    }
  };
  // All workers are awaited, even when a sibling fails, before ending the request.
  const completed = await Promise.allSettled(
    Array.from({ length: Math.min(3, pending.length) }, worker),
  );
  const failure = completed.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}
