/** @jest-environment node */
import { jest } from "@jest/globals";

const callId = "11111111-1111-4111-8111-111111111111";
const chatId = "22222222-2222-4222-8222-222222222222";
const context = {
  callId,
  chatId,
  userId: "member-a",
  sessionId: "session-a",
  connectionId: "connection-a",
  model: "gpt-realtime-2.1-mini",
  voice: "marin",
  vad: "natural",
  remainingSeconds: 1800,
  remainingTurns: 100,
  history: [],
};
const created = {
  callId,
  chat: { id: chatId },
  model: context.model,
  voice: "marin",
  vad: "natural",
  maxCallSeconds: 1800,
  wsPath: `/api/family/realtime?callId=${callId}`,
};
const auth = jest.fn<(...args: unknown[]) => Promise<any>>();
const rate = jest.fn<(...args: unknown[]) => Promise<any>>();
const schema = jest.fn<(...args: unknown[]) => Promise<any>>();
const create = jest.fn<(...args: unknown[]) => Promise<any>>();
const claim = jest.fn<(...args: unknown[]) => Promise<any>>();
const release = jest.fn<(...args: unknown[]) => Promise<any>>();
const end = jest.fn<(...args: unknown[]) => Promise<any>>();
const relay = jest.fn<(...args: unknown[]) => Promise<any>>();
const upgrade = jest.fn<(...args: unknown[]) => Promise<Response>>();
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("@vercel/functions", () => ({
  upgradeWebSocket: upgrade,
}));
jest.unstable_mockModule("@/app/family/server/auth", () => ({
  requireUser: auth,
}));
jest.unstable_mockModule("@/app/family/server/accounts", () => ({
  rateLimit: rate,
}));
jest.unstable_mockModule("@/app/family/server/upgrades", () => ({
  requireFamilyApplicationUpgrade: schema,
}));
jest.unstable_mockModule("@/app/family/server/realtime-ledger", () => ({
  createRealtimeCall: create,
  claimRealtimeCall: claim,
  releaseRealtimeConnection: release,
  endRealtimeCall: end,
}));
jest.unstable_mockModule("@/app/family/server/realtime-relay", () => ({
  startRealtimeRelay: relay,
}));
const route = await import("@/app/api/family/realtime/route");
const { FamilyApiError } = await import("@/app/family/server/errors");
const { middleware } = await import("@/middleware");
const { NextRequest } = await import("next/server");
const preserved = Object.fromEntries(
  ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "FAMILY_MODE", "VERCEL_ENV"].map(
    (key) => [key, process.env[key]],
  ),
);
beforeEach(() => {
  jest.clearAllMocks();
  process.env.BETTER_AUTH_URL = "https://family.example";
  process.env.BETTER_AUTH_SECRET = "synthetic-secret-only-for-tests-00000000";
  process.env.FAMILY_MODE = "1";
  process.env.VERCEL_ENV = "production";
  auth.mockResolvedValue({
    user: { id: "member-a", role: "member", status: "approved" },
    sessionId: "session-a",
    authHeaders: new Headers({
      "set-cookie": "fixture-session=synthetic; HttpOnly; Secure; SameSite=Lax",
    }),
  });
  rate.mockResolvedValue(undefined);
  schema.mockResolvedValue(undefined);
  create.mockResolvedValue(created);
  claim.mockResolvedValue(context);
  release.mockResolvedValue(undefined);
  end.mockResolvedValue(undefined);
  relay.mockResolvedValue(undefined);
  upgrade.mockImplementation(async (handler) => {
    await (handler as (peer: unknown) => Promise<void>)({ fixturePeer: true });
    return new Response(null, { status: 200 });
  });
});
afterEach(() => {
  for (const [key, value] of Object.entries(preserved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
function request(
  method = "GET",
  options: {
    origin?: string | null;
    query?: string;
    body?: unknown;
    upgrade?: boolean;
  } = {},
) {
  const headers = new Headers();
  if (options.origin !== null)
    headers.set("origin", options.origin ?? "https://family.example");
  if (options.upgrade !== false && method === "GET")
    headers.set("upgrade", "websocket");
  if (options.body !== undefined)
    headers.set("content-type", "application/json");
  return new Request(
    `https://family.example/api/family/realtime${
      options.query ?? `?callId=${callId}`
    }`,
    {
      method,
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    },
  );
}
test.each([null, "https://attacker.example"])(
  "rejects websocket Origin %p before authentication or quota",
  async (origin) => {
    const response = await route.GET(request("GET", { origin }));
    expect(response.status).toBe(403);
    expect(auth).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(upgrade).not.toHaveBeenCalled();
  },
);
test("fresh session approval is required before a websocket can use a provider", async () => {
  auth.mockRejectedValue(
    new FamilyApiError(401, "请先登录。", "UNAUTHENTICATED"),
  );
  expect((await route.GET(request())).status).toBe(401);
  expect(claim).not.toHaveBeenCalled();
  expect(upgrade).not.toHaveBeenCalled();
});
test("missing upgrade and client configuration overrides cannot claim a call", async () => {
  expect((await route.GET(request("GET", { upgrade: false }))).status).toBe(
    426,
  );
  expect(
    (await route.GET(request("GET", { query: `?callId=${callId}&model=evil` })))
      .status,
  ).toBe(400);
  expect(
    (
      await route.GET(
        request("GET", { query: `?callId=${callId}&callId=${callId}` }),
      )
    ).status,
  ).toBe(400);
  expect(claim).not.toHaveBeenCalled();
});
test("a call belonging to someone else cannot be upgraded", async () => {
  claim.mockRejectedValue(
    new FamilyApiError(404, "通话不存在。", "REALTIME_NOT_FOUND"),
  );
  expect((await route.GET(request())).status).toBe(404);
  expect(upgrade).not.toHaveBeenCalled();
  expect(relay).not.toHaveBeenCalled();
});
test("the special upgrade response is preserved and bound only to authenticated owner and session", async () => {
  const special = new Response(null, { status: 200 });
  upgrade.mockResolvedValue(special);
  expect(await route.GET(request())).toBe(special);
  expect(claim).toHaveBeenCalledWith("member-a", "session-a", callId);
  expect(upgrade.mock.calls[0][1]).toEqual({ maxPayload: 16384 });
  expect(route.maxDuration).toBe(300);
  await (upgrade.mock.calls[0][0] as (peer: unknown) => Promise<void>)({
    fixturePeer: true,
  });
  expect(relay).toHaveBeenCalledWith({ fixturePeer: true }, context);
});
test("a failed platform upgrade releases only its own claimed lease and sanitizes its error", async () => {
  const logger = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    upgrade.mockRejectedValue(new Error("synthetic-private-provider-message"));
    const response = await route.GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-provider");
    expect(release).toHaveBeenCalledWith(context, {
      resume: false,
      reason: "upgrade_failed",
      inputAudioSeconds: 0,
    });
  } finally {
    logger.mockRestore();
  }
});
test("session admission and end refresh cookies and never accept a user identity from the browser", async () => {
  const body = { requestId: callId, chatId, voice: "marin", vad: "natural" };
  const response = await route.POST(request("POST", { query: "", body }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("set-cookie")).toContain("fixture-session");
  expect(create).toHaveBeenCalledWith("member-a", "session-a", body);
  expect(await response.json()).toEqual(created);
  const stopped = await route.DELETE(
    request("DELETE", { query: "", body: { callId } }),
  );
  expect(stopped.status).toBe(200);
  expect(end).toHaveBeenCalledWith("member-a", "session-a", callId);
  expect(
    (
      await route.DELETE(
        request("DELETE", { query: "", body: { callId, userId: "other" } }),
      )
    ).status,
  ).toBe(400);
});
test("the page CSP allows only configured same-origin WSS, never a caller-controlled websocket destination", () => {
  const response = middleware(
    new NextRequest("https://family.example/", {
      headers: { accept: "text/html", "x-forwarded-host": "evil.example" },
    }),
  );
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(csp).toContain("connect-src 'self' wss://family.example");
  expect(csp).not.toContain("wss://evil.example");
  expect(csp).not.toMatch(/connect-src[^;]* wss:(?:\s|;|$)/);
  expect(csp).not.toContain("api.openai.com");
});
