/** @jest-environment node */
import { jest } from "@jest/globals";
import type { PoolClient } from "pg";
import type { ProviderCredential } from "../app/family/server/provider-keys";

const result = (rows: Record<string, any>[] = []) => ({
  rows,
  rowCount: rows.length,
});
const query =
  jest.fn<
    (sql: string, values?: unknown[]) => Promise<ReturnType<typeof result>>
  >();
const audit = jest.fn(async (..._args: unknown[]) => {});
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("@/app/family/server/db", () => ({
  getPool: () => ({ query }),
  transaction: async (run: (client: PoolClient) => Promise<any>) =>
    run({ query } as unknown as PoolClient),
}));
jest.unstable_mockModule("@/app/family/server/accounts", () => ({ audit }));
const policy = await import("@/app/family/server/provider-policy");
const credentialsModule = await import("@/app/family/server/provider-keys");
const fixture: ProviderCredential[] = [
  { name: "优先甲", key: "synthetic-policy-a-not-real", tier: "priority" },
  { name: "优先乙", key: "synthetic-policy-b-not-real", tier: "priority" },
];
const id = fixture.map(policy.providerCredentialId);
const timestamp = new Date("2026-11-03T00:00:00Z");
let saved: Record<string, any> | undefined;
let administrator = true;
const initialFetch = global.fetch;
const noNetwork = jest.fn<typeof fetch>(async () => {
  throw new Error("Network forbidden in policy tests");
});
beforeEach(() => {
  jest.replaceProperty(process, "env", {
    NODE_ENV: "test",
    FAMILY_OPENAI_PRIORITY_KEYS: JSON.stringify(
      fixture.map(({ name, key }) => ({ name, key })),
    ),
    FAMILY_OPENAI_FALLBACK_ENABLED: "0",
  });
  global.fetch = noNetwork;
  noNetwork.mockClear();
  query.mockReset();
  audit.mockReset();
  audit.mockResolvedValue();
  saved = undefined;
  administrator = true;
  query.mockImplementation(async (sql, values = []) => {
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) return result();
    if (sql.startsWith('SELECT id FROM "user"'))
      return result(administrator ? [{ id: "fixture-admin" }] : []);
    if (sql.startsWith("SELECT revision")) return result(saved ? [saved] : []);
    if (sql.startsWith("INSERT INTO family_provider_policy")) {
      saved = {
        revision: values[0],
        order_ids: JSON.parse(values[1] as string),
        disabled_ids: JSON.parse(values[2] as string),
        updated_at: timestamp,
      };
      return result([saved]);
    }
    throw new Error("Unexpected policy query");
  });
});
afterEach(() => {
  global.fetch = initialFetch;
  expect(noNetwork).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});
const row = (order = id, disabled: string[] = [], revision = 1) => ({
  revision,
  order_ids: order,
  disabled_ids: disabled,
  updated_at: timestamp,
});

test("initial empty policy uses existing server order and exposes no secret fragments", async () => {
  const state = await policy.getProviderPolicyState();
  expect(state).toEqual({
    revision: 0,
    updatedAt: null,
    keys: fixture.map((key, position) => ({
      id: id[position],
      name: key.name,
      tier: key.tier,
      enabled: true,
      position,
    })),
  });
  const serialized = JSON.stringify(state);
  fixture.forEach((key) => {
    expect(serialized).not.toContain(key.key);
    expect(serialized).not.toContain(key.key.slice(-12));
  });
  expect(state.keys.every((key) => /^[a-f0-9]{32}$/.test(key.id))).toBe(true);
});

test("saved order and enabled selection is applied for each new upstream request", async () => {
  saved = row([id[1], id[0]], [id[0]], 3);
  await expect(credentialsModule.effectiveProviderKeys()).resolves.toEqual([
    fixture[1],
  ]);
  saved = row([id[0], id[1]], [], 4);
  await expect(credentialsModule.effectiveProviderKeys()).resolves.toEqual(
    fixture,
  );
  expect(
    query.mock.calls.filter(([sql]) => sql.startsWith("SELECT revision")),
  ).toHaveLength(2);
});

