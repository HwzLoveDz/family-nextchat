/** @jest-environment node */
import { jest } from "@jest/globals";
import type { ProviderCredential } from "../app/family/server/provider-keys";

const query = jest.fn<(sql: string, args?: unknown[]) => Promise<any>>();
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("@/app/family/server/db", () => ({
  getPool: () => ({ query }),
}));
const providerCredentialId = (credential: ProviderCredential) =>
  credential.name.padEnd(32, "0");
jest.unstable_mockModule("@/app/family/server/provider-policy", () => ({
  providerCredentialId,
}));
const {
  probeProviderBalance,
  providerObservations,
  recordProviderRuntime,
  refreshProviderBalances,
} = await import("@/app/family/server/provider-observations");

const key: ProviderCredential = {
  name: "a",
  key: "fixture-private-key-never-real",
  tier: "priority",
};
const originalFetch = global.fetch;
const fetchMock = jest.fn<typeof fetch>();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  fetchMock.mockReset();
  global.fetch = fetchMock;
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test.each([0, -0.51, 23.125])(
  "preserves an explicitly reported USD balance %s",
  async (amount) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ total_available: amount })),
    );
    const result = await probeProviderBalance(key);
    expect(result).toEqual({
      state: "available",
      remainingUSD: amount,
      checkedAt: expect.any(String),
      scope: "organization",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/dashboard/billing/credit_grants");
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${key.key}`,
        Accept: "application/json",
      },
    });
    expect(JSON.stringify(result)).not.toContain(key.key);
    expect((init?.signal as AbortSignal).aborted).toBe(true);
  },
);

test.each([401, 403])(
  "HTTP %s means unavailable billing permission, never zero or an unusable model key",
  async (status) => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: key.key, total_available: 0 } }),
        { status },
      ),
    );
    const result = await probeProviderBalance(key);
    expect(result).toMatchObject({
      state: "permission_denied",
      remainingUSD: null,
    });
    expect(JSON.stringify(result)).not.toContain(key.key);
  },
);

test("an explicit non-USD currency cannot be displayed as a dollar balance", async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ total_available: 20, currency: "eur" })),
  );
  expect(await probeProviderBalance(key)).toMatchObject({
    state: "unsupported",
    remainingUSD: null,
  });
});

test.each([404, 405, 410])("HTTP %s is unsupported", async (status) => {
  fetchMock.mockResolvedValue(
    new Response("private upstream text", { status }),
  );
  expect(await probeProviderBalance(key)).toMatchObject({
    state: "unsupported",
    remainingUSD: null,
  });
});

test.each([
  {},
  { total_available: "21" },
  { total_available: null },
  { total_available: 1e14 },
  [],
])(
  "missing or invalid amount cannot become a zero balance: %p",
  async (payload) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(payload)));
    expect(await probeProviderBalance(key)).toMatchObject({
      state: "unsupported",
      remainingUSD: null,
    });
  },
);

test.each([429, 500, 502])(
  "HTTP %s is a bounded diagnostic failure, not proof of exhausted credits",
  async (status) => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ total_available: 0, error: { message: key.key } }),
        { status },
      ),
    );
    expect(await probeProviderBalance(key)).toMatchObject({
      state: "unavailable",
      remainingUSD: null,
    });
  },
);

test("malformed JSON and oversized bodies expose no raw data", async () => {
  fetchMock
    .mockResolvedValueOnce(new Response(key.key))
    .mockResolvedValueOnce(
      new Response(" ".repeat(65537) + JSON.stringify({ total_available: 0 })),
    );
  for (let i = 0; i < 2; i++) {
    const result = await probeProviderBalance(key);
    expect(result).toMatchObject({ state: "unavailable", remainingUSD: null });
    expect(JSON.stringify(result)).not.toContain(key.key);
  }
});

test("preaborted caller makes no request and cancellation during the read returns no replacement observation", async () => {
  const before = new AbortController();
  before.abort();
  expect(await probeProviderBalance(key, before.signal)).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
  const current = new AbortController();
  fetchMock.mockImplementation(
    async (_url, init) =>
      new Promise<Response>(
        (_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                new DOMException("private reason " + key.key, "AbortError"),
              ),
            { once: true },
          ),
      ),
  );
  const pending = probeProviderBalance(key, current.signal);
  current.abort();
  expect(await pending).toBeNull();
});

test("a hung request aborts after four seconds and cleans its timer", async () => {
  jest.useFakeTimers();
  fetchMock.mockImplementation(
    async (_url, init) =>
      new Promise<Response>(
        (_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          ),
      ),
  );
  const pending = probeProviderBalance(key);
  await jest.advanceTimersByTimeAsync(3999);
  expect((fetchMock.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(
    false,
  );
  await jest.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({
    state: "unavailable",
    remainingUSD: null,
  });
  expect(jest.getTimerCount()).toBe(0);
});

test("observation listing stays scoped to configured credential identities and separates runtime from money", async () => {
  const id = providerCredentialId(key),
    foreign = "f".repeat(32);
  query.mockResolvedValue({
    rows: [
      {
        provider_id: id,
        balance_state: "permission_denied",
        balance_remaining_usd: "999",
        balance_checked_at: new Date("2026-11-03T00:00:00Z"),
        runtime_state: "accepted",
        runtime_observed_at: new Date("2026-11-03T00:00:01Z"),
      },
      {
        provider_id: foreign,
        balance_state: "available",
        balance_remaining_usd: "123",
      },
    ],
  });
  const result = await providerObservations([key, { ...key, name: "b" }]);
  expect(query.mock.calls[0][1]).toEqual([
    [id, providerCredentialId({ ...key, name: "b" })],
  ]);
  expect(result.size).toBe(2);
  expect(result.has(foreign)).toBe(false);
  expect(result.get(id)).toEqual({
    balance: {
      state: "permission_denied",
      remainingUSD: null,
      checkedAt: "2026-11-03T00:00:00.000Z",
      scope: "organization",
    },
    activity: { state: "accepted", checkedAt: "2026-11-03T00:00:01.000Z" },
  });
  expect(
    result.get(providerCredentialId({ ...key, name: "b" }))?.balance,
  ).toMatchObject({ state: "unchecked", remainingUSD: null });
});

test("runtime observations update only runtime columns and cannot replace a newer result", async () => {
  const at = new Date();
  await recordProviderRuntime("a".repeat(32), "quota_limited", at);
  const [sql, args] = query.mock.calls[0];
  expect(args).toEqual(["a".repeat(32), "quota_limited", at]);
  expect(sql).toContain("runtime_observed_at<=EXCLUDED.runtime_observed_at");
  expect(sql).not.toContain("balance_remaining_usd");
});

test("an unclaimed DB lease avoids any upstream request", async () => {
  await refreshProviderBalances([key], true);
  expect(fetchMock).not.toHaveBeenCalled();
  const [sql, args] = query.mock.calls[1];
  expect(sql).toContain("interval '30 seconds'");
  expect(sql).toContain("interval '60 seconds'");
  expect(sql).toContain("interval '10 minutes'");
  expect(sql).toContain("interval '35 seconds'");
  expect(args?.[2]).toBe(true);
});

test("a claimed lease stores sanitized billing evidence and releases only its matching lease", async () => {
  query.mockImplementation(async (sql) => ({
    rows: [],
    rowCount: sql.includes("RETURNING provider_id") ? 1 : 0,
  }));
  fetchMock.mockResolvedValue(new Response("private denial", { status: 403 }));
  await refreshProviderBalances([key], false);
  const claim = query.mock.calls.find(([sql]) =>
    sql.includes("RETURNING provider_id"),
  )!;
  const stored = query.mock.calls.find(([sql]) =>
    sql.includes("SET balance_state="),
  )!;
  const released = query.mock.calls.find(([sql]) =>
    sql.includes("SET refresh_started_at=NULL"),
  )!;
  expect(stored[1]?.slice(0, 4)).toEqual([
    providerCredentialId(key),
    claim[1]?.[1],
    "permission_denied",
    null,
  ]);
  expect(released[1]).toEqual([providerCredentialId(key), claim[1]?.[1]]);
  expect(stored[0]).toContain("refresh_started_at=$2");
});

test("cancellation after claiming releases the lease without erasing an earlier balance", async () => {
  const abort = new AbortController();
  query.mockImplementation(async (sql) => {
    if (sql.includes("RETURNING provider_id")) {
      abort.abort();
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  await refreshProviderBalances([key], true, abort.signal);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(
    query.mock.calls.some(([sql]) => sql.includes("SET balance_state=")),
  ).toBe(false);
  expect(
    query.mock.calls.some(([sql]) =>
      sql.includes("SET refresh_started_at=NULL"),
    ),
  ).toBe(true);
});

test("workers are capped at three and all sibling requests finish before a DB failure is returned", async () => {
  const keys = Array.from({ length: 5 }, (_, i) => ({
    ...key,
    name: String(i),
  }));
  const responses = Array.from({ length: 5 }, () => deferred<Response>());
  let active = 0,
    max = 0,
    started = 0;
  query.mockImplementation(async (sql, args) => {
    if (sql.includes("RETURNING provider_id")) return { rows: [], rowCount: 1 };
    if (
      sql.includes("SET balance_state=") &&
      args?.[0] === providerCredentialId(keys[0])
    )
      throw new Error("synthetic DB failure");
    return { rows: [], rowCount: 0 };
  });
  fetchMock.mockImplementation(async () => {
    const slot = started++;
    active++;
    max = Math.max(max, active);
    try {
      return await responses[slot].promise;
    } finally {
      active--;
    }
  });
  const pending = refreshProviderBalances(keys, true);
  let finished = false;
  const settled = pending.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(started).toBe(3);
  expect(max).toBe(3);
  responses[0].resolve(new Response("denied", { status: 403 }));
  for (let i = 0; i < 12; i++) await Promise.resolve();
  expect(finished).toBe(false);
  responses[1].resolve(new Response("denied", { status: 403 }));
  responses[2].resolve(new Response("denied", { status: 403 }));
  for (let i = 0; i < 16; i++) await Promise.resolve();
  responses[3].resolve(new Response("denied", { status: 403 }));
  responses[4].resolve(new Response("denied", { status: 403 }));
  await settled;
  await expect(pending).rejects.toThrow("synthetic DB failure");
  expect(active).toBe(0);
  expect(max).toBe(3);
});
