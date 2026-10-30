/** Explicit, one-shot preview model acceptance. Never reads a provider key or .env. */
import { randomUUID } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROMPT = "请只回复：连接成功。";
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = resolve(
  dirname(repository),
  ".private-family-preview-fixture.json",
);
const reportPath = resolve(
  repository,
  "../../outputs/harveychat-domain/preview-model-acceptance.json",
);
const report = {
  status: {
    result: "running",
    stage: "validate explicit preview",
    generationRequests: 0,
    httpStatus: null,
    errorCode: null,
  },
  text: { prompt: PROMPT, reply: null },
  usage: null,
  assertions: [],
};
let reportFile;
let reportIdentity;

class AcceptanceError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const safeCode = (code) =>
  typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
const samePath = (a, b) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
function assert(ok, label, code = "ASSERTION_FAILED") {
  report.status.stage = label;
  report.assertions.push({ label, passed: !!ok });
  if (!ok) throw new AcceptanceError(code);
  console.log(`PASS ${label}`);
}
function previewUrl(raw) {
  if (typeof raw !== "string")
    throw new AcceptanceError("EXPLICIT_PREVIEW_URL_REQUIRED");
  const url = new URL(raw);
  const generated = /^(.+)-([a-z0-9]{9})-(.+)\.vercel\.app$/.exec(url.hostname);
  if (
    url.protocol !== "https:" ||
    !generated ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new AcceptanceError("UNIQUE_PREVIEW_URL_REQUIRED");
  return { origin: url.origin, project: generated[1], scope: generated[3] };
}
function verifyPreviewOverride(target, original, confirmed) {
  if (target.project !== original.project || target.scope !== original.scope)
    throw new AcceptanceError("SAME_PROJECT_SCOPE_REQUIRED");
  if (target.origin !== original.origin && confirmed !== "1")
    throw new AcceptanceError("SAME_BRANCH_CONFIRMATION_REQUIRED");
}
function isReadyPreview(status) {
  return (
    status?.deploymentEnvironment === "preview" &&
    status.dbConfigured === true &&
    status.ready === true &&
    status.needsSetup === false
  );
}
async function readFixture() {
  report.status.stage = "read only the designated private fixture";
  const parent = dirname(fixturePath);
  const before = await lstat(fixturePath);
  if (
    (await lstat(parent)).isSymbolicLink() ||
    !samePath(await realpath(parent), parent) ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > 65_536
  )
    throw new AcceptanceError("PRIVATE_FIXTURE_FILE_REQUIRED");
  const file = await open(fixturePath, "r");
  try {
    const opened = await file.stat();
    const after = await lstat(fixturePath);
    if (
      !opened.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    )
      throw new AcceptanceError("PRIVATE_FIXTURE_IDENTITY_CHANGED");
    const fixture = JSON.parse(await file.readFile("utf8"));
    if (fixture.acceptance !== "passed")
      throw new AcceptanceError("PASSED_HTTP_FIXTURE_REQUIRED");
    for (const [name, suffix, role] of [
      ["admin", "admin", "admin"],
      ["memberB", "b", "member"],
    ]) {
      const account = fixture.accounts?.[name];
      if (
        !account ||
        !new RegExp(`^family-e2e-[a-f0-9]{16}-${suffix}@test\\.invalid$`).test(
          account.email,
        ) ||
        typeof account.password !== "string" ||
        account.password.length < 12 ||
        account.password.length > 128 ||
        account.role !== role ||
        account.status !== "approved"
      )
        throw new AcceptanceError("APPROVED_FIXTURE_ACCOUNT_REQUIRED");
    }
    return fixture;
  } finally {
    await file.close();
  }
}
async function saveReport() {
  if (!reportFile) return;
  const current = await lstat(reportPath);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== reportIdentity.dev ||
    current.ino !== reportIdentity.ino
  )
    throw new AcceptanceError("REPORT_IDENTITY_CHANGED");
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8");
  await reportFile.truncate(0);
  for (let offset = 0; offset < bytes.length; ) {
    const { bytesWritten } = await reportFile.write(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (!bytesWritten) throw new AcceptanceError("REPORT_WRITE_FAILED");
    offset += bytesWritten;
  }
  await reportFile.sync();
}
function usage(value) {
  if (
    value?.source === "unknown" &&
    value.inputTokens === null &&
    value.outputTokens === null
  )
    return { source: "unknown", inputTokens: null, outputTokens: null };
  if (
    value?.source === "reported" &&
    [value.inputTokens, value.outputTokens].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    )
  )
    return {
      source: "reported",
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
    };
  throw new AcceptanceError("INVALID_USAGE_CONTRACT");
}
function sameUsage(left, right) {
  return JSON.stringify(usage(left)) === JSON.stringify(usage(right));
}

