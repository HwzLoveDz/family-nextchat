import "server-only";
import { FamilyApiError, digest } from "./errors";

export const WORKSPACE_PAGE_SIZE = 50;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function workspaceQuery(value?: string | null) {
  const query = value?.trim() ?? "";
  if (query.length > 200 || /[\u0000]/.test(query))
    throw new FamilyApiError(
      400,
      "搜索内容不能超过 200 个字符。",
      "INVALID_SEARCH",
    );
  return query;
}
export function cursorScope(...parts: string[]) {
  return digest(JSON.stringify(parts));
}
export interface WorkspaceCursor {
  id: string;
  at: string;
  pin?: string | null;
  scope: string;
}
export function encodeWorkspaceCursor(cursor: WorkspaceCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
export function decodeWorkspaceCursor(
  value: string | null | undefined,
  scope: string,
): WorkspaceCursor | null {
  if (!value) return null;
  try {
    if (value.length > 800 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    // PostgreSQL ordering retains microseconds. JS Date alone would round the
    // page anchor and silently skip records created in the same millisecond.
    const date = (candidate: unknown): candidate is string =>
      typeof candidate === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(?:\d{3})?Z$/.test(candidate) &&
      Number.isFinite(Date.parse(candidate));
    if (
      !parsed ||
      parsed.scope !== scope ||
      !uuid.test(parsed.id) ||
      !date(parsed.at) ||
      (parsed.pin !== undefined && parsed.pin !== null && !date(parsed.pin))
    )
      throw new Error();
    return parsed;
  } catch {
    throw new FamilyApiError(
      400,
      "分页位置无效，请刷新列表。",
      "INVALID_CURSOR",
    );
  }
}
