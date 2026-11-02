/** @jest-environment node */
import { jest } from "@jest/globals";

const base = "https://workspace.test.invalid";
const requireUser = jest.fn<(...args: any[]) => Promise<any>>();
const query = jest.fn<(sql: string, values?: unknown[]) => Promise<any>>();
const rateLimit = jest.fn(async (..._args: unknown[]) => {});
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("@/app/family/server/auth", () => ({ requireUser }));
jest.unstable_mockModule("@/app/family/server/accounts", () => ({ rateLimit }));
jest.unstable_mockModule("@/app/family/server/db", () => ({
  getPool: () => ({ query }),
}));
const { FamilyApiError } = await import("@/app/family/server/errors");
const { GET, PATCH } = await import("@/app/api/family/me/route");
const nested = await import("@/app/api/family/me/[...action]/route");
const { sessionLabel } = await import("@/app/family/server/workspace-account");
const user = {
  id: "owner",
  name: "家人",
  email: "owner@test.invalid",
  role: "member",
  status: "approved",
};
function request(method = "GET", body?: unknown, origin = base) {
  return new Request(base + "/api/family/me", {
    method,
    headers: { origin, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
function action(
  method: "GET" | "POST" | "DELETE",
  path: string[],
  origin = base,
) {
  return nested[method](request(method, undefined, origin), {
    params: Promise.resolve({ action: path }),
  });
}
beforeEach(() => {
  jest.clearAllMocks();
  process.env.FAMILY_MODE = "1";
  process.env.BETTER_AUTH_URL = base;
  process.env.BETTER_AUTH_SECRET =
    "synthetic-workspace-auth-secret-not-real-00000000";
  requireUser.mockResolvedValue({
    user,
    sessionId: "current-opaque-id",
    sessionExpiresAt: "2026-12-01T00:00:00.000Z",
    authHeaders: new Headers({
      "set-cookie": "fixture=opaque; Secure; HttpOnly",
    }),
  });
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});
afterEach(() => {
  delete process.env.FAMILY_MODE;
  delete process.env.BETTER_AUTH_URL;
  delete process.env.BETTER_AUTH_SECRET;
});

test("exact me route preserves identity/rolling expiry and never exposes session ID", async () => {
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    user,
    sessionExpiresAt: "2026-12-01T00:00:00.000Z",
  });
  expect(response.headers.get("set-cookie")).toContain("fixture=opaque");
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("content-security-policy")).toContain(
    "frame-ancestors 'none'",
  );
});

test.each(["PATCH", "POST", "DELETE"])(
  "%s rejects foreign origins before private DB/auth work",
  async (method) => {
    const response =
      method === "PATCH"
        ? await PATCH(
            request(method, { name: "Test" }, "https://foreign.test.invalid"),
          )
        : await action(
            method as "POST" | "DELETE",
            ["sessions", "other"],
            "https://foreign.test.invalid",
          );
    expect(response.status).toBe(403);
    expect(requireUser).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  },
);

test("fresh auth denial blocks account/session reads and mutations", async () => {
  requireUser.mockRejectedValue(
    new FamilyApiError(403, "账号停用", "ACCOUNT_UNAVAILABLE"),
  );
  expect((await GET(request())).status).toBe(403);
  expect((await PATCH(request("PATCH", { name: "new" }))).status).toBe(403);
  expect((await action("GET", ["sessions"])).status).toBe(403);
  expect((await action("POST", ["sessions", "revoke-others"])).status).toBe(
    403,
  );
  expect(query).not.toHaveBeenCalled();
});

test("name update is owner-scoped, retains account fields and requires current approved status", async () => {
  query.mockResolvedValue({
    rows: [{ ...user, name: "新称呼", token: "must-not-leak" }],
    rowCount: 1,
  });
  const response = await PATCH(request("PATCH", { name: "  新称呼  " }));
  expect(await response.json()).toEqual({
    user: { ...user, name: "新称呼" },
    sessionExpiresAt: "2026-12-01T00:00:00.000Z",
  });
  expect(query).toHaveBeenCalledWith(
    expect.stringMatching(/WHERE id=\$2 AND status='approved'/),
    ["新称呼", "owner"],
  );
  expect(rateLimit).toHaveBeenCalledWith(
    expect.anything(),
    "workspace:profile",
    10,
    60,
    "owner",
  );
});

test.each([
  { name: "Test", role: "admin" },
  { name: "Test", email: "other@test.invalid" },
  { name: "\n" },
  { name: "a\u0000b" },
  { name: "x".repeat(81) },
])("invalid profile fields never reach DB: %p", async (body) => {
  expect((await PATCH(request("PATCH", body))).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

test("profile update racing an account disable fails closed", async () => {
  expect((await PATCH(request("PATCH", { name: "名字" }))).status).toBe(403);
});

test("session list only selects own live sessions and serializes a strict credential-free whitelist", async () => {
  const date = new Date("2026-11-02T00:00:00.000Z");
  query.mockResolvedValue({
    rows: [
      {
        id: "current-opaque-id",
        createdAt: date,
        updatedAt: date,
        expiresAt: date,
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0) Chrome/123.0.0.0 Safari/537.36 private-marker",
        token: "secret-token",
        ipAddress: "192.0.2.1",
        userId: "owner",
      },
    ],
    rowCount: 1,
  });
  const response = await action("GET", ["sessions"]);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.sessions).toEqual([
    {
      id: "current-opaque-id",
      current: true,
      label: "Chrome · Windows",
      createdAt: date.toISOString(),
      updatedAt: date.toISOString(),
      expiresAt: date.toISOString(),
    },
  ]);
  expect(JSON.stringify(body)).not.toMatch(
    /secret-token|192\.0\.2\.1|private-marker|userAgent|userId/,
  );
  expect(query).toHaveBeenCalledWith(
    expect.stringMatching(/s\."userId"=\$1 AND s\."expiresAt">now\(\)/),
    ["owner", "current-opaque-id"],
  );
  expect(query.mock.calls[0][0]).not.toMatch(/token|ipAddress/);
});

test("revoking current session is rejected without deleting anything", async () => {
  expect(
    (await action("DELETE", ["sessions", "current-opaque-id"])).status,
  ).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

test("foreign or missing session deletion is indistinguishable and owner-bound", async () => {
  const response = await action("DELETE", ["sessions", "foreign-opaque-id"]);
  expect(response.status).toBe(404);
  expect(query).toHaveBeenCalledWith(
    expect.stringMatching(/s\."userId"=\$1 AND s\.id=\$2 AND s\.id<>\$3/),
    ["owner", "foreign-opaque-id", "current-opaque-id"],
  );
  expect(response.headers.get("set-cookie")).toContain("fixture=opaque");
});

test("opaque non-UUID sessions can be revoked and bulk revoke keeps current session", async () => {
  query.mockResolvedValue({ rows: [{ id: "not-a-uuid-opaque" }], rowCount: 1 });
  expect(
    (await action("DELETE", ["sessions", "not-a-uuid-opaque"])).status,
  ).toBe(200);
  expect((await action("POST", ["sessions", "revoke-others"])).status).toBe(
    200,
  );
  expect(query.mock.calls[1]).toEqual([
    expect.stringMatching(/s\."userId"=\$1 AND s\.id<>\$2/),
    ["owner", "current-opaque-id"],
  ]);
});

test.each(["", "x".repeat(257), "one/two", "has space"])(
  "invalid session ID %p cannot reach query",
  async (id) => {
    expect((await action("DELETE", ["sessions", id])).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  },
);

test("browser labels never echo raw unrecognized agents", () => {
  expect(sessionLabel("private-raw-agent")).toBe("浏览器 · 未知系统");
  expect(sessionLabel("Mozilla (iPhone) Version/17 Safari/605")).toBe(
    "Safari · iOS",
  );
  expect(sessionLabel("Mozilla Windows Chrome/120 Edg/120")).toBe(
    "Edge · Windows",
  );
});
