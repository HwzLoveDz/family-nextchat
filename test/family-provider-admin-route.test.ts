/** @jest-environment node */
import { jest } from "@jest/globals";
import type { ProviderCredential } from "../app/family/server/provider-keys";
const base = "https://provider-admin.test.invalid";
const requireUser = jest.fn<(...args: any[]) => Promise<any>>();
const rateLimit = jest.fn(async (..._args: unknown[]) => {});
const requireUpgrade = jest.fn(async () => {});
const getPolicy = jest.fn<() => Promise<any>>();
const savePolicy = jest.fn<(...args: any[]) => Promise<any>>();
const getObservations = jest.fn<(...args: any[]) => Promise<any>>();
const refreshBalances = jest.fn<(...args: any[]) => Promise<void>>();
const credentials: ProviderCredential[] = [
  {
    name: "志颖测试",
    key: "fixture-private-primary-never-real",
    tier: "priority",
  },
  {
    name: "子哲测试",
    key: "fixture-private-secondary-never-real",
    tier: "priority",
  },
];
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("@/app/family/server/auth", () => ({ requireUser }));
jest.unstable_mockModule("@/app/family/server/accounts", () => ({ rateLimit }));
jest.unstable_mockModule("@/app/family/server/upgrades", () => ({
  requireFamilyApplicationUpgrade: requireUpgrade,
}));
jest.unstable_mockModule("@/app/family/server/provider-keys", () => ({
  configuredProviderKeys: () => credentials,
}));
jest.unstable_mockModule("@/app/family/server/provider-policy", () => ({
  getProviderPolicyState: getPolicy,
  saveProviderPolicy: savePolicy,
}));
jest.unstable_mockModule("@/app/family/server/provider-observations", () => ({
  providerObservations: getObservations,
  refreshProviderBalances: refreshBalances,
}));
const { FamilyApiError } = await import("@/app/family/server/errors");
const exact = await import("@/app/api/family/admin/providers/route");
const refresh = await import("@/app/api/family/admin/providers/refresh/route");
const { handleProviderAdmin, providerAdminSnapshot } = await import(
  "@/app/family/server/provider-admin"
);
const ids = ["a".repeat(32), "b".repeat(32)];
function request(method = "GET", body?: unknown, origin = base) {
  return new Request(base + "/api/family/admin/providers", {
    method,
    headers: { origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
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
  jest.clearAllMocks();
  process.env.FAMILY_MODE = "1";
  process.env.BETTER_AUTH_URL = base;
  process.env.BETTER_AUTH_SECRET =
    "synthetic-provider-auth-secret-not-real-0000000";
  requireUser.mockResolvedValue({
    user: { id: "admin-fixture", role: "admin", status: "approved" },
    authHeaders: new Headers({
      "set-cookie": "synthetic=opaque; Secure; HttpOnly",
    }),
  });
  requireUpgrade.mockResolvedValue();
  rateLimit.mockResolvedValue();
  getPolicy.mockResolvedValue({
    revision: 4,
    updatedAt: "2026-11-03T01:00:00Z",
    keys: credentials.map((key, i) => ({
      id: ids[i],
      name: key.name,
      tier: key.tier,
      enabled: true,
      position: i,
    })),
  });
  savePolicy.mockResolvedValue({});
  getObservations.mockResolvedValue(
    new Map([
      [
        ids[0],
        {
          balance: {
            state: "permission_denied",
            remainingUSD: null,
            checkedAt: "2026-11-03T01:00:01Z",
            scope: "organization",
          },
          activity: { state: "accepted", checkedAt: "2026-11-03T01:00:00Z" },
        },
      ],
    ]),
  );
  refreshBalances.mockResolvedValue();
});
afterEach(() => {
  delete process.env.FAMILY_MODE;
  delete process.env.BETTER_AUTH_URL;
  delete process.env.BETTER_AUTH_SECRET;
});

test("GET enforces fresh admin authorization, returns only metadata, preserves rolling private response", async () => {
  const req = request();
  const response = await exact.GET(req);
  expect(requireUser).toHaveBeenCalledWith(req, true);
  expect(requireUpgrade).toHaveBeenCalledTimes(1);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("cdn-cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toContain("synthetic=opaque");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const data = await response.json();
  expect(data.revision).toBe(4);
  expect(data.providers[0]).toMatchObject({
    id: ids[0],
    name: "志颖测试",
    order: 0,
    enabled: true,
    balance: { state: "permission_denied", remainingUSD: null },
    activity: { state: "accepted" },
  });
  expect(data.providers[1]).toMatchObject({
    balance: { state: "unchecked", remainingUSD: null },
    activity: { state: "unobserved" },
  });
  for (const key of credentials)
    expect(JSON.stringify(data)).not.toContain(key.key);
  expect(refreshBalances).not.toHaveBeenCalled();
  expect(rateLimit).toHaveBeenCalledWith(
    req,
    "admin:provider-read",
    60,
    60,
    "admin-fixture",
  );
});

test.each([401, 403])(
  "all routes reject unauthenticated or nonadmin access with %s before metadata/refresh/write",
  async (status) => {
    requireUser.mockRejectedValue(
      new FamilyApiError(status, "private access rejected", "UNAUTHENTICATED"),
    );
    const responses = [
      await exact.GET(request()),
      await exact.PATCH(
        request("PATCH", { order: ids, disabled: [], expectedRevision: 4 }),
      ),
      await refresh.POST(request("POST", { force: true })),
    ];
    expect(responses.map((r) => r.status)).toEqual([status, status, status]);
    expect(getPolicy).not.toHaveBeenCalled();
    expect(getObservations).not.toHaveBeenCalled();
    expect(savePolicy).not.toHaveBeenCalled();
    expect(refreshBalances).not.toHaveBeenCalled();
    for (const r of responses)
      expect(r.headers.get("cache-control")).toContain("no-store");
  },
);

test.each(["PATCH", "POST"])(
  "%s rejects foreign origins before auth, billing, or DB work",
  async (method) => {
    const req = request(method, {}, "https://foreign.test.invalid");
    const response =
      method === "PATCH" ? await exact.PATCH(req) : await refresh.POST(req);
    expect(response.status).toBe(403);
    expect(requireUser).not.toHaveBeenCalled();
    expect(savePolicy).not.toHaveBeenCalled();
    expect(refreshBalances).not.toHaveBeenCalled();
  },
);

test("schema upgrade and rate limit failures cannot trigger a billing probe or policy change", async () => {
  requireUpgrade.mockRejectedValueOnce(
    new FamilyApiError(503, "upgrade required"),
  );
  expect((await refresh.POST(request("POST", { force: true }))).status).toBe(
    503,
  );
  expect(refreshBalances).not.toHaveBeenCalled();
  rateLimit.mockRejectedValueOnce(new FamilyApiError(429, "too fast"));
  expect(
    (
      await exact.PATCH(
        request("PATCH", { order: ids, disabled: [], expectedRevision: 4 }),
      )
    ).status,
  ).toBe(429);
  expect(savePolicy).not.toHaveBeenCalled();
});

test("PATCH passes explicit ordered IDs, disabled IDs, expected revision and server actor to transactional save", async () => {
  const req = request("PATCH", {
    order: [ids[1], ids[0]],
    disabled: [ids[0]],
    expectedRevision: 4,
  });
  const response = await exact.PATCH(req);
  expect(response.status).toBe(200);
  expect(savePolicy).toHaveBeenCalledWith(
    [ids[1], ids[0]],
    [ids[0]],
    4,
    "admin-fixture",
  );
  expect(getPolicy).toHaveBeenCalledTimes(1);
  expect(refreshBalances).not.toHaveBeenCalled();
});

test.each([
  { order: ids, disabled: [], expectedRevision: 4, key: "private" },
  { order: "forged", disabled: [], expectedRevision: 4 },
  { order: ids, disabled: "forged", expectedRevision: 4 },
  { order: [4], disabled: [], expectedRevision: 4 },
  { order: ids, disabled: [null], expectedRevision: 4 },
  { order: ids, disabled: [], expectedRevision: "4" },
  { order: ids, disabled: [], expectedRevision: -1 },
  { order: Array(10).fill(ids[0]), disabled: [], expectedRevision: 4 },
])("PATCH rejects malformed/extra input before mutation: %p", async (body) => {
  const response = await exact.PATCH(request("PATCH", body));
  expect(response.status).toBe(400);
  expect(savePolicy).not.toHaveBeenCalled();
});

test("stale policy revision returns 409 without reading a new snapshot or retrying the write", async () => {
  savePolicy.mockRejectedValue(
    new FamilyApiError(409, "配置已更新", "PROVIDER_POLICY_CONFLICT"),
  );
  const response = await exact.PATCH(
    request("PATCH", { order: ids, disabled: [], expectedRevision: 4 }),
  );
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe("PROVIDER_POLICY_CONFLICT");
  expect(savePolicy).toHaveBeenCalledTimes(1);
  expect(getPolicy).not.toHaveBeenCalled();
});

test.each([{}, { force: false }, { force: true }])(
  "POST refresh honors explicit force only, passes request abort scope and returns sanitized fresh snapshot: %p",
  async (body) => {
    const req = request("POST", body);
    const response = await refresh.POST(req);
    expect(response.status).toBe(200);
    expect(refreshBalances).toHaveBeenCalledWith(
      credentials,
      body.force === true,
      req.signal,
    );
    const data = await response.json();
    expect(data.providers[0].balance.remainingUSD).toBeNull();
    expect(JSON.stringify(data)).not.toContain(credentials[0].key);
    expect(rateLimit).toHaveBeenCalledWith(
      req,
      "admin:provider-refresh",
      12,
      60,
      "admin-fixture",
    );
  },
);

test.each([
  { force: "true" },
  { force: null },
  { force: true, key: "private" },
])("POST refresh rejects extra/invalid force: %p", async (body) => {
  expect((await refresh.POST(request("POST", body))).status).toBe(400);
  expect(refreshBalances).not.toHaveBeenCalled();
});

test("unexpected upstream/DB exceptions never serialize keys or raw responses", async () => {
  refreshBalances.mockRejectedValue(
    new Error(credentials[0].key + " raw billing response"),
  );
  const response = await refresh.POST(request("POST", { force: true }));
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).not.toContain(credentials[0].key);
  expect(body).not.toContain("raw billing");
  expect(body).toContain("SERVICE_UNAVAILABLE");
});

test("unknown methods cannot invoke a refresh or write", async () => {
  expect((await handleProviderAdmin(request("DELETE"))).status).toBe(404);
  expect((await handleProviderAdmin(request(), true)).status).toBe(404);
  expect(refreshBalances).not.toHaveBeenCalled();
  expect(savePolicy).not.toHaveBeenCalled();
});

test("snapshot failure awaits the sibling observation read before ending the request", async () => {
  const observations = deferred<Map<string, unknown>>();
  getObservations.mockReturnValue(observations.promise);
  getPolicy.mockRejectedValue(new Error("policy unavailable"));
  let settled = false;
  const pending = providerAdminSnapshot();
  const completion = pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // Advance a full event-loop turn so an early Promise.all rejection cannot
  // hide behind an insufficient number of manually flushed microtasks.
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  observations.resolve(new Map());
  await completion;
  await expect(pending).rejects.toThrow("policy unavailable");
});
