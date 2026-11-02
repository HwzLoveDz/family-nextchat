/** @jest-environment node */
import { jest } from "@jest/globals";
import sharp from "sharp";
import { setImmediate as realImmediate } from "node:timers";
import type { GeneratedImageRequest } from "../app/family/server/image-provider";
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
const { requestGeneratedImage } = await import(
  "@/app/family/server/image-provider"
);
const { digest, FamilyApiError } = await import("@/app/family/server/errors");

const credentials = [
  { name: "图片优先甲", key: "synthetic-image-key-a" },
  { name: "图片优先乙", key: "synthetic-image-key-b" },
];
const originalFetch = global.fetch;
const fetchMock = jest.fn<typeof fetch>();
const onUsage = jest.fn<NonNullable<GeneratedImageRequest["onUsage"]>>();
let pixels: Buffer;
const nextTurn = () => new Promise<void>((resolve) => realImmediate(resolve));
const baseRequest = (
  overrides: Partial<GeneratedImageRequest> = {},
): GeneratedImageRequest => ({
  model: "gpt-image-2.5-flare",
  prompt: " 一只合成测试的蓝色小鸟 ",
  options: { size: "1024x1024", quality: "medium" },
  userId: "synthetic-family-owner",
  signal: new AbortController().signal,
  onUsage,
  ...overrides,
});
function response(overrides: Record<string, unknown> = {}) {
  return Response.json({
    data: [{ b64_json: pixels.toString("base64") }],
    usage: { input_tokens: 10, output_tokens: 20 },
    ...overrides,
  });
}
async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
    throw new Error("Unexpected success");
  } catch (error) {
    return error as Error;
  }
}

beforeAll(async () => {
  pixels = await sharp({
    create: { width: 8, height: 6, channels: 3, background: "#317ac0" },
  })
    .png()
    .toBuffer();
});
beforeEach(() => {
  jest.replaceProperty(process, "env", {
    NODE_ENV: "test",
    FAMILY_OPENAI_PRIORITY_KEYS: JSON.stringify(credentials),
    FAMILY_OPENAI_FALLBACK_ENABLED: "0",
  });
  global.fetch = fetchMock;
  fetchMock.mockReset().mockImplementation(async () => response());
  runtimePolicy.mockClear();
  runtimePolicy.mockImplementation(async (keys) => keys);
  runtimeObservation.mockReset().mockResolvedValue();
  onUsage.mockReset();
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test("sends the fixed image endpoint and bounded documented options without exposing identity", async () => {
  const result = await requestGeneratedImage(baseRequest());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("https://api.openai.com/v1/images/generations");
  expect(init?.redirect).toBe("error");
  expect(init?.cache).toBe("no-store");
  expect(init?.headers).toEqual({
    Authorization: "Bearer synthetic-image-key-a",
    "Content-Type": "application/json",
  });
  const body = JSON.parse(String(init?.body));
  expect(body).toEqual({
    model: "gpt-image-2.5-flare",
    prompt: "一只合成测试的蓝色小鸟",
    n: 1,
    size: "1024x1024",
    quality: "medium",
    output_format: "jpeg",
    output_compression: 90,
    background: "opaque",
    moderation: "auto",
    safety_identifier: digest("family-image:synthetic-family-owner"),
    stream: false,
  });
  expect(JSON.stringify(body)).not.toContain("synthetic-family-owner");
  expect(result).toMatchObject({
    width: 8,
    height: 6,
    mediaType: "image/jpeg",
    actualModel: null,
    usage: { source: "reported", inputTokens: 10, outputTokens: 20 },
  });
  expect((await sharp(result.bytes).metadata()).format).toBe("jpeg");
  expect(onUsage).toHaveBeenCalledWith(result.usage, null);
  expect(JSON.stringify({ ...result, bytes: undefined })).not.toContain(
    credentials[0].key,
  );
});

test.each([
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-1.5",
  "gpt-image-1-mini",
])("admits documented model %s", async (model) => {
  await requestGeneratedImage(baseRequest({ model }));
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).model).toBe(
    model,
  );
});

