/** @jest-environment node */
import { jest } from "@jest/globals";

const ownerId = "fixture-owner",
  attachmentId = "11111111-1111-4111-8111-111111111111";
const base = "https://fixture.test.invalid";
const auth = jest.fn<(request: Request, admin?: boolean) => Promise<any>>();
const query = jest.fn<(sql: string, values?: unknown[]) => Promise<any>>();
const audit = jest.fn(async (..._args: unknown[]) => {});
const upgrade = jest.fn(async () => {});
const generate = jest.fn(
  async (..._args: unknown[]) => new Response("fixture response"),
);
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("@/app/family/server/auth", () => ({
  requireUser: auth,
}));
jest.unstable_mockModule("@/app/family/server/db", () => ({
  getPool: () => ({ query }),
}));
jest.unstable_mockModule("@/app/family/server/accounts", () => ({
  audit,
  rateLimit: async () => {},
  siteStatus: async () => ({}),
  setup: async () => ({}),
  register: async () => ({}),
  listUsers: async () => [],
  createInvite: async () => ({}),
  recordActivity: async () => ({}),
  updateUser: async () => ({}),
}));
jest.unstable_mockModule("@/app/family/server/upgrades", () => ({
  requireFamilyApplicationUpgrade: upgrade,
  ensureFamilyApplicationUpgrade: async () => {},
  FAMILY_APPLICATION_SCHEMA_VERSION: 4,
}));
jest.unstable_mockModule("@/app/family/server/chats", () => ({
  generate,
  validId: (id: string) => id,
  listChats: async () => [],
  newChat: async () => ({}),
  updateChat: async () => ({}),
  chatDetail: async () => ({}),
  deleteChat: async () => ({}),
  cancelGeneration: async () => ({}),
}));
const { FamilyApiError } = await import("@/app/family/server/errors");
const { GET, POST } = await import("@/app/api/family/[...path]/route");
let role = "member",
  missing = false;
beforeEach(() => {
  jest.clearAllMocks();
  role = "member";
  missing = false;
  process.env.FAMILY_MODE = "1";
  process.env.BETTER_AUTH_URL = base;
  process.env.BETTER_AUTH_SECRET =
    "synthetic-auth-secret-not-a-real-value-000000";
  auth.mockImplementation(async (_request, admin) => {
    if (admin && role !== "admin")
      throw new FamilyApiError(403, "管理员权限不足。", "FORBIDDEN");
    return {
      user: { id: ownerId, role, status: "approved" },
      sessionExpiresAt: "2026-12-01T00:00:00Z",
      authHeaders: new Headers({
        "set-cookie": "fixture-session=opaque; Path=/; Secure; HttpOnly",
      }),
    };
  });
  query.mockImplementation(async () => ({
    rowCount: missing ? 0 : 1,
    rows: missing
      ? []
      : [
          {
            id: attachmentId,
            user_id: ownerId,
            chat_id: "chat",
            name: "中文 note.txt",
            kind: "text",
            media_type: "text/plain; charset=utf-8",
            byte_size: 7,
            data: Buffer.from("fixture"),
          },
        ],
  }));
  upgrade.mockResolvedValue();
  audit.mockResolvedValue();
});
afterEach(() => {
  delete process.env.FAMILY_MODE;
  delete process.env.BETTER_AUTH_URL;
  delete process.env.BETTER_AUTH_SECRET;
});
const get = (path: string[]) =>
  GET(new Request(base + "/api/family/" + path.join("/")) as any, {
    params: Promise.resolve({ path }),
  });
test("anonymous reads cannot reach attachment metadata or bytes", async () => {
  auth.mockRejectedValueOnce(
    new FamilyApiError(401, "请登录。", "UNAUTHENTICATED"),
  );
  const response = await get(["attachments", attachmentId]);
  expect(response.status).toBe(401);
  expect(query).not.toHaveBeenCalled();
});
test("members cannot select the admin archive attachment route", async () => {
  const response = await get(["admin", "attachments", attachmentId]);
  expect(response.status).toBe(403);
  expect(auth.mock.calls[0][1]).toBe(true);
  expect(query).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
});
test("owner bytes are private no-store/nosniff and carry rolling cookies plus safe disposition", async () => {
  const response = await get(["attachments", attachmentId]);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("fixture");
  expect(query.mock.calls[0][1]).toEqual([attachmentId, ownerId]);
  expect(response.headers.get("cache-control")).toContain("private, no-store");
  expect(response.headers.get("vercel-cdn-cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cross-origin-resource-policy")).toBe(
    "same-origin",
  );
  expect(response.headers.get("content-disposition")).toContain(
    "attachment; filename=\"attachment\"; filename*=UTF-8''",
  );
  expect(response.headers.get("content-disposition")).toContain(
    "%E4%B8%AD%E6%96%87",
  );
  expect(response.headers.get("set-cookie")).toContain("fixture-session=");
  expect(audit).not.toHaveBeenCalled();
});
test("foreign/archived/old-version owner requests are 404 without leaking bytes", async () => {
  missing = true;
  const response = await get(["attachments", attachmentId]);
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("fixture");
});
test("administrator archive reads are audited before any attachment bytes are returned", async () => {
  role = "admin";
  const response = await get(["admin", "attachments", attachmentId]);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("fixture");
  expect(query.mock.calls[0][1]).toEqual([attachmentId]);
  expect(audit).toHaveBeenCalledWith(
    ownerId,
    "attachment.content.read",
    ownerId,
    "chat",
  );
});
test("failed audit or upgrade prevents returning private content", async () => {
  role = "admin";
  audit.mockRejectedValueOnce(new FamilyApiError(503, "审计暂不可用。"));
  const response = await get(["admin", "attachments", attachmentId]);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("fixture");
  query.mockClear();
  upgrade.mockRejectedValueOnce(
    new FamilyApiError(503, "请升级。", "APPLICATION_UPGRADE_REQUIRED"),
  );
  expect((await get(["attachments", attachmentId])).status).toBe(503);
  expect(query).not.toHaveBeenCalled();
});
test("cross-origin attachment send is denied before auth or parsing", async () => {
  const response = await POST(
    new Request(base + "/api/family/chats/chat/messages", {
      method: "POST",
      headers: {
        origin: "https://foreign.test.invalid",
        "Content-Type": "application/json",
      },
      body: "{}",
    }) as any,
    { params: Promise.resolve({ path: ["chats", "chat", "messages"] }) },
  );
  expect(response.status).toBe(403);
  expect(auth).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
});
test("message JSON accepts bounded attachments but rejects >3MB stream before generate", async () => {
  const call = (content: string) =>
    POST(
      new Request(base + "/api/family/chats/chat/messages", {
        method: "POST",
        headers: { origin: base, "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }) as any,
      { params: Promise.resolve({ path: ["chats", "chat", "messages"] }) },
    );
  expect((await call("a".repeat(100_000))).status).toBe(200);
  expect(generate).toHaveBeenCalledTimes(1);
  generate.mockClear();
  expect((await call("a".repeat(3_000_001))).status).toBe(413);
  expect(generate).not.toHaveBeenCalled();
});
