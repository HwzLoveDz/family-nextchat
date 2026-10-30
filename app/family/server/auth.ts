import "server-only";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { PostgresDialect } from "kysely";
import type { PoolClient } from "pg";
import { getPool } from "./db";
import { configuredOrigin, FamilyApiError } from "./errors";
import type { FamilyUser } from "../types";

/** A pinned adapter joins our already-open transaction; it must not issue a nested COMMIT. */
export function createFamilyAuth(
  client?: PoolClient,
  internalRegistration = false,
) {
  const database = client
    ? {
        dialect: new PostgresDialect({
          pool: {
            options: {},
            connect: async () => ({
              query: client.query.bind(client),
              release() {},
            }),
            end: async () => {},
          },
        }),
        type: "postgres" as const,
        transaction: false,
      }
    : getPool();
  const db = client ?? getPool();
  return betterAuth({
    appName: "Family Chat",
    baseURL: configuredOrigin(),
    basePath: "/api/auth",
    secret: process.env.BETTER_AUTH_SECRET!,
    database,
    emailAndPassword: {
      enabled: true,
      disableSignUp: !internalRegistration,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    user: {
      additionalFields: {
        status: {
          type: ["pending", "approved", "disabled"],
          defaultValue: "pending",
          required: true,
          input: false,
        },
      },
    },
    trustedOrigins: [configuredOrigin()],
    rateLimit: { enabled: true, storage: "database", window: 60, max: 30 },
    advanced: { useSecureCookies: process.env.NODE_ENV === "production" },
    plugins: [admin({ defaultRole: "member", adminRoles: ["admin"] })],
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const result = await db.query(
              'SELECT status FROM "user" WHERE id = $1',
              [session.userId],
            );
            if (result.rows[0]?.status !== "approved") {
              throw new APIError("FORBIDDEN", {
                message: "账号尚未获批或已停用，请联系管理员。",
              });
            }
            return { data: session };
          },
        },
      },
    },
    logger: { disabled: true },
    telemetry: { enabled: false },
  });
}
let auth: ReturnType<typeof createFamilyAuth> | undefined;
export function getFamilyAuth() {
  return (auth ??= createFamilyAuth());
}

export async function requireUser(request: Request, adminOnly = false) {
  const authResult = await getFamilyAuth().api.getSession({
    headers: request.headers,
    query: { disableCookieCache: true },
    returnHeaders: true,
  });
  const authSession = authResult.response;
  if (!authSession)
    throw new FamilyApiError(401, "请先登录。", "UNAUTHENTICATED");
  // Fresh DB status and role, not a cached cookie claim or caller-supplied identity.
  const result = await getPool().query(
    'SELECT id, name, email, role, status FROM "user" WHERE id = $1',
    [authSession.user.id],
  );
  const row = result.rows[0];
  if (!row || row.status !== "approved")
    throw new FamilyApiError(
      403,
      "账号尚未获批或已停用。",
      "ACCOUNT_UNAVAILABLE",
    );
  if (adminOnly && row.role !== "admin")
    throw new FamilyApiError(403, "需要管理员权限。", "ADMIN_REQUIRED");
  const user: FamilyUser = {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role === "admin" ? "admin" : "member",
    status: row.status,
  };
  return {
    user,
    sessionId: authSession.session.id,
    sessionExpiresAt: authSession.session.expiresAt.toISOString(),
    authHeaders: authResult.headers,
  };
}
