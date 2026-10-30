/** Real PostgreSQL integration tests. Uses ONLY FAMILY_TEST_DATABASE_URL and a new isolated schema. */
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { NextRequest } from "next/server";
import { AfterContext } from "next/dist/server/after/after-context";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { GET as familyRoute } from "../../app/api/family/[...path]/route";
import { GET as authRoute } from "../../app/api/auth/[...all]/route";
import {
  closeFamilyDatabase,
  getPool,
  verifiedPostgresConnectionString,
} from "../../app/family/server/db";
import { digest } from "../../app/family/server/errors";

let stage = "validate isolated test destination";
let passed = 0;
let created = false;
const schema = `family_test_${randomBytes(8).toString("hex")}`;
const base = "https://family-test.invalid";
const password = `Family-Test-${randomBytes(18).toString("base64url")}`;
let adminPool: Pool | undefined;
const background = new WeakMap<Response, Promise<unknown>[]>();
function check(ok: unknown, label: string): asserts ok {
  stage = label;
  if (!ok) throw new Error("TEST_ASSERTION_FAILED");
  passed++;
  console.log(`PASS ${label}`);
}
function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}
async function family(
  method: string,
  path: string,
  body?: unknown,
  cookies = "",
  origin = base,
) {
  const request = new NextRequest(`${base}/api/family/${path}`, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      cookie: cookies,
      "x-vercel-forwarded-for": "192.0.2.10",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const waiting: Promise<unknown>[] = [];
  const afterContext = new AfterContext({
    waitUntil: (promise) => {
      waiting.push(promise);
    },
    onClose: (callback) => {
      callback();
    },
    onTaskError: () => {
      throw new Error("TEST_AFTER_FAILED");
    },
  });
  // Only the Next request-lifecycle harness is synthetic; all auth/SQL/ownership is real.
  const response = await workAsyncStorage.run({ afterContext } as any, () =>
    familyRoute(request, {
      params: Promise.resolve({ path: path.split("/") }),
    }),
  );
  background.set(response, waiting);
  return response;
}
async function login(email: string) {
  return authRoute(
    new Request(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ email, password, rememberMe: true }),
    }),
  );
}
async function main() {
  const url = process.env.FAMILY_TEST_DATABASE_URL;
  if (!url || !/^family_test_[a-f0-9]{16}$/.test(schema))
    throw new Error("TEST_DESTINATION_REQUIRED");
  if (!("AsyncLocalStorage" in globalThis))
    throw new Error("TEST_PRELOAD_REQUIRED");
  process.env.DATABASE_URL = url;
  process.env.FAMILY_DATABASE_SCHEMA = schema;
  process.env.FAMILY_MODE = "1";
  process.env.BETTER_AUTH_URL = base;
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
  process.env.FAMILY_BOOTSTRAP_TOKEN = randomBytes(32).toString("base64url");
  delete process.env.OPENAI_API_KEY;
  process.env.FAMILY_OPENAI_MODEL = "gpt-4o-mini";
  process.env.FAMILY_OPENAI_MODELS = "gpt-4o-mini,gpt-6.1-sol";
  // No test is permitted to call any external model/provider or network fetch.
  globalThis.fetch = async () => {
    throw new Error("OUTBOUND_FETCH_FORBIDDEN_IN_TEST");
  };
  adminPool = new Pool({
    connectionString: verifiedPostgresConnectionString(url),
    max: 1,
    connectionTimeoutMillis: 8000,
    allowExitOnIdle: true,
  });
  stage = "create exact isolated schema";
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  check(
    (await getPool().query("SELECT current_schema() AS name")).rows[0].name ===
      schema,
    "test connection uses its unique schema",
  );
  const status = await (await family("GET", "status")).json();
  check(
    status.needsSetup && !status.ready,
    "fresh database reports setup required without migrations",
  );
  const setupBody = {
    bootstrapToken: process.env.FAMILY_BOOTSTRAP_TOKEN,
    name: "Test Admin",
    email: "admin@example.invalid",
    password,
  };
  check(
    (await family("POST", "setup", setupBody, "", "https://untrusted.invalid"))
      .status === 403,
    "bootstrap rejects cross-origin request",
  );
  check(
    (
      await family("POST", "setup", {
        ...setupBody,
        bootstrapToken: "incorrect",
      })
    ).status === 403,
    "wrong bootstrap cannot claim admin",
  );
  check(
    !(await getPool().query("SELECT to_regclass('family_setup') AS name"))
      .rows[0].name,
    "wrong bootstrap does not create schema tables",
  );
  stage = "concurrent bootstrap including official Better Auth migration";
  const setupResults = await Promise.all([
    family("POST", "setup", setupBody),
    family("POST", "setup", setupBody),
  ]);
  check(
    setupResults.filter((res) => res.status === 200).length === 1 &&
      setupResults.some((res) => res.status === 409),
    "concurrent setup creates exactly one admin",
  );
  check(
    (
      await getPool().query(
        'SELECT count(*)::int AS count FROM "user" WHERE role=$1 AND status=$2',
        ["admin", "approved"],
      )
    ).rows[0].count === 1,
    "bootstrap role and approval are explicit",
  );
  check(
    (await family("POST", "setup", setupBody)).status === 409,
    "second setup is rejected",
  );
  const bypass = await authRoute(
    new Request(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({
        name: "Bypass",
        email: "bypass@example.invalid",
        password,
      }),
    }),
  );
  check(
    bypass.status === 404,
    "public Better Auth signup cannot bypass invitations",
  );
  const adminLogin = await login("admin@example.invalid");
  check(
    adminLogin.status === 200 && !!cookie(adminLogin),
    "approved admin logs in with library cookies",
  );
  const adminCookie = cookie(adminLogin);
  const adminMe = await (
    await family("GET", "me", undefined, adminCookie)
  ).json();
  check(adminMe.user.role === "admin", "server returns database admin role");
  check(
    new Date(adminMe.sessionExpiresAt).getTime() > Date.now() + 29 * 86400_000,
    "persistent session lasts thirty days",
  );
  const inviteResponse = await family("POST", "admin/invites", {}, adminCookie);
  check(
    inviteResponse.status === 200,
    "admin can create a single-use invitation",
  );
  const invite = await inviteResponse.json();
  const candidates = ["a@example.invalid", "race@example.invalid"];
  const registrations = await Promise.all(
    candidates.map((email) =>
      family("POST", "register", {
        inviteToken: invite.inviteToken,
        name: "Fixture Member",
        email,
        password,
        role: "admin",
        status: "approved",
      }),
    ),
  );
  check(
    registrations.filter((res) => res.status === 200).length === 1 &&
      registrations.some((res) => res.status === 403),
    "one invitation is redeemed atomically under concurrency",
  );
  const memberA = (
    await getPool().query(
      'SELECT id,email,role,status FROM "user" WHERE role<>$1',
      ["admin"],
    )
  ).rows[0];
  check(
    memberA.role === "member" && memberA.status === "pending",
    "client role and approval injection is ignored",
  );
  check(
    (await login(memberA.email)).status === 403,
    "pending member cannot create a session",
  );
  check(
    (
      await family(
        "PATCH",
        `admin/users/${memberA.id}`,
        { status: "approved" },
        adminCookie,
      )
    ).status === 200,
    "admin approves pending member",
  );
  const memberALogin = await login(memberA.email);
  check(memberALogin.status === 200, "approved member can log in");
  const cookieA = cookie(memberALogin);
  const inviteB = await (
    await family("POST", "admin/invites", {}, adminCookie)
  ).json();
  check(
    (
      await family("POST", "register", {
        inviteToken: inviteB.inviteToken,
        name: "Member B",
        email: "b@example.invalid",
        password,
      })
    ).status === 200,
    "second member registration succeeds independently",
  );
  const memberB = (
    await getPool().query('SELECT id FROM "user" WHERE email=$1', [
      "b@example.invalid",
    ])
  ).rows[0];
  await family(
    "PATCH",
    `admin/users/${memberB.id}`,
    { status: "approved" },
    adminCookie,
  );
  const cookieB = cookie(await login("b@example.invalid"));
  check(
    (await family("GET", "admin/users", undefined, cookieA)).status === 403,
    "member cannot list administrative account data",
  );
  check(
    (await family("GET", "me", undefined, "better-auth.session_token=forged"))
      .status === 401,
    "forged session cookie is rejected",
  );
  check(
    (await family("POST", "chats", {}, cookieA, "https://untrusted.invalid"))
      .status === 403,
    "chat mutation rejects CSRF origin",
  );
  const chatResponse = await family("POST", "chats", {}, cookieA);
  check(chatResponse.status === 200, "owner creates a conversation");
  const { chat } = await chatResponse.json();
  check(
    (await family("GET", `chats/${chat.id}`, undefined, cookieA)).status ===
      200,
    "owner can read conversation",
  );
  check(
    (await family("GET", `chats/${chat.id}`, undefined, cookieB)).status ===
      404,
    "other member cannot read conversation by id",
  );
  check(
    (await family("DELETE", `chats/${chat.id}`, undefined, cookieB)).status ===
      404,
    "other member cannot archive conversation by id",
  );
  check(
    (
      await family(
        "POST",
        `chats/${chat.id}/messages`,
        { content: "Fixture only", requestId: randomUUID() },
        cookieA,
      )
    ).status === 503,
    "missing model key fails closed without model request",
  );
  process.env.OPENAI_API_KEY = "fixture-not-a-real-key";
  check(
    (
      await family(
        "POST",
        `chats/${chat.id}/messages`,
        {
          content: "Fixture only",
          requestId: randomUUID(),
          userId: memberA.id,
        },
        cookieB,
      )
    ).status === 404,
    "generation checks owner rather than client user id",
  );
  const generationId = randomUUID();
  const requestId = randomUUID();
  const content = "Fixture replay";
  await getPool().query(
    "INSERT INTO family_generation(id,user_id,chat_id,request_id,request_hash,model,state,finished_at) VALUES($1,$2,$3,$4,$5,'fixture','complete',now())",
    [
      generationId,
      memberA.id,
      chat.id,
      requestId,
      digest(JSON.stringify({ chatId: chat.id, content })),
    ],
  );
  await getPool().query(
    "INSERT INTO family_message(id,chat_id,generation_id,role,content,status) VALUES($1,$2,$3,'user',$4,'complete'),($5,$2,$3,'assistant','Fixture reply','complete')",
    [randomUUID(), chat.id, generationId, content, randomUUID()],
  );
  const replay = await family(
    "POST",
    `chats/${chat.id}/messages`,
    { content, requestId },
    cookieA,
  );
  const replayText = await replay.text();
  check(
    replay.status === 200 && replayText.includes('"type":"done"'),
    "same request id replays saved response without upstream",
  );
  check(
    replayText.includes('"source":"unknown"') &&
      replayText.includes('"inputTokens":null'),
    "unknown token usage remains null rather than zero",
  );
  check(
    (
      await family(
        "POST",
        `chats/${chat.id}/messages`,
        { content: "Different body", requestId },
        cookieA,
      )
    ).status === 409,
    "request id cannot be replayed with different content",
  );
  check(
    (
      await getPool().query(
        "SELECT count(*)::int AS count FROM family_generation WHERE user_id=$1",
        [memberA.id],
      )
    ).rows[0].count === 1,
    "failed and replay requests create no extra generation",
  );
  const eventId = randomUUID();
  await family("POST", "activity", { eventId }, cookieA);
  await family("POST", "activity", { eventId }, cookieA);
  check(
    Number(
      (
        await getPool().query(
          "SELECT active_seconds FROM family_activity WHERE user_id=$1",
          [memberA.id],
        )
      ).rows[0].active_seconds,
    ) === 0,
    "duplicate activity event does not increase duration",
  );
  await getPool().query(
    "UPDATE family_activity SET last_heartbeat_at=now()-interval '30 seconds' WHERE user_id=$1",
    [memberA.id],
  );
  await Promise.all([
    family("POST", "activity", { eventId: randomUUID() }, cookieA),
    family("POST", "activity", { eventId: randomUUID() }, cookieA),
  ]);
  const active = Number(
    (
      await getPool().query(
        "SELECT active_seconds FROM family_activity WHERE user_id=$1",
        [memberA.id],
      )
    ).rows[0].active_seconds,
  );
  check(
    active === 30,
    "overlapping device heartbeats share one server timeline",
  );
  const users = (
    await (await family("GET", "admin/users", undefined, adminCookie)).json()
  ).users;
  check(
    users.find((u: any) => u.id === memberA.id)?.unknownUsageRequests === 1,
    "admin usage counts unknown requests separately",
  );
  check(
    (await family("GET", `admin/chats/${chat.id}`, undefined, adminCookie))
      .status === 200,
    "admin content read uses separate authorized route",
  );
  check(
    (
      await getPool().query(
        "SELECT count(*)::int AS count FROM family_admin_audit WHERE action='chat.content.read'",
      )
    ).rows[0].count === 1,
    "admin content view is audited",
  );
  const encodedFrame = (data: unknown) =>
    new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
  const awaitBackground = async (response: Response) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(background.get(response) ?? []),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("TEST_FINALIZATION_TIMEOUT")),
            15_000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  process.env.FAMILY_OPENAI_MODEL = "gpt-4o-mini";
  globalThis.fetch = async (input, init) => {
    check(
      String(input) === "https://api.openai.com/v1/chat/completions",
      "synthetic upstream is always the fixed official URL",
    );
    const payload = JSON.parse(String(init?.body));
    check(
      payload.model === "gpt-4o-mini" && payload.max_completion_tokens === 2048,
      "server-validated selected model and output cap reach the fixed upstream",
    );
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encodedFrame({
              choices: [
                { delta: { content: "合成完整回复" }, finish_reason: null },
              ],
            }),
          );
          controller.enqueue(
            encodedFrame({
              choices: [],
              usage: { prompt_tokens: 5, completion_tokens: 7 },
            }),
          );
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
    );
  };
  const completeRequest = randomUUID();
  const completeStream = await family(
    "POST",
    `chats/${chat.id}/messages`,
    {
      content: "Synthetic complete fixture",
      requestId: completeRequest,
      model: "gpt-4o-mini",
    },
    cookieA,
  );
  const completeText = await completeStream.text();
  await awaitBackground(completeStream);
  const completeRow = (
    await getPool().query(
      "SELECT state,input_tokens,output_tokens,usage_source FROM family_generation WHERE request_id=$1",
      [completeRequest],
    )
  ).rows[0];
  check(
    completeText.includes('"type":"done"') &&
      completeRow.state === "complete" &&
      completeRow.usage_source === "reported" &&
      Number(completeRow.input_tokens) === 5 &&
      Number(completeRow.output_tokens) === 7,
    "full gateway persists synthetic assistant and provider-reported usage",
  );
  globalThis.fetch = async () =>
    new Response(
      encodedFrame({
        choices: [{ delta: { content: "合成半段回复" }, finish_reason: null }],
      }),
    );
  const partialRequest = randomUUID();
  const partialStream = await family(
    "POST",
    `chats/${chat.id}/messages`,
    { content: "Synthetic truncated fixture", requestId: partialRequest },
    cookieA,
  );
  const partialText = await partialStream.text();
  await awaitBackground(partialStream);
  const partialRow = (
    await getPool().query(
      "SELECT g.state,g.usage_source,g.input_tokens,m.content FROM family_generation g JOIN family_message m ON m.generation_id=g.id AND m.role='assistant' WHERE g.request_id=$1",
      [partialRequest],
    )
  ).rows[0];
  check(
    partialText.includes('"type":"error"') &&
      partialRow.state === "partial" &&
      partialRow.content === "合成半段回复" &&
      partialRow.input_tokens === null,
    "full gateway preserves truncated output with unknown usage",
  );
  globalThis.fetch = async (_input, init) => {
    let abortHandler: (() => void) | undefined;
    return new Response(
      new ReadableStream({
        start(controller) {
          abortHandler = () =>
            controller.error(new Error("synthetic cancellation"));
          init?.signal?.addEventListener("abort", abortHandler, { once: true });
          controller.enqueue(
            encodedFrame({
              choices: [
                { delta: { content: "合成取消回复" }, finish_reason: null },
              ],
            }),
          );
        },
        cancel() {
          if (abortHandler)
            init?.signal?.removeEventListener("abort", abortHandler);
        },
      }),
    );
  };
  const cancelRequest = randomUUID();
  const cancelStream = await family(
    "POST",
    `chats/${chat.id}/messages`,
    { content: "Synthetic cancellation fixture", requestId: cancelRequest },
    cookieA,
  );
  const cancelReader = cancelStream.body!.getReader();
  let received = "";
  while (!received.includes('"type":"delta"')) {
    const chunk = await cancelReader.read();
    if (chunk.done) break;
    received += new TextDecoder().decode(chunk.value);
  }
  await cancelReader.cancel();
  await awaitBackground(cancelStream);
  const canceled = (
    await getPool().query(
      "SELECT g.state,m.content FROM family_generation g JOIN family_message m ON m.generation_id=g.id AND m.role='assistant' WHERE g.request_id=$1",
      [cancelRequest],
    )
  ).rows[0];
  check(
    canceled.state === "partial" && canceled.content === "合成取消回复",
    "Next after waitUntil keeps cancellation finalization alive",
  );
  check(
    (await family("DELETE", `chats/${chat.id}`, undefined, cookieA)).status ===
      200,
    "owner archives conversation without physical erasure",
  );
  check(
    (await family("GET", `chats/${chat.id}`, undefined, cookieA)).status ===
      404,
    "archived conversation is inaccessible to member by id",
  );
  check(
    (
      await family(
        "POST",
        `chats/${chat.id}/messages`,
        { content: "Archived fixture", requestId: randomUUID() },
        cookieA,
      )
    ).status === 404,
    "archived conversation cannot receive new member messages",
  );
  const archivedList = await (
    await family(
      "GET",
      `admin/users/${memberA.id}/chats`,
      undefined,
      adminCookie,
    )
  ).json();
  check(
    archivedList.chats.find((item: any) => item.id === chat.id)?.archived ===
      true,
    "administrator list includes marked archived conversation",
  );
  const archivedDetail = await (
    await family("GET", `admin/chats/${chat.id}`, undefined, adminCookie)
  ).json();
  check(
    archivedDetail.chat.archived === true &&
      archivedDetail.messages.some(
        (item: any) => item.content === "合成取消回复",
      ),
    "administrator can still read archived response text",
  );
  check(
    (
      await getPool().query(
        "SELECT count(*)::int AS count FROM family_admin_audit WHERE action='chat.content.read'",
      )
    ).rows[0].count === 2,
    "archived administrator content access is audited",
  );
  globalThis.fetch = async () => {
    throw new Error("OUTBOUND_FETCH_FORBIDDEN_IN_TEST");
  };
  // Hold the INSERT transaction open: its approval trigger holds a shared user-row lock.
  // The disable transaction must wait, then delete the newly committed session too.
  const raceClient = await getPool().connect();
  try {
    await raceClient.query("BEGIN");
    await raceClient.query(
      'INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 day\',now(),now())',
      [randomUUID(), randomBytes(32).toString("hex"), memberB.id],
    );
    const disableRace = family(
      "PATCH",
      `admin/users/${memberB.id}`,
      { status: "disabled" },
      adminCookie,
    );
    await raceClient.query("COMMIT");
    check(
      (await disableRace).status === 200,
      "disable serializes after concurrent session insertion",
    );
  } finally {
    await raceClient.query("ROLLBACK").catch(() => undefined);
    raceClient.release();
  }
  check(
    (
      await getPool().query(
        'SELECT count(*)::int AS count FROM "session" WHERE "userId"=$1',
        [memberB.id],
      )
    ).rows[0].count === 0,
    "disable removes the concurrently committed session",
  );
  // Reverse order: a session insert waiting on an uncommitted disable must be rejected.
  await family(
    "PATCH",
    `admin/users/${memberB.id}`,
    { status: "approved" },
    adminCookie,
  );
  const disableClient = await getPool().connect();
  try {
    await disableClient.query("BEGIN");
    await disableClient.query('UPDATE "user" SET status=$1 WHERE id=$2', [
      "disabled",
      memberB.id,
    ]);
    await disableClient.query('DELETE FROM "session" WHERE "userId"=$1', [
      memberB.id,
    ]);
    const lateInsert = getPool()
      .query(
        'INSERT INTO "session"(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,now()+interval \'1 day\',now(),now())',
        [randomUUID(), randomBytes(32).toString("hex"), memberB.id],
      )
      .then(
        () => false,
        (error) => error?.code === "42501",
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
    await disableClient.query("COMMIT");
    check(
      await lateInsert,
      "database trigger rejects session inserted after concurrent disable",
    );
  } finally {
    await disableClient.query("ROLLBACK").catch(() => undefined);
    disableClient.release();
  }
  check(
    (
      await family(
        "PATCH",
        `admin/users/${memberA.id}`,
        { status: "disabled" },
        adminCookie,
      )
    ).status === 200,
    "admin disables member",
  );
  check(
    (
      await getPool().query(
        'SELECT count(*)::int AS count FROM "session" WHERE "userId"=$1',
        [memberA.id],
      )
    ).rows[0].count === 0,
    "disabling revokes existing database sessions",
  );
  check(
    (await family("GET", "me", undefined, cookieA)).status === 401,
    "revoked cookie cannot fetch private data",
  );
  check(
    (await login(memberA.email)).status === 403,
    "disabled member cannot create new session",
  );
  check(
    (
      await family(
        "PATCH",
        `admin/users/${adminMe.user.id}`,
        { status: "disabled" },
        adminCookie,
      )
    ).status === 409,
    "administrator cannot disable own last admin account",
  );
  const retryInvite = await (
    await family("POST", "admin/invites", {}, adminCookie)
  ).json();
  check(
    (
      await family("POST", "register", {
        inviteToken: retryInvite.inviteToken,
        name: "Rollback",
        email: "rollback@example.invalid",
        password: "short",
      })
    ).status === 400,
    "bad credentials rollback registration",
  );
  // Fail AFTER Better Auth has written user/account, proving the outer invite transaction owns both.
  const accountCount = Number(
    (await getPool().query('SELECT count(*) AS count FROM "account"')).rows[0]
      .count,
  );
  await getPool().query(
    "CREATE FUNCTION family_fixture_fail_invite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure after auth writes'; END $$; CREATE TRIGGER family_fixture_fail_invite BEFORE UPDATE OF used_by ON family_invite FOR EACH ROW EXECUTE FUNCTION family_fixture_fail_invite()",
  );
  check(
    (
      await family("POST", "register", {
        inviteToken: retryInvite.inviteToken,
        name: "Rollback",
        email: "rollback@example.invalid",
        password,
      })
    ).status === 503,
    "failure after library auth writes returns a safe error",
  );
  check(
    !(
      await getPool().query('SELECT 1 FROM "user" WHERE email=$1', [
        "rollback@example.invalid",
      ])
    ).rowCount &&
      Number(
        (await getPool().query('SELECT count(*) AS count FROM "account"'))
          .rows[0].count,
      ) === accountCount,
    "outer transaction rolls back library user and credential account together",
  );
  check(
    (
      await getPool().query(
        "SELECT used_by FROM family_invite WHERE token_hash=$1",
        [digest(retryInvite.inviteToken)],
      )
    ).rows[0].used_by === null,
    "post-auth failure does not burn invitation",
  );
  await getPool().query(
    "DROP TRIGGER family_fixture_fail_invite ON family_invite; DROP FUNCTION family_fixture_fail_invite()",
  );
  check(
    (
      await family("POST", "register", {
        inviteToken: retryInvite.inviteToken,
        name: "Rollback",
        email: "rollback@example.invalid",
        password,
      })
    ).status === 200,
    "rolled-back invitation remains redeemable",
  );
  console.log(
    `Family integration: ${passed} checks passed in isolated schema ${schema}.`,
  );
}
main()
  .catch(() => {
    console.error(
      `Family integration failed at: ${stage}. No secrets or provider responses printed.`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeFamilyDatabase();
    if (adminPool) {
      try {
        if (created && /^family_test_[a-f0-9]{16}$/.test(schema)) {
          await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
          console.log(`Removed exact test schema ${schema}.`);
        }
      } finally {
        await adminPool.end();
      }
    }
  });