test("save persists an exact complete order with an optimistic revision and returns sanitized state", async () => {
  const state = await policy.saveProviderPolicy(
    [id[1], id[0]],
    [id[0]],
    0,
    "fixture-admin",
  );
  expect(state.revision).toBe(1);
  expect(state.keys.map((key) => [key.id, key.enabled])).toEqual([
    [id[1], true],
    [id[0], false],
  ]);
  expect(query.mock.calls.map(([sql]) => sql)).toEqual(
    expect.arrayContaining([
      "SELECT pg_advisory_xact_lock(714209837)",
      expect.stringContaining("FOR SHARE"),
      expect.stringContaining("FOR UPDATE"),
    ]),
  );
  const insert = query.mock.calls.find(([sql]) => sql.startsWith("INSERT"))!;
  expect(insert[1]).toEqual([
    1,
    JSON.stringify([id[1], id[0]]),
    JSON.stringify([id[0]]),
    "fixture-admin",
  ]);
  expect(JSON.stringify(insert)).not.toContain(fixture[0].key);
  expect(audit).toHaveBeenCalledWith(
    "fixture-admin",
    "provider.policy.update",
    undefined,
    undefined,
    expect.objectContaining({ query }),
  );
});

test("failed audit rejects the entire save transaction instead of reporting success", async () => {
  audit.mockRejectedValueOnce(new Error("synthetic audit storage failure"));
  await expect(
    policy.saveProviderPolicy(id, [], 0, "fixture-admin"),
  ).rejects.toMatchObject({ status: 503, code: "PROVIDER_POLICY_UNAVAILABLE" });
  expect(audit).toHaveBeenCalledTimes(1);
});

test("stale revisions cannot overwrite another administrator's saved order", async () => {
  saved = row(id, [], 2);
  await expect(
    policy.saveProviderPolicy([...id].reverse(), [], 1, "fixture-admin"),
  ).rejects.toMatchObject({ status: 409, code: "PROVIDER_POLICY_CONFLICT" });
  expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});

test("an unchanged revision cannot authorize a stale browser key set after configuration rotation", async () => {
  saved = row(id, [], 1);
  const rotated = {
    ...fixture[1],
    key: "synthetic-policy-rotated-key-not-real",
  };
  process.env.FAMILY_OPENAI_PRIORITY_KEYS = JSON.stringify(
    [fixture[0], rotated].map(({ name, key }) => ({ name, key })),
  );
  await expect(
    policy.saveProviderPolicy(id, [], 1, "fixture-admin"),
  ).rejects.toMatchObject({ status: 409, code: "PROVIDER_POLICY_CONFLICT" });
  expect(query).not.toHaveBeenCalled();
  const latest = await policy.getProviderPolicyState();
  expect(latest.revision).toBe(1);
  expect(latest.keys.map((key) => key.id)).toEqual([
    policy.providerCredentialId(rotated),
    id[0],
  ]);
});

test("an unchanged revision cannot authorize a browser which omitted a newly added credential", async () => {
  saved = row(id, [], 1);
  const added = { name: "新加入", key: "synthetic-policy-added-key-not-real" };
  process.env.FAMILY_OPENAI_PRIORITY_KEYS = JSON.stringify([
    added,
    ...fixture.map(({ name, key }) => ({ name, key })),
  ]);
  await expect(
    policy.saveProviderPolicy(id, [], 1, "fixture-admin"),
  ).rejects.toMatchObject({ status: 409, code: "PROVIDER_POLICY_CONFLICT" });
  expect(query).not.toHaveBeenCalled();
});

test("an administrator who was demoted before transaction acquisition cannot edit routing", async () => {
  administrator = false;
  await expect(
    policy.saveProviderPolicy(id, [], 0, "fixture-admin"),
  ).rejects.toMatchObject({ status: 403, code: "ADMIN_REQUIRED" });
  expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});

test.each([
  [[], []],
  [[id[0]], []],
  [[id[0], id[0]], []],
  [id, [id[0], id[0]]],
  [id, ["f".repeat(32)]],
  [id, [...id]],
  [[id[0], "f".repeat(32)], []],
  [["bad", id[1]], []],
])(
  "incomplete, duplicate, invented or all-disabled submissions are rejected (%#)",
  async (order, disabled) => {
    await expect(
      policy.saveProviderPolicy(order, disabled, 0, "fixture-admin"),
    ).rejects.toHaveProperty("status");
    expect(query).not.toHaveBeenCalled();
  },
);

