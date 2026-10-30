import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, transaction } from "./db";
import { createFamilyAuth } from "./auth";
import { digest, FamilyApiError, secureEqual, text } from "./errors";
import { FAMILY_NOTICE, type FamilySiteStatus } from "../types";
import { configuredOrigin } from "./errors";
import { ensureFamilySchema } from "./schema";
import { applicationUpgradeStatus } from "./upgrades";

function statusErrorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "STATUS_UNCLASSIFIED";
  const code = "code" in error ? error.code : undefined;
  if (
    typeof code === "string" &&
    (/^[0-9A-Z]{5}$/.test(code) ||
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ENOTFOUND",
        "ETIMEDOUT",
        "EAI_AGAIN",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "ERR_TLS_CERT_ALTNAME_INVALID",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
      ].includes(code))
  )
    return code;
  if (
    error instanceof FamilyApiError &&
    typeof error.code === "string" &&
    /^[A-Z0-9_]{1,40}$/.test(error.code)
  )
    return error.code;
  if (
    error instanceof Error &&
    [
      "FAMILY_DATABASE_UNAVAILABLE",
      "FAMILY_TEST_UNPOOLED_DATABASE_REQUIRED",
      "INVALID_TEST_SCHEMA",
      "TEST_SCHEMA_FORBIDDEN_IN_PRODUCTION",
      "INVALID_POSTGRES_DESTINATION",
    ].includes(error.message)
  )
    return error.message;
  return "STATUS_UNCLASSIFIED";
}

