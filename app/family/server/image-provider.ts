import "server-only";
import sharp from "sharp";
import {
  FAMILY_IMAGE_QUALITIES,
  FAMILY_IMAGE_SIZES,
  type FamilyImageOptions,
} from "../image-types";
import type { FamilyUsage } from "../types";
import { digest, FamilyApiError } from "./errors";
import { rejectExhaustedQuota, withProviderKey } from "./provider-keys";

const IMAGE_MODELS = new Set([
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-1.5",
  "gpt-image-1-mini",
]);
const REPORTED_MODELS = new Set([
  ...IMAGE_MODELS,
  "gpt-image-2.5-flare-2026-09-08",
  "gpt-image-2.5-sunburst-2026-09-08",
]);
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_STORED_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 180_000;

export interface GeneratedImageResult {
  bytes: Buffer;
  width: number;
  height: number;
  mediaType: "image/jpeg";
  usage: FamilyUsage;
  /** Null unless the upstream explicitly reports a safely recognized model. */
  actualModel: string | null;
}
export interface GeneratedImageRequest {
  model: string;
  prompt: string;
  options: FamilyImageOptions;
  userId: string;
  signal: AbortSignal;
  onUsage?: (usage: FamilyUsage, actualModel: string | null) => void;
}

const invalidResponse = () =>
  new FamilyApiError(
    502,
    "图片服务未返回有效图片，请稍后重试或更换模型。",
    "IMAGE_PROVIDER_BAD_RESPONSE",
  );
const abortError = () => new DOMException("请求已取消。", "AbortError");
function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw abortError();
}

function validate(request: GeneratedImageRequest) {
  if (!IMAGE_MODELS.has(request.model))
    throw new FamilyApiError(
      400,
      "请选择列表中的图片模型。",
      "IMAGE_MODEL_NOT_ALLOWED",
    );
  if (
    typeof request.prompt !== "string" ||
    !request.prompt.trim() ||
    request.prompt.length > 12000 ||
    request.prompt.includes("\u0000")
  )
    throw new FamilyApiError(
      400,
      "图片描述不能为空，且不能超过 12000 个字符。",
      "INVALID_IMAGE_PROMPT",
    );
  const options = request.options;
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== "size" && key !== "quality") ||
    !(FAMILY_IMAGE_SIZES as readonly unknown[]).includes(options.size) ||
    !(FAMILY_IMAGE_QUALITIES as readonly unknown[]).includes(options.quality)
  )
    throw new FamilyApiError(
      400,
      "图片尺寸或质量设置无效。",
      "INVALID_IMAGE_OPTIONS",
    );
  if (
    typeof request.userId !== "string" ||
    !request.userId ||
    request.userId.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(request.userId)
  )
    throw new FamilyApiError(400, "账户标识无效。", "INVALID_IMAGE_OWNER");
}

function observedUsage(value: unknown): FamilyUsage {
  const unknown: FamilyUsage = {
    source: "unknown",
    inputTokens: null,
    outputTokens: null,
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return unknown;
  const { input_tokens: input, output_tokens: output } = value as Record<
    string,
    unknown
  >;
  if (
    !Number.isSafeInteger(input) ||
    Number(input) < 0 ||
    !Number.isSafeInteger(output) ||
    Number(output) < 0
  )
    return unknown;
  return {
    source: "reported",
    inputTokens: input as number,
    outputTokens: output as number,
  };
}

/** Abort fake/slow readers too; native fetch is also stopped by the same signal. */
async function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  assertActive(signal);
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function responseJson(
  response: Response,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!response.body) throw invalidResponse();
  const declared = response.headers.get("content-length");
  if (
    declared &&
    /^\d+$/.test(declared) &&
    Number(declared) > MAX_RESPONSE_BYTES
  )
    throw invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      assertActive(signal);
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw invalidResponse();
      chunks.push(value);
    }
    assertActive(signal);
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, length),
      ),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw invalidResponse();
    return value as Record<string, unknown>;
  } finally {
    try {
      void reader.cancel().catch(() => {});
    } catch {
      /* No raw error is exposed. */
    }
    try {
      reader.releaseLock();
    } catch {
      /* Abort can detach the reader. */
    }
  }
}

