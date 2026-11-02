import "server-only";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { transaction } from "./db";
import { digest, FamilyApiError } from "./errors";
import { modelCatalog } from "./models";
import type { FamilyChat, FamilyUsage } from "../types";
import {
  REALTIME_MODEL,
  REALTIME_TRANSCRIBE_MODEL,
  REALTIME_VOICES,
  REALTIME_MAX_CALL_SECONDS,
  type RealtimeCallCreated,
  type RealtimeVoice,
  type RealtimeVad,
} from "../realtime-types";

export interface RealtimeContext {
  callId: string;
  userId: string;
  sessionId: string;
  chatId: string;
  connectionId: string;
  model: string;
  voice: RealtimeVoice;
  vad: RealtimeVad;
  remainingSeconds: number;
  remainingTurns: number;
  history: { role: "user" | "assistant"; content: string }[];
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const providerId = /^[a-zA-Z0-9_-]{1,200}$/;
const unavailable = () =>
  new FamilyApiError(
    403,
    "实时通话已结束或当前会话不可用。",
    "REALTIME_UNAVAILABLE",
  );
const invalid = () =>
  new FamilyApiError(400, "实时通话参数无效。", "INVALID_REALTIME_PARAMETERS");
function id(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) throw invalid();
  return value;
}
function eventId(value: unknown): string {
  if (typeof value !== "string" || !providerId.test(value)) throw invalid();
  return value;
}
function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0"))
    throw invalid();
  return value;
}
function actualModel(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,120}$/.test(value)
    ? value
    : null;
}
function usageValue(value: FamilyUsage): FamilyUsage {
  if (
    value?.source === "reported" &&
    [value.inputTokens, value.outputTokens].every(
      (n) => Number.isSafeInteger(n) && n !== null && n >= 0,
    )
  )
    return value;
  return { source: "unknown", inputTokens: null, outputTokens: null };
}
function seconds(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= REALTIME_MAX_CALL_SECONDS
    ? value
    : null;
}
function chatJson(row: Record<string, any>): FamilyChat {
  return {
    id: row.id,
    title: row.title,
    model: row.model || modelCatalog().defaultModel,
    archived: !!row.deleted_at,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** All text and realtime mutations take this user lock before the shared chat lock. */
export async function lockRealtimeChat(
  client: PoolClient,
  userId: string,
  chatId: string,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    "family-generation:" + userId,
  ]);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    "family-chat:" + chatId,
  ]);
}
export async function assertNoRealtimeCall(
  client: PoolClient,
  userId: string,
  chatId: string,
): Promise<void> {
  const live = await client.query(
    "SELECT 1 FROM family_realtime_call WHERE state='active' AND expires_at>now() AND lease_expires_at>now() AND (user_id=$1 OR chat_id=$2) LIMIT 1",
    [userId, chatId],
  );
  if (live.rowCount)
    throw new FamilyApiError(
      409,
      "请先结束实时通话，再修改或发送文字。",
      "REALTIME_BUSY",
    );
}
async function assertSession(
  client: PoolClient,
  userId: string,
  sessionId: string,
): Promise<void> {
  // Account disable takes the user lock before deleting sessions. Follow that
  // order, rather than relying on a JOIN plan's row-lock order.
  const account = await client.query(
    "SELECT id FROM \"user\" WHERE id=$1 AND status='approved' FOR SHARE",
    [userId],
  );
  if (!account.rowCount) throw unavailable();
  const auth = await client.query(
    'SELECT s.id FROM "session" s JOIN "user" u ON u.id=s."userId" WHERE s.id=$1 AND s."userId"=$2 AND s."expiresAt">now() AND u.status=\'approved\' FOR SHARE OF s,u',
    [sessionId, userId],
  );
  if (!auth.rowCount) throw unavailable();
}
async function ownedCall(
  client: PoolClient,
  context: RealtimeContext,
  live: boolean,
): Promise<Record<string, any>> {
  const row = (
    await client.query(
      "SELECT c.* FROM family_realtime_call c WHERE c.id=$1 AND c.user_id=$2 AND c.session_id=$3 AND c.chat_id=$4" +
        (live
          ? " AND c.state='active' AND c.connection_id=$5 AND c.expires_at>now() AND c.lease_expires_at>now()"
          : "") +
        " FOR UPDATE OF c",
      live
        ? [
            context.callId,
            context.userId,
            context.sessionId,
            context.chatId,
            context.connectionId,
          ]
        : [context.callId, context.userId, context.sessionId, context.chatId],
    )
  ).rows[0];
  if (!row) throw unavailable();
  return row;
}
async function liveCall(
  client: PoolClient,
  context: RealtimeContext,
): Promise<Record<string, any>> {
  const call = await ownedCall(client, context, true);
  await assertSession(client, context.userId, context.sessionId);
  const chat = await client.query(
    "SELECT id FROM family_chat WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR SHARE",
    [context.chatId, context.userId],
  );
  if (!chat.rowCount) throw unavailable();
  return call;
}
async function sealPending(
  client: PoolClient,
  callId: string,
  connectionId?: string,
): Promise<void> {
  const values = connectionId ? [callId, connectionId] : [callId];
  const scope =
    "t.call_id=$1" + (connectionId ? " AND t.connection_id=$2" : "");
  await client.query(
    "UPDATE family_generation g SET state='partial',finished_at=COALESCE(g.finished_at,now()) FROM family_realtime_turn t WHERE g.id=t.generation_id AND " +
      scope +
      " AND g.state='running'",
    values,
  );
  await client.query(
    "UPDATE family_message m SET status='partial' FROM family_realtime_turn t WHERE m.id=t.assistant_message_id AND " +
      scope +
      " AND m.status='streaming'",
    values,
  );
  await client.query(
    "UPDATE family_realtime_turn t SET state='partial',interrupted=true WHERE " +
      scope +
      " AND t.state='running'",
    values,
  );
  await client.query(
    "UPDATE family_realtime_usage v SET state='error',finished_at=COALESCE(v.finished_at,now()) FROM family_realtime_turn t WHERE v.turn_id=t.id AND " +
      scope +
      " AND v.state='running'",
    values,
  );
}
async function reap(client: PoolClient): Promise<void> {
  const expired = await client.query(
    "UPDATE family_realtime_call SET state='ended',ended_at=now(),end_reason='expired',connection_id=NULL WHERE state='active' AND (expires_at<=now() OR lease_expires_at<=now()) RETURNING id",
  );
  for (const row of expired.rows) await sealPending(client, row.id);
}
function created(
  call: Record<string, any>,
  chat: Record<string, any>,
): RealtimeCallCreated {
  return {
    callId: call.id,
    chat: chatJson(chat),
    model: call.model,
    voice: call.voice,
    vad: call.vad,
    maxCallSeconds: REALTIME_MAX_CALL_SECONDS,
    wsPath: "/api/family/realtime?callId=" + call.id,
  };
}
export async function createRealtimeCall(
  userId: string,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<RealtimeCallCreated> {
  if (
    Object.keys(body).some(
      (key) => !["requestId", "chatId", "voice", "vad"].includes(key),
    )
  )
    throw invalid();
  const requestId = id(body.requestId),
    requestedChat = body.chatId == null ? null : id(body.chatId);
  const voice = body.voice;
  if (
    !REALTIME_VOICES.includes(voice as RealtimeVoice) ||
    !["natural", "fast"].includes(body.vad as string)
  )
    throw invalid();
  const hash = digest(JSON.stringify([requestedChat, voice, body.vad]));
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(714209835)");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "family-generation:" + userId,
    ]);
    await assertSession(client, userId, sessionId);
    await reap(client);
    const existing = (
      await client.query(
        "SELECT * FROM family_realtime_call WHERE user_id=$1 AND request_id=$2 FOR UPDATE",
        [userId, requestId],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.session_id !== sessionId ||
        existing.request_hash !== hash ||
        existing.state !== "active"
      )
        throw new FamilyApiError(
          409,
          "此通话请求已使用，请重新开始。",
          "REALTIME_REQUEST_CONFLICT",
        );
      const chat = (
        await client.query(
          "SELECT * FROM family_chat WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
          [existing.chat_id, userId],
        )
      ).rows[0];
      if (!chat) throw unavailable();
      return created(existing, chat);
    }
    const active = await client.query(
      "SELECT user_id,chat_id FROM family_realtime_call WHERE state='active' AND expires_at>now() AND lease_expires_at>now()",
    );
    if (
      active.rowCount! >= 4 ||
      active.rows.some(
        (row) => row.user_id === userId || row.chat_id === requestedChat,
      )
    )
      throw new FamilyApiError(
        429,
        "当前已有实时通话，请稍后再试。",
        "REALTIME_BUSY",
      );
    const chatId = requestedChat ?? randomUUID();
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      "family-chat:" + chatId,
    ]);
    let chat: Record<string, any>;
    if (requestedChat) {
      chat = (
        await client.query(
          "SELECT * FROM family_chat WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE",
          [chatId, userId],
        )
      ).rows[0];
      if (!chat)
        throw new FamilyApiError(404, "对话不存在。", "CHAT_NOT_FOUND");
    } else {
      chat = (
        await client.query(
          "INSERT INTO family_chat(id,user_id,title,model) VALUES($1,$2,$3,$4) RETURNING *",
          [chatId, userId, "实时语音聊天", modelCatalog().defaultModel],
        )
      ).rows[0];
    }
    if (
      (
        await client.query(
          "SELECT 1 FROM family_generation WHERE chat_id=$1 AND state='running' LIMIT 1",
          [chatId],
        )
      ).rowCount
    )
      throw new FamilyApiError(409, "请等待当前回复结束。", "GENERATION_BUSY");
    const call = (
      await client.query(
        "INSERT INTO family_realtime_call(id,user_id,session_id,chat_id,request_id,request_hash,model,voice,vad,expires_at,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1800 seconds',now()+interval '30 seconds') RETURNING *",
        [
          randomUUID(),
          userId,
          sessionId,
          chatId,
          requestId,
          hash,
          REALTIME_MODEL,
          voice,
          body.vad,
        ],
      )
    ).rows[0];
    return created(call, chat);
  });
}
async function history(
  client: PoolClient,
  chatId: string,
  userId: string,
): Promise<RealtimeContext["history"]> {
  const rows = (
    await client.query(
      "SELECT m.generation_id,m.role,m.content FROM family_message m JOIN family_generation g ON g.id=m.generation_id LEFT JOIN family_realtime_turn t ON t.generation_id=g.id WHERE m.chat_id=$1 AND g.user_id=$2 AND g.superseded_at IS NULL AND m.status='complete' AND (m.role='user' OR (g.state='complete' AND (g.kind='text' OR (t.heard_complete AND NOT t.interrupted)))) ORDER BY m.position DESC LIMIT 48",
      [chatId, userId],
    )
  ).rows;
  const groups = new Map<string, RealtimeContext["history"]>();
  for (const row of rows) {
    if (!row.content) continue;
    if (row.role !== "user" && row.role !== "assistant") continue;
    const group = groups.get(row.generation_id) ?? [];
    group.push({ role: row.role, content: row.content });
    groups.set(row.generation_id, group);
  }
  const chosen: RealtimeContext["history"][] = [];
  let length = 0;
  for (const group of groups.values()) {
    // Never restore an orphan assistant or cut a generation in half.
    if (!group.some((entry) => entry.role === "user")) continue;
    const size = group.reduce(
      (total, entry) => total + entry.content.length,
      0,
    );
    if (chosen.length >= 12 || length + size > 20000) break;
    length += size;
    chosen.push(group.reverse());
  }
  return chosen.reverse().flat();
}
export async function claimRealtimeCall(
  userId: string,
  sessionId: string,
  callId: string,
): Promise<RealtimeContext> {
  id(callId);
  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(714209835)");
    await reap(client);
    await assertSession(client, userId, sessionId);
    const call = (
      await client.query(
        "SELECT * FROM family_realtime_call WHERE id=$1 AND user_id=$2 AND session_id=$3 AND state='active' AND expires_at>now() AND lease_expires_at>now() FOR UPDATE",
        [callId, userId, sessionId],
      )
    ).rows[0];
    if (!call) throw unavailable();
    if (call.connection_id)
      throw new FamilyApiError(
        409,
        "此通话已连接。",
        "REALTIME_ALREADY_CONNECTED",
      );
    const chat = await client.query(
      "SELECT id FROM family_chat WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR SHARE",
      [call.chat_id, userId],
    );
    if (!chat.rowCount) throw unavailable();
    const connectionId = randomUUID();
    await client.query(
      "UPDATE family_realtime_call SET connection_id=$1,lease_expires_at=LEAST(expires_at,now()+interval '20 seconds') WHERE id=$2",
      [connectionId, callId],
    );
    const remainingSeconds = Math.max(
      0,
      Math.floor((new Date(call.expires_at).getTime() - Date.now()) / 1000),
    );
    return {
      callId,
      userId,
      sessionId,
      chatId: call.chat_id,
      connectionId,
      model: call.model,
      voice: call.voice,
      vad: call.vad,
      remainingSeconds,
      remainingTurns: Math.max(0, 100 - call.turn_count),
      history: await history(client, call.chat_id, userId),
    };
  });
}
export async function assertRealtimeLease(
  context: RealtimeContext,
): Promise<void> {
  await transaction(async (client) => {
    await liveCall(client, context);
    await client.query(
      "UPDATE family_realtime_call SET lease_expires_at=LEAST(expires_at,now()+interval '20 seconds') WHERE id=$1 AND connection_id=$2",
      [context.callId, context.connectionId],
    );
  });
}
export async function beginRealtimeTurn(
  context: RealtimeContext,
  inputItemId: string,
): Promise<void> {
  eventId(inputItemId);
  await transaction(async (client) => {
    await lockRealtimeChat(client, context.userId, context.chatId);
    const call = await liveCall(client, context);
    const existing = (
      await client.query(
        "SELECT id,connection_id FROM family_realtime_turn WHERE call_id=$1 AND input_item_id=$2",
        [context.callId, inputItemId],
      )
    ).rows[0];
    if (existing) {
      if (existing.connection_id !== context.connectionId) throw unavailable();
      return;
    }
    if (call.turn_count >= 100)
      throw new FamilyApiError(
        429,
        "本次通话已达到轮数上限。",
        "REALTIME_TURN_LIMIT",
      );
    await sealPending(client, context.callId);
    const generationId = randomUUID(),
      userMessageId = randomUUID(),
      assistantMessageId = randomUUID(),
      turnId = randomUUID();
    const requestId = "realtime:" + context.callId + ":" + inputItemId;
    await client.query(
      "INSERT INTO family_generation(id,user_id,chat_id,request_id,request_hash,model,kind,state) VALUES($1,$2,$3,$4,$5,$6,'realtime','running')",
      [
        generationId,
        context.userId,
        context.chatId,
        requestId,
        digest(requestId),
        call.model,
      ],
    );
    await client.query(
      "INSERT INTO family_message(id,chat_id,generation_id,role,content,status) VALUES($1,$2,$3,'user','','complete'),($4,$2,$3,'assistant','','streaming')",
      [userMessageId, context.chatId, generationId, assistantMessageId],
    );
    await client.query(
      "INSERT INTO family_realtime_turn(id,call_id,connection_id,input_item_id,generation_id,user_message_id,assistant_message_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        turnId,
        context.callId,
        context.connectionId,
        inputItemId,
        generationId,
        userMessageId,
        assistantMessageId,
      ],
    );
    for (const kind of ["response", "transcribe"] as const)
      await client.query(
        "INSERT INTO family_realtime_usage(id,call_id,turn_id,user_id,kind,requested_model) VALUES($1,$2,$3,$4,$5,$6)",
        [
          randomUUID(),
          context.callId,
          turnId,
          context.userId,
          kind,
          kind === "response" ? call.model : REALTIME_TRANSCRIBE_MODEL,
        ],
      );
    await client.query(
      "UPDATE family_realtime_call SET turn_count=turn_count+1 WHERE id=$1",
      [context.callId],
    );
    await client.query(
      "UPDATE family_chat SET updated_at=now() WHERE id=$1 AND user_id=$2",
      [context.chatId, context.userId],
    );
  });
}
async function ownedTurn(
  client: PoolClient,
  context: RealtimeContext,
  inputItemId: string,
): Promise<Record<string, any>> {
  const turn = (
    await client.query(
      "SELECT t.*,c.user_id,c.session_id,c.chat_id FROM family_realtime_turn t JOIN family_realtime_call c ON c.id=t.call_id WHERE t.call_id=$1 AND t.connection_id=$2 AND t.input_item_id=$3 AND c.user_id=$4 AND c.session_id=$5 AND c.chat_id=$6 FOR UPDATE OF t",
      [
        context.callId,
        context.connectionId,
        inputItemId,
        context.userId,
        context.sessionId,
        context.chatId,
      ],
    )
  ).rows[0];
  if (!turn) throw unavailable();
  return turn;
}
async function saveUsage(
  client: PoolClient,
  context: RealtimeContext,
  turnId: string,
  kind: "response" | "transcribe",
  provider: string,
  value: FamilyUsage,
  model: string | null,
  reportedAudioSeconds: number | null,
  state: "complete" | "error" | "partial",
): Promise<void> {
  const usage = usageValue(value);
  const current = (
    await client.query(
      "SELECT provider_id,usage_source FROM family_realtime_usage WHERE turn_id=$1 AND kind=$2 FOR UPDATE",
      [turnId, kind],
    )
  ).rows[0];
  if (!current || (current.provider_id && current.provider_id !== provider))
    throw new FamilyApiError(
      409,
      "实时用量事件不匹配。",
      "REALTIME_EVENT_CONFLICT",
    );
  await client.query(
    "UPDATE family_realtime_usage SET provider_id=COALESCE(provider_id,$1),state=CASE WHEN provider_id IS NULL THEN $2 ELSE state END,actual_model=COALESCE(actual_model,$3),input_tokens=CASE WHEN usage_source='reported' THEN input_tokens ELSE $4 END,output_tokens=CASE WHEN usage_source='reported' THEN output_tokens ELSE $5 END,usage_source=CASE WHEN usage_source='reported' THEN usage_source ELSE $6 END,reported_audio_seconds=COALESCE(reported_audio_seconds,$7),finished_at=COALESCE(finished_at,now()) WHERE turn_id=$8 AND kind=$9 AND call_id=$10 AND user_id=$11",
    [
      provider,
      state,
      actualModel(model),
      usage.inputTokens,
      usage.outputTokens,
      usage.source,
      seconds(reportedAudioSeconds),
      turnId,
      kind,
      context.callId,
      context.userId,
    ],
  );
}
export async function recordRealtimeTranscript(
  context: RealtimeContext,
  inputItemId: string,
  transcript: string,
  usage: FamilyUsage,
  reportedAudioSeconds: number | null,
  model: string | null,
): Promise<void> {
  eventId(inputItemId);
  boundedText(transcript, 12000);
  await transaction(async (client) => {
    await ownedCall(client, context, false);
    const turn = await ownedTurn(client, context, inputItemId);
    await saveUsage(
      client,
      context,
      turn.id,
      "transcribe",
      inputItemId,
      usage,
      model,
      reportedAudioSeconds,
      "complete",
    );
    // First final transcript wins; a duplicated event cannot rewrite history.
    if (!turn.transcript_recorded) {
      await client.query(
        "UPDATE family_message SET content=$1 WHERE id=$2 AND chat_id=$3",
        [transcript, turn.user_message_id, context.chatId],
      );
      await client.query(
        "UPDATE family_realtime_turn SET transcript_recorded=true WHERE id=$1",
        [turn.id],
      );
    }
  });
}
export async function recordRealtimeResponse(
  context: RealtimeContext,
  input: {
    responseId: string;
    inputItemId: string;
    outputItemId?: string;
    text: string;
    status: "completed" | "cancelled" | "failed" | "incomplete";
    usage: FamilyUsage;
    actualModel: string | null;
  },
): Promise<void> {
  eventId(input.responseId);
  eventId(input.inputItemId);
  if (input.outputItemId) eventId(input.outputItemId);
  boundedText(input.text, 24000);
  if (
    !["completed", "cancelled", "failed", "incomplete"].includes(input.status)
  )
    throw invalid();
  await transaction(async (client) => {
    await ownedCall(client, context, false);
    const turn = await ownedTurn(client, context, input.inputItemId);
    if (turn.response_id && turn.response_id !== input.responseId)
      throw new FamilyApiError(
        409,
        "回复事件不匹配。",
        "REALTIME_EVENT_CONFLICT",
      );
    const playback = input.outputItemId
      ? (
          await client.query(
            "SELECT interrupted,heard_complete FROM family_realtime_playback WHERE call_id=$1 AND connection_id=$2 AND output_item_id=$3",
            [context.callId, context.connectionId, input.outputItemId],
          )
        ).rows[0]
      : undefined;
    const interrupted =
      !!turn.interrupted ||
      !!playback?.interrupted ||
      input.status !== "completed";
    const state =
      input.status === "completed" && !interrupted
        ? "complete"
        : input.text
        ? "partial"
        : "error";
    await saveUsage(
      client,
      context,
      turn.id,
      "response",
      input.responseId,
      input.usage,
      input.actualModel,
      null,
      state,
    );
    if (!turn.response_id) {
      await client.query(
        "UPDATE family_realtime_turn SET response_id=$1,output_item_id=$2,state=$3,interrupted=$4,heard_complete=$5 WHERE id=$6",
        [
          input.responseId,
          input.outputItemId ?? null,
          state,
          interrupted,
          !interrupted && !!playback?.heard_complete,
          turn.id,
        ],
      );
      await client.query(
        "UPDATE family_generation SET state=$1,finished_at=COALESCE(finished_at,now()),input_tokens=$2,output_tokens=$3,usage_source=$4,actual_model=$5 WHERE id=$6",
        [
          state,
          usageValue(input.usage).inputTokens,
          usageValue(input.usage).outputTokens,
          usageValue(input.usage).source,
          actualModel(input.actualModel),
          turn.generation_id,
        ],
      );
      await client.query(
        "UPDATE family_message SET content=$1,status=$2 WHERE id=$3 AND chat_id=$4",
        [input.text, state, turn.assistant_message_id, context.chatId],
      );
    } else if (usageValue(input.usage).source === "reported") {
      await client.query(
        "UPDATE family_generation SET input_tokens=CASE WHEN usage_source='reported' THEN input_tokens ELSE $1 END,output_tokens=CASE WHEN usage_source='reported' THEN output_tokens ELSE $2 END,usage_source='reported',actual_model=COALESCE(actual_model,$3) WHERE id=$4",
        [
          input.usage.inputTokens,
          input.usage.outputTokens,
          actualModel(input.actualModel),
          turn.generation_id,
        ],
      );
    }
  });
}
async function playback(
  context: RealtimeContext,
  outputItemId: string,
  playedMs: number,
  complete: boolean,
  interrupted: boolean,
): Promise<void> {
  eventId(outputItemId);
  if (
    !Number.isSafeInteger(playedMs) ||
    playedMs < 0 ||
    playedMs > REALTIME_MAX_CALL_SECONDS * 1000
  )
    throw invalid();
  await transaction(async (client) => {
    await ownedCall(client, context, false);
    const prior = (
      await client.query(
        "SELECT id FROM family_realtime_turn WHERE call_id=$1 AND connection_id=$2 LIMIT 1",
        [context.callId, context.connectionId],
      )
    ).rows[0];
    if (!prior) throw unavailable();
    await client.query(
      "INSERT INTO family_realtime_playback(call_id,connection_id,output_item_id,played_ms,heard_complete,interrupted) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(call_id,connection_id,output_item_id) DO UPDATE SET played_ms=GREATEST(family_realtime_playback.played_ms,EXCLUDED.played_ms),interrupted=family_realtime_playback.interrupted OR EXCLUDED.interrupted,heard_complete=(family_realtime_playback.heard_complete OR EXCLUDED.heard_complete) AND NOT (family_realtime_playback.interrupted OR EXCLUDED.interrupted)",
      [
        context.callId,
        context.connectionId,
        outputItemId,
        playedMs,
        complete && !interrupted,
        interrupted,
      ],
    );
    await client.query(
      "UPDATE family_realtime_turn SET interrupted=interrupted OR $1,heard_complete=(heard_complete OR $2) AND NOT(interrupted OR $1) WHERE call_id=$3 AND connection_id=$4 AND output_item_id=$5",
      [
        interrupted,
        complete && !interrupted,
        context.callId,
        context.connectionId,
        outputItemId,
      ],
    );
  });
}
export async function markRealtimeInterrupted(
  context: RealtimeContext,
  outputItemId: string,
  playedMs: number,
): Promise<void> {
  await playback(context, outputItemId, playedMs, false, true);
}
export async function markRealtimePlayed(
  context: RealtimeContext,
  outputItemId: string,
  playedMs: number,
  complete: boolean,
): Promise<void> {
  await playback(context, outputItemId, playedMs, complete, false);
}
export async function releaseRealtimeConnection(
  context: RealtimeContext,
  input: { resume: boolean; reason: string; inputAudioSeconds: number },
): Promise<void> {
  const duration = seconds(input.inputAudioSeconds);
  if (duration === null || typeof input.reason !== "string") throw invalid();
  const reason = /^[a-zA-Z0-9_-]{1,64}$/.test(input.reason)
    ? input.reason
    : "closed";
  await transaction(async (client) => {
    const call = await ownedCall(client, context, false);
    if (call.connection_id !== context.connectionId) return;
    await sealPending(client, context.callId, context.connectionId);
    await client.query(
      "UPDATE family_realtime_call SET connection_id=NULL,input_audio_seconds=COALESCE(input_audio_seconds,0)+$1,lease_expires_at=LEAST(expires_at,now()+interval '30 seconds'),state=CASE WHEN $2 AND expires_at>now() AND turn_count<100 THEN 'active' ELSE 'ended' END,ended_at=CASE WHEN $2 AND expires_at>now() AND turn_count<100 THEN NULL ELSE COALESCE(ended_at,now()) END,end_reason=$3 WHERE id=$4 AND connection_id=$5",
      [
        duration,
        input.resume && call.state === "active",
        reason,
        context.callId,
        context.connectionId,
      ],
    );
  });
}
export async function endRealtimeCall(
  userId: string,
  sessionId: string,
  callId: string,
): Promise<void> {
  id(callId);
  await transaction(async (client) => {
    const call = (
      await client.query(
        "SELECT id FROM family_realtime_call WHERE id=$1 AND user_id=$2 AND session_id=$3 FOR UPDATE",
        [callId, userId, sessionId],
      )
    ).rows[0];
    if (!call)
      throw new FamilyApiError(404, "通话不存在。", "REALTIME_NOT_FOUND");
    await client.query(
      "UPDATE family_realtime_call SET state='ended',ended_at=COALESCE(ended_at,now()),lease_expires_at=now(),end_reason='user-ended' WHERE id=$1",
      [callId],
    );
    await sealPending(client, callId);
  });
}
