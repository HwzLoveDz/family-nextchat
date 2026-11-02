/** @jest-environment node */

import { jest } from "@jest/globals";
import type { ProviderCredential } from "../app/family/server/provider-keys";

jest.unstable_mockModule("server-only", () => ({}));
const runtimePolicy = jest.fn(async (keys: ProviderCredential[]) => keys);
const runtimeObservation = jest.fn(async (..._args: unknown[]) => {});
jest.unstable_mockModule("@/app/family/server/provider-policy", () => ({
  resolveRuntimeProviderKeys: runtimePolicy,
}));
jest.unstable_mockModule("@/app/family/server/provider-observations", () => ({
  recordProviderRuntime: runtimeObservation,
}));
const { FamilyApiError } = await import("@/app/family/server/errors");
const {
  configuredProviderKeys,
  providerKeySummary,
  hasProviderKeys,
  ProviderQuotaExhaustedError,
  isQuotaExhaustedError,
  rejectExhaustedQuota,
  withProviderKey,
  effectiveProviderKeys,
  providerCredentialId,
} = await import("@/app/family/server/provider-keys");

// These values are synthetic; no inherited credential is read or sent anywhere.
const priority = [
  { name: "优先甲", key: "fixture-priority-a-not-a-real-secret" },
  { name: "优先乙", key: "fixture-priority-b-not-a-real-secret" },
];
const legacy = "fixture-legacy-not-a-real-secret";
const encoder = new TextEncoder();
const signal = () => new AbortController().signal;
const quotaBody = (code = "insufficient_quota") =>
  JSON.stringify({
    error: { code, message: "fixture raw provider diagnostic" },
  });
let environment: NodeJS.ProcessEnv;
const initialFetch = global.fetch;
const noNetwork = jest.fn<typeof fetch>(async () => {
  throw new Error("Outbound requests are forbidden in credential pool tests");
});

beforeEach(() => {
  // Replace the environment object without copying or inspecting its contents.
  environment = { NODE_ENV: "test" };
  jest.replaceProperty(process, "env", environment);
  global.fetch = noNetwork;
  noNetwork.mockClear();
  runtimePolicy.mockReset();
  runtimePolicy.mockImplementation(async (keys: ProviderCredential[]) => keys);
  runtimeObservation.mockReset();
  runtimeObservation.mockResolvedValue();
});
afterEach(() => {
  global.fetch = initialFetch;
  jest.restoreAllMocks();
  expect(noNetwork).not.toHaveBeenCalled();
});

function configure(includeFallback = true) {
  environment.FAMILY_OPENAI_PRIORITY_KEYS = JSON.stringify(priority);
  if (includeFallback) environment.OPENAI_API_KEY = legacy;
}

