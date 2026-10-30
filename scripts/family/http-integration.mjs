/** One-shot, real preview HTTP E2E. Creates fixture accounts only in an explicitly confirmed empty preview DB. */
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function samePath(a, b) {
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

async function validatePrivateFixtureOutput(requested) {
  if (requested === undefined) return undefined;
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const parent = dirname(repository);
  const expected = resolve(parent, ".private-family-preview-fixture.json");
  if (!requested || !samePath(resolve(requested), expected))
    throw new Error("PRIVATE_FIXTURE_DESTINATION_REQUIRED");
  // Keep the fixed destination outside the checkout and reject redirected parents.
  if (
    (await lstat(parent)).isSymbolicLink() ||
    !samePath(await realpath(parent), parent)
  )
    throw new Error("PRIVATE_FIXTURE_PARENT_REQUIRED");
  try {
    await lstat(expected);
    throw new Error("PRIVATE_FIXTURE_ALREADY_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return expected;
}

async function createPrivateFixture(path, fixture) {
  // wx refuses both existing regular files and symlinks, including an open race.
  const file = await open(path, "wx", 0o600);
  try {
    const created = await file.stat();
    if (!created.isFile() || created.nlink !== 1)
      throw new Error("PRIVATE_FIXTURE_REGULAR_FILE_REQUIRED");
    const store = { path, file, created };
    await updatePrivateFixture(store, fixture);
    return store;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function updatePrivateFixture(store, fixture) {
  const current = await lstat(store.path);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.nlink !== 1 ||
    current.dev !== store.created.dev ||
    current.ino !== store.created.ino
  )
    throw new Error("PRIVATE_FIXTURE_IDENTITY_CHANGED");
  const bytes = Buffer.from(`${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  await store.file.truncate(0);
  for (let offset = 0; offset < bytes.length; ) {
    const { bytesWritten } = await store.file.write(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (!bytesWritten) throw new Error("PRIVATE_FIXTURE_WRITE_FAILED");
    offset += bytesWritten;
  }
  await store.file.sync();
}

function loginRetryDelay(headers) {
  const raw = headers.get("retry-after") ?? headers.get("x-retry-after");
  if (raw === null) return 11_000; // Better Auth's default sign-in window is 10s.
  const numeric = Number(raw);
  const seconds = Number.isFinite(numeric)
    ? numeric
    : (Date.parse(raw) - Date.now()) / 1000;
  if (!Number.isFinite(seconds) || seconds > 60)
    throw new Error("LOGIN_RETRY_BOUND_EXCEEDED");
  return Math.min(60_000, Math.max(0, Math.ceil(seconds * 1000)) + 250);
}

async function retryLogin(attempt, expected) {
  let response = await attempt();
  if (response.status === 429) {
    stage = "respect login rate limit before one bounded retry";
    const delay = loginRetryDelay(response.headers);
    console.log(
      `INFO login throttle HTTP expected=${expected} actual=429; waiting ${delay}ms before one retry`,
    );
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, delay));
    response = await attempt();
  }
  return response;
}

let stage = "validate preview destination";
let passed = 0;
let lastHttpStatus;
let pendingHttpDiagnostics = [];
let failureHttpDiagnostics = [];
let privateFixtureStore;
let privateFixtureData;
async function persistPrivateFixture(acceptance) {
  if (!privateFixtureStore) return;
  privateFixtureData.acceptance = acceptance;
  privateFixtureData.stage = stage;
  privateFixtureData.passedChecks = passed;
  privateFixtureData.updatedAt = new Date().toISOString();
  if (acceptance === "failed")
    privateFixtureData.failureHttp = failureHttpDiagnostics.length
      ? failureHttpDiagnostics
      : [{ actual: lastHttpStatus ?? null }];
  await updatePrivateFixture(privateFixtureStore, privateFixtureData);
}
function httpStatus(response, expected) {
  pendingHttpDiagnostics.push({ expected, actual: response.status });
  return response.status === expected;
}
function safeHttpDiagnostics() {
  return failureHttpDiagnostics.length
    ? failureHttpDiagnostics
        .map(
          ({ expected, actual }) =>
            `HTTP expected=${expected} actual=${actual}`,
        )
        .join("; ")
    : `HTTP actual=${lastHttpStatus ?? "unavailable"}, expected=unavailable`;
}
function check(ok, label) {
  stage = label;
  const diagnostics = pendingHttpDiagnostics.splice(0);
  if (!ok) {
    failureHttpDiagnostics = diagnostics;
    throw new Error("E2E_ASSERTION_FAILED");
  }
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
  stage = "validate optional private fixture destination";
  const privateFixtureOutput = await validatePrivateFixtureOutput(
    process.env.FAMILY_E2E_FIXTURE_OUTPUT,
  );
  const base = destination.origin;
  const marker = randomBytes(8).toString("hex");
  const password = `Fixture-${randomBytes(24).toString("base64url")}`;
  const adminEmail = `family-e2e-${marker}-admin@test.invalid`;
  const candidates = [
    `family-e2e-${marker}-a@test.invalid`,
    `family-e2e-${marker}-race@test.invalid`,
  ];
  const emailB = `family-e2e-${marker}-b@test.invalid`;
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
    lastHttpStatus = response.status;
    jar?.capture(response);
    return response;
  }
  const family = (method, path, body, jar, origin) =>
    call(method, `/api/family/${path}`, body, jar, origin);
  const signIn = async (email, jar, expected = 200) => {
    const attempt = () =>
      call(
        "POST",
        "/api/auth/sign-in/email",
        { email, password, rememberMe: true },
        jar,
      );
    return retryLogin(attempt, expected);
  };
  const familyJson = async (method, path, body, jar, label) => {
    const response = await family(method, path, body, jar);
    check(httpStatus(response, 200), label);
    return response.json();
  };
  stage = "read server preview marker before any mutation";
  const preflight = await family("GET", "status");
  check(httpStatus(preflight, 200), "preview status endpoint is reachable");
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
  if (privateFixtureOutput !== undefined) {
    stage = "save in-progress preview fixture before setup";
    privateFixtureData = {
      previewUrl: base,
      acceptance: "in_progress",
      createdAt: new Date().toISOString(),
      stage,
      passedChecks: passed,
      accounts: {
        admin: {
          email: adminEmail,
          password,
          role: "admin",
          status: "not_created",
        },
        memberA: {
          email: candidates[0],
          candidateEmails: candidates,
          password,
          role: "member",
          status: "not_created",
        },
        memberB: {
          email: emailB,
          password,
          role: "member",
          status: "not_created",
        },
      },
    };
    privateFixtureStore = await createPrivateFixture(
      privateFixtureOutput,
      privateFixtureData,
    );
    console.log("private fixture saved");
  }
  const setupBody = {
    bootstrapToken,
    name: "E2E Fixture Admin",
    email: adminEmail,
    password,
  };
  check(
    httpStatus(
      await family(
        "POST",
        "setup",
        setupBody,
        undefined,
        "https://untrusted.test.invalid",
      ),
      403,
    ),
    "cross-origin bootstrap cannot initialize database",
  );
  check(
    httpStatus(
      await family("POST", "setup", {
        ...setupBody,
        bootstrapToken: "incorrect-fixture-token",
      }),
      403,
    ),
    "wrong bootstrap cannot claim administrator",
  );
  stage = "initialize preview fixture administrator and schema";
  check(
    httpStatus(await family("POST", "setup", setupBody), 200),
    "authorized setup migrates and creates explicit admin",
  );
  if (privateFixtureData) privateFixtureData.accounts.admin.status = "approved";
  check(
    httpStatus(await family("POST", "setup", setupBody), 409),
    "administrator bootstrap cannot be repeated",
  );
  check(
    httpStatus(
      await call("POST", "/api/auth/sign-up/email", {
        name: "Bypass",
        email: `family-e2e-${marker}-bypass@test.invalid`,
        password,
        role: "admin",
        status: "approved",
      }),
      404,
    ),
    "raw auth signup cannot bypass invitation workflow",
  );
  const login = await signIn(adminEmail, admin);
  check(
    httpStatus(login, 200) && !!admin.header(),
    "administrator logs in using persistent library cookie",
  );
  const adminResponse = await family("GET", "me", undefined, admin);
  check(
    httpStatus(adminResponse, 200),
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
  check(httpStatus(inviteRes, 200), "administrator creates an invitation");
  const invite = await inviteRes.json();
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
    results.filter((res) => httpStatus(res, 200)).length === 1 &&
      results.filter((res) => httpStatus(res, 403)).length === 1,
    "concurrent registration consumes invitation exactly once",
  );
  const emailA = candidates[results.findIndex((res) => res.status === 200)];
  if (privateFixtureData) {
    privateFixtureData.accounts.memberA.email = emailA;
    privateFixtureData.accounts.memberA.status = "pending";
    await updatePrivateFixture(privateFixtureStore, privateFixtureData);
  }
  check(
    httpStatus(await signIn(emailA, memberA, 403), 403) && !memberA.header(),
    "pending account cannot obtain login session",
  );
  const users = (
    await familyJson(
      "GET",
      "admin/users",
      undefined,
      admin,
      "administrator reads accounts before A approval",
    )
  ).users;
  const accountA = users.find((user) => user.email === emailA);
  check(
    accountA?.role === "member" && accountA?.status === "pending",
    "client cannot inject role or approval status",
  );
  check(
    httpStatus(
      await family(
        "PATCH",
        `admin/users/${accountA.id}`,
        { status: "approved" },
        admin,
      ),
      200,
    ),
    "administrator approves member A",
  );
  check(
    httpStatus(await signIn(emailA, memberA), 200),
    "approved member logs in successfully",
  );
  if (privateFixtureData)
    privateFixtureData.accounts.memberA.status = "approved";
  const inviteB = await familyJson(
    "POST",
    "admin/invites",
    {},
    admin,
    "administrator creates independent B invitation",
  );
  check(
    httpStatus(
      await family("POST", "register", {
        inviteToken: inviteB.inviteToken,
        name: "E2E Fixture Member B",
        email: emailB,
        password,
      }),
      200,
    ),
    "independent invitation registers member B",
  );
  if (privateFixtureData)
    privateFixtureData.accounts.memberB.status = "pending";
  const nextUsers = (
    await familyJson(
      "GET",
      "admin/users",
      undefined,
      admin,
      "administrator reads accounts before B approval",
    )
  ).users;
  const accountB = nextUsers.find((user) => user.email === emailB);
  check(
    accountB?.role === "member" && accountB.status === "pending",
    "member B is present and pending before approval",
  );
  check(
    httpStatus(
      await family(
        "PATCH",
        `admin/users/${accountB.id}`,
        { status: "approved" },
        admin,
      ),
      200,
    ),
    "administrator approves member B",
  );
  if (privateFixtureData)
    privateFixtureData.accounts.memberB.status = "approved";
  check(
    httpStatus(await signIn(emailB, memberB), 200),
    "second approved member logs in independently",
  );
  const memberBMe = await familyJson(
    "GET",
    "me",
    undefined,
    memberB,
    "second member cookie authenticates its account",
  );
  check(
    memberBMe.user.id === accountB.id &&
      memberBMe.user.role === "member" &&
      memberBMe.user.status === "approved",
    "second member identity and approval come from database",
  );
  check(
    httpStatus(await family("GET", "admin/users", undefined, memberA), 403),
    "member cannot access administrative accounts",
  );
  check(
    httpStatus(await family("POST", "admin/invites", {}, memberA), 403),
    "member cannot generate invitations",
  );
  check(
    httpStatus(
      await family(
        "POST",
        "chats",
        {},
        memberA,
        "https://untrusted.test.invalid",
      ),
      403,
    ),
    "cross-origin chat mutation is rejected",
  );
  check(
    httpStatus(await family("GET", "me"), 401),
    "anonymous client cannot read account data",
  );
  const chatRes = await family("POST", "chats", {}, memberA);
  check(httpStatus(chatRes, 200), "member A creates a private conversation");
  const { chat } = await chatRes.json();
  check(
    httpStatus(
      await family("GET", `chats/${chat.id}`, undefined, memberA),
      200,
    ),
    "owner reads its own conversation",
  );
  check(
    httpStatus(
      await family("GET", `chats/${chat.id}`, undefined, memberB),
      404,
    ),
    "member B cannot read A conversation id",
  );
  check(
    httpStatus(
      await family("DELETE", `chats/${chat.id}`, undefined, memberB),
      404,
    ),
    "member B cannot archive A conversation id",
  );
  check(
    httpStatus(
      await family(
        "POST",
        `chats/${chat.id}/messages`,
        {
          content: "Fixture only",
          requestId: randomUUID(),
          userId: accountA.id,
        },
        memberB,
      ),
      404,
    ),
    "member B cannot send through A conversation or forge its user id",
  );
  check(
    httpStatus(
      await family(
        "POST",
        `chats/${chat.id}/messages`,
        { content: "Fixture only", requestId: "invalid/id" },
        memberA,
      ),
      400,
    ),
    "invalid idempotency request identifier is rejected",
  );
  check(
    httpStatus(
      await family(
        "POST",
        `chats/${chat.id}/messages`,
        { content: "Fixture only", requestId: randomUUID() },
        memberA,
      ),
      503,
    ),
    "missing model key fails closed without real model invocation",
  );
  const unchanged = await familyJson(
    "GET",
    `chats/${chat.id}`,
    undefined,
    memberA,
    "owner reads conversation after missing model configuration",
  );
  check(
    unchanged.messages.length === 0,
    "missing model key does not persist a fake reply or generation",
  );
  const eventId = randomUUID();
  check(
    httpStatus(await family("POST", "activity", { eventId }, memberA), 200),
    "foreground activity endpoint accepts server-timed event",
  );
  check(
    httpStatus(await family("POST", "activity", { eventId }, memberA), 200),
    "duplicate heartbeat is accepted idempotently",
  );
  check(
    httpStatus(
      await family("GET", `admin/users/${accountA.id}/chats`, undefined, admin),
      200,
    ),
    "administrator lists member conversation through admin guard",
  );
  check(
    httpStatus(
      await family("GET", `admin/chats/${chat.id}`, undefined, admin),
      200,
    ),
    "administrator reads content through audited admin route",
  );
  check(
    httpStatus(
      await family("DELETE", `chats/${chat.id}`, undefined, memberA),
      200,
    ),
    "owner archives its conversation",
  );
  const memberChats = await familyJson(
    "GET",
    "chats",
    undefined,
    memberA,
    "owner lists conversations after archive",
  );
  check(
    !memberChats.chats.some((item) => item.id === chat.id),
    "archived conversation disappears from member list",
  );
  check(
    httpStatus(
      await family("GET", `chats/${chat.id}`, undefined, memberA),
      404,
    ),
    "member cannot reopen archived conversation directly",
  );
  check(
    httpStatus(
      await family(
        "POST",
        `chats/${chat.id}/messages`,
        { content: "Archived fixture", requestId: randomUUID() },
        memberA,
      ),
      404,
    ),
    "member cannot send to archived conversation",
  );
  const adminChats = await familyJson(
    "GET",
    `admin/users/${accountA.id}/chats`,
    undefined,
    admin,
    "administrator lists retained conversations after archive",
  );
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
  check(
    httpStatus(archivedResponse, 200),
    "administrator reads retained archived conversation successfully",
  );
  const archivedDetail = await archivedResponse.json();
  check(
    httpStatus(archivedResponse, 200) &&
      archivedDetail.chat.archived === true &&
      Array.isArray(archivedDetail.messages),
    "administrator retains audited access to archived conversation",
  );
  check(
    httpStatus(
      await family(
        "PATCH",
        `admin/users/${accountA.id}`,
        { status: "disabled" },
        admin,
      ),
      200,
    ),
    "administrator disables member A",
  );
  if (privateFixtureData)
    privateFixtureData.accounts.memberA.status = "disabled";
  check(
    httpStatus(await family("GET", "me", undefined, memberA), 401),
    "disabled account old cookie is revoked immediately",
  );
  check(
    httpStatus(await signIn(emailA, new Cookies(), 403), 403),
    "disabled account cannot create a new session",
  );
  check(
    httpStatus(
      await family(
        "PATCH",
        `admin/users/${adminMe.user.id}`,
        { status: "disabled" },
        admin,
      ),
      409,
    ),
    "last administrator cannot disable itself",
  );
  check(
    httpStatus(await call("POST", "/api/auth/sign-out", {}, memberB), 200),
    "library sign-out succeeds",
  );
  check(
    httpStatus(await family("GET", "me", undefined, memberB), 401),
    "signed-out browser no longer sees private data",
  );
  await persistPrivateFixture("passed");
  console.log(
    `Family preview HTTP E2E: ${passed} checks passed. Fixture accounts remain only in the confirmed preview database.`,
  );
  console.log(
    "No provider key was supplied, no model request was performed. SSE/provider usage require the separate isolated mock/PG tests.",
  );
}
main()
  .catch(async () => {
    try {
      await persistPrivateFixture("failed");
    } catch {
      console.error(
        "Private fixture update failed; no automatic deletion was performed.",
      );
    }
    console.error(
      `Family preview HTTP E2E failed at: ${stage}. ${safeHttpDiagnostics()}. No credentials, cookies, tokens, response bodies or fixture emails printed.`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await privateFixtureStore?.file.close();
    } catch {
      console.error("Private fixture handle close failed.");
      process.exitCode = 1;
    }
  });