function decodeImage(data: unknown): Buffer {
  if (
    !Array.isArray(data) ||
    data.length !== 1 ||
    !data[0] ||
    typeof data[0] !== "object" ||
    Array.isArray(data[0])
  )
    throw invalidResponse();
  const value = (data[0] as Record<string, unknown>).b64_json;
  // Never follow upstream URLs or parse SVG: only canonical, bounded raster bytes.
  if (
    typeof value !== "string" ||
    !value ||
    value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw invalidResponse();
  const bytes = Buffer.from(value, "base64");
  if (
    !bytes.length ||
    bytes.length > MAX_IMAGE_BYTES ||
    bytes.toString("base64") !== value
  )
    throw invalidResponse();
  const jpeg =
    bytes.length > 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const png =
    bytes.length > 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp =
    bytes.length > 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!jpeg && !png && !webp) throw invalidResponse();
  return bytes;
}

/** One accepted request produces one image. Decode/storage errors never select another key. */
export async function requestGeneratedImage(
  request: GeneratedImageRequest,
): Promise<GeneratedImageResult> {
  validate(request);
  assertActive(request.signal);
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  request.signal.addEventListener("abort", cancel, { once: true });
  if (request.signal.aborted) controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, TIMEOUT_MS);
  try {
    const response = await withProviderKey(async ({ key }) => {
      const response = await untilAborted(
        fetch("https://api.openai.com/v1/images/generations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: request.model,
            prompt: request.prompt.trim(),
            n: 1,
            size: request.options.size,
            quality: request.options.quality,
            output_format: "jpeg",
            output_compression: 90,
            background: "opaque",
            moderation: "auto",
            safety_identifier: digest(`family-image:${request.userId}`),
            stream: false,
          }),
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        }),
        controller.signal,
      );
      await rejectExhaustedQuota(response, controller.signal);
      if (response.status === 403 || response.status === 401)
        throw new FamilyApiError(
          403,
          "当前 API 没有此图片模型的访问权限，请联系管理员检查模型权限及 OpenAI 组织验证。",
          "IMAGE_MODEL_ACCESS_DENIED",
        );
      if (response.status === 400)
        throw new FamilyApiError(
          400,
          "图片请求未被模型接受，请调整描述或更换图片模型。",
          "IMAGE_REQUEST_REJECTED",
        );
      if (response.status === 429)
        throw new FamilyApiError(
          429,
          "图片服务请求较多，请稍后重试。",
          "IMAGE_PROVIDER_RATE_LIMITED",
        );
      if (response.status === 404)
        throw new FamilyApiError(
          502,
          "此图片模型暂不可用，请选择其他图片模型。",
          "IMAGE_MODEL_UNAVAILABLE",
        );
      if (!response.ok)
        throw new FamilyApiError(
          502,
          "图片服务暂时不可用，请稍后重试。",
          "IMAGE_PROVIDER_ERROR",
        );
      return response;
    }, controller.signal);
    const data = await responseJson(response, controller.signal);
    const usage = observedUsage(data.usage);
    const actualModel =
      typeof data.model === "string" && REPORTED_MODELS.has(data.model)
        ? data.model
        : null;
    // Report evidence before validating image bytes, so a billed but malformed
    // result still contributes its reported usage to the authoritative ledger.
    request.onUsage?.(usage, actualModel);
    assertActive(controller.signal);
    const source = decodeImage(data.data);
    const image = sharp(source, {
      failOn: "error",
      limitInputPixels: 4096 * 4096,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    assertActive(controller.signal);
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > 4096 ||
      metadata.height > 4096 ||
      (metadata.pages ?? 1) !== 1
    )
      throw invalidResponse();
    const { data: bytes, info } = await image
      .rotate()
      .resize({
        width: 1536,
        height: 1536,
        fit: "inside",
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: "4:4:4" })
      .toBuffer({ resolveWithObject: true });
    assertActive(controller.signal);
    if (!bytes.length || bytes.length > MAX_STORED_BYTES)
      throw invalidResponse();
    return {
      bytes,
      width: info.width,
      height: info.height,
      mediaType: "image/jpeg",
      usage,
      actualModel,
    };
  } catch (error) {
    if (request.signal.aborted) throw abortError();
    if (timedOut)
      throw new FamilyApiError(
        504,
        "图片生成等待超时，请稍后刷新查看结果，避免立即重复生成。",
        "IMAGE_PROVIDER_TIMEOUT",
      );
    if (error instanceof FamilyApiError) throw error;
    throw invalidResponse();
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", cancel);
    controller.abort();
  }
}
