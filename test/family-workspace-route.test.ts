/** @jest-environment node */
import { jest } from "@jest/globals";
const auth = jest.fn<(...args: any[]) => Promise<any>>();
const page = jest.fn(async (..._args: unknown[]) => ({
  chats: [],
  nextCursor: null,
}));
const files = jest.fn(async (..._args: unknown[]) => ({
  files: [],
  nextCursor: null,
}));
const detail = jest.fn(async (..._args: unknown[]) => ({
  chat: {},
  messages: [],
  hasMoreMessages: false,
  nextBeforeMessageId: null,
}));
const update = jest.fn(async (..._args: unknown[]) => ({ id: "fixture" }));
const upgrade = jest.fn(async () => {});
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("@/app/family/server/auth", () => ({
  requireUser: auth,
}));
jest.unstable_mockModule("@/app/family/server/accounts", () => ({
  audit: async () => {},
  rateLimit: async () => {},
  siteStatus: async () => ({}),
  setup: async () => ({}),
  register: async () => ({}),
  listUsers: async () => [],
  createInvite: async () => ({}),
  recordActivity: async () => ({}),
  updateUser: async () => ({}),
}));
jest.unstable_mockModule("@/app/family/server/chats", () => ({
  validId: (id: string) => id,
  listChatPage: page,
  listChats: async () => [],
  newChat: async () => ({}),
  updateChat: update,
  chatDetail: detail,
  deleteChat: async () => ({}),
  generate: async () => new Response(),
  cancelGeneration: async () => ({}),
}));
jest.unstable_mockModule("@/app/family/server/workspace-files", () => ({
  listWorkspaceFiles: files,
}));
jest.unstable_mockModule("@/app/family/server/upgrades", () => ({
  requireFamilyApplicationUpgrade: upgrade,
  ensureFamilyApplicationUpgrade: async () => {},
  FAMILY_APPLICATION_SCHEMA_VERSION: 6,
}));
const { FamilyApiError } = await import("@/app/family/server/errors");
const routes = await import("@/app/api/family/[...path]/route");
const base = "https://workspace.test.invalid";
const owner = "synthetic-owner";
beforeEach(() => {
  jest.clearAllMocks();
  process.env.FAMILY_MODE = "1";
  process.env.BETTER_AUTH_URL = base;
  process.env.BETTER_AUTH_SECRET =
    "synthetic-not-a-secret-long-enough-for-fixture";
  auth.mockResolvedValue({
    user: { id: owner, status: "approved", role: "member" },
    sessionExpiresAt: "2026-12-01T00:00:00Z",
    authHeaders: new Headers({
      "set-cookie": "fixture=opaque; Path=/; Secure; HttpOnly",
    }),
  });
  upgrade.mockResolvedValue();
});
afterEach(() => {
  delete process.env.FAMILY_MODE;
  delete process.env.BETTER_AUTH_URL;
  delete process.env.BETTER_AUTH_SECRET;
});
const get = (path: string, query = "") =>
  routes.GET(new Request(`${base}/api/family/${path}${query}`) as any, {
    params: Promise.resolve({ path: path.split("/") }),
  });
test("chat and file queries use the authenticated owner and preserve private rolling-cookie responses", async () => {
  const response = await get(
    "chats",
    "?q=hello%25&view=archived&cursor=opaque",
  );
  expect(page).toHaveBeenCalledWith(owner, {
    q: "hello%",
    view: "archived",
    cursor: "opaque",
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("private, no-store");
  expect(response.headers.get("set-cookie")).toContain("fixture=");
  const fileResponse = await get(
    "files",
    "?q=note&chatId=fixture-chat&cursor=next",
  );
  expect(files).toHaveBeenCalledWith(owner, {
    q: "note",
    chatId: "fixture-chat",
    cursor: "next",
  });
  expect(fileResponse.headers.get("vercel-cdn-cache-control")).toBe("no-store");
  expect(upgrade).toHaveBeenCalledTimes(2);
});
test("older-message cursor is forwarded after approved owner authentication", async () => {
  expect(
    (await get("chats/fixture-chat", "?before=fixture-message")).status,
  ).toBe(200);
  expect(detail).toHaveBeenCalledWith(
    "fixture-chat",
    owner,
    false,
    "fixture-message",
  );
});
test.each(["chats", "files"])(
  "anonymous %s search never reaches private database operations",
  async (path) => {
    auth.mockRejectedValueOnce(new FamilyApiError(401, "请登录。"));
    expect((await get(path, "?q=private")).status).toBe(401);
    expect(page).not.toHaveBeenCalled();
    expect(files).not.toHaveBeenCalled();
    expect(upgrade).not.toHaveBeenCalled();
  },
);
test("missing v6 blocks both chat search and file metadata", async () => {
  upgrade.mockRejectedValue(
    new FamilyApiError(503, "需要升级。", "APPLICATION_UPGRADE_REQUIRED"),
  );
  expect((await get("chats")).status).toBe(503);
  expect((await get("files")).status).toBe(503);
  expect(page).not.toHaveBeenCalled();
  expect(files).not.toHaveBeenCalled();
});
test("cross-origin pin and restore mutation fails before authentication", async () => {
  const response = await routes.PATCH(
    new Request(base + "/api/family/chats/fixture-chat", {
      method: "PATCH",
      headers: {
        origin: "https://foreign.test.invalid",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ archived: false, pinned: true }),
    }) as any,
    { params: Promise.resolve({ path: ["chats", "fixture-chat"] }) },
  );
  expect(response.status).toBe(403);
  expect(auth).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