test.each([
  { model: "gpt-image-1" },
  { model: "dall-e-3" },
  { model: "https://foreign.invalid" },
  { prompt: " " },
  { prompt: "a".repeat(12001) },
  { prompt: "bad\u0000prompt" },
  { options: { size: "auto", quality: "medium" } },
  { options: { size: "1024x1024", quality: "max" } },
  { options: { size: "1024x1024", quality: "medium", n: 10 } },
  { options: null },
  { userId: "" },
  { userId: "a\nprivate" },
])(
  "rejects invalid requested model/options before sending %#",
  async (input) => {
    await expect(
      requestGeneratedImage(
        baseRequest(input as Partial<GeneratedImageRequest>),
      ),
    ).rejects.toBeInstanceOf(FamilyApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

test("uses persisted order and advances only after explicit quota rejection", async () => {
  runtimePolicy.mockImplementation(async (keys) => [...keys].reverse());
  fetchMock.mockImplementation(async (_url, init) => {
    const auth = (init?.headers as Record<string, string>).Authorization;
    return auth.endsWith("key-b")
      ? Response.json(
          {
            error: {
              code: "credit_balance_exhausted",
              message: "upstream private text",
            },
          },
          { status: 429 },
        )
      : response();
  });
  await requestGeneratedImage(baseRequest());
  expect(
    fetchMock.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>).Authorization,
    ),
  ).toEqual(["Bearer synthetic-image-key-b", "Bearer synthetic-image-key-a"]);
  expect(runtimeObservation.mock.calls.map((call) => call[1])).toEqual([
    "quota_limited",
    "accepted",
  ]);
});

test.each([
  [401, "IMAGE_MODEL_ACCESS_DENIED"],
  [403, "IMAGE_MODEL_ACCESS_DENIED"],
  [400, "IMAGE_REQUEST_REJECTED"],
  [404, "IMAGE_MODEL_UNAVAILABLE"],
  [429, "IMAGE_PROVIDER_RATE_LIMITED"],
  [500, "IMAGE_PROVIDER_ERROR"],
])(
  "HTTP %s never changes key and never reveals upstream content",
  async (status, code) => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          error: {
            code: "rate_limit_error",
            message: "raw sensitive upstream key synthetic-image-key-a",
          },
        },
        { status: status as number },
      ),
    );
    const error = await failure(requestGeneratedImage(baseRequest()));
    expect(error).toMatchObject({ code });
    expect(error.message).not.toMatch(/synthetic-image-key|sensitive upstream/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runtimeObservation).not.toHaveBeenCalled();
    expect(onUsage).not.toHaveBeenCalled();
  },
);