/** Bounded SSE decoder used by the real request and the offline acceptance checks. */
class FamilyStreamDecoder {
  decoder = new TextDecoder("utf-8", { fatal: true });
  buffer = "";
  data = [];
  bytes = 0;
  start = null;
  done = null;
  text = "";
  feed(bytes, final = false) {
    this.bytes += bytes.length;
    if (this.bytes > 1_048_576) throw new AcceptanceError("STREAM_TOO_LARGE");
    this.buffer += this.decoder.decode(bytes, { stream: !final });
    if (this.buffer.length > 131_072)
      throw new AcceptanceError("STREAM_FRAME_TOO_LARGE");
    for (;;) {
      const index = this.buffer.search(/[\r\n]/);
      if (
        index < 0 ||
        (!final &&
          this.buffer[index] === "\r" &&
          index === this.buffer.length - 1)
      )
        break;
      const line = this.buffer.slice(0, index);
      const consumed =
        this.buffer[index] === "\r" && this.buffer[index + 1] === "\n" ? 2 : 1;
      this.buffer = this.buffer.slice(index + consumed);
      this.line(line);
    }
    if (final) {
      if (this.buffer) this.line(this.buffer);
      this.buffer = "";
      this.line("");
    }
  }
  line(line) {
    if (line === "") {
      if (this.data.length) {
        const value = this.data.join("\n");
        this.data = [];
        this.event(JSON.parse(value));
      }
    } else if (line.startsWith("data:")) {
      this.data.push(line.slice(5).replace(/^ /, ""));
      if (this.data.reduce((total, value) => total + value.length, 0) > 131_072)
        throw new AcceptanceError("STREAM_FRAME_TOO_LARGE");
    }
  }
  event(event) {
    if (event?.type === "error")
      throw new AcceptanceError(
        safeCode(event.code) ?? "STREAM_APPLICATION_ERROR",
      );
    if (event?.type === "start") {
      if (
        this.start ||
        this.done ||
        event.userMessage?.role !== "user" ||
        event.assistantMessage?.role !== "assistant" ||
        ![event.userMessage.id, event.assistantMessage.id].every(
          (id) =>
            typeof id === "string" && id.trim().length > 0 && id.length <= 100,
        ) ||
        event.userMessage.id === event.assistantMessage.id
      )
        throw new AcceptanceError("INVALID_STREAM_START");
      this.start = event;
    } else if (event?.type === "delta") {
      if (!this.start || this.done || typeof event.text !== "string")
        throw new AcceptanceError("INVALID_STREAM_DELTA");
      this.text += event.text;
      if (this.text.length > 64_000)
        throw new AcceptanceError("REPLY_TOO_LARGE");
    } else if (event?.type === "done") {
      if (
        !this.start ||
        this.done ||
        event.message?.role !== "assistant" ||
        typeof event.message.content !== "string" ||
        event.message.id !== this.start.assistantMessage.id
      )
        throw new AcceptanceError("INVALID_STREAM_DONE");
      usage(event.usage);
      if (!sameUsage(event.message.usage, event.usage))
        throw new AcceptanceError("STREAM_USAGE_MISMATCH");
      this.done = event;
    } else throw new AcceptanceError("UNKNOWN_STREAM_EVENT");
  }
  finish() {
    this.feed(new Uint8Array(), true);
    if (!this.start || !this.done)
      throw new AcceptanceError("INCOMPLETE_STREAM");
    if (
      this.done.message.status !== "complete" ||
      !this.text.trim() ||
      this.text !== this.done.message.content
    )
      throw new AcceptanceError("INCOMPLETE_REPLY");
    return {
      start: this.start,
      message: this.done.message,
      usage: usage(this.done.usage),
      text: this.text,
    };
  }
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
async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new AcceptanceError("MISSING_JSON_BODY");
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 2_097_152) throw new AcceptanceError("JSON_TOO_LARGE");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function counters(row) {
  const values = [
    row?.inputTokens,
    row?.outputTokens,
    row?.unknownUsageRequests,
  ];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new AcceptanceError("INVALID_ADMIN_COUNTERS");
  return {
    inputTokens: values[0],
    outputTokens: values[1],
    unknownUsageRequests: values[2],
  };
}
function counterDelta(before, after) {
  return Object.fromEntries(
    Object.keys(before).map((key) => [key, after[key] - before[key]]),
  );
}
async function main() {
  if (process.env.FAMILY_MODEL_E2E_PREVIEW_CONFIRMED !== "1")
    throw new AcceptanceError("EXPLICIT_PREVIEW_CONFIRMATION_REQUIRED");
  const target = previewUrl(process.env.FAMILY_MODEL_E2E_URL);
  reportFile = await open(reportPath, "wx", 0o600); // Existing report prevents accidental repeated paid execution.
  reportIdentity = await reportFile.stat();
  if (!reportIdentity.isFile() || reportIdentity.nlink !== 1)
    throw new AcceptanceError("REGULAR_REPORT_FILE_REQUIRED");
  await saveReport();
  const fixture = await readFixture();
  verifyPreviewOverride(
    target,
    previewUrl(fixture.previewUrl),
    process.env.FAMILY_MODEL_E2E_SAME_BRANCH_CONFIRMED,
  );
  const admin = new Cookies();
  const member = new Cookies();
  async function call(method, path, body, jar, label) {
    report.status.stage = label;
    const response = await fetch(`${target.origin}${path}`, {
      method,
      headers: {
        origin: target.origin,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(jar ? { cookie: jar.header() } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(65_000),
      redirect: "error",
      cache: "no-store",
    });
    report.status.httpStatus = response.status;
    jar?.capture(response);
    return response;
  }
  async function json(method, path, body, jar, label, expected = 200) {
    const response = await call(method, path, body, jar, label);
    if (response.status !== expected) {
      let errorCode = null;
      if (response.headers.get("content-type")?.includes("application/json"))
        errorCode = safeCode((await boundedJson(response)).code);
      else await response.body?.cancel();
      report.status.errorCode = errorCode;
      report.assertions.push({
        label,
        passed: false,
        expectedHttpStatus: expected,
        actualHttpStatus: response.status,
      });
      throw new AcceptanceError(errorCode ?? "UNEXPECTED_HTTP_STATUS");
    }
    assert(true, label);
    return boundedJson(response);
  }
  const family = (method, path, body, jar, label, expected) =>
    json(method, `/api/family/${path}`, body, jar, label, expected);
  try {
    const status = await family(
      "GET",
      "status",
      undefined,
      undefined,
      "preview status is reachable",
    );
    assert(
      isReadyPreview(status),
      "server confirms initialized preview environment",
      "READY_PREVIEW_REQUIRED",
    );
    for (const [account, jar, role, label] of [
      [fixture.accounts.admin, admin, "admin", "administrator"],
      [fixture.accounts.memberB, member, "member", "member B"],
    ]) {
      await json(
        "POST",
        "/api/auth/sign-in/email",
        { email: account.email, password: account.password, rememberMe: true },
        jar,
        `${label} fixture login`,
      );
      const me = await family(
        "GET",
        "me",
        undefined,
        jar,
        `${label} account is readable`,
      );
      assert(
        me.user?.email === account.email &&
          me.user.role === role &&
          me.user.status === "approved",
        `${label} identity and approval verified`,
        "FIXTURE_IDENTITY_MISMATCH",
      );
    }
    const usersBefore = await family(
      "GET",
      "admin/users",
      undefined,
      admin,
      "administrator reads baseline usage",
    );
    const memberRow = usersBefore.users?.find(
      (user) => user.email === fixture.accounts.memberB.email,
    );
    assert(!!memberRow, "member B exists in administrator accounts");
    const before = counters(memberRow);
    const { chat: adminChat } = await family(
      "POST",
      "chats",
      { title: "模型验收 · 管理员隔离" },
      admin,
      "administrator creates empty isolation fixture",
    );
    await family(
      "GET",
      `chats/${adminChat.id}`,
      undefined,
      member,
      "member B cannot read administrator conversation",
      404,
    );
    const { chat } = await family(
      "POST",
      "chats",
      { title: "模型连通验收" },
      member,
      "member B creates model acceptance conversation",
    );
    report.status.generationRequests = 1;
    report.status.stage = "send the single real model request";
    await saveReport();
    const stream = await call(
      "POST",
      `/api/family/chats/${chat.id}/messages`,
      { content: PROMPT, requestId: randomUUID() },
      member,
      "single model SSE response",
    );
    if (stream.status !== 200) {
      const isJson = stream.headers
        .get("content-type")
        ?.includes("application/json");
      const body = isJson ? await boundedJson(stream) : null;
      if (!isJson) await stream.body?.cancel();
      report.status.errorCode = safeCode(body?.code);
      report.assertions.push({
        label: "single model SSE response",
        passed: false,
        expectedHttpStatus: 200,
        actualHttpStatus: stream.status,
      });
      throw new AcceptanceError(
        report.status.errorCode ?? "MODEL_HTTP_FAILURE",
      );
    }
    const isSse = stream.headers
      .get("content-type")
      ?.includes("text/event-stream");
    if (!isSse) await stream.body?.cancel();
    assert(isSse, "model response uses SSE");
    const parser = new FamilyStreamDecoder();
    const reader = stream.body?.getReader();
    if (!reader) throw new AcceptanceError("MISSING_STREAM_BODY");
    let result;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.feed(value);
      }
      result = parser.finish();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    report.text.reply = result.text;
    report.usage = { ...result.usage, adminCounterDelta: null };
    assert(
      result.start.userMessage.content === PROMPT,
      "SSE records the intended user prompt",
    );
    assert(
      result.message.status === "complete" && result.text.trim().length > 0,
      "SSE contains a complete nonempty model reply",
    );
    await saveReport();
    const own = await family(
      "GET",
      `chats/${chat.id}`,
      undefined,
      member,
      "member reloads persisted model conversation",
    );
    assert(
      own.messages?.length === 2 &&
        own.messages[0].role === "user" &&
        own.messages[0].content === PROMPT &&
        own.messages[0].id === result.start.userMessage.id &&
        own.messages[1].role === "assistant" &&
        own.messages[1].status === "complete" &&
        own.messages[1].id === result.message.id &&
        own.messages[1].content === result.text,
      "user prompt and model reply persist exactly",
    );
    assert(
      sameUsage(own.messages[1].usage, result.usage),
      "persisted assistant usage matches SSE",
    );
    const inspected = await family(
      "GET",
      `admin/chats/${chat.id}`,
      undefined,
      admin,
      "administrator reads content through audited admin route",
    );
    assert(
      JSON.stringify(inspected.messages) === JSON.stringify(own.messages),
      "administrator sees the same persisted content and usage",
    );
    const usersAfter = await family(
      "GET",
      "admin/users",
      undefined,
      admin,
      "administrator reads usage after the single generation",
    );
    const afterRow = usersAfter.users?.find((user) => user.id === memberRow.id);
    const delta = counterDelta(before, counters(afterRow));
    report.usage.adminCounterDelta = delta;
    if (result.usage.source === "reported")
      assert(
        delta.inputTokens === result.usage.inputTokens &&
          delta.outputTokens === result.usage.outputTokens &&
          delta.unknownUsageRequests === 0,
        "reported tokens equal administrator usage increments",
        "USAGE_COUNTER_MISMATCH",
      );
    else
      assert(
        result.usage.inputTokens === null &&
          result.usage.outputTokens === null &&
          delta.inputTokens === 0 &&
          delta.outputTokens === 0 &&
          delta.unknownUsageRequests === 1,
        "unknown usage stays null and increments unknown request count",
        "UNKNOWN_USAGE_COUNTER_MISMATCH",
      );
    report.status.result = "passed";
    report.status.errorCode = null;
  } finally {
    // These are this script's library sessions only. No fixture or chat is deleted.
    const resultStatus = { ...report.status };
    await Promise.allSettled(
      [admin, member]
        .filter((jar) => jar.values.size)
        .map(async (jar) => {
          const response = await call(
            "POST",
            "/api/auth/sign-out",
            {},
            jar,
            report.status.stage,
          );
          await response.body?.cancel();
        }),
    );
    Object.assign(report.status, resultStatus);
  }
}

function offlineChecks() {
  let passed = 0;
  const check = (ok, label) => {
    if (!ok) throw new AcceptanceError("OFFLINE_CHECK_FAILED");
    passed++;
    console.log(`PASS ${label}`);
  };
  const rejects = (run) => {
    try {
      run();
      return false;
    } catch {
      return true;
    }
  };
  const known = { source: "reported", inputTokens: 9, outputTokens: 3 };
  const unknown = { source: "unknown", inputTokens: null, outputTokens: null };
  const text = "连接成功。";
  const start = {
    type: "start",
    userMessage: { id: "fixture-user", role: "user", content: PROMPT },
    assistantMessage: { id: "fixture-reply", role: "assistant", content: "" },
  };
  const done = (value = known) => ({
    type: "done",
    message: {
      id: "fixture-reply",
      role: "assistant",
      status: "complete",
      content: text,
      usage: value,
    },
    usage: value,
  });
  const encoded = (events) =>
    new TextEncoder().encode(
      events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
    );
  const events = [
    start,
    { type: "delta", text: "连接" },
    { type: "delta", text: "成功。" },
    done(),
  ];
  const bytes = encoded(events);
  const parser = new FamilyStreamDecoder();
  for (let offset = 0; offset < bytes.length; offset += 7)
    parser.feed(bytes.slice(offset, offset + 7));
  const result = parser.finish();
  check(
    result.text === text,
    "actual decoder handles split Chinese UTF-8 and CRLF SSE",
  );
  check(
    sameUsage(result.usage, known),
    "actual decoder retains reported token usage",
  );
  const noUsage = new FamilyStreamDecoder();
  noUsage.feed(encoded([start, { type: "delta", text }, done(unknown)]));
  check(
    noUsage.finish().usage.inputTokens === null,
    "unknown usage remains null",
  );
  check(
    rejects(() =>
      usage({ source: "unknown", inputTokens: 0, outputTokens: 0 }),
    ),
    "unknown usage cannot be fabricated as zero",
  );
  check(
    usage({ source: "reported", inputTokens: 0, outputTokens: 0 }).source ===
      "reported",
    "explicit reported zero remains distinct",
  );
  check(
    rejects(() =>
      usage({ source: "reported", inputTokens: null, outputTokens: 2 }),
    ),
    "incomplete reported usage rejected",
  );
  const truncated = new FamilyStreamDecoder();
  truncated.feed(encoded([start, { type: "delta", text }]));
  check(
    rejects(() => truncated.finish()),
    "truncated stream cannot pass",
  );
  check(
    rejects(() => {
      const p = new FamilyStreamDecoder();
      p.feed(encoded([start, start]));
    }),
    "duplicate stream start rejected",
  );
  check(
    rejects(() => {
      const p = new FamilyStreamDecoder();
      p.feed(
        encoded([{ ...start, userMessage: { ...start.userMessage, id: "" } }]),
      );
    }),
    "empty stream message id rejected",
  );
  check(
    rejects(() => {
      const p = new FamilyStreamDecoder();
      p.feed(
        encoded([
          {
            ...start,
            assistantMessage: {
              ...start.assistantMessage,
              id: start.userMessage.id,
            },
          },
        ]),
      );
    }),
    "user and assistant stream ids must differ",
  );
  check(
    rejects(() => {
      const p = new FamilyStreamDecoder();
      p.feed(
        encoded([
          start,
          { type: "delta", text },
          { ...done(), message: { ...done().message, id: "unrelated-reply" } },
        ]),
      );
    }),
    "done id must match the started assistant message",
  );
  check(
    rejects(() => {
      const p = new FamilyStreamDecoder();
      p.feed(encoded([{ type: "delta", text }]));
    }),
    "delta before start rejected",
  );
  check(
    rejects(() => {
      const p = new FamilyStreamDecoder();
      p.feed(
        encoded([
          start,
          { type: "error", message: "synthetic-sensitive-content" },
        ]),
      );
    }),
    "stream error rejected without echoing its message",
  );
  const mismatch = new FamilyStreamDecoder();
  mismatch.feed(encoded([start, { type: "delta", text: "不一致" }, done()]));
  check(
    rejects(() => mismatch.finish()),
    "done content must equal received deltas",
  );
  const original = previewUrl(
    "https://family-nextchat-123abc456-harvey-s-projects6.vercel.app/",
  );
  const target = previewUrl(
    "https://family-nextchat-789def012-harvey-s-projects6.vercel.app/",
  );
  check(
    rejects(() => previewUrl("https://harveychat.dpdns.org/")),
    "custom destination rejected",
  );
  check(
    rejects(() => previewUrl("https://family-nextchat.vercel.app/")),
    "production alias rejected",
  );
  check(
    rejects(() => verifyPreviewOverride(target, original, undefined)),
    "changed unique host requires explicit same-branch confirmation",
  );
  verifyPreviewOverride(target, original, "1");
  check(true, "confirmed same-project unique host accepted");
  check(
    !isReadyPreview({
      deploymentEnvironment: "production",
      dbConfigured: true,
      ready: true,
    }),
    "server production marker rejected before login",
  );
  check(
    isReadyPreview({
      deploymentEnvironment: "preview",
      dbConfigured: true,
      ready: true,
      needsSetup: false,
    }),
    "initialized server preview marker accepted",
  );
  check(
    !isReadyPreview({
      deploymentEnvironment: "preview",
      dbConfigured: true,
      ready: true,
    }),
    "missing setup marker rejected",
  );
  check(
    !isReadyPreview({
      deploymentEnvironment: "preview",
      dbConfigured: "true",
      ready: true,
      needsSetup: false,
    }),
    "string database marker rejected",
  );
  check(
    !isReadyPreview({
      deploymentEnvironment: "preview",
      dbConfigured: true,
      ready: "true",
      needsSetup: false,
    }),
    "string readiness marker rejected",
  );
  const delta = counterDelta(
    { inputTokens: 4, outputTokens: 1, unknownUsageRequests: 0 },
    { inputTokens: 13, outputTokens: 4, unknownUsageRequests: 0 },
  );
  check(
    delta.inputTokens === known.inputTokens &&
      delta.outputTokens === known.outputTokens,
    "administrator usage increments compare to reported tokens",
  );
  console.log(
    `Preview model acceptance: ${passed} offline checks passed. No HTTP, fixture, environment secrets or report files read/written.`,
  );
}

if (process.argv.includes("--self-test")) {
  offlineChecks();
} else
  main()
    .catch((error) => {
      report.status.result = "failed";
      report.status.errorCode =
        report.status.errorCode ??
        (error instanceof AcceptanceError
          ? error.code
          : error?.name === "TimeoutError"
          ? "REQUEST_TIMEOUT"
          : "UNEXPECTED_FAILURE");
      console.error(
        `Preview model acceptance failed at: ${report.status.stage}; HTTP=${
          report.status.httpStatus ?? "unavailable"
        }; code=${
          report.status.errorCode
        }. No credentials, cookies, account objects or emails printed.`,
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await saveReport();
      } catch {
        console.error(
          "Safe model report could not be saved; existing report is never overwritten.",
        );
        process.exitCode = 1;
      }
      try {
        await reportFile?.close();
      } catch {
        process.exitCode = 1;
      }
      if (!process.exitCode)
        console.log("Preview model acceptance passed; safe report saved.");
    });
