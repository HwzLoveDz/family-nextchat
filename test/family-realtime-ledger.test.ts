/** @jest-environment node */
import { jest } from "@jest/globals";
import type { PoolClient } from "pg";
import type { RealtimeContext } from "../app/family/server/realtime-ledger";
const result = (rows: Record<string, any>[] = []) => ({
  rows,
  rowCount: rows.length,
});
const query =
  jest.fn<
    (sql: string, values?: any[]) => Promise<ReturnType<typeof result>>
  >();
const poolQuery =
  jest.fn<
    (sql: string, values?: any[]) => Promise<ReturnType<typeof result>>
  >();
let serial: Promise<unknown> = Promise.resolve();
const transaction = jest.fn(
  async (run: (client: PoolClient) => Promise<any>) => {
    const next = serial.then(() => run({ query } as unknown as PoolClient));
    serial = next.catch(() => {});
    return next;
  },
);
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("@/app/family/server/db", () => ({
  transaction,
  getPool: () => ({ query: poolQuery }),
}));
const ledger = await import("@/app/family/server/realtime-ledger");
const upgrades = await import("@/app/family/server/upgrades");
const { listUsers } = await import("@/app/family/server/accounts");
const { updateChat, deleteChat } = await import("@/app/family/server/chats");
const callId = "10000000-0000-4000-8000-000000000001",
  chatId = "10000000-0000-4000-8000-000000000002",
  connectionId = "10000000-0000-4000-8000-000000000003";
const requestId = "10000000-0000-4000-8000-000000000004";
const context = (): RealtimeContext => ({
  callId,
  chatId,
  connectionId,
  userId: "synthetic-a",
  sessionId: "session-a",
  model: "gpt-realtime-2.1-mini",
  voice: "marin",
  vad: "natural",
  remainingSeconds: 1700,
  remainingTurns: 100,
  history: [],
});
const reported = {
    source: "reported" as const,
    inputTokens: 10,
    outputTokens: 20,
  },
  unknown = {
    source: "unknown" as const,
    inputTokens: null,
    outputTokens: null,
  };
let call: Record<string, any>,
  chat: Record<string, any>,
  authorized: boolean,
  liveCalls: Record<string, any>[],
  turns: Map<string, any>,
  usages: Map<string, any>,
  messages: Map<string, any>,
  playback: Map<string, any>,
  generations: Map<string, any>,
  historyRows: Record<string, any>[];