export async function siteStatus(): Promise<FamilySiteStatus> {
  const result: FamilySiteStatus = {
    deploymentEnvironment:
      process.env.VERCEL_ENV === "preview"
        ? "preview"
        : process.env.VERCEL_ENV === "production"
        ? "production"
        : "development",
    ready: false,
    needsSetup: false,
    dbConfigured: !!process.env.DATABASE_URL,
    modelConfigured: !!process.env.OPENAI_API_KEY,
    schemaReady: false,
    schemaVersion: 0,
    notice: FAMILY_NOTICE,
  };
  if (!result.dbConfigured)
    return { ...result, notice: `${FAMILY_NOTICE} 账号数据库尚未配置。` };
  try {
    configuredOrigin();
    const exists = await getPool().query(
      "SELECT to_regclass('family_setup') AS table_name",
    );
    if (!exists.rows[0]?.table_name) return { ...result, needsSetup: true };
    const setup = await getPool().query(
      "SELECT initialized FROM family_setup WHERE id = 1",
    );
    if (!setup.rows.length) throw new Error();
    result.needsSetup = !setup.rows[0].initialized;
    result.ready = !!setup.rows[0].initialized;
    if (!process.env.OPENAI_API_KEY)
      result.notice += " 模型 API 尚未配置，当前不能发送消息。";
    Object.assign(result, await applicationUpgradeStatus());
    return result;
  } catch (error) {
    console.error("[FamilyStatus] unavailable", {
      code: statusErrorCode(error),
    });
    return {
      ...result,
      notice: `${FAMILY_NOTICE} 账号服务正在配置或暂时不可用。`,
    };
  }
}
export async function rateLimit(
  request: Request,
  action: string,
  max: number,
  windowSeconds: number,
  userId?: string,
) {
  const ip =
    request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  const key = digest(
    `${action}:${userId ?? ip}:${bucket}:${process.env.BETTER_AUTH_SECRET}`,
  );
  const result = await getPool().query(
    "INSERT INTO family_rate_limit(key,count,expires_at) VALUES($1,1,now()+($2 * interval '1 second')) ON CONFLICT(key) DO UPDATE SET count=family_rate_limit.count+1 RETURNING count",
    [key, windowSeconds],
  );
  if (result.rows[0].count > max)
    throw new FamilyApiError(429, "操作过于频繁，请稍后再试。", "RATE_LIMITED");
}
function credentials(body: Record<string, unknown>) {
  const name = text(body.name, 80, "姓名");
  const email = text(body.email, 254, "邮箱").toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new FamilyApiError(400, "请填写有效邮箱。");
  if (
    typeof body.password !== "string" ||
    body.password.length < 12 ||
    body.password.length > 128
  )
    throw new FamilyApiError(400, "密码需为 12–128 个字符。");
  return { name, email, password: body.password };
}
async function createAccount(
  client: PoolClient,
  body: Record<string, unknown>,
) {
  const values = credentials(body);
  if (
    (
      await client.query('SELECT 1 FROM "user" WHERE email = $1', [
        values.email,
      ])
    ).rowCount
  )
    throw new FamilyApiError(409, "此邮箱已经登记，请直接登录或联系管理员。");
  // This instance uses the same pinned connection and outer transaction as the invite/setup lock.
  const result = await createFamilyAuth(client, true).api.signUpEmail({
    body: values,
  });
  const row = (
    await client.query('SELECT id FROM "user" WHERE id = $1 AND email = $2', [
      result.user.id,
      values.email,
    ])
  ).rows[0];
  if (!row) throw new FamilyApiError(409, "注册未完成，请联系管理员。");
  return row.id as string;
}
export async function setup(body: Record<string, unknown>, request?: Request) {
  const expected = process.env.FAMILY_BOOTSTRAP_TOKEN;
  if (!expected || expected.length < 32)
    throw new FamilyApiError(503, "管理员初始化尚未配置。");
  const token =
    typeof body.bootstrapToken === "string" ? body.bootstrapToken : "";
  if (!secureEqual(token, expected))
    throw new FamilyApiError(403, "初始化凭证无效。");
  const exists = await getPool().query(
    "SELECT to_regclass('family_setup') AS table_name",
  );
  if (
    exists.rows[0]?.table_name &&
    (await getPool().query("SELECT initialized FROM family_setup WHERE id=1"))
      .rows[0]?.initialized
  ) {
    throw new FamilyApiError(409, "管理员已经初始化。", "ALREADY_SETUP");
  }
  await ensureFamilySchema();
  if (request) await rateLimit(request, "setup", 5, 3600);
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(714209831)");
    const state = (
      await client.query(
        "SELECT initialized FROM family_setup WHERE id=1 FOR UPDATE",
      )
    ).rows[0];
    if (!state || state.initialized)
      throw new FamilyApiError(409, "管理员已经初始化。", "ALREADY_SETUP");
    if ((await client.query('SELECT 1 FROM "user" LIMIT 1')).rowCount)
      throw new FamilyApiError(409, "数据库已有账号，请人工检查后再初始化。");
    const userId = await createAccount(client, body);
    await client.query(
      'UPDATE "user" SET role=$1,status=$2,"updatedAt"=now() WHERE id=$3',
      ["admin", "approved", userId],
    );
    await client.query(
      "UPDATE family_setup SET initialized=true,admin_id=$1,initialized_at=now() WHERE id=1",
      [userId],
    );
  });
  return { ok: true };
}
export async function register(body: Record<string, unknown>) {
  const token = text(body.inviteToken, 256, "邀请码");
  await transaction(async (client) => {
    if (
      !(
        await client.query(
          "SELECT 1 FROM family_setup WHERE id=1 AND initialized",
        )
      ).rowCount
    )
      throw new FamilyApiError(503, "管理员尚未完成初始化。");
    const invite = (
      await client.query(
        "SELECT id FROM family_invite WHERE token_hash=$1 AND used_by IS NULL AND revoked_at IS NULL AND expires_at>now() FOR UPDATE",
        [digest(token)],
      )
    ).rows[0];
    if (!invite)
      throw new FamilyApiError(
        403,
        "邀请码无效、已使用或已过期。",
        "INVITE_INVALID",
      );
    const userId = await createAccount(client, body);
    await client.query(
      "UPDATE family_invite SET used_by=$1,used_at=now() WHERE id=$2",
      [userId, invite.id],
    );
  });
  return { ok: true, status: "pending" as const };
}
export async function createInvite(
  adminId: string,
  body: Record<string, unknown>,
) {
  const days = body.expiresInDays === undefined ? 7 : body.expiresInDays;
  if (
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 30
  )
    throw new FamilyApiError(400, "邀请有效期应为 1–30 天。");
  const token = randomBytes(32).toString("base64url");
  const result = await getPool().query(
    "INSERT INTO family_invite(id,token_hash,created_by,expires_at) VALUES($1,$2,$3,now()+($4 * interval '1 day')) RETURNING expires_at",
    [randomUUID(), digest(token), adminId, days],
  );
  await audit(adminId, "invite.create");
  return {
    inviteToken: token,
    expiresAt: result.rows[0].expires_at.toISOString(),
  };
}
export async function audit(
  actorId: string,
  action: string,
  targetUserId?: string,
  targetChatId?: string,
  client?: PoolClient,
) {
  await (client ?? getPool()).query(
    "INSERT INTO family_admin_audit(id,actor_id,action,target_user_id,target_chat_id) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), actorId, action, targetUserId ?? null, targetChatId ?? null],
  );
}
export async function updateUser(
  adminId: string,
  userId: string,
  status: unknown,
) {
  if (status !== "approved" && status !== "disabled")
    throw new FamilyApiError(400, "账号状态无效。");
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(714209832)");
    const target = (
      await client.query('SELECT id,role FROM "user" WHERE id=$1 FOR UPDATE', [
        userId,
      ])
    ).rows[0];
    if (!target) throw new FamilyApiError(404, "账号不存在。");
    if (status === "disabled" && target.role === "admin") {
      if (userId === adminId)
        throw new FamilyApiError(409, "不能停用自己的管理员账号。");
      const count = await client.query(
        'SELECT count(*)::int AS count FROM "user" WHERE role=$1 AND status=$2 AND id<>$3',
        ["admin", "approved", userId],
      );
      if (count.rows[0].count < 1)
        throw new FamilyApiError(409, "不能停用最后一个管理员。");
    }
    await client.query(
      'UPDATE "user" SET status=$1,"updatedAt"=now() WHERE id=$2',
      [status, userId],
    );
    if (status === "disabled")
      await client.query('DELETE FROM "session" WHERE "userId"=$1', [userId]);
    await audit(adminId, `user.${status}`, userId, undefined, client);
  });
  return { ok: true };
}
export async function recordActivity(userId: string, eventId: unknown) {
  const event = text(eventId, 100, "活动编号");
  await transaction(async (client) => {
    const inserted = await client.query(
      "INSERT INTO family_activity_event(user_id,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id",
      [userId, event],
    );
    if (!inserted.rowCount) return;
    await client.query(
      "INSERT INTO family_activity(user_id) VALUES($1) ON CONFLICT DO NOTHING",
      [userId],
    );
    // One timeline per user, shared across tabs/devices. Client timestamps are never accepted.
    await client.query(
      "UPDATE family_activity SET active_seconds=active_seconds+CASE WHEN last_heartbeat_at>=now()-interval '45 seconds' THEN LEAST(30,GREATEST(0,FLOOR(EXTRACT(EPOCH FROM now()-last_heartbeat_at))))::bigint ELSE 0 END,last_heartbeat_at=GREATEST(last_heartbeat_at,now()),last_seen_at=GREATEST(last_seen_at,now()) WHERE user_id=$1",
      [userId],
    );
  });
  return { ok: true, estimated: true };
}
export async function listUsers() {
  const result = await getPool()
    .query(`SELECT u.id,u.name,u.email,u.role,u.status,u."createdAt" AS created_at,a.last_seen_at,COALESCE(a.active_seconds,0) AS active_seconds,
    COALESCE(g.input_tokens,0)+COALESCE(v.input_tokens,0) AS input_tokens,
    COALESCE(g.output_tokens,0)+COALESCE(v.output_tokens,0) AS output_tokens,
    COALESCE(g.unknown_requests,0)+COALESCE(v.unknown_requests,0) AS unknown_requests,
    COALESCE(v.requests,0) AS voice_requests,COALESCE(v.input_tokens,0) AS voice_input_tokens,
    COALESCE(v.output_tokens,0) AS voice_output_tokens,COALESCE(v.unknown_requests,0) AS voice_unknown_requests,
    COALESCE(v.audio_seconds,0) AS voice_audio_seconds
    FROM "user" u LEFT JOIN family_activity a ON a.user_id=u.id LEFT JOIN
    (SELECT user_id,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,COUNT(*) FILTER(WHERE usage_source='unknown') AS unknown_requests FROM family_generation GROUP BY user_id) g ON g.user_id=u.id
    LEFT JOIN (SELECT user_id,COUNT(*) AS requests,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,
      COUNT(*) FILTER(WHERE usage_source='unknown') AS unknown_requests,SUM(audio_seconds) AS audio_seconds
      FROM family_voice_usage GROUP BY user_id) v ON v.user_id=u.id
    ORDER BY u."createdAt" DESC LIMIT 200`);
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role === "admin" ? "admin" : "member",
    status: row.status,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    activeSeconds: Number(row.active_seconds),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    unknownUsageRequests: Number(row.unknown_requests),
    voiceRequests: Number(row.voice_requests),
    voiceInputTokens: Number(row.voice_input_tokens),
    voiceOutputTokens: Number(row.voice_output_tokens),
    voiceUnknownUsageRequests: Number(row.voice_unknown_requests),
    voiceAudioSeconds: Number(row.voice_audio_seconds),
  }));
}
