import "server-only";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import type { PoolClient } from "pg";
import { getPool, transaction } from "./db";
import { FamilyApiError, digest, text } from "./errors";
import { PRIVATE_API_HEADERS } from "../enabled";
import { OpenAIStreamDecoder } from "./openai-stream";
import type {
  FamilyChat,
  FamilyChatDetail,
  FamilyMessage,
  FamilyStreamEvent,
  FamilyUsage,
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
  const result = await getPool().query(
    "INSERT INTO family_chat(id,user_id,title) VALUES($1,$2,$3) RETURNING *",
    [randomUUID(), userId, title],
  );
  return chatJson(result.rows[0]);
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
    "SELECT m.*,g.input_tokens,g.output_tokens,g.usage_source FROM family_message m JOIN family_generation g ON g.id=m.generation_id WHERE m.chat_id=$1 ORDER BY m.position LIMIT 400",
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
}
async function prepare(
  client: PoolClient,
  userId: string,
  chatId: string,
  content: string,
  requestId: string,
  model: string,
): Promise<GenerationStart> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `family-generation:${userId}`,
  ]);
  const owner = await client.query(
    "SELECT id FROM family_chat WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE",
    [chatId, userId],
  );
  if (!owner.rowCount) throw new FamilyApiError(404, "对话不存在。");
  const requestHash = digest(JSON.stringify({ chatId, content }));
  const existing = (
    await client.query(
      "SELECT * FROM family_generation WHERE user_id=$1 AND request_id=$2",
      [userId, requestId],
    )
  ).rows[0];
  if (existing) {
    if (existing.request_hash !== requestHash)
      throw new FamilyApiError(
        409,
        "请求编号不能用于不同内容。",
        "REQUEST_CONFLICT",
      );
    if (existing.state !== "complete")
      throw new FamilyApiError(
        409,
        "此请求已在处理中或已经中断，请刷新对话查看。",
        "REQUEST_EXISTS",
      );
    const messages = (
      await client.query(
        "SELECT * FROM family_message WHERE generation_id=$1 ORDER BY position",
        [existing.id],
      )
    ).rows;
    return {
      id: existing.id,
      assistantId: messages[1].id,
      userMessage: messageJson(messages[0]),
      assistantMessage: {
        ...messageJson(messages[1]),
        usage: usageJson(existing),
      },
      history: [],
      replay: true,
      usage: usageJson(existing),
    };
  }
  // Recover orphaned streams on the next request, without a watcher or cron job.
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
  const count = await client.query(
    "SELECT count(*)::int AS count FROM family_message WHERE chat_id=$1",
    [chatId],
  );
  if (count.rows[0].count >= 398)
    throw new FamilyApiError(400, "这段对话已较长，请新建对话。");
  const previous = (
    await client.query(
      "SELECT m.role,m.content FROM family_message m JOIN family_generation g ON g.id=m.generation_id WHERE m.chat_id=$1 AND g.state='complete' AND m.status='complete' ORDER BY m.position DESC LIMIT 40",
      [chatId],
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
    "INSERT INTO family_generation(id,user_id,chat_id,request_id,request_hash,model,state) VALUES($1,$2,$3,$4,$5,$6,'running')",
    [id, userId, chatId, requestId, requestHash, model],
  );
  const rows = (
    await client.query(
      "INSERT INTO family_message(id,chat_id,generation_id,role,content,status) VALUES($1,$2,$3,'user',$4,'complete'),($5,$2,$3,'assistant','','streaming') RETURNING *",
      [userMessageId, chatId, id, content, assistantId],
    )
  ).rows;
  await client.query(
    "UPDATE family_chat SET title=CASE WHEN title='新对话' THEN $2 ELSE title END,updated_at=now() WHERE id=$1",
    [chatId, content.replace(/\s+/g, " ").slice(0, 40)],
  );
  await client.query(
    "INSERT INTO family_activity(user_id,last_seen_at) VALUES($1,now()) ON CONFLICT(user_id) DO UPDATE SET last_seen_at=now()",
    [userId],
  );
  return {
    id,
    assistantId,
    userMessage: messageJson(rows[0]),
    assistantMessage: messageJson(rows[1]),
    history,
  };
}
export async function generate(
  request: Request,
  userId: string,
  chatId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  validId(chatId);
  const content = text(body.content, 12_000, "消息");
  const requestId = text(body.requestId, 100, "请求编号", 8);
  if (!/^[a-zA-Z0-9_-]+$/.test(requestId))
    throw new FamilyApiError(400, "请求编号格式无效。");
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.FAMILY_OPENAI_MODEL?.trim() || "gpt-4o-mini";
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
  if (!apiKey)
    throw new FamilyApiError(
      503,
      "管理员尚未配置模型 API，当前不能发送消息。",
      "MODEL_NOT_CONFIGURED",
    );
  const started = await transaction((client) =>
    prepare(client, userId, chatId, content, requestId, model),
  );
  const encoder = new TextEncoder();
  if (started.replay) {
    const events: FamilyStreamEvent[] = [
      {
        type: "start",
        userMessage: started.userMessage,
        assistantMessage: started.assistantMessage,
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
              body: JSON.stringify({
                model,
                messages: started.history,
                stream: true,
                stream_options: { include_usage: true },
                max_completion_tokens: 2048,
              }),
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
) {
  return transaction(async (client) => {
    await client.query(
      "UPDATE family_generation SET state=$1,finished_at=now(),input_tokens=$2,output_tokens=$3,usage_source=$4 WHERE id=$5",
      [state, usage.inputTokens, usage.outputTokens, usage.source, started.id],
    );
    const result = await client.query(
      "UPDATE family_message SET content=$1,status=$2 WHERE id=$3 RETURNING *",
      [content, state, started.assistantId],
    );
    await client.query(
      "UPDATE family_chat SET updated_at=now() WHERE id=(SELECT chat_id FROM family_generation WHERE id=$1)",
      [started.id],
    );
    return { ...messageJson(result.rows[0]), usage };
  });
}
