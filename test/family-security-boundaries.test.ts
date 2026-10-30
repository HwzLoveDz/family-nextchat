/** @jest-environment node */

import { jest } from "@jest/globals";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { runInNewContext } from "node:vm";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// No deployment credentials or real upstreams are needed for these boundaries.
jest.unstable_mockModule("@/app/config/server", () => ({
  getServerSideConfig: jest.fn(() => ({
    apiKey: "sk-fixture-not-a-real-key",
    needCode: false,
    codes: new Set(),
    hideUserApiKey: false,
    allowedWebDavEndpoints: ["https://dav.example/"],
    customModels: "",
    isVercel: true,
    gaId: "fixture-analytics",
    gtmId: "fixture-tag-manager",
  })),
}));
jest.unstable_mockModule("@/app/config/client", () => ({
  getClientConfig: jest.fn(() => ({ fixture: "legacy-client-config" })),
}));
jest.unstable_mockModule("next/headers", () => ({
  headers: jest.fn(async () => new Headers()),
}));
jest.unstable_mockModule("@vercel/speed-insights/next", () => ({
  SpeedInsights: jest.fn(() => null),
}));
jest.unstable_mockModule("@next/third-parties/google", () => ({
  GoogleTagManager: jest.fn(() => null),
  GoogleAnalytics: jest.fn(() => null),
}));

type DirectHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, unknown>> },
) => Promise<Response>;

const providers = [
  "openai",
  "azure",
  "google",
  "anthropic",
  "baidu",
  "bytedance",
  "alibaba",
  "moonshot",
  "stability",
  "iflytek",
  "deepseek",
  "xai",
  "chatglm",
  "siliconflow",
  "302ai",
  "proxy",
  "cache",
  "unknown-provider",
];

