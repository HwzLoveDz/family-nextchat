/** @jest-environment node */

import { jest } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";
import md5 from "spark-md5";

// These credentials are fixtures. fetch is replaced for every test so no
// request can reach a provider or collector.
const TEST_KEY = "sk-fixture-private-deployment-never-valid";
const TEST_CODE = "fixture-family-access-code";
const TEST_BASE_URL = "https://provider.example";
const ENV_NAMES = [
  "OPENAI_API_KEY",
  "CODE",
  "BASE_URL",
  "HIDE_USER_API_KEY",
  "DISABLE_FAST_LINK",
  "CUSTOM_MODELS",
  "DISABLE_GPT4",
] as const;

describe("private deployment API boundaries", () => {
  const originalEnv = Object.fromEntries(
    ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  const originalFetch = global.fetch;
  let logSpy: ReturnType<typeof jest.spyOn>;
  let fetchMock: ReturnType<typeof makeFetchMock>;

  function makeFetchMock() {
    return jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "fixture reply" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
  }

  function chatRequest(authorization?: string, model = "fixture-model") {
    return new NextRequest(
      "https://family.example/api/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "fixture prompt" }],
          stream: false,
        }),
      },
    );
  }

  beforeEach(() => {
    jest.resetModules();
    process.env.OPENAI_API_KEY = TEST_KEY;
    process.env.CODE = TEST_CODE;
    process.env.BASE_URL = TEST_BASE_URL;
    process.env.HIDE_USER_API_KEY = "1";
    process.env.DISABLE_FAST_LINK = "1";
    process.env.CUSTOM_MODELS = "-all,+fixture-model@openai";
    delete process.env.DISABLE_GPT4;
    fetchMock = makeFetchMock();
    global.fetch = fetchMock as typeof fetch;
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    logSpy.mockRestore();
    for (const name of ENV_NAMES) {
      const value = originalEnv[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test.each([
    ["GET", "proxy"],
    ["POST", "proxy"],
    ["GET", "unrecognized-provider"],
    ["POST", "unrecognized-provider"],
  ])("%s for %s never reaches a caller-selected upstream", async (method, provider) => {
    const route = await import("../app/api/[provider]/[...path]/route");
    const req = new NextRequest(
      `https://family.example/api/${provider}/v1/chat/completions`,
      {
        method,
        headers: { "X-Base-URL": "https://collector.example/api.openai.com" },
        ...(method === "POST" ? { body: "{}" } : {}),
      },
    );

    const handler = method === "GET" ? route.GET : route.POST;
    const response = await handler(req, {
      params: Promise.resolve({ provider, path: ["v1", "chat", "completions"] }),
    });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("generic proxy stays disabled even when called directly with a valid code", async () => {
    const { handle } = await import("../app/api/proxy");
    const req = new NextRequest("https://family.example/api/proxy/v1/models", {
      headers: {
        Authorization: `Bearer nk-${TEST_CODE}`,
        "X-Base-URL": "https://api.openai.com.collector.example",
      },
    });
    const response = await handle(req, { params: { path: ["v1", "models"] } });

    expect(response.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ["missing", undefined],
    ["incorrect", "Bearer nk-not-the-deployment-code"],
    ["caller supplied API key", "Bearer sk-fixture-caller-key"],
  ])("%s authentication cannot spend the shared key", async (_name, authorization) => {
    const { handle } = await import("../app/api/openai");
    const response = await handle(chatRequest(authorization), {
      params: { path: ["v1", "chat", "completions"] },
    });

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("valid access code sends the shared key only to the configured upstream", async () => {
    const { handle } = await import("../app/api/openai");
    const req = chatRequest(`Bearer nk-${TEST_CODE}`);
    req.headers.set("X-Base-URL", "https://collector.example/api.openai.com");
    const response = await handle(req, {
      params: { path: ["v1", "chat", "completions"] },
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(`${TEST_BASE_URL}/v1/chat/completions`);
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      `Bearer ${TEST_KEY}`,
    );
    expect(await response.text()).not.toContain(TEST_KEY);
    const logs = JSON.stringify(logSpy.mock.calls);
    expect(logs).not.toContain(TEST_KEY);
    expect(logs).not.toContain(TEST_CODE);
    expect(logs).not.toContain(md5.hash(TEST_CODE));
  });

  test("valid access code without a provider key is never forwarded upstream", async () => {
    delete process.env.OPENAI_API_KEY;
    const { handle } = await import("../app/api/openai");
    const response = await handle(chatRequest(`Bearer nk-${TEST_CODE}`), {
      params: { path: ["v1", "chat", "completions"] },
    });
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(JSON.parse(body)).toEqual({
      error: true,
      msg: "The administrator has not configured an API key for GPT.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(body).not.toContain(TEST_CODE);
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(TEST_CODE);
  });

  test("an authenticated request cannot use a model outside the configured list", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    try {
      const { handle } = await import("../app/api/openai");
      const timersBeforeRequest = jest.getTimerCount();
      const response = await handle(
        chatRequest(`Bearer nk-${TEST_CODE}`, "unapproved-expensive-model"),
        { params: { path: ["v1", "chat", "completions"] } },
      );

      expect(response.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(timersBeforeRequest);
    } finally {
      // A failing regression must still release its test-owned timers.
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  test("framework rewrites cannot restore an unauthenticated API proxy", async () => {
    // Import .mjs with native Node: next/jest otherwise transforms the config
    // into CommonJS while its extension still requires ESM.
    const configCheck = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'console.log = () => {}; const { default: config } = await import("./next.config.mjs"); process.stdout.write(JSON.stringify(await config.rewrites()));',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, BUILD_MODE: "standalone" },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    );
    expect(configCheck.error).toBeUndefined();
    expect(configCheck.status).toBe(0);
    type Rule = { source: string };
    const rewrites = JSON.parse(configCheck.stdout) as
      | Rule[]
      | { beforeFiles?: Rule[]; afterFiles?: Rule[]; fallback?: Rule[] };
    const rules = Array.isArray(rewrites)
      ? rewrites
      : [
          ...(rewrites.beforeFiles ?? []),
          ...(rewrites.afterFiles ?? []),
          ...(rewrites.fallback ?? []),
        ];

    expect(rules.some((rule) => rule.source.startsWith("/api/proxy"))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("public configuration exposes feature flags without deployment credentials", async () => {
    const { GET } = await import("../app/api/config/route");
    const response = await GET();
    const body = await response.text();
    const config = JSON.parse(body);

    expect(config.needCode).toBe(true);
    expect(config.hideUserApiKey).toBe(true);
    expect(config.disableFastLink).toBe(true);
    expect(body).not.toContain(TEST_KEY);
    expect(body).not.toContain(TEST_CODE);
    expect(body).not.toContain(md5.hash(TEST_CODE));
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(TEST_KEY);
  });
});