describe("server-only credential configuration", () => {
  test("keeps ordered priorities before the legacy fallback and exposes only labels", () => {
    configure();
    expect(configuredProviderKeys()).toEqual([
      ...priority.map((credential) => ({ ...credential, tier: "priority" })),
      { name: "原有密钥", key: legacy, tier: "fallback" },
    ]);
    expect(providerKeySummary()).toEqual([
      { name: "优先甲", tier: "priority" },
      { name: "优先乙", tier: "priority" },
      { name: "原有密钥", tier: "fallback" },
    ]);
    const publicMetadata = JSON.stringify(providerKeySummary());
    for (const key of [...priority.map((entry) => entry.key), legacy])
      expect(publicMetadata).not.toContain(key);
    expect(hasProviderKeys()).toBe(true);
  });

  test("supports fallback-only compatibility and an explicit fallback label", () => {
    environment.OPENAI_API_KEY = ` ${legacy} `;
    environment.FAMILY_OPENAI_FALLBACK_NAME = "原站备用";
    environment.FAMILY_OPENAI_FALLBACK_ENABLED = "1";
    expect(configuredProviderKeys()).toEqual([
      { name: "原站备用", key: legacy, tier: "fallback" },
    ]);
  });

  test("deduplicates identical secrets across both tiers without adding allowance", () => {
    environment.FAMILY_OPENAI_PRIORITY_KEYS = JSON.stringify([
      priority[0],
      { name: "同一密钥的另一标签", key: priority[0].key },
    ]);
    environment.OPENAI_API_KEY = priority[0].key;
    expect(configuredProviderKeys()).toEqual([
      { ...priority[0], tier: "priority" },
    ]);
    expect(providerKeySummary()).toEqual([
      { name: priority[0].name, tier: "priority" },
    ]);
  });

  test("accepts eight priorities plus one independent fallback", () => {
    environment.FAMILY_OPENAI_PRIORITY_KEYS = JSON.stringify(
      Array.from({ length: 8 }, (_, index) => ({
        name: `优先 ${index}`,
        key: `fixture-key-${index}`,
      })),
    );
    environment.OPENAI_API_KEY = legacy;
    expect(configuredProviderKeys()).toHaveLength(9);
  });

  test("disabled fallback does not read or validate the legacy secret or label", () => {
    configure(false);
    environment.FAMILY_OPENAI_FALLBACK_ENABLED = "0";
    const legacyRead = jest.fn(() => {
      throw new Error("The disabled legacy credential must remain unread");
    });
    Object.defineProperty(environment, "OPENAI_API_KEY", { get: legacyRead });
    Object.defineProperty(environment, "FAMILY_OPENAI_FALLBACK_NAME", {
      get: legacyRead,
    });
    expect(configuredProviderKeys()).toHaveLength(2);
    expect(providerKeySummary().every((key) => key.tier === "priority")).toBe(
      true,
    );
    expect(hasProviderKeys()).toBe(true);
    expect(legacyRead).not.toHaveBeenCalled();
  });

  test.each(["", "false", "true", "2", " 0"])(
    "rejects the unsupported fallback switch %j safely",
    (value) => {
      configure();
      environment.FAMILY_OPENAI_FALLBACK_ENABLED = value;
      expect(configuredProviderKeys).toThrow(FamilyApiError);
      expect(configuredProviderKeys).toThrow("模型密钥池配置无效");
      expect(hasProviderKeys()).toBe(false);
    },
  );

  test.each([
    ["malformed JSON", `{${legacy}`],
    ["empty JSON", ""],
    ["non-array", JSON.stringify({ name: "甲", key: legacy })],
    ["null entry", "[null]"],
    ["array entry", "[[]]"],
    ["missing key", JSON.stringify([{ name: "甲" }])],
    ["unknown field", JSON.stringify([{ ...priority[0], url: legacy }])],
    ["empty name", JSON.stringify([{ name: " ", key: legacy }])],
    ["long name", JSON.stringify([{ name: "甲".repeat(65), key: legacy }])],
    ["control in name", JSON.stringify([{ name: "甲\n乙", key: legacy }])],
    ["non-string key", JSON.stringify([{ name: "甲", key: 123 }])],
    ["empty key", JSON.stringify([{ name: "甲", key: " " }])],
    ["whitespace in key", JSON.stringify([{ name: "甲", key: "bad key" }])],
    ["long key", JSON.stringify([{ name: "甲", key: "k".repeat(4097) }])],
    [
      "ambiguous label",
      JSON.stringify([priority[0], { name: priority[0].name, key: legacy }]),
    ],
    [
      "too many entries",
      JSON.stringify(Array.from({ length: 9 }, () => priority[0])),
    ],
    ["oversize JSON", " ".repeat(65_537)],
  ])("rejects %s without exposing any supplied value", (_, value) => {
    environment.FAMILY_OPENAI_PRIORITY_KEYS = value;
    environment.OPENAI_API_KEY = legacy;
    let failure: unknown;
    try {
      configuredProviderKeys();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(FamilyApiError);
    expect(failure).toMatchObject({
      status: 503,
      code: "PROVIDER_KEYS_INVALID",
    });
    expect(String(failure)).not.toContain(legacy);
    expect(String(failure)).not.toContain(priority[0].key);
    expect(hasProviderKeys()).toBe(false);
  });

  test("an empty disabled pool reports no configuration and cannot attempt the legacy key", async () => {
    environment.FAMILY_OPENAI_FALLBACK_ENABLED = "0";
    environment.OPENAI_API_KEY = legacy;
    const attempt = jest.fn(async () => "unexpected");
    expect(configuredProviderKeys()).toEqual([]);
    expect(providerKeySummary()).toEqual([]);
    expect(hasProviderKeys()).toBe(false);
    await expect(withProviderKey(attempt, signal())).rejects.toMatchObject({
      status: 503,
      code: "MODEL_NOT_CONFIGURED",
    });
    expect(attempt).not.toHaveBeenCalled();
  });
});

describe("conservative billing-quota classification", () => {
  test.each([
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "insufficient_quota",
    "billing_hard_limit_reached",
  ])("accepts explicit HTTP 429 code %s", (code) => {
    expect(isQuotaExhaustedError(429, { code })).toBe(true);
  });

  test.each([200, 400, 401, 403, 404, 408, 500, 503])(
    "never treats HTTP %s as billing exhaustion",
    (status) => {
      expect(
        isQuotaExhaustedError(status, { code: "insufficient_quota" }),
      ).toBe(false);
    },
  );

  test.each([
    null,
    [],
    "insufficient_quota",
    { message: "insufficient_quota credit balance exhausted" },
    { code: "rate_limit_exceeded", type: "insufficient_quota" },
    { code: "tokens", type: "insufficient_quota" },
    { code: "unknown", type: "insufficient_quota" },
    { code: "", type: "insufficient_quota" },
    { code: 429, type: "insufficient_quota" },
    { code: "INSUFFICIENT_QUOTA" },
    { type: "rate_limit_exceeded" },
  ])(
    "does not infer exhaustion from an unknown or contradictory error %j",
    (error) => {
      expect(isQuotaExhaustedError(429, error)).toBe(false);
    },
  );

  test("supports the legacy quota type only when its code is absent", () => {
    expect(isQuotaExhaustedError(429, { type: "insufficient_quota" })).toBe(
      true,
    );
    expect(
      isQuotaExhaustedError(429, { code: null, type: "insufficient_quota" }),
    ).toBe(true);
    expect(
      isQuotaExhaustedError(429, {
        code: "insufficient_quota",
        type: "rate_limit_exceeded",
      }),
    ).toBe(true);
  });
});

describe("bounded HTTP rejection inspection", () => {
  test("recognizes quota from split UTF-8 JSON and returns a fixed safe error", async () => {
    const bytes = encoder.encode(
      JSON.stringify({
        error: { code: "insufficient_quota", message: legacy + "额度" },
      }),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += 2)
          controller.enqueue(bytes.slice(index, index + 2));
        controller.close();
      },
    });
    const response = new Response(body, { status: 429 });
    let failure: unknown;
    try {
      await rejectExhaustedQuota(response, signal());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProviderQuotaExhaustedError);
    expect(failure).toMatchObject({
      status: 429,
      code: "PROVIDER_QUOTA_EXHAUSTED",
    });
    expect(String(failure)).not.toContain(legacy);
    expect(body.locked).toBe(false);
  });

  test("accepts a complete quota object at the exact 8 KiB bound", async () => {
    const skeleton = JSON.stringify({
      error: { code: "insufficient_quota" },
      padding: "",
    });
    const text = JSON.stringify({
      error: { code: "insufficient_quota" },
      padding: "p".repeat(8192 - encoder.encode(skeleton).byteLength),
    });
    expect(encoder.encode(text)).toHaveLength(8192);
    await expect(
      rejectExhaustedQuota(new Response(text, { status: 429 }), signal()),
    ).rejects.toBeInstanceOf(ProviderQuotaExhaustedError);
  });

  test("cancels oversize bodies without trusting a valid quota prefix or awaiting cancel", async () => {
    const cancel = jest.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(quotaBody() + " ".repeat(8192)));
      },
      cancel,
    });
    await expect(
      rejectExhaustedQuota(new Response(body, { status: 429 }), signal()),
    ).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });

  test.each([
    "{not JSON",
    "[]",
    JSON.stringify({ code: "insufficient_quota" }),
    JSON.stringify({ error: { message: "insufficient_quota" } }),
    quotaBody("rate_limit_exceeded"),
  ])("does not switch on malformed or non-quota JSON %s", async (text) => {
    const response = new Response(text, { status: 429 });
    await expect(
      rejectExhaustedQuota(response, signal()),
    ).resolves.toBeUndefined();
    expect(response.body!.locked).toBe(false);
  });

  test("invalid UTF-8 and a raw stream failure cannot become quota evidence", async () => {
    const invalid = new Response(
      new Uint8Array([...encoder.encode(quotaBody()), 0xff]),
      { status: 429 },
    );
    await expect(
      rejectExhaustedQuota(invalid, signal()),
    ).resolves.toBeUndefined();
    const failed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(legacy));
      },
    });
    await expect(
      rejectExhaustedQuota(new Response(failed, { status: 429 }), signal()),
    ).resolves.toBeUndefined();
    expect(failed.locked).toBe(false);
  });

  test("does not consume successful streams or non-429 rejections", async () => {
    for (const status of [200, 401, 403, 500, 503]) {
      const response = new Response(quotaBody(), { status });
      await rejectExhaustedQuota(response, signal());
      expect(response.bodyUsed).toBe(false);
      expect(await response.text()).toBe(quotaBody());
    }
  });

  test("abort interrupts a pending error-body read, cancels its reader and hides the reason", async () => {
    const cancel = jest.fn(() => {});
    const body = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const pending = rejectExhaustedQuota(
      new Response(body, { status: 429 }),
      controller.signal,
    );
    controller.abort(new Error(legacy));
    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: "请求已取消。",
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
  });
});