test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2147483647])(
  "invalid revision %p cannot touch storage",
  async (revision) => {
    await expect(
      policy.saveProviderPolicy(id, [], revision, "fixture-admin"),
    ).rejects.toMatchObject({ status: 400 });
    expect(query).not.toHaveBeenCalled();
  },
);

test("new priority keys prepend deterministically while a newly enabled legacy fallback remains last", async () => {
  saved = row([...id].reverse());
  const newer: ProviderCredential = {
    name: "新加入",
    key: "synthetic-policy-new-not-real",
    tier: "priority",
  };
  const legacy: ProviderCredential = {
    name: "旧备用",
    key: "synthetic-policy-legacy-not-real",
    tier: "fallback",
  };
  await expect(
    policy.resolveRuntimeProviderKeys([newer, ...fixture, legacy]),
  ).resolves.toEqual([newer, fixture[1], fixture[0], legacy]);
});

test("removed credentials cannot be resurrected and rotation receives a new identity", async () => {
  saved = row(id, [id[1]]);
  const rotated = { ...fixture[0], key: "synthetic-rotated-not-real" };
  expect(policy.providerCredentialId(rotated)).not.toBe(id[0]);
  await expect(
    policy.resolveRuntimeProviderKeys([rotated, fixture[1]]),
  ).resolves.toEqual([rotated]);
});

test("env-disabled legacy credentials are never read or restored by a saved policy", async () => {
  const legacy = {
    name: "旧备用",
    key: "synthetic-policy-legacy-not-real",
    tier: "fallback" as const,
  };
  saved = row([policy.providerCredentialId(legacy), ...id]);
  const read = jest.fn(() => {
    throw new Error("Disabled legacy must stay unread");
  });
  Object.defineProperty(process.env, "OPENAI_API_KEY", {
    get: read,
    configurable: true,
  });
  await expect(credentialsModule.effectiveProviderKeys()).resolves.toEqual(
    fixture,
  );
  expect(read).not.toHaveBeenCalled();
  await expect(
    policy.saveProviderPolicy(
      [policy.providerCredentialId(legacy), ...id],
      [],
      1,
      "fixture-admin",
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(read).not.toHaveBeenCalled();
});

test("removing the final enabled credential fails closed while the admin can still fix the policy", async () => {
  saved = row(id, [id[1]]);
  await expect(
    policy.resolveRuntimeProviderKeys([fixture[1]]),
  ).rejects.toMatchObject({ code: "PROVIDER_KEYS_DISABLED" });
  const state = await policy.getProviderPolicyState();
  expect(state.keys).toHaveLength(2);
});

test.each([
  { revision: -1, order_ids: id, disabled_ids: [], updated_at: timestamp },
  {
    revision: 1,
    order_ids: [id[0], id[0]],
    disabled_ids: [],
    updated_at: timestamp,
  },
  {
    revision: 1,
    order_ids: id,
    disabled_ids: ["f".repeat(32)],
    updated_at: timestamp,
  },
  { revision: 1, order_ids: id, disabled_ids: [], updated_at: "not-a-date" },
])(
  "malformed stored policies fail closed instead of reverting to environment order (%#)",
  async (bad) => {
    saved = bad;
    await expect(
      credentialsModule.effectiveProviderKeys(),
    ).rejects.toMatchObject({
      status: 503,
      code: "PROVIDER_POLICY_UNAVAILABLE",
    });
  },
);

test("storage errors never expose raw connection diagnostics or bypass policy", async () => {
  query.mockRejectedValue(
    new Error("postgresql://fixture-user:fixture-secret@private.invalid/db"),
  );
  await expect(credentialsModule.effectiveProviderKeys()).rejects.toMatchObject(
    { status: 503, code: "PROVIDER_POLICY_UNAVAILABLE" },
  );
  await expect(policy.getProviderPolicyState()).rejects.not.toThrow(
    "fixture-secret",
  );
  await expect(
    policy.saveProviderPolicy(id, [], 0, "fixture-admin"),
  ).rejects.toMatchObject({ status: 503, code: "PROVIDER_POLICY_UNAVAILABLE" });
});
