import "server-only";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import type { PoolClient } from "pg";
import { getPool, transaction } from "./db";
import { FamilyApiError, digest, text } from "./errors";
import { PRIVATE_API_HEADERS } from "../enabled";
import { OpenAIStreamDecoder } from "./openai-stream";
import { allowedModel, completionBody, modelCatalog } from "./models";
import type {
  FamilyChat,
  FamilyChatDetail,
  FamilyMessage,
  FamilyStreamEvent,
  FamilyUsage,
  FamilyModel,
} from "../types";

export function validId(value: string) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new FamilyApiError(404, "对话不存在。");
  return value;
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
function usageJson(row: Record<string, any>): FamilyUsage {
  return {
    source: row.usage_source === "reported" ? "reported" : "unknown",
    inputTokens:
      row.input_tokens === null || row.input_tokens === undefined
        ? null
        : Number(row.input_tokens),
    outputTokens:
      row.output_tokens === null || row.output_tokens === undefined
        ? null
        : Number(row.output_tokens),
  };
}
function messageJson(row: Record<string, any>): FamilyMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    requestedModel: row.requested_model ?? null,
    model: row.actual_model ?? null,
    superseded: !!row.superseded_at,
    ...(row.role === "assistant" ? { usage: usageJson(row) } : {}),
  };
}
export async function listChats(userId: string, includeArchived = false) {
  return (
    await getPool().query(
      "SELECT * FROM family_chat WHERE user_id=$1" +
        (includeArchived ? "" : " AND deleted_at IS NULL") +
        " ORDER BY updated_at DESC LIMIT 200",
      [userId],
    )
  ).rows.map(chatJson);
}
export async function newChat(userId: string, body: Record<string, unknown>) {
  const title =
    body.title === undefined ? "新对话" : text(body.title, 80, "标题");
  if (Object.keys(body).some((key) => !["title", "model"].includes(key)))
    throw new FamilyApiError(400, "新对话参数无效。");
  const model = allowedModel(
    body.model === undefined ? modelCatalog().defaultModel : body.model,
  );
  const result = await getPool().query(
    "INSERT INTO family_chat(id,user_id,title,model) VALUES($1,$2,$3,$4) RETURNING *",
    [randomUUID(), userId, title, model.id],
  );
  return chatJson(result.rows[0]);
}
export async function updateChat(
  chatId: string,
  userId: string,
  body: Record<string, unknown>,
) {
  validId(chatId);
  if (
    !Object.keys(body).length ||
    Object.keys(body).some((key) => !["title", "model"].includes(key))
  )
    throw new FamilyApiError(400, "请提供对话名称或列表中的模型。");
  return transaction(async (client) => {
    const owner = await client.query(
      "SELECT * FROM family_chat WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE",
      [chatId, userId],
    );
    if (!owner.rowCount) throw new FamilyApiError(404, "对话不存在。");
    const title =
      body.title === undefined
        ? owner.rows[0].title
        : text(body.title, 80, "标题");
    const model =
      body.model === undefined
        ? owner.rows[0].model
        : allowedModel(body.model).id;
    if (
      (
        await client.query(
          "SELECT 1 FROM family_generation WHERE chat_id=$1 AND state='running' AND started_at>now()-interval '90 seconds'",
          [chatId],
        )
      ).rowCount
    )
      throw new FamilyApiError(
        409,
        "请等待当前回复结束后再修改对话。",
        "GENERATION_BUSY",
      );
    const result = await client.query(
      "UPDATE family_chat SET title=$1,model=$2,updated_at=now() WHERE id=$3 AND user_id=$4 AND deleted_at IS NULL RETURNING *",
      [title, model, chatId, userId],
    );
    return chatJson(result.rows[0]);
  });
}
export async function chatDetail(
  chatId: string,
  userId?: string,
  includeArchived = false,
): Promise<FamilyChatDetail> {
  validId(chatId);
  const result = await getPool().query(
    "SELECT * FROM family_chat WHERE id=$1" +
      (!userId && includeArchived ? "" : " AND deleted_at IS NULL") +
      (userId ? " AND user_id=$2" : ""),
    userId ? [chatId, userId] : [chatId],
  );
  if (!result.rows[0]) throw new FamilyApiError(404, "对话不存在。");
  const messages = await getPool().query(
    "SELECT m.*,g.model AS requested_model,g.actual_model,g.superseded_at,g.input_tokens,g.output_tokens,g.usage_source FROM family_message m JOIN family_generation g ON g.id=m.generation_id WHERE m.chat_id=$1" +
      (!userId && includeArchived ? "" : " AND g.superseded_at IS NULL") +
      " ORDER BY m.position LIMIT 400",
    [chatId],
  );
  return {
    chat: chatJson(result.rows[0]),
    messages: messages.rows.map(messageJson),
  };
}
export async function deleteChat(chatId: string, userId: string) {
  validId(chatId);
  await transaction(async (client) => {
    const row = await client.query(
      "SELECT id FROM family_chat WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE",
      [chatId, userId],
    );
    if (!row.rowCount) throw new FamilyApiError(404, "对话不存在。");
    if (
      (
        await client.query(
          "SELECT 1 FROM family_generation WHERE chat_id=$1 AND state='running' AND started_at>now()-interval '90 seconds'",
          [chatId],
        )
      ).rowCount
    )
      throw new FamilyApiError(409, "请等待当前回复结束后再删除。");
    // Archive from the member view. Administrators retain explicit audited access.
    await client.query(
      "UPDATE family_chat SET deleted_at=now(),updated_at=now() WHERE id=$1",
      [chatId],
    );
  });
  return { ok: true };
}
interface GenerationStart {
  id: string;
  assistantId: string;
  userMessage: FamilyMessage;
  assistantMessage: FamilyMessage;
  history: { role: "user" | "assistant"; content: string }[];
  replay?: boolean;
  usage?: FamilyUsage;
  model: FamilyModel;
  replacedMessageIds?: string[];
}
type GenerationMode = "send" | "edit" | "retry" | "regenerate";
interface GenerationIntent {
  mode: GenerationMode;
  content: string | null;
  sourceMessageId: string | null;
  requestedModel?: string;
}
function generationIntent(body: Record<string, unknown>): GenerationIntent {
  const mode = body.mode === undefined ? "send" : body.mode;
  if (
    typeof mode !== "string" ||
    !["send", "edit", "retry", "regenerate"].includes(mode)
  )
    throw new FamilyApiError(400, "消息操作无效。", "INVALID_MESSAGE_MODE");
  if (
    body.model !== undefined &&
    (typeof body.model !== "string" || !body.model || body.model.length > 100)
  )
    throw new FamilyApiError(400, "请选择列表中的模型。", "MODEL_NOT_ALLOWED");
  if (
    Object.keys(body).some(
      (key) =>
        !["content", "requestId", "model", "mode", "sourceMessageId"].includes(
          key,
        ),
    )
  )
    throw new FamilyApiError(
      400,
      "消息参数无效。",
      "INVALID_MESSAGE_PARAMETERS",
    );
  if (mode === "send" && body.sourceMessageId !== undefined)
    throw new FamilyApiError(
      400,
      "新消息不能指定来源。",
      "INVALID_MESSAGE_SOURCE",
    );
  let sourceMessageId: string | null = null;
  if (mode !== "send")
    sourceMessageId = validId(text(body.sourceMessageId, 100, "原消息编号"));
  if ((mode === "retry" || mode === "regenerate") && body.content !== undefined)
    throw new FamilyApiError(
      400,
      "此操作由服务器读取原问题。",
      "INVALID_MESSAGE_PARAMETERS",
    );
  return {
    mode: mode as GenerationMode,
    content:
      mode === "send" || mode === "edit"
        ? text(body.content, 12_000, "消息")
        : null,
    sourceMessageId,
    requestedModel: body.model as string | undefined,
  };
}
function intentHash(chatId: string, intent: GenerationIntent, model: string) {
  return digest(
    JSON.stringify({
      chatId,
      content: intent.content,
      model,
      mode: intent.mode,
      sourceMessageId: intent.sourceMessageId,
    }),
  );
}
async function prepare(
  client: PoolClient,
  userId: string,
  chatId: string,
  intent: GenerationIntent,
  requestId: string,
): Promise<GenerationStart> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    "family-generation:" + userId,
  ]);
  const owner = await client.query(
    "SELECT * FROM family_chat WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE",
    [chatId, userId],
  );
  if (!owner.rowCount) throw new FamilyApiError(404, "对话不存在。");
  const existing = (
    await client.query(
      "SELECT * FROM family_generation WHERE user_id=$1 AND request_id=$2",
      [userId, requestId],
    )
  ).rows[0];
  if (existing) {
    const requested = intent.requestedModel ?? existing.model;
    const expected = intentHash(chatId, intent, requested);
    const legacy =
      intent.mode === "send" &&
      !intent.sourceMessageId &&
      requested === existing.model &&
      existing.request_hash ===
        digest(JSON.stringify({ chatId, content: intent.content }));
    if (
      existing.chat_id !== chatId ||
      (existing.request_hash !== expected && !legacy)
    )
      throw new FamilyApiError(
        409,
        "请求编号不能用于不同内容、模型或操作。",
        "REQUEST_CONFLICT",
      );
    if (existing.state !== "complete")
      throw new FamilyApiError(
        409,
        "此请求已在处理中或已经中断，请刷新对话查看。",
        "REQUEST_EXISTS",
      );
    if (existing.superseded_at)
      throw new FamilyApiError(
        409,
        "这条回复已有新版本，请刷新对话查看。",
        "REQUEST_SUPERSEDED",
      );
    const messages = (
      await client.query(
        "SELECT m.*,g.model AS requested_model,g.actual_model,g.superseded_at,g.input_tokens,g.output_tokens,g.usage_source FROM family_message m JOIN family_generation g ON g.id=m.generation_id WHERE generation_id=$1 ORDER BY position",
        [existing.id],
      )
    ).rows;
    const replaced = existing.source_generation_id
      ? (
          await client.query(
            "SELECT id FROM family_message WHERE generation_id=$1 ORDER BY position",
            [existing.source_generation_id],
          )
        ).rows.map((row) => row.id)
      : undefined;
    return {
      id: existing.id,
      assistantId: messages[1].id,
      userMessage: messageJson(messages[0]),
      assistantMessage: messageJson(messages[1]),
      history: [],
      replay: true,
      usage: usageJson(existing),
      model: {
        id: existing.model,
        name: existing.model,
        description: "",
        reasoning: false,
      },
      replacedMessageIds: replaced,
    };
  }
  const model = allowedModel(
    intent.requestedModel ?? owner.rows[0].model ?? modelCatalog().defaultModel,
  );
  const stale = await client.query(
    "UPDATE family_generation SET state='partial',finished_at=now() WHERE user_id=$1 AND state='running' AND started_at<now()-interval '90 seconds' RETURNING id",
    [userId],
  );
  for (const row of stale.rows)
    await client.query(
      "UPDATE family_message SET status='partial' WHERE generation_id=$1 AND role='assistant'",
      [row.id],
    );
  const running = await client.query(
    "SELECT chat_id FROM family_generation WHERE user_id=$1 AND state='running'",
    [userId],
  );
  if (
    running.rowCount! >= 2 ||
    running.rows.some((row) => row.chat_id === chatId)
  )
    throw new FamilyApiError(
      429,
      "当前已有回复正在生成，请稍后再试。",
      "GENERATION_BUSY",
    );
  let content = intent.content!;
  let sourceGeneration: string | null = null;
  let replacedMessageIds: string[] | undefined;
  if (intent.mode !== "send") {
    const source = (
      await client.query(
        "SELECT g.id,g.state,m.role FROM family_generation g JOIN family_message m ON m.generation_id=g.id WHERE g.chat_id=$1 AND g.user_id=$2 AND m.id=$3",
        [chatId, userId, intent.sourceMessageId],
      )
    ).rows[0];
    if (!source)
      throw new FamilyApiError(404, "原消息不存在。", "MESSAGE_NOT_FOUND");
    const last = (
      await client.query(
        "SELECT g.id,g.state,u.id AS user_message_id,u.content AS user_content,a.id AS assistant_message_id FROM family_generation g JOIN family_message u ON u.generation_id=g.id AND u.role='user' JOIN family_message a ON a.generation_id=g.id AND a.role='assistant' WHERE g.chat_id=$1 AND g.superseded_at IS NULL ORDER BY u.position DESC LIMIT 1 FOR UPDATE OF g",
        [chatId],
      )
    ).rows[0];
    if (!last || last.id !== source.id)
      throw new FamilyApiError(
        409,
        "目前仅可编辑、重试或重新生成最后一轮。",
        "LAST_TURN_ONLY",
      );
    if (
      (intent.mode === "edit" && source.role !== "user") ||
      (intent.mode !== "edit" && source.role !== "assistant")
    )
      throw new FamilyApiError(
        400,
        "原消息类型与操作不匹配。",
        "INVALID_MESSAGE_SOURCE",
      );
    if (intent.mode === "regenerate" && source.state !== "complete")
      throw new FamilyApiError(
        409,
        "中断的回复请使用重试。",
        "REGENERATE_REQUIRES_COMPLETE",
      );
    if (intent.mode === "retry" && !["partial", "error"].includes(source.state))
      throw new FamilyApiError(
        409,
        "只有中断或失败的回复可以重试。",
        "RETRY_REQUIRES_FAILURE",
      );
    sourceGeneration = last.id;
    replacedMessageIds = [last.user_message_id, last.assistant_message_id];
    if (intent.mode !== "edit") content = last.user_content;
  }
  const count = await client.query(
    "SELECT count(*)::int AS count FROM family_message WHERE chat_id=$1",
    [chatId],
  );
  if (count.rows[0].count >= 398)
    throw new FamilyApiError(400, "这段对话已较长，请新建对话。");
  const previous = (
    await client.query(
      "SELECT m.role,m.content FROM family_message m JOIN family_generation g ON g.id=m.generation_id WHERE m.chat_id=$1 AND g.state='complete' AND m.status='complete' AND g.superseded_at IS NULL AND ($2::uuid IS NULL OR g.id<>$2) ORDER BY m.position DESC LIMIT 40",
      [chatId, sourceGeneration],
    )
  ).rows;
  let chars = content.length;
  const history: GenerationStart["history"] = [];
  for (const row of previous) {
    if (chars + row.content.length > 48_000) break;
    chars += row.content.length;
    history.unshift({ role: row.role, content: row.content });
  }
  history.push({ role: "user", content });
  const id = randomUUID();
  const userMessageId = randomUUID();
  const assistantId = randomUUID();
  await client.query(
    "INSERT INTO family_generation(id,user_id,chat_id,request_id,request_hash,model,mode,source_generation_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running')",
    [
      id,
      userId,
      chatId,
      requestId,
      intentHash(chatId, intent, model.id),
      model.id,
      intent.mode,
      sourceGeneration,
    ],
  );
  const rows = (
    await client.query(
      "INSERT INTO family_message(id,chat_id,generation_id,role,content,status) VALUES($1,$2,$3,'user',$4,'complete'),($5,$2,$3,'assistant','','streaming') RETURNING *",
      [userMessageId, chatId, id, content, assistantId],
    )
  ).rows;
  if (sourceGeneration)
    await client.query(
      "UPDATE family_generation SET superseded_at=now() WHERE id=$1 AND chat_id=$2 AND user_id=$3",
      [sourceGeneration, chatId, userId],
    );
  await client.query(
    "UPDATE family_chat SET title=CASE WHEN title='新对话' THEN $2 ELSE title END,model=$3,updated_at=now() WHERE id=$1",
    [chatId, content.replace(/\s+/g, " ").slice(0, 40), model.id],
  );
  await client.query(
    "INSERT INTO family_activity(user_id,last_seen_at) VALUES($1,now()) ON CONFLICT(user_id) DO UPDATE SET last_seen_at=now()",
    [userId],
  );
  return {
    id,
    assistantId,
    userMessage: messageJson({ ...rows[0], requested_model: model.id }),
    assistantMessage: messageJson({ ...rows[1], requested_model: model.id }),
    history,
    model,
    replacedMessageIds,
  };
}
export async function generate(
  request: Request,
  userId: string,
  chatId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  validId(chatId);
  const requestId = text(body.requestId, 100, "请求编号", 8);
  if (!/^[a-zA-Z0-9_-]+$/.test(requestId))
    throw new FamilyApiError(400, "请求编号格式无效。");
  const apiKey = process.env.OPENAI_API_KEY;
  if (
    !(
      await getPool().query(
        "SELECT 1 FROM family_chat WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL",
        [chatId, userId],
      )
    ).rowCount
  ) {
    throw new FamilyApiError(404, "对话不存在。");
  }
  const intent = generationIntent(body);
  if (!apiKey)
    throw new FamilyApiError(
      503,
      "管理员尚未配置模型 API，当前不能发送消息。",
      "MODEL_NOT_CONFIGURED",
    );
  const started = await transaction((client) =>
    prepare(client, userId, chatId, intent, requestId),
  );
  const encoder = new TextEncoder();
  if (started.replay) {
    const events: FamilyStreamEvent[] = [
      {
        type: "start",
        userMessage: started.userMessage,
        assistantMessage: started.assistantMessage,
        ...(started.replacedMessageIds
          ? { replacedMessageIds: started.replacedMessageIds }
          : {}),
      },
      {
        type: "done",
        message: started.assistantMessage,
        usage: started.usage!,
      },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      {
        headers: {
          ...PRIVATE_API_HEADERS,
          "Content-Type": "text/event-stream; charset=utf-8",
        },
      },
    );
  }
  let resolveWork!: () => void;
  const workCompleted = new Promise<void>((resolve) => {
    resolveWork = resolve;
  });
  // Keep the bounded final database flush alive after a client cancels its stream.
  after(workCompleted);
  const abort = new AbortController();
  let output = "";
  let usage: FamilyUsage = {
    source: "unknown",
    inputTokens: null,
    outputTokens: null,
  };
  let closed = false;
  const onAbort = () => abort.abort();
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) abort.abort();
  const timeout = setTimeout(onAbort, 40_000);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: FamilyStreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          closed = true;
          abort.abort();
        }
      };
      const work = async () => {
        let lastSave = Date.now();
        const parser = new OpenAIStreamDecoder((delta) => {
          output += delta;
          emit({ type: "delta", text: delta });
        });
        try {
          emit({
            type: "start",
            userMessage: started.userMessage,
            assistantMessage: started.assistantMessage,
            ...(started.replacedMessageIds
              ? { replacedMessageIds: started.replacedMessageIds }
              : {}),
          });
          if (started.replay) {
            emit({
              type: "done",
              message: started.assistantMessage,
              usage: started.usage!,
            });
            return;
          }
          const upstream = await fetch(
            "https://api.openai.com/v1/chat/completions",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(
                completionBody(started.model, started.history),
              ),
              signal: abort.signal,
              redirect: "error",
              cache: "no-store",
            },
          );
          if (!upstream.ok || !upstream.body) {
            await upstream.body?.cancel();
            throw new FamilyApiError(
              502,
              upstream.status === 429
                ? "模型服务暂时繁忙，请稍后重试。"
                : "模型请求未成功，请联系管理员检查配置。",
            );
          }
          const reader = upstream.body.getReader();
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              parser.write(chunk.value);
              usage = parser.usage;
              if (Date.now() - lastSave >= 1000) {
                await getPool().query(
                  "UPDATE family_message SET content=$1 WHERE id=$2",
                  [output, started.assistantId],
                );
                const approved = await getPool().query(
                  'SELECT 1 FROM "user" WHERE id=$1 AND status=$2',
                  [userId, "approved"],
                );
                if (!approved.rowCount)
                  throw new FamilyApiError(403, "账号已停用，生成已停止。");
                lastSave = Date.now();
              }
            }
            parser.end();
            usage = parser.usage;
            if (parser.finishReason === "length")
              throw new FamilyApiError(
                502,
                "回复达到长度上限，已保存收到的内容。",
              );
            if (parser.finishReason === "content_filter")
              throw new FamilyApiError(
                502,
                "模型未能完成这次回复，请调整问题后重试。",
              );
            if (!output.trim())
              throw new FamilyApiError(
                502,
                "模型未返回可显示的回复，请重试或选择其他模型。",
              );
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
          if (abort.signal.aborted)
            throw new FamilyApiError(502, "回复已中断，已保存收到的内容。");
          const message = await finishGeneration(
            started,
            output,
            "complete",
            usage,
            parser.actualModel,
          );
          emit({ type: "done", message, usage });
        } catch (error) {
          abort.abort();
          usage = parser.usage;
          let saved = true;
          if (!started.replay) {
            await finishGeneration(
              started,
              output,
              output ? "partial" : "error",
              usage,
              parser.actualModel,
            ).catch(() => {
              saved = false;
            });
          }
          emit({
            type: "error",
            message: !saved
              ? "回复已中断，保存未完成，请稍后刷新检查。"
              : error instanceof FamilyApiError
              ? error.message
              : "回复已中断，已保存收到的内容，请刷新后查看。",
          });
        } finally {
          clearTimeout(timeout);
          request.signal.removeEventListener("abort", onAbort);
          try {
            if (!closed) {
              closed = true;
              controller.close();
            }
          } finally {
            resolveWork();
          }
        }
      };
      void work();
    },
    cancel() {
      closed = true;
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      ...PRIVATE_API_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
async function finishGeneration(
  started: GenerationStart,
  content: string,
  state: "complete" | "partial" | "error",
  usage: FamilyUsage,
  actualModel: string | null,
) {
  return transaction(async (client) => {
    await client.query(
      "UPDATE family_generation SET state=$1,finished_at=now(),input_tokens=$2,output_tokens=$3,usage_source=$4,actual_model=$6 WHERE id=$5",
      [
        state,
        usage.inputTokens,
        usage.outputTokens,
        usage.source,
        started.id,
        actualModel,
      ],
    );
    const result = await client.query(
      "UPDATE family_message SET content=$1,status=$2 WHERE id=$3 RETURNING *",
      [content, state, started.assistantId],
    );
    await client.query(
      "UPDATE family_chat SET updated_at=now() WHERE id=(SELECT chat_id FROM family_generation WHERE id=$1)",
      [started.id],
    );
    return {
      ...messageJson({
        ...result.rows[0],
        requested_model: started.model.id,
        actual_model: actualModel,
      }),
      usage,
    };
  });
}