describe("one attempt per credential, with quota-only failover", () => {
  test("a new request applies persisted order and disabled selection before its first attempt", async () => {
    configure();
    runtimePolicy.mockImplementation(async (keys) => [keys[1]]);
    const attempt = jest.fn(async (key: ProviderCredential) => key.name);
    await expect(withProviderKey(attempt, signal())).resolves.toBe("优先乙");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(runtimeObservation).toHaveBeenCalledWith(
      providerCredentialId(priority[1] as ProviderCredential),
      "accepted",
      expect.any(Date),
    );
  });

  test("policy read failures fail closed without contacting a provider", async () => {
    configure();
    runtimePolicy.mockRejectedValue(
      new FamilyApiError(503, "policy unavailable"),
    );
    const attempt = jest.fn(async () => "forbidden");
    await expect(withProviderKey(attempt, signal())).rejects.toMatchObject({
      status: 503,
    });
    expect(attempt).not.toHaveBeenCalled();
  });

  test("an observation failure after paid acceptance cannot start another credential attempt", async () => {
    configure();
    runtimeObservation.mockRejectedValue(
      new Error("synthetic storage failure"),
    );
    const attempt = jest.fn(async (key: ProviderCredential) => key.name);
    await expect(withProviderKey(attempt, signal())).resolves.toBe("优先甲");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test.each([401, 403, 429, 500, 503])(
    "resolved HTTP %p is neither accepted evidence nor a reason to replay through another credential",
    async (status) => {
      configure();
      const rejected = new Response("synthetic rejection", { status });
      const attempt = jest.fn(async () => rejected);
      await expect(withProviderKey(attempt, signal())).resolves.toBe(rejected);
      expect(attempt).toHaveBeenCalledTimes(1);
      expect(runtimeObservation).not.toHaveBeenCalled();
    },
  );

  test("a successful HTTP response is accepted evidence while its body remains unread", async () => {
    configure();
    const accepted = new Response("synthetic stream", { status: 200 });
    await expect(withProviderKey(async () => accepted, signal())).resolves.toBe(
      accepted,
    );
    expect(accepted.bodyUsed).toBe(false);
    expect(runtimeObservation).toHaveBeenCalledWith(
      providerCredentialId({ ...priority[0], tier: "priority" }),
      "accepted",
      expect.any(Date),
    );
  });

  test("quota status observation failures do not suppress the intended quota-only failover", async () => {
    configure();
    runtimeObservation.mockRejectedValue(
      new Error("synthetic storage failure"),
    );
    const attempt = jest.fn(async (key: ProviderCredential) => {
      if (key.key === priority[0].key) throw new ProviderQuotaExhaustedError();
      return "accepted";
    });
    await expect(withProviderKey(attempt, signal())).resolves.toBe("accepted");
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(runtimeObservation.mock.calls.map(([, state]) => state)).toEqual([
      "quota_limited",
      "accepted",
    ]);
  });

  test("effective empty configuration preserves the unconfigured result without a DB policy read", async () => {
    await expect(effectiveProviderKeys()).resolves.toEqual([]);
    expect(runtimePolicy).not.toHaveBeenCalled();
  });
  test("tries ordered priorities and stops at the first success", async () => {
    configure();
    const attempt = jest.fn(async (credential: ProviderCredential) => {
      if (credential.key === priority[0].key)
        throw new ProviderQuotaExhaustedError();
      return "completed by second priority";
    });
    await expect(withProviderKey(attempt, signal())).resolves.toBe(
      "completed by second priority",
    );
    expect(attempt.mock.calls.map(([credential]) => credential.name)).toEqual([
      "优先甲",
      "优先乙",
    ]);
  });

  test("all exhausted candidates are attempted once and exhaustion is not cached", async () => {
    configure();
    const exhausted = jest.fn(async (_credential: ProviderCredential) => {
      throw new ProviderQuotaExhaustedError();
    });
    await expect(withProviderKey(exhausted, signal())).rejects.toBeInstanceOf(
      ProviderQuotaExhaustedError,
    );
    expect(exhausted.mock.calls.map(([credential]) => credential.tier)).toEqual(
      ["priority", "priority", "fallback"],
    );
    const restored = jest.fn(
      async (_credential: ProviderCredential) => "restored",
    );
    await expect(withProviderKey(restored, signal())).resolves.toBe("restored");
    expect(restored.mock.calls[0][0].key).toBe(priority[0].key);
    expect(restored).toHaveBeenCalledTimes(1);
  });

  test("disabled legacy is never attempted even when it could succeed after all priorities exhaust", async () => {
    configure();
    environment.FAMILY_OPENAI_FALLBACK_ENABLED = "0";
    const attempt = jest.fn(async (credential: ProviderCredential) => {
      if (credential.key === legacy) return "forbidden legacy success";
      throw new ProviderQuotaExhaustedError();
    });
    await expect(withProviderKey(attempt, signal())).rejects.toMatchObject({
      code: "PROVIDER_QUOTA_EXHAUSTED",
    });
    expect(attempt.mock.calls.map(([credential]) => credential.name)).toEqual([
      "优先甲",
      "优先乙",
    ]);
  });

  test("a repeated secret cannot obtain another attempt under a different label or tier", async () => {
    environment.FAMILY_OPENAI_PRIORITY_KEYS = JSON.stringify([
      priority[0],
      { ...priority[0], name: "重复" },
    ]);
    environment.OPENAI_API_KEY = priority[0].key;
    const attempt = jest.fn(async () => {
      throw new ProviderQuotaExhaustedError();
    });
    await expect(withProviderKey(attempt, signal())).rejects.toBeInstanceOf(
      ProviderQuotaExhaustedError,
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test.each([
    new Error("fixture network failure"),
    new FamilyApiError(401, "fixture unauthorized"),
    new FamilyApiError(403, "fixture forbidden"),
    new FamilyApiError(404, "fixture model not found"),
    new FamilyApiError(429, "fixture rate limited", "RATE_LIMITED"),
    new FamilyApiError(500, "fixture upstream error"),
    new FamilyApiError(503, "fixture unavailable"),
    { code: "PROVIDER_QUOTA_EXHAUSTED" },
  ])("does not retry an untyped or non-quota failure %#", async (failure) => {
    configure();
    const attempt = jest.fn(async () => {
      throw failure;
    });
    await expect(withProviderKey(attempt, signal())).rejects.toBe(failure);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  test("an invalid pool never starts a provider attempt", async () => {
    environment.FAMILY_OPENAI_PRIORITY_KEYS = `{${legacy}`;
    const attempt = jest.fn(async () => "unexpected");
    await expect(withProviderKey(attempt, signal())).rejects.toMatchObject({
      code: "PROVIDER_KEYS_INVALID",
    });
    expect(attempt).not.toHaveBeenCalled();
  });

  test("a pre-aborted request performs no attempt and never exposes its abort reason", async () => {
    configure();
    const controller = new AbortController();
    controller.abort(new Error(legacy));
    const attempt = jest.fn(async () => "unexpected");
    await expect(
      withProviderKey(attempt, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError", message: "请求已取消。" });
    expect(attempt).not.toHaveBeenCalled();
  });

  test.each(["success", "quota"])(
    "abort after an in-flight %s prevents all subsequent candidates",
    async (outcome) => {
      configure();
      const controller = new AbortController();
      const attempt = jest.fn(async () => {
        controller.abort(new Error(legacy));
        if (outcome === "quota") throw new ProviderQuotaExhaustedError();
        return "late success";
      });
      await expect(
        withProviderKey(attempt, controller.signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(attempt).toHaveBeenCalledTimes(1);
    },
  );
});
