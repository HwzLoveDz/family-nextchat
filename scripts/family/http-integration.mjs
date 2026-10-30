/** One-shot, real preview HTTP E2E. Creates fixture accounts only in an explicitly confirmed empty preview DB. */
import { randomBytes, randomUUID } from "node:crypto";

let stage = "validate preview destination";
let passed = 0;
function check(ok, label) {
  stage = label;
  if (!ok) throw new Error("E2E_ASSERTION_FAILED");
  passed++;
  console.log(`PASS ${label}`);
}
class Cookies {
  values = new Map();
  capture(response) {
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";", 1)[0];
      const separator = pair.indexOf("=");
      this.values.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }
  header() {
    return [...this.values]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }
}
async function main() {
  if (process.env.FAMILY_E2E_PREVIEW_CONFIRMED !== "1")
    throw new Error("PREVIEW_CONFIRMATION_REQUIRED");
  const raw = process.env.FAMILY_E2E_URL;
  const bootstrapToken = process.env.FAMILY_E2E_BOOTSTRAP_TOKEN;
  if (!raw || !bootstrapToken || bootstrapToken.length < 32)
    throw new Error("E2E_CONFIGURATION_REQUIRED");
  const destination = new URL(raw);
  if (
    destination.protocol !== "https:" ||
    !/^[a-z0-9-]+\.vercel\.app$/.test(destination.hostname) ||
    destination.port ||
    destination.username ||
    destination.password ||
    destination.search ||
    destination.hash ||
    destination.pathname !== "/"
  )
    throw new Error("PREVIEW_URL_REQUIRED");
  const base = destination.origin;
  const marker = randomBytes(8).toString("hex");
  const password = `Fixture-${randomBytes(24).toString("base64url")}`;
  const adminEmail = `family-e2e-${marker}-admin@test.invalid`;
  const admin = new Cookies();
  const memberA = new Cookies();
  const memberB = new Cookies();
  async function call(method, path, body, jar, origin = base) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(jar ? { cookie: jar.header() } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
      cache: "no-store",
    });
    jar?.capture(response);
    return response;
  }
  const family = (method, path, body, jar, origin) =>
    call(method, `/api/family/${path}`, body, jar, origin);
  const signIn = (email, jar) =>
    call(
      "POST",
      "/api/auth/sign-in/email",
      { email, password, rememberMe: true },
      jar,
    );
  stage = "read server preview marker before any mutation";
  const preflight = await family("GET", "status");
  check(preflight.status === 200, "preview status endpoint is reachable");
  const status = await preflight.json();
  check(
    status.deploymentEnvironment === "preview",
    "server confirms VERCEL_ENV preview",
  );
  check(
    status.dbConfigured && status.needsSetup && !status.ready,
    "preview database is empty and awaits setup",
  );
  check(
    preflight.headers.get("cache-control")?.includes("no-store"),
    "public status disables caching",
  );
  const setupBody = {
    bootstrapToken,
    name: "E2E Fixture Admin",
    email: adminEmail,
    password,
  };
  check(
    (
      await family(
        "POST",
        "setup",
        setupBody,
        undefined,
        "https://untrusted.test.invalid",
      )
    ).status === 403,
    "cross-origin bootstrap cannot initialize database",
  );
  check(
    (
      await family("POST", "setup", {
        ...setupBody,
        bootstrapToken: "incorrect-fixture-token",
      })
    ).status === 403,
    "wrong bootstrap cannot claim administrator",
  );
  stage = "initialize preview fixture administrator and schema";
  check(
    (await family("POST", "setup", setupBody)).status === 200,
    "authorized setup migrates and creates explicit admin",
  );
  check(
    (await family("POST", "setup", setupBody)).status === 409,
    "administrator bootstrap cannot be repeated",
  );
  check(
    (
      await call("POST", "/api/auth/sign-up/email", {
        name: "Bypass",
        email: `family-e2e-${marker}-bypass@test.invalid`,
        password,
        role: "admin",
        status: "approved",
      })
    ).status === 404,
    "raw auth signup cannot bypass invitation workflow",
  );
  const login = await signIn(adminEmail, admin);
  check(
    login.status === 200 && !!admin.header(),
    "administrator logs in using persistent library cookie",
  );
  const adminResponse = await family("GET", "me", undefined, admin);
  check(
    adminResponse.status === 200,
    "cookie authenticates private account endpoint",
  );
  const adminMe = await adminResponse.json();
  check(
    adminMe.user.role === "admin" && adminMe.user.status === "approved",
    "administrator role comes from database",
  );
  check(
    new Date(adminMe.sessionExpiresAt).getTime() > Date.now() + 29 * 86400_000,
    "mobile login persists for thirty days",
  );
  check(
    adminResponse.headers.get("cache-control")?.includes("no-store"),
    "private account response disables caching",
  );
  const inviteRes = await family("POST", "admin/invites", {}, admin);
  check(inviteRes.status === 200, "administrator creates an invitation");
  const invite = await inviteRes.json();
  const candidates = [
    `family-e2e-${marker}-a@test.invalid`,
    `family-e2e-${marker}-race@test.invalid`,
  ];
  const results = await Promise.all(
    candidates.map((email) =>
      family("POST", "register", {
        inviteToken: invite.inviteToken,
        name: "E2E Fixture Member A",
        email,
        password,
        role: "admin",
        status: "approved",
      }),
    ),
  );
  check(
    results.filter((res) => res.status === 200).length === 1 &&
      results.filter((res) => res.status === 403).length === 1,
    "concurrent registration consumes invitation exactly once",
  );
  const emailA = candidates[results.findIndex((res) => res.status === 200)];
  check(
    (await signIn(emailA, memberA)).status === 403 && !memberA.header(),
    "pending account cannot obtain login session",
  );
  const users = (
    await (await family("GET", "admin/users", undefined, admin)).json()
  ).users;
  const accountA = users.find((user) => user.email === emailA);
  check(
    accountA?.role === "member" && accountA?.status === "pending",
    "client cannot inject role or approval status",
  );
  check(
    (
      await family(
        "PATCH",
        `admin/users/${accountA.id}`,
        { status: "approved" },
        admin,
      )
    ).status === 200,
    "administrator approves member A",
  );
  check(
    (await signIn(emailA, memberA)).status === 200,
    "approved member logs in successfully",
  );
  const emailB = `family-e2e-${marker}-b@test.invalid`;
  const inviteB = await (
    await family("POST", "admin/invites", {}, admin)
  ).json();
  check(
    (
      await family("POST", "register", {
        inviteToken: inviteB.inviteToken,
        name: "E2E Fixture Member B",
        email: emailB,
        password,
      })
    ).status === 200,
    "independent invitation registers member B",
  );
  const nextUsers = (
    await (await family("GET", "admin/users", undefined, admin)).json()
  ).users;
  const accountB = nextUsers.find((user) => user.email === emailB);
  await family(
    "PATCH",
    `admin/users/${accountB.id}`,
    { status: "approved" },
    admin,
  );
  check(
    (await signIn(emailB, memberB)).status === 200,
    "second approved member logs in independently",
  );
  check(
    (await family("GET", "admin/users", undefined, memberA)).status === 403,
    "member cannot access administrative accounts",
  );
  check(
    (await family("POST", "admin/invites", {}, memberA)).status === 403,
    "member cannot generate invitations",
  );
  check(
    (
      await family(
        "POST",
        "chats",
        {},
        memberA,
        "https://untrusted.test.invalid",
      )
    ).status === 403,
    "cross-origin chat mutation is rejected",
  );
  check(
    (await family("GET", "me")).status === 401,
    "anonymous client cannot read account data",
  );
  const chatRes = await family("POST", "chats", {}, memberA);
  check(chatRes.status === 200, "member A creates a private conversation");
  const { chat } = await chatRes.json();
  check(
    (await family("GET", `chats/${chat.id}`, undefined, memberA)).status ===
      200,
    "owner reads its own conversation",
  );
  check(
    (await family("GET", `chats/${chat.id}`, undefined, memberB)).status ===
      404,
    "member B cannot read A conversation id",
  );
  check(
    (await family("DELETE", `chats/${chat.id}`, undefined, memberB)).status ===
      404,
    "member B cannot archive A conversation id",
  );
  check(
    (
      await family(
        "POST",
        `chats/${chat.id}/messages`,
        {
          content: "Fixture only",
          requestId: randomUUID(),
          userId: accountA.id,
        },
        memberB,
      )
    ).status === 404,
    "member B cannot send through A conversation or forge its user id",
  );
  check(
    (
      await family(
        "POST",
        `chats/${chat.id}/messages`,
        { content: "Fixture only", requestId: "invalid/id" },
        memberA,
      )
    ).status === 400,
    "invalid idempotency request identifier is rejected",
  );
  check(
    (
      await family(
        "POST",
        `chats/${chat.id}/messages`,
        { content: "Fixture only", requestId: randomUUID() },
        memberA,
      )
    ).status === 503,
    "missing model key fails closed without real model invocation",
  );
  const unchanged = await (
    await family("GET", `chats/${chat.id}`, undefined, memberA)
  ).json();
  check(
    unchanged.messages.length === 0,
    "missing model key does not persist a fake reply or generation",
  );
  const eventId = randomUUID();
  check(
    (await family("POST", "activity", { eventId }, memberA)).status === 200,
    "foreground activity endpoint accepts server-timed event",
  );
  check(
    (await family("POST", "activity", { eventId }, memberA)).status === 200,
    "duplicate heartbeat is accepted idempotently",
  );
  check(
    (await family("GET", `admin/users/${accountA.id}/chats`, undefined, admin))
      .status === 200,
    "administrator lists member conversation through admin guard",
  );
  check(
    (await family("GET", `admin/chats/${chat.id}`, undefined, admin)).status ===
      200,
    "administrator reads content through audited admin route",
  );
  check(
    (await family("DELETE", `chats/${chat.id}`, undefined, memberA)).status ===
      200,
    "owner archives its conversation",
  );
  const memberChats = await (
    await family("GET", "chats", undefined, memberA)
  ).json();
  check(
    !memberChats.chats.some((item) => item.id === chat.id),
    "archived conversation disappears from member list",
  );
  check(
    (await family("GET", `chats/${chat.id}`, undefined, memberA)).status ===
      404,
    "member cannot reopen archived conversation directly",
  );
  check(
    (
      await family(
        "POST",
        `chats/${chat.id}/messages`,
        { content: "Archived fixture", requestId: randomUUID() },
        memberA,
      )
    ).status === 404,
    "member cannot send to archived conversation",
  );
  const adminChats = await (
    await family("GET", `admin/users/${accountA.id}/chats`, undefined, admin)
  ).json();
  check(
    adminChats.chats.find((item) => item.id === chat.id)?.archived === true,
    "administrator list retains marked archived conversation",
  );
  const archivedResponse = await family(
    "GET",
    `admin/chats/${chat.id}`,
    undefined,
    admin,
  );
  const archivedDetail = await archivedResponse.json();
  check(
    archivedResponse.status === 200 &&
      archivedDetail.chat.archived === true &&
      Array.isArray(archivedDetail.messages),
    "administrator retains audited access to archived conversation",
  );
  check(
    (
      await family(
        "PATCH",
        `admin/users/${accountA.id}`,
        { status: "disabled" },
        admin,
      )
    ).status === 200,
    "administrator disables member A",
  );
  check(
    (await family("GET", "me", undefined, memberA)).status === 401,
    "disabled account old cookie is revoked immediately",
  );
  check(
    (await signIn(emailA, new Cookies())).status === 403,
    "disabled account cannot create a new session",
  );
  check(
    (
      await family(
        "PATCH",
        `admin/users/${adminMe.user.id}`,
        { status: "disabled" },
        admin,
      )
    ).status === 409,
    "last administrator cannot disable itself",
  );
  check(
    (await call("POST", "/api/auth/sign-out", {}, memberB)).status === 200,
    "library sign-out succeeds",
  );
  check(
    (await family("GET", "me", undefined, memberB)).status === 401,
    "signed-out browser no longer sees private data",
  );
  console.log(
    `Family preview HTTP E2E: ${passed} checks passed. Fixture accounts remain only in the confirmed preview database.`,
  );
  console.log(
    "No provider key was supplied, no model request was performed. SSE/provider usage require the separate isolated mock/PG tests.",
  );
}
main().catch(() => {
  console.error(
    `Family preview HTTP E2E failed at: ${stage}. No credentials, cookies, tokens or fixture emails printed.`,
  );
  process.exitCode = 1;
});