test("malformed quota JSON cannot trigger another accepted image request", async () => {
  fetchMock.mockResolvedValue(
    new Response("not JSON raw diagnostic", { status: 429 }),
  );
  await expect(requestGeneratedImage(baseRequest())).rejects.toMatchObject({
    code: "IMAGE_PROVIDER_RATE_LIMITED",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("connection failures have a safe error and no automatic paid retry", async () => {
  fetchMock.mockRejectedValue(
    new Error("synthetic-image-key-a https://private.invalid"),
  );
  const error = await failure(requestGeneratedImage(baseRequest()));
  expect(error).toMatchObject({ code: "IMAGE_PROVIDER_BAD_RESPONSE" });
  expect(error.message).not.toMatch(/synthetic-image-key|private.invalid/);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test.each([
  { input_tokens: 0, output_tokens: 0 },
  { input_tokens: 11, output_tokens: 0 },
])("retains reported zero tokens %#", async (usage) => {
  fetchMock.mockResolvedValue(response({ usage }));
  expect((await requestGeneratedImage(baseRequest())).usage).toEqual({
    source: "reported",
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  });
});

test.each([
  undefined,
  null,
  {},
  { input_tokens: 1 },
  { input_tokens: -1, output_tokens: 2 },
  { input_tokens: "1", output_tokens: 2 },
  { input_tokens: 1.1, output_tokens: 2 },
  { input_tokens: 1, output_tokens: Number.MAX_SAFE_INTEGER + 1 },
])("does not invent missing token usage %#", async (usage) => {
  fetchMock.mockResolvedValue(response({ usage }));
  expect((await requestGeneratedImage(baseRequest())).usage).toEqual({
    source: "unknown",
    inputTokens: null,
    outputTokens: null,
  });
});

test("actual model is only reported when explicitly present and safely allowlisted", async () => {
  fetchMock
    .mockResolvedValueOnce(
      response({ model: "gpt-image-2.5-flare-2026-09-08" }),
    )
    .mockResolvedValueOnce(response({ model: "raw-synthetic-image-key-a" }));
  expect((await requestGeneratedImage(baseRequest())).actualModel).toBe(
    "gpt-image-2.5-flare-2026-09-08",
  );
  expect((await requestGeneratedImage(baseRequest())).actualModel).toBeNull();
});

test.each([
  undefined,
  [],
  [{ url: "https://private.invalid/secret" }],
  [{ b64_json: "SGVsbG8" }],
  [{ b64_json: "SGVsbG8=\n" }],
  [{ b64_json: "SGVsbG9=" }],
  [{ b64_json: "data:image/png;base64,AAAA" }],
  [
    {
      b64_json: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///private"/></svg>',
      ).toString("base64"),
    },
  ],
  [{ b64_json: Buffer.from("GIF89a").toString("base64") }],
  [{ b64_json: "AAAA" }, { b64_json: "AAAA" }],
])(
  "rejects invalid image bytes/remote URLs without a second generation %#",
  async (data) => {
    fetchMock.mockResolvedValue(response({ data }));
    await expect(requestGeneratedImage(baseRequest())).rejects.toMatchObject({
      code: "IMAGE_PROVIDER_BAD_RESPONSE",
    });
    expect(onUsage).toHaveBeenCalledWith(
      { source: "reported", inputTokens: 10, outputTokens: 20 },
      null,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

test("declared oversized response is rejected without parsing or another paid attempt", async () => {
  fetchMock.mockResolvedValue(
    new Response("{}", {
      headers: { "content-length": String(24 * 1024 * 1024 + 1) },
    }),
  );
  await expect(requestGeneratedImage(baseRequest())).rejects.toMatchObject({
    code: "IMAGE_PROVIDER_BAD_RESPONSE",
  });
  expect(onUsage).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("actual streamed oversized response is bounded even without Content-Length", async () => {
  let count = 0;
  const cancel = jest.fn();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(++count < 4 ? 8 * 1024 * 1024 : 1));
    },
    cancel,
  });
  fetchMock.mockResolvedValue(new Response(stream));
  await expect(requestGeneratedImage(baseRequest())).rejects.toMatchObject({
    code: "IMAGE_PROVIDER_BAD_RESPONSE",
  });
  expect(cancel).toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("valid billed usage is preserved before a corrupt raster fails decoding", async () => {
  fetchMock.mockResolvedValue(
    response({
      data: [
        { b64_json: Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString("base64") },
      ],
    }),
  );
  await expect(requestGeneratedImage(baseRequest())).rejects.toMatchObject({
    code: "IMAGE_PROVIDER_BAD_RESPONSE",
  });
  expect(onUsage).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("normalizes raster dimensions and strips metadata", async () => {
  const jpeg = await sharp({
    create: { width: 2048, height: 1024, channels: 3, background: "#317ac0" },
  })
    .jpeg()
    .withMetadata({ exif: { IFD0: { Artist: "synthetic private author" } } })
    .toBuffer();
  fetchMock.mockResolvedValue(
    response({ data: [{ b64_json: jpeg.toString("base64") }] }),
  );
  const result = await requestGeneratedImage(baseRequest());
  const meta = await sharp(result.bytes).metadata();
  expect(result).toMatchObject({
    width: 1536,
    height: 768,
    mediaType: "image/jpeg",
  });
  expect(result.bytes.byteLength).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(meta.exif).toBeUndefined();
  expect(meta.icc).toBeUndefined();
});

test("rejects oversized pixel edges after recording reported usage", async () => {
  const raster = await sharp({
    create: { width: 4097, height: 1, channels: 3, background: "#317ac0" },
  })
    .png()
    .toBuffer();
  fetchMock.mockResolvedValue(
    response({ data: [{ b64_json: raster.toString("base64") }] }),
  );
  await expect(requestGeneratedImage(baseRequest())).rejects.toMatchObject({
    code: "IMAGE_PROVIDER_BAD_RESPONSE",
  });
  expect(onUsage).toHaveBeenCalledTimes(1);
});

test("already cancelled requests do not open the provider or reveal caller reason", async () => {
  const controller = new AbortController();
  controller.abort("synthetic-private-cancel-reason");
  const error = await failure(
    requestGeneratedImage(baseRequest({ signal: controller.signal })),
  );
  expect(error.name).toBe("AbortError");
  expect(error.message).not.toContain("private-cancel");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("caller cancellation aborts an outstanding body reader, without retry or raw reason", async () => {
  const cancel = jest.fn();
  fetchMock.mockResolvedValue(new Response(new ReadableStream({ cancel })));
  const controller = new AbortController();
  const result = requestGeneratedImage(
    baseRequest({ signal: controller.signal }),
  );
  const rejected = expect(result).rejects.toMatchObject({
    name: "AbortError",
    message: "请求已取消。",
  });
  await nextTurn();
  controller.abort("raw private reason");
  await rejected;
  expect(cancel).toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(onUsage).not.toHaveBeenCalled();
});

test("provider wait times out at 180 seconds and releases its timer", async () => {
  jest.useFakeTimers();
  fetchMock.mockImplementation(
    async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("synthetic raw detail", "AbortError")),
          { once: true },
        );
      }),
  );
  const result = requestGeneratedImage(baseRequest());
  const rejected = expect(result).rejects.toMatchObject({
    code: "IMAGE_PROVIDER_TIMEOUT",
    status: 504,
  });
  await nextTurn();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(180000);
  await rejected;
  expect(jest.getTimerCount()).toBe(0);
});

test("success clears its bounded timer and does not leave delayed work", async () => {
  jest.useFakeTimers();
  await requestGeneratedImage(baseRequest());
  expect(jest.getTimerCount()).toBe(0);
});
