import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { PRIVATE_API_HEADERS } from "../enabled";

export class FamilyApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function secureEqual(left: string, right: string) {
  return timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));
}
export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: PRIVATE_API_HEADERS });
}
export function fail(error: unknown): Response {
  if (error instanceof FamilyApiError) {
    return json({ error: error.message, code: error.code }, error.status);
  }
  // Never echo SQL, URLs, credentials, upstream bodies or library error objects.
  const code =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,40}$/.test(error.code)
      ? error.code
      : "UNCLASSIFIED";
  console.error("[FamilyAPI] operation failed", { code });
  return json(
    { error: "服务暂时不可用，请稍后重试。", code: "SERVICE_UNAVAILABLE" },
    503,
  );
}
export function configuredOrigin(): string {
  const raw =
    process.env.BETTER_AUTH_URL ||
    (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : "");
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!raw || !secret || secret.length < 32) {
    throw new FamilyApiError(503, "账号服务尚未配置。", "AUTH_NOT_CONFIGURED");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new FamilyApiError(503, "站点地址尚未配置。");
  }
  if (
    parsed.protocol !== "https:" &&
    !(process.env.NODE_ENV !== "production" && parsed.hostname === "localhost")
  ) {
    throw new FamilyApiError(503, "账号服务需要 HTTPS。");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new FamilyApiError(503, "站点地址配置无效。");
  }
  return parsed.origin;
}
export function assertSameOrigin(request: Request) {
  if (request.headers.get("origin") !== configuredOrigin()) {
    throw new FamilyApiError(403, "请从本站页面提交操作。", "ORIGIN_REJECTED");
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    throw new FamilyApiError(403, "不允许跨站操作。", "ORIGIN_REJECTED");
  }
}
export async function bodyJson(
  request: Request,
  limit = 65_536,
): Promise<Record<string, unknown>> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase() !== "application/json"
  ) {
    throw new FamilyApiError(415, "请使用 JSON 提交。");
  }
  if (!request.body) throw new FamilyApiError(400, "请求内容为空。");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new FamilyApiError(413, "提交的内容过长。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new FamilyApiError(400, "请求格式无效。");
  }
}
export function text(
  value: unknown,
  max: number,
  label: string,
  min = 1,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.length > max
  ) {
    throw new FamilyApiError(400, `${label}格式无效。`);
  }
  return value.trim();
}