const originalFetch = global.fetch;
const forbiddenFetch = jest.fn<typeof fetch>(async () => {
  throw new Error("No outbound requests in ledger fixtures");
});
function fixtureTurn(input = "item_input", conn = connectionId) {
  const row = {
    id: "turn-" + input,
    call_id: callId,
    connection_id: conn,
    input_item_id: input,
    generation_id: "generation-" + input,
    user_message_id: "user-" + input,
    assistant_message_id: "assistant-" + input,
    response_id: null,
    output_item_id: null,
    transcript_recorded: false,
    interrupted: false,
    heard_complete: false,
    state: "running",
  };
  turns.set(input, row);
  generations.set(row.generation_id, { state: "running", ...unknown });
  messages.set(row.user_message_id, { content: "", status: "complete" });
  messages.set(row.assistant_message_id, { content: "", status: "streaming" });
  for (const kind of ["response", "transcribe"])
    usages.set(row.id + kind, {
      provider_id: null,
      state: "running",
      usage_source: "unknown",
      input_tokens: null,
      output_tokens: null,
      actual_model: null,
      reported_audio_seconds: null,
    });
  return row;
}
beforeEach(() => {
  jest.clearAllMocks();
  serial = Promise.resolve();
  global.fetch = forbiddenFetch;
  process.env.FAMILY_OPENAI_MODEL = "gpt-4o-mini";
  process.env.FAMILY_OPENAI_MODELS = "gpt-4o-mini";
  call = {
    id: callId,
    user_id: "synthetic-a",
    session_id: "session-a",
    chat_id: chatId,
    connection_id: connectionId,
    model: "gpt-realtime-2.1-mini",
    voice: "marin",
    vad: "natural",
    state: "active",
    turn_count: 0,
    expires_at: new Date(Date.now() + 1700000),
    lease_expires_at: new Date(Date.now() + 20000),
    input_audio_seconds: null,
  };
  chat = {
    id: chatId,
    user_id: "synthetic-a",
    title: "Synthetic voice",
    model: "gpt-4o-mini",
    created_at: new Date(),
    updated_at: new Date(),
  };
  authorized = true;
  liveCalls = [];
  turns = new Map();
  usages = new Map();
  messages = new Map();
  playback = new Map();
  generations = new Map();
  historyRows = [];
  poolQuery.mockImplementation(async () => result());
  query.mockImplementation(async (sql, v = []) => {
    if (sql.startsWith("SELECT pg_advisory")) return result();
    if (sql.startsWith('SELECT id FROM "user"'))
      return result(
        authorized && v[0] === "synthetic-a" ? [{ id: "synthetic-a" }] : [],
      );
    if (sql.startsWith('SELECT s.id FROM "session"'))
      return result(
        authorized && v[0] === "session-a" && v[1] === "synthetic-a"
          ? [{ id: "session-a" }]
          : [],
      );
    if (
      sql.startsWith(
        "UPDATE family_realtime_call SET state='ended',ended_at=now()",
      )
    )
      return result();
    if (sql.startsWith("SELECT * FROM family_realtime_call WHERE user_id="))
      return result();
    if (sql.startsWith("SELECT user_id,chat_id FROM family_realtime_call"))
      return result(liveCalls);
    if (sql.startsWith("SELECT 1 FROM family_realtime_call"))
      return result(
        liveCalls.filter((row) => row.user_id === v[0] || row.chat_id === v[1]),
      );
    if (sql.startsWith("SELECT * FROM family_realtime_call WHERE id="))
      return result(
        v[0] === call.id &&
          v[1] === call.user_id &&
          v[2] === call.session_id &&
          call.state === "active" &&
          +call.lease_expires_at > Date.now()
          ? [{ ...call }]
          : [],
      );
    if (sql.startsWith("SELECT c.* FROM family_realtime_call"))
      return result(
        v[0] === call.id &&
          v[1] === call.user_id &&
          v[2] === call.session_id &&
          v[3] === call.chat_id &&
          (v.length < 5 ||
            (v[4] === call.connection_id &&
              call.state === "active" &&
              +call.lease_expires_at > Date.now()))
          ? [{ ...call }]
          : [],
      );
    if (
      sql.startsWith("SELECT * FROM family_chat") ||
      sql.startsWith("SELECT id FROM family_chat")
    )
      return result(
        v[0] === chat.id && v[1] === chat.user_id && !chat.deleted_at
          ? [{ ...chat }]
          : [],
      );
    if (sql.startsWith("SELECT 1 FROM family_generation")) return result();
    if (sql.startsWith("INSERT INTO family_realtime_call"))
      return result([
        {
          ...call,
          id: v[0],
          request_id: v[4],
          request_hash: v[5],
          connection_id: null,
        },
      ]);
    if (sql.startsWith("UPDATE family_realtime_call SET connection_id=$1")) {
      call.connection_id = v[0];
      return result();
    }
    if (sql.startsWith("UPDATE family_realtime_call SET lease_expires_at="))
      return result();
    if (sql.startsWith("SELECT m.generation_id,m.role,m.content"))
      return result(historyRows);
    if (sql.startsWith("SELECT id,connection_id FROM family_realtime_turn"))
      return result(turns.has(v[1]) ? [turns.get(v[1])] : []);
    if (sql.startsWith("SELECT t.*,c.user_id")) {
      const row = turns.get(v[2]);
      return result(
        row &&
          row.call_id === v[0] &&
          row.connection_id === v[1] &&
          v[3] === call.user_id &&
          v[4] === call.session_id &&
          v[5] === call.chat_id
          ? [{ ...row }]
          : [],
      );
    }
    if (
      sql.startsWith(
        "SELECT provider_id,usage_source FROM family_realtime_usage",
      )
    ) {
      const u = usages.get(v[0] + v[1]);
      return result(u ? [{ ...u }] : []);
    }
    if (
      sql.startsWith(
        "SELECT interrupted,heard_complete FROM family_realtime_playback",
      )
    )
      return result(playback.has(v[2]) ? [{ ...playback.get(v[2]) }] : []);
    if (sql.startsWith("SELECT id FROM family_realtime_turn"))
      return result(
        [...turns.values()]
          .filter((row) => row.call_id === v[0] && row.connection_id === v[1])
          .slice(0, 1),
      );
    if (sql.startsWith("INSERT INTO family_generation")) {
      generations.set(v[0], { state: "running", ...unknown });
      return result();
    }
    if (sql.startsWith("INSERT INTO family_message")) {
      messages.set(v[0], { content: "", status: "complete" });
      messages.set(v[3], { content: "", status: "streaming" });
      return result();
    }
    if (sql.startsWith("INSERT INTO family_realtime_turn")) {
      turns.set(v[3], {
        id: v[0],
        call_id: v[1],
        connection_id: v[2],
        input_item_id: v[3],
        generation_id: v[4],
        user_message_id: v[5],
        assistant_message_id: v[6],
        state: "running",
        interrupted: false,
        heard_complete: false,
        response_id: null,
        transcript_recorded: false,
      });
      return result();
    }
    if (sql.startsWith("INSERT INTO family_realtime_usage")) {
      usages.set(v[2] + v[4], {
        provider_id: null,
        usage_source: "unknown",
        state: "running",
        input_tokens: null,
        output_tokens: null,
      });
      return result();
    }
    if (sql.startsWith("UPDATE family_realtime_call SET turn_count=")) {
      call.turn_count++;
      return result();
    }
    if (sql.startsWith("UPDATE family_chat SET updated_at=")) return result();
    if (sql.startsWith("UPDATE family_generation g SET state='partial'")) {
      for (const t of turns.values())
        if (
          (!v[1] || t.connection_id === v[1]) &&
          generations.get(t.generation_id)?.state === "running"
        )
          generations.get(t.generation_id).state = "partial";
      return result();
    }
    if (sql.startsWith("UPDATE family_message m SET status='partial'")) {
      for (const t of turns.values())
        if (
          (!v[1] || t.connection_id === v[1]) &&
          messages.get(t.assistant_message_id)?.status === "streaming"
        )
          messages.get(t.assistant_message_id).status = "partial";
      return result();
    }
    if (sql.startsWith("UPDATE family_realtime_turn t SET state='partial'")) {
      for (const t of turns.values())
        if ((!v[1] || t.connection_id === v[1]) && t.state === "running") {
          t.state = "partial";
          t.interrupted = true;
        }
      return result();
    }
    if (sql.startsWith("UPDATE family_realtime_usage v SET state='error'")) {
      for (const u of usages.values())
        if (u.state === "running") u.state = "error";
      return result();
    }
    if (sql.startsWith("UPDATE family_realtime_usage SET provider_id=")) {
      const u = usages.get(v[7] + v[8]);
      const hadProvider = !!u.provider_id;
      u.provider_id ??= v[0];
      if (!hadProvider) u.state = v[1];
      u.actual_model ??= v[2];
      if (u.usage_source !== "reported") {
        u.input_tokens = v[3];
        u.output_tokens = v[4];
        u.usage_source = v[5];
      }
      u.reported_audio_seconds ??= v[6];
      return result();
    }
    if (sql.startsWith("UPDATE family_message SET content=$1 WHERE")) {
      messages.get(v[1]).content = v[0];
      return result();
    }
    if (
      sql.startsWith("UPDATE family_realtime_turn SET transcript_recorded=")
    ) {
      [...turns.values()].find((t) => t.id === v[0]).transcript_recorded = true;
      return result();
    }
    if (sql.startsWith("UPDATE family_realtime_turn SET response_id=")) {
      Object.assign(
        [...turns.values()].find((t) => t.id === v[5]),
        {
          response_id: v[0],
          output_item_id: v[1],
          state: v[2],
          interrupted: v[3],
          heard_complete: v[4],
        },
      );
      return result();
    }
    if (sql.startsWith("UPDATE family_generation SET state=$1")) {
      Object.assign(generations.get(v[5]), {
        state: v[0],
        inputTokens: v[1],
        outputTokens: v[2],
        source: v[3],
        actual_model: v[4],
      });
      return result();
    }
    if (sql.startsWith("UPDATE family_generation SET input_tokens=")) {
      const g = generations.get(v[3]);
      if (g.source !== "reported")
        Object.assign(g, {
          inputTokens: v[0],
          outputTokens: v[1],
          source: "reported",
        });
      return result();
    }
    if (sql.startsWith("UPDATE family_message SET content=$1,status=$2")) {
      Object.assign(messages.get(v[2]), { content: v[0], status: v[1] });
      return result();
    }
    if (sql.startsWith("INSERT INTO family_realtime_playback")) {
      const prior = playback.get(v[2]) ?? {
        played_ms: 0,
        heard_complete: false,
        interrupted: false,
      };
      prior.played_ms = Math.max(prior.played_ms, v[3]);
      prior.interrupted ||= v[5];
      prior.heard_complete =
        (prior.heard_complete || v[4]) && !prior.interrupted;
      playback.set(v[2], prior);
      return result();
    }
    if (sql.startsWith("UPDATE family_realtime_turn SET interrupted=")) {
      for (const t of turns.values())
        if (t.output_item_id === v[4] && t.connection_id === v[3]) {
          t.interrupted ||= v[0];
          t.heard_complete = (t.heard_complete || v[1]) && !t.interrupted;
        }
      return result();
    }
    if (sql.startsWith("UPDATE family_realtime_call SET connection_id=NULL")) {
      call.connection_id = null;
      call.input_audio_seconds = (call.input_audio_seconds ?? 0) + v[0];
      call.state = v[1] ? "active" : "ended";
      return result();
    }
    if (sql.startsWith("SELECT id FROM family_realtime_call"))
      return result(
        v[0] === call.id && v[1] === call.user_id && v[2] === call.session_id
          ? [{ id: call.id }]
          : [],
      );
    if (sql.startsWith("UPDATE family_realtime_call SET state='ended'")) {
      call.state = "ended";
      return result();
    }
    throw new Error("Unexpected synthetic query: " + sql.slice(0, 90));
  });
});
afterEach(() => {
  global.fetch = originalFetch;
  expect(forbiddenFetch).not.toHaveBeenCalled();
  delete process.env.FAMILY_OPENAI_MODEL;
  delete process.env.FAMILY_OPENAI_MODELS;
});

