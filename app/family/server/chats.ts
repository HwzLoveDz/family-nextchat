import "server-only";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import type { PoolClient } from "pg";
import { getPool, transaction } from "./db";
import { FamilyApiError, digest, text } from "./errors";
import { PRIVATE_API_HEADERS } from "../enabled";
import { OpenAIStreamDecoder } from "./openai-stream";
import { assertNoRealtimeCall, lockRealtimeChat } from "./realtime-ledger";
import {
  configuredProviderKeys,
  rejectExhaustedQuota,
  withProviderKey,
} from "./provider-keys";
import {
  allowedModel,
  completionBody,
  modelCatalog,
  isImageModelId,
} from "./models";
import {
  DEFAULT_IMAGE_OPTIONS,
  FAMILY_IMAGE_SIZES,
  FAMILY_IMAGE_QUALITIES,
  type FamilyImageOptions,
} from "../image-types";
import {
  loadGeneratedImages,
  storeGeneratedImage,
  type GeneratedImageAsset,
} from "./generated-images";
import {
  cursorScope,
  decodeWorkspaceCursor,
  encodeWorkspaceCursor,
  workspaceQuery,
  WORKSPACE_PAGE_SIZE,
} from "./workspace-pagination";
import {
  prepareAttachments,
  loadMessageAttachments,
  storeAttachments,
  inheritAttachments,
  attachmentHistory,
  type PreparedAttachment,
  type CompletionMessage,
  type SavedAttachment,
} from "./attachments";
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
    pinnedAt: row.pinned_at?.toISOString() ?? null,
    ...(row.match_snippet ? { matchSnippet: row.match_snippet } : {}),
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
    ...(row.attachments?.length ? { attachments: row.attachments } : {}),
    ...(row.generatedImages?.length
      ? { generatedImages: row.generatedImages }
      : {}),
    ...(row.image_size && row.image_quality
      ? { imageOptions: { size: row.image_size, quality: row.image_quality } }
      : {}),
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
/** Search only the authenticated owner's current message versions. No wildcard syntax. */
export async function listChatPage(
  userId: string,
  options: {
    q?: string | null;
    view?: string | null;
    cursor?: string | null;
  } = {},
): Promise<{ chats: FamilyChat[]; nextCursor: string | null }> {
  const q = workspaceQuery(options.q);
  const view = options.view || "active";
  if (view !== "active" && view !== "archived")
    throw new FamilyApiError(400, "对话列表类型无效。");
  const scope = cursorScope("chats", userId, view, q);
  const cursor = decodeWorkspaceCursor(options.cursor, scope);
  const rows = (
    await getPool().query(
      `SELECT c.*,
      to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
      to_char(c.pinned_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_pin,
      CASE WHEN hit.content IS NOT NULL THEN
      substring(hit.content FROM greatest(1,strpos(lower(hit.content),lower($2))-40) FOR 160)
      ELSE NULL END AS match_snippet
    FROM family_chat c
    LEFT JOIN LATERAL (
      SELECT m.content FROM family_message m JOIN family_generation g ON g.id=m.generation_id
      WHERE $2<>'' AND m.chat_id=c.id AND g.chat_id=c.id AND g.user_id=$1
        AND g.superseded_at IS NULL AND strpos(lower(m.content),lower($2))>0
      ORDER BY m.position DESC LIMIT 1
    ) hit ON true
    WHERE c.user_id=$1 AND ${
      view === "archived" ? "c.deleted_at IS NOT NULL" : "c.deleted_at IS NULL"
    }
      AND ($2='' OR strpos(lower(c.title),lower($2))>0 OR hit.content IS NOT NULL)
      AND ($3::timestamptz IS NULL OR
        (COALESCE(c.pinned_at,'-infinity'::timestamptz),c.updated_at,c.id)<
        (COALESCE($4::timestamptz,'-infinity'::timestamptz),$3::timestamptz,$5::uuid))
    ORDER BY c.pinned_at DESC NULLS LAST,c.updated_at DESC,c.id DESC LIMIT 51`,
      [userId, q, cursor?.at ?? null, cursor?.pin ?? null, cursor?.id ?? null],
    )
  ).rows;
  const page = rows.slice(0, WORKSPACE_PAGE_SIZE);
  const last = page.at(-1);
  return {
    chats: page.map(chatJson),
    nextCursor:
      rows.length > WORKSPACE_PAGE_SIZE && last
        ? encodeWorkspaceCursor({
            id: last.id,
            at: last.cursor_at,
            pin: last.cursor_pin ?? null,
            scope,
          })
        : null,
  };
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
    Object.keys(body).some(
      (key) => !["title", "model", "pinned", "archived"].includes(key),
    ) ||
    (body.pinned !== undefined && typeof body.pinned !== "boolean") ||
    (body.archived !== undefined && typeof body.archived !== "boolean")
  )
    throw new FamilyApiError(400, "请提供对话名称或列表中的模型。");
  return transaction(async (client) => {
    await lockRealtimeChat(client, userId, chatId);
    const owner = await client.query(
      "SELECT * FROM family_chat WHERE id=$1 AND user_id=$2" +
        (body.archived === false ? "" : " AND deleted_at IS NULL") +
        " FOR UPDATE",
      [chatId, userId],
    );
    if (!owner.rowCount) throw new FamilyApiError(404, "对话不存在。");
    await assertNoRealtimeCall(client, userId, chatId);
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
          "SELECT 1 FROM family_generation WHERE chat_id=$1 AND state='running' AND started_at>now()-CASE WHEN model LIKE 'gpt-image-%' THEN interval '240 seconds' ELSE interval '90 seconds' END",
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
      "UPDATE family_chat SET title=$1,model=$2,updated_at=now(),pinned_at=CASE WHEN $5::boolean IS NULL THEN pinned_at WHEN $5 THEN COALESCE(pinned_at,now()) ELSE NULL END,deleted_at=CASE WHEN $6::boolean IS NULL THEN deleted_at WHEN $6 THEN COALESCE(deleted_at,now()) ELSE NULL END WHERE id=$3 AND user_id=$4 RETURNING *",
      [
        title,
        model,
        chatId,
        userId,
        body.pinned ?? null,
        body.archived ?? null,
      ],
    );
    return chatJson(result.rows[0]);
  });
}
export async function chatDetail(
  chatId: string,
  userId?: string,
  includeArchived = false,
  before?: string | null,
): Promise<FamilyChatDetail> {
  validId(chatId);
  const result = await getPool().query(
    "SELECT * FROM family_chat WHERE id=$1" +
      (!userId && includeArchived ? "" : " AND deleted_at IS NULL") +
      (userId ? " AND user_id=$2" : ""),
    userId ? [chatId, userId] : [chatId],
  );
  if (!result.rows[0]) throw new FamilyApiError(404, "对话不存在。");
  let beforePosition: string | number | null = null;
  if (before) {
    validId(before);
    const pivot = (
      await getPool().query(
        "SELECT m.position FROM family_message m JOIN family_generation g ON g.id=m.generation_id WHERE m.id=$1 AND m.chat_id=$2" +
          (!userId && includeArchived ? "" : " AND g.superseded_at IS NULL") +
          (userId ? " AND g.user_id=$3" : ""),
        userId ? [before, chatId, userId] : [before, chatId],
      )
    ).rows[0];
    if (!pivot) throw new FamilyApiError(404, "消息位置不存在。");
    beforePosition = pivot.position;
  }
  const messages = await getPool().query(
    "SELECT m.*,g.model AS requested_model,g.actual_model,g.superseded_at,g.input_tokens,g.output_tokens,g.usage_source,g.image_size,g.image_quality FROM family_message m JOIN family_generation g ON g.id=m.generation_id WHERE m.chat_id=$1" +
      (!userId && includeArchived ? "" : " AND g.superseded_at IS NULL") +
      " AND ($2::bigint IS NULL OR m.position<$2::bigint) ORDER BY m.position DESC LIMIT 81",
    [chatId, beforePosition],
  );
  const page = messages.rows.slice(0, 80).reverse();
  const attachments = await loadMessageAttachments(
    getPool(),
    page.filter((row) => row.role === "user").map((row) => row.id),
  );
  const generatedImages = await loadGeneratedImages(
    getPool(),
    page
      .filter(
        (row) =>
          row.role === "assistant" && isImageModelId(row.requested_model ?? ""),
      )
      .map((row) => row.id),
  );
  return {
    chat: chatJson(result.rows[0]),
    messages: page.map((row) =>
      messageJson({
        ...row,
        generatedImages: generatedImages.get(row.id),
        attachments: attachments
          .get(row.id)
          ?.map(({ data, textContent, textCharacters, ...meta }) => meta),
      }),
    ),
    hasMoreMessages: messages.rows.length > 80,
    nextBeforeMessageId: messages.rows.length > 80 ? page[0]?.id ?? null : null,
  };
}
export async function deleteChat(chatId: string, userId: string) {
  validId(chatId);
  await transaction(async (client) => {
    await lockRealtimeChat(client, userId, chatId);
    const row = await client.query(
      "SELECT id FROM family_chat WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE",
      [chatId, userId],
    );
    if (!row.rowCount) throw new FamilyApiError(404, "对话不存在。");
    await assertNoRealtimeCall(client, userId, chatId);
    if (
      (
        await client.query(
          "SELECT 1 FROM family_generation WHERE chat_id=$1 AND state='running' AND started_at>now()-CASE WHEN model LIKE 'gpt-image-%' THEN interval '240 seconds' ELSE interval '90 seconds' END",
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
  userId?: string;
  imageOptions?: FamilyImageOptions;
  assistantId: string;
  userMessage: FamilyMessage;
  assistantMessage: FamilyMessage;
  history: CompletionMessage[];
  replay?: boolean;
  usage?: FamilyUsage;
  model: FamilyModel;
  replacedMessageIds?: string[];
}
export async function cancelGeneration(
  chatId: string,
  userId: string,
  assistantId: string,
) {
  validId(chatId);
  validId(assistantId);
  return transaction(async (client) => {
    const generation = (
      await client.query(
        "SELECT g.id,g.state FROM family_generation g JOIN family_chat c ON c.id=g.chat_id JOIN family_message m ON m.generation_id=g.id WHERE c.id=$1 AND c.user_id=$2 AND c.deleted_at IS NULL AND g.user_id=$2 AND m.id=$3 AND m.role='assistant' FOR UPDATE OF g",
        [chatId, userId, assistantId],
      )
    ).rows[0];
    if (!generation)
      throw new FamilyApiError(404, "回复不存在。", "MESSAGE_NOT_FOUND");
    if (generation.state === "complete")
      throw new FamilyApiError(
        409,
        "回复已经完成，停止请求未能抢先生效。",
        "ALREADY_COMPLETE",
      );
    if (generation.state === "running")
      await client.query(
        "UPDATE family_generation SET cancel_requested_at=COALESCE(cancel_requested_at,now()) WHERE id=$1 AND state='running'",
        [generation.id],
      );
    // The running guard remains held until the generator finalizes its ledger.
    return { ok: true as const };
  });
}
type GenerationMode = "send" | "edit" | "retry" | "regenerate";
interface GenerationIntent {
  mode: GenerationMode;
  content: string | null;
  sourceMessageId: string | null;
  requestedModel?: string;
  attachments: PreparedAttachment[];
  imageOptions?: FamilyImageOptions;
}
export function validatedImageOptions(value: unknown): FamilyImageOptions {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["size", "quality"].includes(key))
  )
    throw new FamilyApiError(400, "图片设置无效。", "INVALID_IMAGE_OPTIONS");
  const input = value as Record<string, unknown>;
  const size = input.size ?? DEFAULT_IMAGE_OPTIONS.size;
  const quality = input.quality ?? DEFAULT_IMAGE_OPTIONS.quality;
  if (
    !FAMILY_IMAGE_SIZES.includes(size as any) ||
    !FAMILY_IMAGE_QUALITIES.includes(quality as any)
  )
    throw new FamilyApiError(
      400,
      "请选择列表中的图片尺寸和画质。",
      "INVALID_IMAGE_OPTIONS",
    );
  return { size, quality } as FamilyImageOptions;
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
        ![
          "content",
          "requestId",
          "model",
          "mode",
          "sourceMessageId",
          "attachments",
          "imageOptions",
        ].includes(key),
    )
  )
    throw new FamilyApiError(
      400,
      "消息参数无效。",
      "INVALID_MESSAGE_PARAMETERS",
    );
  if (mode !== "send" && body.attachments !== undefined)
    throw new FamilyApiError(
      400,
      "此操作保留原附件，不能指定新附件。",
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
        ? mode === "send" &&
          Array.isArray(body.attachments) &&
          body.attachments.length > 0 &&
          (body.content === undefined ||
            (typeof body.content === "string" && !body.content.trim()))
          ? "请分析这些附件。"
          : text(body.content, 12_000, "消息")
        : null,
    sourceMessageId,
    requestedModel: body.model as string | undefined,
    attachments: [],
    ...(body.imageOptions !== undefined
      ? { imageOptions: validatedImageOptions(body.imageOptions) }
      : {}),
  };
}
function intentHash(
  chatId: string,
  intent: GenerationIntent,
  model: string,
  defaultOptions = DEFAULT_IMAGE_OPTIONS,
) {
  return digest(
    JSON.stringify({
      chatId,
      content: intent.content,
      model,
      mode: intent.mode,
      sourceMessageId: intent.sourceMessageId,
      ...(isImageModelId(model)
        ? { imageOptions: intent.imageOptions ?? defaultOptions }
        : {}),
      ...(intent.attachments.length
        ? {
            attachments: intent.attachments.map(
              (file) => file.inputFingerprint,
            ),
          }
        : {}),
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
  await lockRealtimeChat(client, userId, chatId);
  const owner = await client.query(
    "SELECT * FROM family_chat WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE",
    [chatId, userId],
  );
  if (!owner.rowCount) throw new FamilyApiError(404, "对话不存在。");
  await assertNoRealtimeCall(client, userId, chatId);
  const existing = (
    await client.query(
      "SELECT *,EXISTS(SELECT 1 FROM family_message m JOIN family_message_attachment l ON l.message_id=m.id WHERE m.generation_id=family_generation.id) AS has_attachments FROM family_generation WHERE user_id=$1 AND request_id=$2",
      [userId, requestId],
    )
  ).rows[0];
  if (existing) {
    const requested = intent.requestedModel ?? existing.model;
    if (!isImageModelId(requested) && intent.imageOptions)
      throw new FamilyApiError(
        400,
        "图片设置只适用于图片模型。",
        "INVALID_IMAGE_OPTIONS",
      );
    const expected = intentHash(
      chatId,
      intent,
      requested,
      existing.image_size && existing.image_quality
        ? { size: existing.image_size, quality: existing.image_quality }
        : DEFAULT_IMAGE_OPTIONS,
    );
    const legacy =
      intent.mode === "send" &&
      !intent.sourceMessageId &&
      !intent.attachments.length &&
      !existing.has_attachments &&
      requested === existing.model &&
      existing.request_hash ===
        digest(JSON.stringify({ chatId, content: intent.content }));
    if (
      existing.chat_id !== chatId ||
      (intent.mode === "send" &&
        !intent.attachments.length &&
        existing.has_attachments) ||
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
        "SELECT m.*,g.model AS requested_model,g.actual_model,g.superseded_at,g.input_tokens,g.output_tokens,g.usage_source,g.image_size,g.image_quality FROM family_message m JOIN family_generation g ON g.id=m.generation_id WHERE generation_id=$1 ORDER BY position",
        [existing.id],
      )
    ).rows;
    const metadata = await loadMessageAttachments(
      client,
      messages.filter((row) => row.role === "user").map((row) => row.id),
    );
    const generatedImages = await loadGeneratedImages(
      client,
      isImageModelId(existing.model) ? [messages[1].id] : [],
    );
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
      userMessage: messageJson({
        ...messages[0],
        attachments: metadata
          .get(messages[0].id)
          ?.map(({ data, textContent, textCharacters, ...meta }) => meta),
      }),
      assistantMessage: messageJson({
        ...messages[1],
        generatedImages: generatedImages.get(messages[1].id),
      }),
      history: [],
      replay: true,
      usage: usageJson(existing),
      model: {
        id: existing.model,
        name: existing.model,
        description: "",
        reasoning: false,
        ...(isImageModelId(existing.model) ? { kind: "image" as const } : {}),
      },
      ...(isImageModelId(existing.model)
        ? {
            imageOptions:
              existing.image_size && existing.image_quality
                ? { size: existing.image_size, quality: existing.image_quality }
                : DEFAULT_IMAGE_OPTIONS,
          }
        : {}),
      replacedMessageIds: replaced,
    };
  }
  const model = allowedModel(
    intent.requestedModel ?? owner.rows[0].model ?? modelCatalog().defaultModel,
  );
  if (model.kind !== "image" && intent.imageOptions)
    throw new FamilyApiError(
      400,
      "图片设置只适用于图片模型。",
      "INVALID_IMAGE_OPTIONS",
    );
  let imageOptions =
    model.kind === "image"
      ? intent.imageOptions ?? { ...DEFAULT_IMAGE_OPTIONS }
      : undefined;
  const stale = await client.query(
    "UPDATE family_generation SET state='partial',finished_at=now() WHERE user_id=$1 AND state='running' AND started_at<now()-CASE WHEN model LIKE 'gpt-image-%' THEN interval '240 seconds' ELSE interval '90 seconds' END RETURNING id",
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
  let sourceUserMessage: string | null = null;
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
        "SELECT g.id,g.state,u.id AS user_message_id,u.content AS user_content,a.id AS assistant_message_id,g.image_size,g.image_quality FROM family_generation g JOIN family_message u ON u.generation_id=g.id AND u.role='user' JOIN family_message a ON a.generation_id=g.id AND a.role='assistant' WHERE g.chat_id=$1 AND g.superseded_at IS NULL ORDER BY u.position DESC LIMIT 1 FOR UPDATE OF g",
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
    sourceUserMessage = last.user_message_id;
    replacedMessageIds = [last.user_message_id, last.assistant_message_id];
    if (intent.mode !== "edit") content = last.user_content;
    if (
      model.kind === "image" &&
      !intent.imageOptions &&
      last.image_size &&
      last.image_quality
    )
      imageOptions = validatedImageOptions({
        size: last.image_size,
        quality: last.image_quality,
      });
  }
  const count = await client.query(
    "SELECT count(*)::int AS count FROM family_message WHERE chat_id=$1",
    [chatId],
  );
  if (count.rows[0].count >= 398)
    throw new FamilyApiError(400, "这段对话已较长，请新建对话。");
  const previous = (
    await client.query(
      "SELECT m.id,m.generation_id,m.role,m.content FROM family_message m JOIN family_generation g ON g.id=m.generation_id LEFT JOIN family_realtime_turn rt ON rt.generation_id=g.id WHERE m.chat_id=$1 AND g.state='complete' AND m.status='complete' AND g.superseded_at IS NULL AND (g.kind='text' OR m.role='user' OR (rt.heard_complete AND NOT rt.interrupted)) AND ($2::uuid IS NULL OR g.id<>$2) ORDER BY m.position DESC LIMIT 40",
      [chatId, sourceGeneration],
    )
  ).rows;
  const inherited = sourceUserMessage
    ? (await loadMessageAttachments(client, [sourceUserMessage], true)).get(
        sourceUserMessage,
      ) ?? []
    : [];
  const currentFiles: SavedAttachment[] = sourceUserMessage
    ? inherited
    : intent.attachments.map((file) => ({ id: "", ...file }));
  if (model.kind === "image" && currentFiles.length)
    throw new FamilyApiError(
      400,
      "图片模型目前使用文字描述生成图片，请先移除附件。",
      "IMAGE_ATTACHMENTS_UNSUPPORTED",
    );
  const history =
    model.kind === "image"
      ? []
      : await attachmentHistory(client, model, content, currentFiles, previous);
  const id = randomUUID();
  const userMessageId = randomUUID();
  const assistantId = randomUUID();
  await client.query(
    "INSERT INTO family_generation(id,user_id,chat_id,request_id,request_hash,model,mode,source_generation_id,state,image_size,image_quality) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,$10)",
    [
      id,
      userId,
      chatId,
      requestId,
      intentHash(chatId, intent, model.id, imageOptions),
      model.id,
      intent.mode,
      sourceGeneration,
      imageOptions?.size ?? null,
      imageOptions?.quality ?? null,
    ],
  );
  const rows = (
    await client.query(
      "INSERT INTO family_message(id,chat_id,generation_id,role,content,status) VALUES($1,$2,$3,'user',$4,'complete'),($5,$2,$3,'assistant','','streaming') RETURNING *",
      [userMessageId, chatId, id, content, assistantId],
    )
  ).rows;
  const attachments = sourceUserMessage
    ? (await inheritAttachments(
        client,
        sourceUserMessage,
        userMessageId,
        chatId,
      ),
      inherited.map(({ data, textContent, textCharacters, ...meta }) => meta))
    : await storeAttachments(
        client,
        userId,
        chatId,
        userMessageId,
        intent.attachments,
      );
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
    userId,
    assistantId,
    imageOptions,
    userMessage: messageJson({
      ...rows[0],
      requested_model: model.id,
      attachments,
    }),
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
  if (!configuredProviderKeys().length)
    throw new FamilyApiError(
      503,
      "管理员尚未配置模型 API，当前不能发送消息。",
      "MODEL_NOT_CONFIGURED",
    );
  intent.attachments = await prepareAttachments(
    body.attachments,
    request.signal,
    userId,
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
  const isImage = started.model.kind === "image";
  let imageActualModel: string | null = null;
  const timeout = setTimeout(onAbort, isImage ? 180_000 : 40_000);
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
      const keepAlive = isImage
        ? setInterval(() => {
            if (closed || abort.signal.aborted) return;
            try {
              controller.enqueue(encoder.encode(": generating image\n\n"));
            } catch {
              closed = true;
              abort.abort();
            }
          }, 15000)
        : undefined;
      const work = async () => {
        let lastSave = Date.now();
        let cancellationRequested = false;
        let statusFailure: FamilyApiError | undefined;
        let checkInFlight: Promise<void> | undefined;
        const checkStatus = async () => {
          try {
            const current = (
              await getPool().query(
                'SELECT g.cancel_requested_at,u.status FROM family_generation g JOIN "user" u ON u.id=g.user_id WHERE g.id=$1 AND g.user_id=$2',
                [started.id, userId],
              )
            ).rows[0];
            if (current?.cancel_requested_at) {
              cancellationRequested = true;
              abort.abort();
            } else if (current?.status !== "approved") {
              statusFailure = new FamilyApiError(
                403,
                "账号已停用，生成已停止。",
              );
              abort.abort();
            }
          } catch {
            statusFailure = new FamilyApiError(
              503,
              "账号或停止状态暂时无法确认，生成已停止。",
            );
            abort.abort();
          }
        };
        // Independent of reader.read(): cancellation must also abort a provider
        // that is waiting for its first token. At most one DB poll may be in flight.
        const statusTimer = setInterval(() => {
          if (!checkInFlight && !abort.signal.aborted) {
            const pending = checkStatus();
            checkInFlight = pending;
            void pending.finally(() => {
              if (checkInFlight === pending) checkInFlight = undefined;
            });
          }
        }, 1000);
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
          if (isImage) {
            const { requestGeneratedImage } = await import("./image-provider");
            const image = await requestGeneratedImage({
              model: started.model.id,
              prompt: started.userMessage.content,
              options: started.imageOptions ?? DEFAULT_IMAGE_OPTIONS,
              userId,
              signal: abort.signal,
              onUsage: (reported, actual) => {
                usage = reported;
                imageActualModel = actual;
              },
            });
            usage = image.usage;
            imageActualModel = image.actualModel;
            if (abort.signal.aborted)
              throw new FamilyApiError(
                502,
                "图片生成已停止。",
                "IMAGE_GENERATION_CANCELLED",
              );
            output = "图片已生成。";
            const message = await finishGeneration(
              started,
              output,
              "complete",
              usage,
              imageActualModel,
              {
                bytes: image.bytes,
                width: image.width,
                height: image.height,
                mediaType: "image/jpeg",
                model: started.model.id,
              },
            );
            if (message.status !== "complete") {
              emit({
                type: "error",
                message: "图片生成已停止，已保存实际用量。",
              });
              return;
            }
            emit({ type: "done", message, usage });
            return;
          }
          // Only an explicit, pre-acceptance quota rejection may select another
          // credential. The accepted response/stream is consumed exactly once.
          const upstream = await withProviderKey(async ({ key }) => {
            const response = await fetch(
              "https://api.openai.com/v1/chat/completions",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${key}`,
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
            await rejectExhaustedQuota(response, abort.signal);
            return response;
          }, abort.signal);
          if (!upstream.ok || !upstream.body) {
            // A refusal must not keep the generation/ledger open while an
            // unresponsive provider waits forever on its cancellation hook.
            try {
              void upstream.body?.cancel().catch(() => {});
            } catch {}
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
          if (message.status !== "complete") {
            emit({
              type: "error",
              message: "生成已停止，已保存收到的内容和实际用量。",
            });
            return;
          }
          emit({ type: "done", message, usage });
        } catch (error) {
          abort.abort();
          if (!isImage) usage = parser.usage;
          // A completed provider response is not a published image until its
          // private asset and message commit together. Do not save a success
          // stub when decoding or asset persistence failed after billing.
          if (isImage) output = "";
          let saved = true;
          if (!started.replay) {
            await finishGeneration(
              started,
              output,
              output ? "partial" : "error",
              usage,
              isImage ? imageActualModel : parser.actualModel,
            ).catch(() => {
              saved = false;
            });
          }
          emit({
            type: "error",
            message: !saved
              ? isImage
                ? "图片保存未完成，请刷新确认，避免重复生成。"
                : "回复已中断，保存未完成，请稍后刷新检查。"
              : cancellationRequested
              ? "生成已停止，已保存收到的内容和实际用量。"
              : statusFailure
              ? statusFailure.message
              : error instanceof FamilyApiError
              ? error.message
              : isImage
              ? "图片生成或保存未完成，请刷新确认后再决定是否重试。"
              : "回复已中断，已保存收到的内容，请刷新后查看。",
          });
        } finally {
          clearInterval(statusTimer);
          if (keepAlive !== undefined) clearInterval(keepAlive);
          clearTimeout(timeout);
          await checkInFlight;
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
export async function finishGeneration(
  started: GenerationStart,
  content: string,
  state: "complete" | "partial" | "error",
  usage: FamilyUsage,
  actualModel: string | null,
  image?: GeneratedImageAsset,
) {
  return transaction(async (client) => {
    const generation = (
      await client.query(
        "SELECT cancel_requested_at FROM family_generation WHERE id=$1 FOR UPDATE",
        [started.id],
      )
    ).rows[0];
    if (!generation) throw new FamilyApiError(404, "回复不存在。");
    const approved =
      image && started.userId
        ? (
            await client.query(
              'SELECT status FROM "user" WHERE id=$1 FOR SHARE',
              [started.userId],
            )
          ).rows[0]?.status === "approved"
        : true;
    const finalState =
      generation.cancel_requested_at || !approved
        ? image
          ? "error"
          : content
          ? "partial"
          : "error"
        : state;
    if (image && finalState !== "complete") content = "";
    await client.query(
      "UPDATE family_generation SET state=$1,finished_at=now(),input_tokens=$2,output_tokens=$3,usage_source=$4,actual_model=$6 WHERE id=$5",
      [
        finalState,
        usage.inputTokens,
        usage.outputTokens,
        usage.source,
        started.id,
        actualModel,
      ],
    );
    const result = await client.query(
      "UPDATE family_message SET content=$1,status=$2 WHERE id=$3 RETURNING *",
      [content, finalState, started.assistantId],
    );
    await client.query(
      "UPDATE family_chat SET updated_at=now() WHERE id=(SELECT chat_id FROM family_generation WHERE id=$1)",
      [started.id],
    );
    const generatedImages =
      image && finalState === "complete" && started.userId
        ? [
            await storeGeneratedImage(
              client,
              started.userId,
              started.id,
              started.assistantId,
              image,
            ),
          ]
        : [];
    return {
      ...messageJson({
        ...result.rows[0],
        generatedImages,
        image_size: started.imageOptions?.size,
        image_quality: started.imageOptions?.quality,
        requested_model: started.model.id,
        actual_model: actualModel,
      }),
      usage,
    };
  });
}
