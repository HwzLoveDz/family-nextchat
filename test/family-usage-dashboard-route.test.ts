/** @jest-environment node */
import { jest } from "@jest/globals";
const base = "https://usage.test.invalid",
  requireUser = jest.fn<(...args: any[]) => Promise<any>>(),
  load = jest.fn<(...args: any[]) => Promise<any>>(),
  limit = jest.fn<(...args: any[]) => Promise<void>>(),
  upgrade = jest.fn<() => Promise<void>>();
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("@/app/family/server/auth", () => ({ requireUser }));
jest.unstable_mockModule("@/app/family/server/accounts", () => ({
  rateLimit: limit,
}));
jest.unstable_mockModule("@/app/family/server/upgrades", () => ({
  requireFamilyApplicationUpgrade: upgrade,
}));
jest.unstable_mockModule("@/app/family/server/usage-dashboard", () => ({
  loadUsageDashboard: load,
}));
const { FamilyApiError } = await import("@/app/family/server/errors"),
  self = await import("@/app/api/family/usage/route"),
  admin = await import("@/app/api/family/admin/usage/route");
beforeEach(() => {
  jest.clearAllMocks();
  process.env.FAMILY_MODE = "1";
  requireUser.mockResolvedValue({
    user: { id: "member-a", role: "member", status: "approved" },
    authHeaders: new Headers({
      "set-cookie": "synthetic=opaque; Secure; HttpOnly",
    }),
  });
  limit.mockResolvedValue();
  upgrade.mockResolvedValue();
  load.mockResolvedValue({ scope: "self", summary: { totalTokens: 123 } });
});
afterEach(() => {
  delete process.env.FAMILY_MODE;
});
const request = (query = "") => new Request(base + "/api/family/usage" + query);
test("self route derives actor from session and never accepts client-provided owner", async () => {
  const r = await self.GET(request("?days=7"));
  expect(r.status).toBe(200);
  expect(requireUser).toHaveBeenCalledWith(expect.any(Request));
  expect(load).toHaveBeenCalledWith(7, { actorId: "member-a", admin: false });
  expect(r.headers.get("set-cookie")).toContain("synthetic=opaque");
  expect(r.headers.get("cache-control")).toContain("no-store");
  expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
});
test.each([
  "?userId=member-b",
  "?userId=member-a",
  "?admin=true",
  "?days=7&days=30",
  "?days=365",
])("self route rejects extra or invalid filters %s", async (query) => {
  const r = await self.GET(request(query));
  expect(r.status).toBe(400);
  expect(load).not.toHaveBeenCalled();
});
test("administrator using self endpoint still gets self-only access", async () => {
  requireUser.mockResolvedValue({
    user: { id: "admin-a", role: "admin", status: "approved" },
    authHeaders: new Headers(),
  });
  await self.GET(request());
  expect(load).toHaveBeenCalledWith("all", {
    actorId: "admin-a",
    admin: false,
  });
});
test("admin endpoint requires fresh administrator and passes explicit scoped filter", async () => {
  const r = await admin.GET(request("?days=90&userId=opaque-member"));
  expect(r.status).toBe(200);
  expect(requireUser).toHaveBeenCalledWith(expect.any(Request), true);
  expect(load).toHaveBeenCalledWith(90, {
    actorId: "member-a",
    admin: true,
    userId: "opaque-member",
  });
});
test.each([401, 403])(
  "authorization %s is returned before reading any ledger",
  async (status) => {
    requireUser.mockRejectedValue(
      new FamilyApiError(status, "权限不足", "DENIED"),
    );
    const r = await admin.GET(request());
    expect(r.status).toBe(status);
    expect(load).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  },
);
test("schema or rate limit failure stops aggregation and retains private headers", async () => {
  upgrade.mockRejectedValue(
    new FamilyApiError(503, "请升级", "APPLICATION_UPGRADE_REQUIRED"),
  );
  let r = await self.GET(request());
  expect(r.status).toBe(503);
  expect(load).not.toHaveBeenCalled();
  upgrade.mockResolvedValue();
  limit.mockRejectedValue(new FamilyApiError(429, "稍后重试", "RATE_LIMITED"));
  r = await admin.GET(request());
  expect(r.status).toBe(429);
  expect(r.headers.get("cache-control")).toContain("no-store");
  expect(load).not.toHaveBeenCalled();
});