const response = (extra: Record<string, unknown> = {}) => ({
  responseId: "resp_one",
  inputItemId: "item_input",
  outputItemId: "item_output",
  text: "合成回复",
  status: "completed" as const,
  usage: reported,
  actualModel: "gpt-realtime-2.1-mini-2026-10-01",
  ...extra,
});

test.each([
  { voice: "arbitrary", vad: "fast" },
  { voice: "marin", vad: "bad" },
  { voice: "marin", vad: "fast", endpoint: "untrusted" },
])("invalid session controls fail before any DB mutation: %j", async (body) => {
  await expect(
    ledger.createRealtimeCall("synthetic-a", "session-a", {
      requestId,
      ...body,
    }),
  ).rejects.toMatchObject({ code: "INVALID_REALTIME_PARAMETERS" });
  expect(query).not.toHaveBeenCalled();
});
test("foreign chat and revoked session cannot create a call", async () => {
  chat.user_id = "synthetic-b";
  await expect(
    ledger.createRealtimeCall("synthetic-a", "session-a", {
      requestId,
      chatId,
      voice: "marin",
      vad: "natural",
    }),
  ).rejects.toMatchObject({ status: 404 });
  expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
  authorized = false;
  await expect(
    ledger.createRealtimeCall("synthetic-a", "session-a", {
      requestId,
      chatId,
      voice: "marin",
      vad: "natural",
    }),
  ).rejects.toMatchObject({ code: "REALTIME_UNAVAILABLE" });
});
test.each(["user", "chat", "global"])(
  "cross-instance %s cap rejects before inserting a call",
  async (mode) => {
    liveCalls =
      mode === "global"
        ? Array.from({ length: 4 }, (_, i) => ({
            user_id: "other" + i,
            chat_id: "other" + i,
          }))
        : [
            {
              user_id: mode === "user" ? "synthetic-a" : "other",
              chat_id: mode === "chat" ? chatId : "other",
            },
          ];
    await expect(
      ledger.createRealtimeCall("synthetic-a", "session-a", {
        requestId,
        chatId,
        voice: "marin",
        vad: "natural",
      }),
    ).rejects.toMatchObject({ code: "REALTIME_BUSY" });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  },
);
test("two serialized claimants cannot acquire the same call connection", async () => {
  call.connection_id = null;
  const claims = await Promise.allSettled([
    ledger.claimRealtimeCall("synthetic-a", "session-a", callId),
    ledger.claimRealtimeCall("synthetic-a", "session-a", callId),
  ]);
  expect(claims.map((claim) => claim.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(
    query.mock.calls.filter(([sql]) =>
      sql.startsWith("UPDATE family_realtime_call SET connection_id=$1"),
    ),
  ).toHaveLength(1);
  expect(
    query.mock.calls.some(
      ([sql]) =>
        sql.startsWith("SELECT * FROM family_realtime_call") &&
        sql.includes("FOR UPDATE"),
    ),
  ).toBe(true);
});
test.each([
  "foreign-owner",
  "foreign-session",
  "revoked",
  "stale-connection",
  "expired",
])("lease %s is rejected without renewal or generation", async (mode) => {
  const ctx = context();
  if (mode === "foreign-owner") ctx.userId = "synthetic-b";
  if (mode === "foreign-session") ctx.sessionId = "session-b";
  if (mode === "revoked") authorized = false;
  if (mode === "stale-connection") call.connection_id = "different";
  if (mode === "expired") call.lease_expires_at = new Date(0);
  await expect(ledger.assertRealtimeLease(ctx)).rejects.toMatchObject({
    code: "REALTIME_UNAVAILABLE",
  });
  await expect(
    ledger.beginRealtimeTurn(ctx, "item_input"),
  ).rejects.toMatchObject({ code: "REALTIME_UNAVAILABLE" });
  expect(
    query.mock.calls.some(
      ([sql]) =>
        sql.startsWith("INSERT") ||
        sql.startsWith("UPDATE family_realtime_call SET lease"),
    ),
  ).toBe(false);
});
test("turn begin is idempotent and a later committed turn seals only an unfinished predecessor", async () => {
  await ledger.beginRealtimeTurn(context(), "item_first");
  await ledger.beginRealtimeTurn(context(), "item_first");
  expect(call.turn_count).toBe(1);
  expect(usages.size).toBe(2);
  const first = turns.get("item_first");
  await ledger.beginRealtimeTurn(context(), "item_second");
  expect(first.state).toBe("partial");
  expect(first.interrupted).toBe(true);
  expect(messages.get(first.assistant_message_id).status).toBe("partial");
  expect(call.turn_count).toBe(2);
  expect(usages.size).toBe(4);
});
test("the hundred-turn limit rejects before creating another generation", async () => {
  call.turn_count = 100;
  await expect(
    ledger.beginRealtimeTurn(context(), "item_limit"),
  ).rejects.toMatchObject({ code: "REALTIME_TURN_LIMIT" });
  expect(generations.size).toBe(0);
});
test("ASR final text and independent duration are idempotent, and missing tokens stay unknown", async () => {
  const turn = fixtureTurn();
  await ledger.recordRealtimeTranscript(
    context(),
    "item_input",
    "合成提问",
    unknown,
    3.25,
    "gpt-4o-mini-transcribe",
  );
  await ledger.recordRealtimeTranscript(
    context(),
    "item_input",
    "不应覆盖第一条最终转写",
    unknown,
    null,
    null,
  );
  expect(messages.get(turn.user_message_id).content).toBe("合成提问");
  expect(usages.get(turn.id + "transcribe")).toMatchObject({
    input_tokens: null,
    output_tokens: null,
    usage_source: "unknown",
    reported_audio_seconds: 3.25,
    actual_model: "gpt-4o-mini-transcribe",
  });
  expect(usages.get(turn.id + "response").provider_id).toBeNull();
});
test.each(["cancelled", "failed", "incomplete"] as const)(
  "%s responses preserve real usage/model and never claim a full assistant history",
  async (status) => {
    const turn = fixtureTurn();
    await ledger.recordRealtimeResponse(context(), response({ status }));
    expect(messages.get(turn.assistant_message_id)).toMatchObject({
      status: "partial",
      content: "合成回复",
    });
    expect(usages.get(turn.id + "response")).toMatchObject({
      input_tokens: 10,
      output_tokens: 20,
      usage_source: "reported",
      actual_model: "gpt-realtime-2.1-mini-2026-10-01",
    });
    expect(turn.interrupted).toBe(true);
    expect(turn.heard_complete).toBe(false);
  },
);
test("a duplicate done cannot erase reported tokens or rewrite an accepted subtitle", async () => {
  const turn = fixtureTurn();
  await ledger.recordRealtimeResponse(context(), response());
  await ledger.recordRealtimeResponse(
    context(),
    response({ usage: unknown, text: "不应覆盖", actualModel: null }),
  );
  expect(messages.get(turn.assistant_message_id).content).toBe("合成回复");
  expect(usages.get(turn.id + "response")).toMatchObject({
    input_tokens: 10,
    output_tokens: 20,
    usage_source: "reported",
  });
  await expect(
    ledger.recordRealtimeResponse(
      context(),
      response({ responseId: "resp_other" }),
    ),
  ).rejects.toMatchObject({ code: "REALTIME_EVENT_CONFLICT" });
});
test("late real usage can upgrade an unknown done without counting a new request", async () => {
  const turn = fixtureTurn();
  await ledger.recordRealtimeResponse(context(), response({ usage: unknown }));
  await ledger.recordRealtimeResponse(context(), response());
  expect(usages.size).toBe(2);
  expect(usages.get(turn.id + "response")).toMatchObject({
    input_tokens: 10,
    output_tokens: 20,
    usage_source: "reported",
  });
  expect(generations.get(turn.generation_id)).toMatchObject(reported);
});
test("interruption before done is irreversible even after a later full-playback claim", async () => {
  const turn = fixtureTurn();
  await ledger.markRealtimeInterrupted(context(), "item_output", 450);
  await ledger.markRealtimePlayed(context(), "item_output", 900, true);
  await ledger.recordRealtimeResponse(context(), response());
  expect(turn.interrupted).toBe(true);
  expect(turn.heard_complete).toBe(false);
  expect(messages.get(turn.assistant_message_id).status).toBe("partial");
});
test("full playback after done permits heard history, but interrupted output never re-enters it", async () => {
  const turn = fixtureTurn();
  await ledger.recordRealtimeResponse(context(), response());
  expect(turn.heard_complete).toBe(false);
  await ledger.markRealtimePlayed(context(), "item_output", 900, true);
  expect(turn.heard_complete).toBe(true);
  await ledger.markRealtimeInterrupted(context(), "item_output", 400);
  expect(turn.heard_complete).toBe(false);
  expect(turn.interrupted).toBe(true);
});
test("revocation stops new work while a previously accepted response may still settle its exact owned ledger", async () => {
  const turn = fixtureTurn();
  authorized = false;
  call.state = "ended";
  await expect(ledger.assertRealtimeLease(context())).rejects.toMatchObject({
    code: "REALTIME_UNAVAILABLE",
  });
  await ledger.recordRealtimeResponse(
    context(),
    response({ status: "cancelled" }),
  );
  expect(usages.get(turn.id + "response").input_tokens).toBe(10);
  await expect(
    ledger.recordRealtimeResponse(
      { ...context(), userId: "synthetic-b" },
      response(),
    ),
  ).rejects.toMatchObject({ code: "REALTIME_UNAVAILABLE" });
});
test("releasing the same connection twice preserves reported usage and adds measured input seconds once", async () => {
  const turn = fixtureTurn();
  await ledger.recordRealtimeResponse(context(), response());
  await ledger.releaseRealtimeConnection(context(), {
    resume: true,
    reason: "rotate",
    inputAudioSeconds: 4.5,
  });
  await ledger.releaseRealtimeConnection(context(), {
    resume: true,
    reason: "rotate",
    inputAudioSeconds: 4.5,
  });
  expect(call.input_audio_seconds).toBe(4.5);
  expect(call.connection_id).toBeNull();
  expect(call.state).toBe("active");
  expect(usages.get(turn.id + "response").usage_source).toBe("reported");
});
test("only an owned matching session can end a call", async () => {
  fixtureTurn();
  await expect(
    ledger.endRealtimeCall("synthetic-b", "session-a", callId),
  ).rejects.toMatchObject({ status: 404 });
  expect(call.state).toBe("active");
  await ledger.endRealtimeCall("synthetic-a", "session-a", callId);
  expect(call.state).toBe("ended");
});
test.each(["model", "title", "archive"])(
  "a text %s mutation is blocked while the user's call lease is active",
  async (kind) => {
    liveCalls = [{ user_id: "synthetic-a", chat_id: chatId }];
    await expect(
      kind === "archive"
        ? deleteChat(chatId, "synthetic-a")
        : updateChat(
            chatId,
            "synthetic-a",
            kind === "model" ? { model: "gpt-4o-mini" } : { title: "new" },
          ),
    ).rejects.toMatchObject({ code: "REALTIME_BUSY" });
    expect(
      query.mock.calls.some(([sql]) => sql.startsWith("UPDATE family_chat")),
    ).toBe(false);
  },
);
test("v8 is additive and validates every realtime column through SELECT-only readiness", async () => {
  expect(upgrades.FAMILY_APPLICATION_SCHEMA_VERSION).toBe(8);
  expect(upgrades.FAMILY_APPLICATION_UPGRADE_SQL).not.toMatch(
    /\b(?:DROP|DELETE|TRUNCATE)\b|ALTER TABLE "?(?:user|session|account)"?\b/i,
  );
  poolQuery
    .mockResolvedValueOnce(
      result([{ version_table_exists: true, columns_ready: false }]),
    )
    .mockResolvedValueOnce(result([{ version: 8 }]));
  await expect(
    upgrades.requireFamilyApplicationUpgrade(),
  ).rejects.toMatchObject({ code: "APPLICATION_UPGRADE_REQUIRED" });
  const sql = poolQuery.mock.calls[0][0];
  expect(sql).toContain("count(*) = 123");
  expect(sql).toContain(
    "('family_chat','pinned_at','timestamp with time zone','YES')",
  );
  expect(sql).toContain("('family_realtime_call','session_id','text','NO')");
  expect(sql).toContain(
    "('family_realtime_turn','heard_complete','boolean','NO')",
  );
  expect(sql).toContain(
    "('family_realtime_usage','actual_model','text','YES')",
  );
  expect(
    poolQuery.mock.calls.every(([sql]) => /^SELECT/.test(sql.trim())),
  ).toBe(true);
  expect(transaction).not.toHaveBeenCalled();
});
test("account aggregation isolates text, old voice and realtime sums before joining owners", async () => {
  poolQuery.mockResolvedValueOnce(
    result([
      {
        id: "synthetic-a",
        name: "Fixture",
        email: "fixture@example.invalid",
        status: "approved",
        role: "member",
        created_at: new Date(),
        last_seen_at: null,
        active_seconds: 0,
        input_tokens: 18,
        output_tokens: 25,
        unknown_requests: 1,
        voice_requests: 1,
        voice_input_tokens: 3,
        voice_output_tokens: 2,
        voice_unknown_requests: 0,
        voice_audio_seconds: 4,
        realtime_requests: 2,
        realtime_input_tokens: 10,
        realtime_output_tokens: 20,
        realtime_unknown_requests: 1,
        realtime_audio_seconds: 5,
      },
    ]),
  );
  const users = await listUsers();
  expect(users[0]).toMatchObject({
    inputTokens: 18,
    outputTokens: 25,
    realtimeInputTokens: 10,
    realtimeUnknownUsageRequests: 1,
    realtimeAudioSeconds: 5,
  });
  const sql = poolQuery.mock.calls[0][0];
  expect(sql).toContain("family_generation WHERE kind='text' GROUP BY user_id");
  expect(sql).toContain("family_realtime_usage GROUP BY user_id");
  expect(sql).toContain("family_realtime_call GROUP BY user_id");
});

test("an owned call preserves its text model and returns only the fixed realtime configuration", async () => {
  const created = await ledger.createRealtimeCall("synthetic-a", "session-a", {
    requestId,
    chatId,
    voice: "marin",
    vad: "natural",
  });
  expect(created.chat.id).toBe(chatId);
  expect(created.chat.model).toBe("gpt-4o-mini");
  expect(created).toMatchObject({
    model: "gpt-realtime-2.1-mini",
    voice: "marin",
    vad: "natural",
    maxCallSeconds: 1800,
  });
  expect(created.wsPath).toBe("/api/family/realtime?callId=" + created.callId);
  expect(JSON.stringify(created)).not.toContain("session-a");
  expect(
    query.mock.calls.filter(([sql]) =>
      sql.startsWith("INSERT INTO family_realtime_call"),
    ),
  ).toHaveLength(1);
});
test("reconnect restores at most twelve complete text groups and carries the remaining call turn budget", async () => {
  call.connection_id = null;
  call.turn_count = 99;
  historyRows = [
    {
      generation_id: "orphan",
      role: "assistant",
      content: "orphan must not rehydrate",
    },
  ];
  for (let index = 0; index < 13; index++)
    historyRows.push(
      {
        generation_id: "pair-" + index,
        role: "assistant",
        content: "answer-" + index,
      },
      {
        generation_id: "pair-" + index,
        role: "user",
        content: "question-" + index,
      },
    );
  const restored = await ledger.claimRealtimeCall(
    "synthetic-a",
    "session-a",
    callId,
  );
  expect(restored.remainingTurns).toBe(1);
  expect(restored.history).toHaveLength(24);
  expect(restored.history[0]).toEqual({ role: "user", content: "question-11" });
  expect(
    restored.history.some(
      (entry) =>
        entry.content.includes("orphan") || entry.content.endsWith("-12"),
    ),
  ).toBe(false);
  const read = query.mock.calls.find(([sql]) =>
    sql.startsWith("SELECT m.generation_id,m.role,m.content"),
  )!;
  expect(read[0]).toContain("t.heard_complete AND NOT t.interrupted");
  expect(read[1]).toEqual([chatId, "synthetic-a"]);
});
test("an abrupt release seals partial output without inventing tokens, and cannot reopen an explicitly ended call", async () => {
  const turn = fixtureTurn();
  messages.get(turn.assistant_message_id).content = "partial received text";
  await ledger.endRealtimeCall("synthetic-a", "session-a", callId);
  await ledger.releaseRealtimeConnection(context(), {
    resume: true,
    reason: "socket_closed",
    inputAudioSeconds: 1,
  });
  expect(call.state).toBe("ended");
  expect(generations.get(turn.generation_id).state).toBe("partial");
  expect(messages.get(turn.assistant_message_id)).toMatchObject({
    content: "partial received text",
    status: "partial",
  });
  expect(usages.get(turn.id + "response")).toMatchObject({
    usage_source: "unknown",
    input_tokens: null,
    output_tokens: null,
  });
});