describe("family deployment security boundaries", () => {
  const initialMode = process.env.FAMILY_MODE;
  const initialVercelEnv = process.env.VERCEL_ENV;
  const initialAuthUrl = process.env.BETTER_AUTH_URL;
  const initialNodeEnv = process.env.NODE_ENV;
  const initialFetch = global.fetch;
  let fetchMock: ReturnType<typeof jest.fn<typeof fetch>>;
  let logSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    Reflect.set(process.env, "NODE_ENV", "test");
    process.env.FAMILY_MODE = "1";
    delete process.env.VERCEL_ENV;
    delete process.env.BETTER_AUTH_URL;
    fetchMock = jest.fn<typeof fetch>(async () => {
      throw new Error("Security regression: unexpected upstream fetch");
    });
    global.fetch = fetchMock;
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = initialFetch;
    if (initialMode === undefined) delete process.env.FAMILY_MODE;
    else process.env.FAMILY_MODE = initialMode;
    if (initialVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = initialVercelEnv;
    if (initialAuthUrl === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = initialAuthUrl;
    if (initialNodeEnv === undefined)
      Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", initialNodeEnv);
    logSpy.mockRestore();
    jest.clearAllMocks();
  });

  function request(
    path: string,
    method: string,
    credential = "sk-fixture-byok",
  ) {
    return new NextRequest(`https://family.example${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        "X-Base-URL": "https://collector.example/api.openai.com",
        "Content-Type": "application/json",
      },
      ...(["GET", "HEAD"].includes(method) ? {} : { body: "{}" }),
    });
  }

  async function expectBlocked(response: Response) {
    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Vercel-CDN-Cache-Control")).toBe("no-store");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    expect(await response.text()).not.toContain("sk-fixture");
    expect(fetchMock).not.toHaveBeenCalled();
  }

  test.each(providers)(
    "direct provider route closes %s without middleware",
    async (provider) => {
      const route = await import("../app/api/[provider]/[...path]/route");
      // Use valid-shaped CODE and BYOK requests. Neither may select an upstream.
      for (const credential of ["nk-fixture-access-code", "sk-fixture-byok"]) {
        for (const method of ["GET", "POST"] as const) {
          const response = await route[method](
            request(`/api/${provider}/v1/chat/completions`, method, credential),
            {
              params: Promise.resolve({
                provider,
                path: ["v1", "chat", "completions"],
              }),
            },
          );
          await expectBlocked(response);
        }
      }
    },
  );

  test.each([
    ["config", () => import("../app/api/config/route"), {}],
    ["artifacts", () => import("../app/api/artifacts/route"), {}],
    ["tencent", () => import("../app/api/tencent/route"), {}],
    [
      "webdav",
      () => import("../app/api/webdav/[...path]/route"),
      { path: ["chatgpt-next-web", "backup.json"] },
    ],
    [
      "upstash",
      () => import("../app/api/upstash/[action]/[...key]/route"),
      { action: "get", key: ["private-history"] },
    ],
  ] as const)(
    "every exported %s handler closes without middleware",
    async (name, load, params) => {
      const route = await load();
      for (const method of [
        "GET",
        "POST",
        "PUT",
        "DELETE",
        "PATCH",
        "OPTIONS",
        "HEAD",
      ]) {
        const handler = (route as unknown as Record<string, DirectHandler>)[
          method
        ];
        if (!handler) continue;
        const endpoint =
          name === "webdav"
            ? "https://dav.example/"
            : "https://fixture.upstash.io";
        const response = await handler(
          request(
            `/api/${name}/private?endpoint=${encodeURIComponent(endpoint)}`,
            method,
          ),
          { params: Promise.resolve(params) },
        );
        await expectBlocked(response);
      }
    },
  );

  test("generic proxy and shared legacy authentication reject direct callers", async () => {
    const { handle } = await import("../app/api/proxy");
    await expectBlocked(
      await handle(request("/api/proxy/private", "POST"), {
        params: { path: ["private"] },
      }),
    );
    const { auth } = await import("../app/api/auth");
    const { ModelProvider } = await import("../app/constant");
    const { getServerSideConfig } = await import("../app/config/server");
    jest.mocked(getServerSideConfig).mockClear();
    for (const credential of ["nk-fixture-access-code", "sk-fixture-byok"]) {
      const req = request(
        "/api/openai/v1/chat/completions",
        "POST",
        credential,
      );
      expect(auth(req, ModelProvider.GPT).error).toBe(true);
      expect(req.headers.get("Authorization")).toBe(`Bearer ${credential}`);
    }
    expect(getServerSideConfig).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("legacy route inventory requires reviewing newly added API entrypoints", () => {
    function routes(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const file = join(dir, entry.name);
        return entry.isDirectory()
          ? routes(file)
          : entry.name === "route.ts"
          ? [relative("app/api", file).replaceAll("\\", "/")]
          : [];
      });
    }
    const legacyRoutes = routes("app/api").filter(
      (name) => !name.startsWith("family/") && !name.startsWith("auth/"),
    );
    expect(legacyRoutes.sort()).toEqual(
      [
        "[provider]/[...path]/route.ts",
        "artifacts/route.ts",
        "config/route.ts",
        "tencent/route.ts",
        "upstash/[action]/[...key]/route.ts",
        "webdav/[...path]/route.ts",
      ].sort(),
    );
  });

  test.each([undefined, "0"])(
    "production cannot reopen direct legacy APIs when FAMILY_MODE is %s",
    async (mode) => {
      Reflect.set(process.env, "NODE_ENV", "production");
      if (mode === undefined) delete process.env.FAMILY_MODE;
      else process.env.FAMILY_MODE = mode;
      const providerRoute = await import(
        "../app/api/[provider]/[...path]/route"
      );
      for (const credential of ["nk-fixture-access-code", "sk-fixture-byok"]) {
        await expectBlocked(
          await providerRoute.POST(
            request("/api/openai/v1/chat/completions", "POST", credential),
            {
              params: Promise.resolve({
                provider: "openai",
                path: ["v1", "chat", "completions"],
              }),
            },
          ),
        );
      }
      const directRoutes = [
        [await import("../app/api/config/route"), {}],
        [await import("../app/api/artifacts/route"), {}],
        [await import("../app/api/tencent/route"), {}],
        [
          await import("../app/api/webdav/[...path]/route"),
          { path: ["chatgpt-next-web", "backup.json"] },
        ],
        [
          await import("../app/api/upstash/[action]/[...key]/route"),
          { action: "get", key: ["private-history"] },
        ],
      ] as const;
      for (const [route, params] of directRoutes) {
        for (const method of ["GET", "POST", "PUT", "OPTIONS"]) {
          const handler = (route as unknown as Record<string, DirectHandler>)[
            method
          ];
          if (handler)
            await expectBlocked(
              await handler(
                request(
                  "/api/legacy/private?endpoint=https%3A%2F%2Ffixture.upstash.io",
                  method,
                ),
                { params: Promise.resolve(params) },
              ),
            );
        }
      }
      const { handle: proxy } = await import("../app/api/proxy");
      await expectBlocked(
        await proxy(request("/api/proxy/private", "POST"), {
          params: { path: ["private"] },
        }),
      );
      const { auth } = await import("../app/api/auth");
      const { ModelProvider } = await import("../app/constant");
      expect(
        auth(request("/api/openai/v1/models", "GET"), ModelProvider.GPT).error,
      ).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test.each([undefined, "0"])(
    "production framework config remains isolated when FAMILY_MODE is %s",
    (mode) => {
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_ENV: "production",
        BUILD_MODE: "standalone",
      };
      if (mode === undefined) delete childEnv.FAMILY_MODE;
      else childEnv.FAMILY_MODE = mode;
      const check = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'console.log=()=>{};const {default:c}=await import("./next.config.mjs");process.stdout.write(JSON.stringify({headers:await c.headers(),rewrites:await c.rewrites()}));',
        ],
        {
          cwd: process.cwd(),
          env: childEnv,
          encoding: "utf8",
          timeout: 10_000,
          windowsHide: true,
        },
      );
      expect(check.error).toBeUndefined();
      expect(check.status).toBe(0);
      const value = JSON.parse(check.stdout) as {
        headers: { headers: { key: string; value: string }[] }[];
        rewrites: { beforeFiles: unknown[] };
      };
      expect(value.rewrites.beforeFiles).toEqual([]);
      expect(
        value.headers
          .flatMap((rule) => rule.headers)
          .some((header) => header.key.startsWith("Access-Control-")),
      ).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test("middleware only admits the dedicated API namespaces and supplies fresh nonces", async () => {
    const { middleware } = await import("../middleware");
    for (const path of [
      "/api",
      "/api/cache/private.png",
      "/api/family-evil/chat",
      "/api/authentication/session",
      "/api/artifacts?id=private",
      "/sharegpt",
      "/google-fonts/css2",
    ]) {
      await expectBlocked(middleware(request(path, "GET")));
    }
    const first = middleware(request("/", "GET"));
    const second = middleware(request("/", "GET"));
    const csp = first.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(
      first.headers.get("x-middleware-request-content-security-policy"),
    ).toBe(csp);
    expect(second.headers.get("Content-Security-Policy")).not.toBe(csp);
    for (const path of ["/api/family/session", "/api/auth/sign-in/email"]) {
      const response = middleware(request(path, "POST"));
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    }
  });

  test("production alias page redirects to the configured origin without trusting redirect inputs", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.BETTER_AUTH_URL = "https://primary.example";
    const { middleware } = await import("../middleware");
    const response = middleware(
      new NextRequest(
        "https://family-nextchat.vercel.app//attacker.example/chat?next=https%3A%2F%2Fattacker.example",
        {
          headers: {
            accept: "text/html",
            "x-forwarded-host": "attacker.example",
          },
        },
      ),
    );
    expect(response.status).toBe(307);
    const destination = new URL(response.headers.get("Location")!);
    expect(destination.origin).toBe("https://primary.example");
    expect(destination.pathname).toBe("//attacker.example/chat");
    expect(destination.searchParams.get("next")).toBe(
      "https://attacker.example",
    );
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("production canonical page and Preview pages keep their own origin", async () => {
    process.env.VERCEL_ENV = "production";
    process.env.BETTER_AUTH_URL = "https://primary.example";
    const { middleware } = await import("../middleware");
    const primary = middleware(
      new NextRequest("https://primary.example/", {
        headers: { "x-forwarded-host": "attacker.example" },
      }),
    );
    expect(primary.headers.get("Location")).toBeNull();
    expect(primary.headers.get("x-middleware-next")).toBe("1");
    process.env.VERCEL_ENV = "preview";
    const preview = middleware(new NextRequest("https://preview.vercel.app/"));
    expect(preview.headers.get("Location")).toBeNull();
    expect(preview.headers.get("x-middleware-next")).toBe("1");
  });

  test.each([
    ["GET", "/api/family/me"],
    ["POST", "/api/auth/sign-in/email"],
    ["GET", "/_next/static/chunks/example.js"],
    ["GET", "/_next/image?url=%2Ficon.png"],
    ["GET", "/serviceWorker.js"],
    ["GET", "/icon.png"],
    ["POST", "/"],
  ])(
    "production alias %s %s is not redirected as a document",
    async (method, path) => {
      process.env.VERCEL_ENV = "production";
      process.env.BETTER_AUTH_URL = "https://primary.example";
      const { middleware } = await import("../middleware");
      const response = middleware(request(path, method));
      expect(response.headers.get("Location")).toBeNull();
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  test.each([
    undefined,
    "//attacker.example",
    "http://primary.example",
    "https://user:password@primary.example",
    "https://primary.example/path?next=https://attacker.example",
  ])("invalid production canonical config fails closed (%s)", async (value) => {
    process.env.VERCEL_ENV = "production";
    if (value === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = value;
    const { middleware } = await import("../middleware");
    const response = middleware(request("/", "GET"));
    expect(response.status).toBe(503);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.text()).not.toContain("attacker.example");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("family layout emits no legacy config, worker registration or third-party scripts", async () => {
    const { default: Layout, viewport } = await import("../app/layout");
    const html = renderToStaticMarkup(
      await Layout({ children: createElement("main", null, "family fixture") }),
    );
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain("family fixture");
    for (const blocked of [
      "serviceWorkerRegister",
      "legacy-client-config",
      "site.webmanifest",
      "fonts.googleapis.com",
      "googletagmanager",
      "vitals.vercel-insights",
    ]) {
      expect(html).not.toContain(blocked);
    }
    expect(viewport.maximumScale).toBeUndefined();
    const { getServerSideConfig } = await import("../app/config/server");
    const { getClientConfig } = await import("../app/config/client");
    const { GoogleAnalytics, GoogleTagManager } = await import(
      "@next/third-parties/google"
    );
    const { SpeedInsights } = await import("@vercel/speed-insights/next");
    // Clear module-import calls from unrelated legacy routes, then render again.
    jest.mocked(getServerSideConfig).mockClear();
    await Layout({ children: null });
    expect(getServerSideConfig).not.toHaveBeenCalled();
    expect(getClientConfig).not.toHaveBeenCalled();
    expect(GoogleAnalytics).not.toHaveBeenCalled();
    expect(GoogleTagManager).not.toHaveBeenCalled();
    expect(SpeedInsights).not.toHaveBeenCalled();
  });

  test("framework config removes credentialed wildcard CORS and all family external rewrites", () => {
    const check = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'console.log=()=>{};const {default:c}=await import("./next.config.mjs");process.stdout.write(JSON.stringify({headers:await c.headers(),rewrites:await c.rewrites()}));',
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, FAMILY_MODE: "1", BUILD_MODE: "standalone" },
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    );
    expect(check.error).toBeUndefined();
    expect(check.status).toBe(0);
    const value = JSON.parse(check.stdout) as {
      headers: { source: string; headers: { key: string; value: string }[] }[];
      rewrites: { beforeFiles: unknown[] };
    };
    expect(value.rewrites.beforeFiles).toEqual([]);
    const headers = value.headers.flatMap((rule) => rule.headers);
    expect(
      headers.some((header) => header.key.startsWith("Access-Control-")),
    ).toBe(false);
    expect(
      value.headers.find((rule) => rule.source === "/api/:path*")?.headers,
    ).toContainEqual({
      key: "Cache-Control",
      value: "private, no-store, max-age=0",
    });
  });

  test("worker safety upgrade removes known private caches and cannot intercept API files", async () => {
    const callbacks: Record<
      string,
      (event: { waitUntil(promise: Promise<unknown>): void }) => void
    > = {};
    const cacheDelete = jest.fn(async (_name: string) => true);
    const cacheOpen = jest.fn();
    const claim = jest.fn(async () => {});
    const unregister = jest.fn(async () => true);
    const navigate = jest.fn(async (_url: string) => null);
    const otherOriginNavigate = jest.fn(async (_url: string) => null);
    const matchAll = jest.fn(async () => [
      { url: "https://family.example/old-tab", navigate },
      { url: "https://unrelated.example/", navigate: otherOriginNavigate },
    ]);
    runInNewContext(readFileSync("public/serviceWorker.js", "utf8"), {
      self: {
        addEventListener: (name: string, fn: (typeof callbacks)[string]) => {
          callbacks[name] = fn;
        },
        skipWaiting: async () => {},
        clients: { claim, matchAll },
        registration: { unregister },
        location: { origin: "https://family.example" },
      },
      caches: { delete: cacheDelete, open: cacheOpen },
      URL,
    });
    const pending: Promise<unknown>[] = [];
    callbacks.install({
      waitUntil: (promise) => {
        pending.push(promise);
      },
    });
    callbacks.activate({
      waitUntil: (promise) => {
        pending.push(promise);
      },
    });
    await Promise.all(pending);
    expect(cacheDelete.mock.calls.map(([name]) => name).sort()).toEqual([
      "chatgpt-next-web-cache",
      "chatgpt-next-web-file",
    ]);
    expect(cacheOpen).not.toHaveBeenCalled();
    expect(callbacks.fetch).toBeUndefined();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(matchAll).toHaveBeenCalledWith({
      type: "window",
      includeUncontrolled: true,
    });
    expect(navigate).toHaveBeenCalledWith("https://family.example/old-tab");
    expect(otherOriginNavigate).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
