import "server-only";
import { isFamilyMode, PRIVATE_API_HEADERS } from "../enabled";
import type { FamilyMe, FamilyUser } from "../types";
import type { FamilySessionSummary } from "../workspace-types";
import { requireUser } from "./auth";
import { rateLimit } from "./accounts";
import { getPool } from "./db";
import {
  assertSameOrigin,
  bodyJson,
  fail,
  FamilyApiError,
  json,
  text,
} from "./errors";

/** Deliberately discard raw user agents, IP addresses, and session tokens. */
export function sessionLabel(raw: unknown): string {
  const ua = typeof raw === "string" ? raw.slice(0, 2048) : "";
  const browser = /Edg(?:e|A|iOS)?\//i.test(ua)
    ? "Edge"
    : /(?:Chrome|CriOS)\//i.test(ua)
    ? "Chrome"
    : /(?:Firefox|FxiOS)\//i.test(ua)
    ? "Firefox"
    : /Safari\//i.test(ua)
    ? "Safari"
    : "浏览器";
  const system = /iPhone|iPad|iPod/i.test(ua)
    ? "iOS"
    : /Android/i.test(ua)
    ? "Android"
    : /Windows/i.test(ua)
    ? "Windows"
    : /Macintosh|Mac OS X/i.test(ua)
    ? "macOS"
    : /Linux/i.test(ua)
    ? "Linux"
    : "未知系统";
  return `${browser} · ${system}`;
}

function sessionId(value: string): string {
  // Better Auth session IDs are opaque text, not message/chat UUIDs.
  if (!value || value.length > 256 || /[\s\x00-\x1f\x7f/\\]/.test(value))
    throw new FamilyApiError(400, "登录记录格式无效。");
  return value;
}

export async function listWorkspaceSessions(
  userId: string,
  currentId: string,
): Promise<FamilySessionSummary[]> {
  const result = await getPool().query(
    `SELECT s.id,s."createdAt",s."updatedAt",s."expiresAt",s."userAgent"
     FROM "session" s JOIN "user" u ON u.id=s."userId"
     WHERE s."userId"=$1 AND s."expiresAt">now() AND u.status='approved'
     ORDER BY (s.id=$2) DESC,s."updatedAt" DESC,s.id ASC LIMIT 100`,
    [userId, currentId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    current: row.id === currentId,
    label: sessionLabel(row.userAgent),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
  }));
}

export async function saveWorkspaceName(
  userId: string,
  body: Record<string, unknown>,
): Promise<FamilyUser> {
  if (Object.keys(body).some((key) => key !== "name"))
    throw new FamilyApiError(400, "仅支持修改称呼。");
  const name = text(body.name, 80, "称呼");
  if (/[\x00-\x1f\x7f]/.test(name))
    throw new FamilyApiError(400, "称呼格式无效。");
  const result = await getPool().query(
    `UPDATE "user" SET name=$1,"updatedAt"=now()
     WHERE id=$2 AND status='approved' RETURNING id,name,email,role,status`,
    [name, userId],
  );
  const row = result.rows[0];
  if (!row)
    throw new FamilyApiError(
      403,
      "账号尚未获批或已停用。",
      "ACCOUNT_UNAVAILABLE",
    );
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role === "admin" ? "admin" : "member",
    status: row.status,
  };
}

export async function revokeWorkspaceSession(
  userId: string,
  currentId: string,
  target: string,
) {
  const targetId = sessionId(target);
  if (targetId === currentId)
    throw new FamilyApiError(400, "退出当前登录请使用退出登录按钮。");
  const result = await getPool().query(
    `DELETE FROM "session" s USING "user" u
     WHERE s."userId"=$1 AND s.id=$2 AND s.id<>$3
       AND u.id=s."userId" AND u.status='approved' RETURNING s.id`,
    [userId, targetId, currentId],
  );
  if (!result.rowCount)
    throw new FamilyApiError(404, "登录记录不存在或已失效。");
}

export async function revokeOtherWorkspaceSessions(
  userId: string,
  currentId: string,
) {
  await getPool().query(
    `DELETE FROM "session" s USING "user" u
     WHERE s."userId"=$1 AND s.id<>$2
       AND u.id=s."userId" AND u.status='approved'`,
    [userId, currentId],
  );
}

/** Both exact /me and its nested routes use the same private response contract. */
export async function handleWorkspaceAccount(
  request: Request,
  action: string[] = [],
): Promise<Response> {
  let authHeaders: Headers | undefined;
  const finish = (response: Response) => {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(PRIVATE_API_HEADERS))
      headers.set(key, value);
    for (const cookie of authHeaders?.getSetCookie() ?? [])
      headers.append("set-cookie", cookie);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  try {
    if (!isFamilyMode()) return finish(json({ error: "Not found" }, 404));
    if (request.method !== "GET") assertSameOrigin(request);
    const session = await requireUser(request);
    authHeaders = session.authHeaders;
    const me = (user = session.user): FamilyMe => ({
      user,
      sessionExpiresAt: session.sessionExpiresAt,
    });
    if (!action.length && request.method === "GET") return finish(json(me()));
    if (!action.length && request.method === "PATCH") {
      await rateLimit(request, "workspace:profile", 10, 60, session.user.id);
      return finish(
        json(
          me(
            await saveWorkspaceName(
              session.user.id,
              await bodyJson(request, 1024),
            ),
          ),
        ),
      );
    }
    if (
      action.length === 1 &&
      action[0] === "sessions" &&
      request.method === "GET"
    ) {
      await rateLimit(request, "workspace:sessions", 60, 60, session.user.id);
      return finish(
        json({
          sessions: await listWorkspaceSessions(
            session.user.id,
            session.sessionId,
          ),
        }),
      );
    }
    if (action.length === 2 && action[0] === "sessions") {
      if (action[1] === "revoke-others" && request.method === "POST") {
        await rateLimit(request, "workspace:revoke", 10, 60, session.user.id);
        await revokeOtherWorkspaceSessions(session.user.id, session.sessionId);
        return finish(json({ ok: true }));
      }
      if (request.method === "DELETE") {
        await rateLimit(request, "workspace:revoke", 10, 60, session.user.id);
        await revokeWorkspaceSession(
          session.user.id,
          session.sessionId,
          action[1],
        );
        return finish(json({ ok: true }));
      }
    }
    throw new FamilyApiError(404, "接口不存在。");
  } catch (error) {
    return finish(fail(error));
  }
}
