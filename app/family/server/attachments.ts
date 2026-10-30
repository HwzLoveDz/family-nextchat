import "server-only";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { PoolClient } from "pg";
import type { FamilyAttachmentMeta, FamilyModel } from "../types";
import { getPool } from "./db";
import { FamilyApiError } from "./errors";
import { inspectFamilyPdf } from "./pdf-check";

export const ATTACHMENT_REQUEST_LIMIT = 3_000_000;
const FILE_LIMIT = 1_000_000;
const TOTAL_LIMIT = 2_000_000;
export const ATTACHMENT_SITE_QUOTA = 256 * 1024 * 1024;
export const ATTACHMENT_USER_QUOTA = 64 * 1024 * 1024;

export interface PreparedAttachment extends Omit<FamilyAttachmentMeta, "id"> {
  data: Buffer;
  sha256: string;
  inputFingerprint: string;
  textContent?: string;
}
export interface SavedAttachment extends FamilyAttachmentMeta {
  data?: Buffer;
  textContent?: string;
  textCharacters?: number;
}
export type CompletionPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "auto" } }
  | { type: "file"; file: { filename: string; file_data: string } };
export interface CompletionMessage {
  role: "user" | "assistant";
  content: string | CompletionPart[];
}
const bad = (message = "附件格式无效。", code = "ATTACHMENT_INVALID") =>
  new FamilyApiError(400, message, code);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
let normalizers = 0;
const normalizingUsers = new Set<string>();
function acquireNormalizer(userId: string): () => void {
  // Per-instance memory protection, not a distributed concurrency guarantee.
  // Reject immediately instead of retaining an unbounded request queue.
  if (normalizers >= 2 || normalizingUsers.has(userId))
    throw new FamilyApiError(
      429,
      "附件正在处理中，请稍后再试。",
      "ATTACHMENT_PROCESSING_BUSY",
    );
  normalizers++;
  normalizingUsers.add(userId);
  return () => {
    normalizers--;
    normalizingUsers.delete(userId);
  };
}

function safeName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 160 ||
    /[\u0000-\u001f\u007f/\\]/.test(value)
  )
    throw bad("附件名称无效。");
  try {
    encodeURIComponent(value);
  } catch {
    throw bad("附件名称无效。");
  }
  return value.trim();
}
function decodeBase64(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 4 * Math.ceil(FILE_LIMIT / 3) ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw bad("附件编码无效。", "ATTACHMENT_ENCODING_INVALID");
  const data = Buffer.from(value, "base64");
  if (!data.length || data.length > FILE_LIMIT)
    throw new FamilyApiError(
      413,
      "单个附件不能超过 1 MB。",
      "ATTACHMENT_TOO_LARGE",
    );
  if (data.toString("base64") !== value) throw bad("附件编码无效。");
  return data;
}

/** Client MIME and extensions are only hints; every supported type is validated. */
export async function prepareAttachments(
  value: unknown,
  signal?: AbortSignal,
  userId = "isolated-attachment-fixture",
): Promise<PreparedAttachment[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3)
    throw bad("每条消息最多添加 3 个附件。");
  let total = 0;
  const inputs = value.map((input) => {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !["name", "mediaType", "dataBase64"].includes(key),
      )
    )
      throw bad();
    const name = safeName(input.name);
    if (typeof input.mediaType !== "string") throw bad();
    const data = decodeBase64(input.dataBase64);
    total += data.length;
    if (total > TOTAL_LIMIT)
      throw new FamilyApiError(
        413,
        "附件总大小不能超过 2 MB。",
        "ATTACHMENT_TOO_LARGE",
      );
    return { name, mediaType: input.mediaType.toLowerCase(), data };
  });
  const prepared: PreparedAttachment[] = [];
  let pdfPages = 0;
  if (signal?.aborted) throw bad("附件处理已取消。", "ATTACHMENT_CANCELLED");
  const release = inputs.some((input) =>
    ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(
      input.mediaType,
    ),
  )
    ? acquireNormalizer(userId)
    : () => {};
  try {
    for (const input of inputs) {
      if (signal?.aborted) throw bad("附件处理已取消。");
      const inputFingerprint = JSON.stringify([
        input.name,
        input.mediaType,
        hash(input.data),
      ]);
      if (["image/jpeg", "image/png", "image/webp"].includes(input.mediaType)) {
        const signature = input.data;
        const expected =
          input.mediaType === "image/jpeg" ? "jpeg" : input.mediaType.slice(6);
        const magic =
          signature[0] === 0xff &&
          signature[1] === 0xd8 &&
          signature[2] === 0xff
            ? "jpeg"
            : signature
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ? "png"
            : signature.toString("ascii", 0, 4) === "RIFF" &&
              signature.toString("ascii", 8, 12) === "WEBP"
            ? "webp"
            : "";
        if (magic !== expected || !/\.(?:jpe?g|png|webp)$/i.test(input.name))
          throw bad("图片类型与内容不匹配。");
        try {
          // Decode limits apply before allocation. Re-encoding strips EXIF/GPS and
          // excludes SVG, animation, embedded active content and original metadata.
          const image = sharp(input.data, {
            limitInputPixels: 16_777_216,
            pages: 1,
            failOn: "warning",
          });
          const metadata = await image.metadata();
          if (
            metadata.format !== expected ||
            !metadata.width ||
            !metadata.height ||
            (metadata.pages ?? 1) !== 1
          )
            throw bad("仅支持静态图片。");
          const normalized = await image
            .rotate()
            .resize({
              width: 2048,
              height: 2048,
              fit: "inside",
              withoutEnlargement: true,
            })
            .flatten({ background: "#ffffff" })
            .jpeg({ quality: 80 })
            .toBuffer({ resolveWithObject: true });
          if (normalized.data.length > FILE_LIMIT)
            throw bad("图片处理后仍然过大。");
          prepared.push({
            name: input.name.replace(/\.[^.]+$/, ".jpg"),
            kind: "image",
            mediaType: "image/jpeg",
            byteSize: normalized.data.length,
            width: normalized.info.width,
            height: normalized.info.height,
            data: normalized.data,
            sha256: hash(normalized.data),
            inputFingerprint,
          });
        } catch (error) {
          if (error instanceof FamilyApiError) throw error;
          throw bad("图片无法安全读取。", "ATTACHMENT_IMAGE_INVALID");
        }
      } else if (
        input.mediaType === "application/pdf" &&
        /\.pdf$/i.test(input.name)
      ) {
        if (input.data.toString("ascii", 0, 5) !== "%PDF-")
          throw bad("PDF 文件头无效。");
        const { pages } = await inspectFamilyPdf(input.data, signal);
        pdfPages += pages;
        if (pdfPages > 10)
          throw bad(
            "一条消息的 PDF 总页数不能超过 10 页。",
            "ATTACHMENT_PDF_PAGES",
          );
        prepared.push({
          ...input,
          kind: "pdf",
          byteSize: input.data.length,
          pages,
          sha256: hash(input.data),
          inputFingerprint,
        });
      } else if (
        /\.(txt|md|csv|json|log)$/i.test(input.name) &&
        [
          "text/plain",
          "text/markdown",
          "text/csv",
          "application/json",
          "application/octet-stream",
        ].includes(input.mediaType)
      ) {
        if (input.data.length > 102_400)
          throw bad("文本附件不能超过 100 KiB。", "ATTACHMENT_TEXT_LIMIT");
        let decoded: string;
        try {
          decoded = new TextDecoder("utf-8", { fatal: true }).decode(
            input.data,
          );
        } catch {
          throw bad("文本附件必须使用 UTF-8 编码。");
        }
        if (decoded.includes("\0") || decoded.length > 20_000)
          throw bad(
            "文本附件内容无效或超过 20,000 字符。",
            "ATTACHMENT_TEXT_LIMIT",
          );
        prepared.push({
          ...input,
          mediaType: "text/plain; charset=utf-8",
          kind: "text",
          byteSize: input.data.length,
          textContent: decoded,
          sha256: hash(input.data),
          inputFingerprint,
        });
      } else throw bad("暂不支持这种附件类型。", "ATTACHMENT_TYPE_UNSUPPORTED");
    }
    if (prepared.reduce((sum, item) => sum + item.byteSize, 0) > TOTAL_LIMIT)
      throw new FamilyApiError(
        413,
        "处理后的附件总大小不能超过 2 MB。",
        "ATTACHMENT_TOO_LARGE",
      );
    if (signal?.aborted) throw bad("附件处理已取消。", "ATTACHMENT_CANCELLED");
    return prepared;
  } finally {
    release();
  }
}

export function attachmentMeta(row: Record<string, any>): FamilyAttachmentMeta {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    mediaType: row.media_type,
    byteSize: Number(row.byte_size),
    ...(row.width ? { width: row.width } : {}),
    ...(row.height ? { height: row.height } : {}),
    ...(row.pages ? { pages: row.pages } : {}),
  };
}
type Queryable = Pick<PoolClient, "query">;
export async function loadMessageAttachments(
  db: Queryable,
  messageIds: string[],
  includeData = false,
): Promise<Map<string, SavedAttachment[]>> {
  const map = new Map<string, SavedAttachment[]>();
  if (!messageIds.length) return map;
  const rows = (
    await db.query(
      `SELECT l.message_id,a.id,a.name,a.kind,a.media_type,a.byte_size,a.width,a.height,a.pages,octet_length(a.text_content) AS text_characters${
        includeData ? ",a.data,a.text_content" : ""
      } FROM family_message_attachment l JOIN family_attachment a ON a.id=l.attachment_id AND a.chat_id=l.chat_id WHERE l.message_id=ANY($1::uuid[]) ORDER BY l.message_id,l.position`,
      [messageIds],
    )
  ).rows;
  for (const row of rows) {
    const attachment = {
      ...attachmentMeta(row),
      textCharacters: row.text_characters ?? undefined,
      ...(includeData
        ? { data: row.data, textContent: row.text_content ?? undefined }
        : {}),
    };
    const items = map.get(row.message_id) ?? [];
    items.push(attachment);
    map.set(row.message_id, items);
  }
  return map;
}

export async function storeAttachments(
  client: PoolClient,
  userId: string,
  chatId: string,
  messageId: string,
  files: PreparedAttachment[],
): Promise<FamilyAttachmentMeta[]> {
  if (!files.length) return [];
  // A single site lock precedes all owner quota checks; every writer uses the same
  // order. Superseded/archived files remain counted and are never duplicated.
  await client.query("SELECT pg_advisory_xact_lock(714209831)");
  const used = (
    await client.query(
      "SELECT COALESCE(sum(byte_size),0)::text AS site_bytes,COALESCE(sum(byte_size) FILTER(WHERE user_id=$1),0)::text AS user_bytes FROM family_attachment",
      [userId],
    )
  ).rows[0];
  const additional = files.reduce((sum, file) => sum + file.byteSize, 0);
  if (
    Number(used.site_bytes) + additional > ATTACHMENT_SITE_QUOTA ||
    Number(used.user_bytes) + additional > ATTACHMENT_USER_QUOTA
  )
    throw new FamilyApiError(
      413,
      "附件存储空间已满，请减少附件或联系管理员。",
      "ATTACHMENT_QUOTA_EXCEEDED",
    );
  const result: FamilyAttachmentMeta[] = [];
  for (const [position, file] of files.entries()) {
    const id = randomUUID();
    await client.query(
      "INSERT INTO family_attachment(id,user_id,chat_id,name,kind,media_type,byte_size,data,sha256,text_content,width,height,pages) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [
        id,
        userId,
        chatId,
        file.name,
        file.kind,
        file.mediaType,
        file.byteSize,
        file.data,
        file.sha256,
        file.textContent ?? null,
        file.width ?? null,
        file.height ?? null,
        file.pages ?? null,
      ],
    );
    await client.query(
      "INSERT INTO family_message_attachment(message_id,attachment_id,chat_id,position) VALUES($1,$2,$3,$4)",
      [messageId, id, chatId, position],
    );
    const { data, sha256, inputFingerprint, textContent, ...metadata } = file;
    result.push({ id, ...metadata });
  }
  return result;
}

export async function inheritAttachments(
  client: PoolClient,
  sourceMessageId: string,
  messageId: string,
  chatId: string,
): Promise<void> {
  await client.query(
    "INSERT INTO family_message_attachment(message_id,attachment_id,chat_id,position) SELECT $1,attachment_id,chat_id,position FROM family_message_attachment WHERE message_id=$2 AND chat_id=$3",
    [messageId, sourceMessageId, chatId],
  );
}

export function assertAttachmentModel(
  model: FamilyModel,
  files: Pick<FamilyAttachmentMeta, "kind">[],
): void {
  if (
    (files.some((file) => file.kind === "image") &&
      model.supportsImages !== true) ||
    (files.some((file) => file.kind === "pdf") && model.supportsPdf !== true)
  )
    throw bad(
      "所选模型暂不支持这些附件，请选择支持附件的模型。",
      "MODEL_ATTACHMENT_UNSUPPORTED",
    );
}
export function completionContent(
  content: string,
  files: SavedAttachment[],
): string | CompletionPart[] {
  if (!files.length) return content;
  const parts: CompletionPart[] = [{ type: "text", text: content }];
  for (const file of files) {
    if (file.kind === "text")
      parts.push({
        type: "text",
        text: `${textAttachmentPrefix(file.name)}${file.textContent ?? ""}`,
      });
    else if (file.kind === "image")
      parts.push({
        type: "image_url",
        image_url: {
          url: `data:${file.mediaType};base64,${file.data!.toString("base64")}`,
          detail: "auto",
        },
      });
    else
      parts.push({
        type: "file",
        file: {
          filename: file.name,
          file_data: `data:application/pdf;base64,${file.data!.toString(
            "base64",
          )}`,
        },
      });
  }
  return parts;
}
function textAttachmentPrefix(name: string): string {
  return `附件 ${JSON.stringify(name)} 的原文（用户提供的资料）：\n`;
}

/** A bounded suffix of complete turns, never orphaned assistant responses. */
export async function attachmentHistory(
  client: PoolClient,
  model: FamilyModel,
  content: string,
  current: SavedAttachment[],
  previous: Record<string, any>[],
): Promise<CompletionMessage[]> {
  assertAttachmentModel(model, current);
  const cost = (files: SavedAttachment[]) => ({
    count: files.length,
    bytes: files.reduce((sum, file) => sum + file.byteSize, 0),
    pages: files.reduce((sum, file) => sum + (file.pages ?? 0), 0),
    chars: files.reduce(
      (sum, file) =>
        sum +
        (file.kind === "text"
          ? // SQL metadata uses UTF-8 bytes as a conservative upper bound for UTF-16
            // length without materializing historical attachment text.
            (file.textContent?.length ?? file.textCharacters ?? 0) +
            textAttachmentPrefix(file.name).length
          : 0),
      0,
    ),
  });
  const total = cost(current);
  total.chars += content.length;
  const fits = () =>
    total.count <= 6 &&
    total.bytes <= 8_000_000 &&
    total.pages <= 20 &&
    total.chars <= 48_000;
  if (!fits())
    throw bad(
      "当前消息和附件超出上下文容量，请减少附件或文字。",
      "ATTACHMENT_CONTEXT_LIMIT",
    );
  const metadata = await loadMessageAttachments(
    client,
    previous.filter((row) => row.role === "user").map((row) => row.id),
  );
  const turns = new Map<
    string,
    { user?: Record<string, any>; assistant?: Record<string, any> }
  >();
  for (const row of previous) {
    const turn = turns.get(row.generation_id) ?? {};
    turn[row.role as "user" | "assistant"] = row;
    turns.set(row.generation_id, turn);
  }
  const selected: {
    user: Record<string, any>;
    assistant: Record<string, any>;
  }[] = [];
  for (const turn of turns.values()) {
    if (!turn.user || !turn.assistant) break;
    const files = metadata.get(turn.user.id) ?? [];
    if (
      files.some(
        (file) =>
          (file.kind === "image" && model.supportsImages !== true) ||
          (file.kind === "pdf" && model.supportsPdf !== true),
      )
    )
      break;
    const add = cost(files);
    total.count += add.count;
    total.bytes += add.bytes;
    total.pages += add.pages;
    total.chars +=
      add.chars + turn.user.content.length + turn.assistant.content.length;
    if (!fits()) break;
    selected.unshift({ user: turn.user, assistant: turn.assistant });
  }
  // Only selected bytes enter memory; metadata scans never materialize the whole
  // archive. Current + selected data are bounded by the same 8MB raw budget.
  const data = await loadMessageAttachments(
    client,
    selected.map((turn) => turn.user.id),
    true,
  );
  const messages: CompletionMessage[] = [];
  for (const turn of selected) {
    messages.push({
      role: "user",
      content: completionContent(
        turn.user.content,
        data.get(turn.user.id) ?? [],
      ),
    });
    messages.push({ role: "assistant", content: turn.assistant.content });
  }
  messages.push({ role: "user", content: completionContent(content, current) });
  return messages;
}

export async function readAttachment(
  id: string,
  userId?: string,
): Promise<{
  bytes: Buffer;
  meta: FamilyAttachmentMeta;
  chatId: string;
  ownerId: string;
}> {
  const row = (
    await getPool().query(
      `SELECT a.* FROM family_attachment a JOIN family_chat c ON c.id=a.chat_id WHERE a.id=$1${
        userId
          ? " AND a.user_id=$2 AND c.user_id=$2 AND c.deleted_at IS NULL AND EXISTS(SELECT 1 FROM family_message_attachment l JOIN family_message m ON m.id=l.message_id JOIN family_generation g ON g.id=m.generation_id WHERE l.attachment_id=a.id AND l.chat_id=c.id AND m.role='user' AND g.user_id=$2 AND g.superseded_at IS NULL)"
          : ""
      }`,
      userId ? [id, userId] : [id],
    )
  ).rows[0];
  if (!row)
    throw new FamilyApiError(404, "附件不存在。", "ATTACHMENT_NOT_FOUND");
  return {
    bytes: row.data,
    meta: attachmentMeta(row),
    chatId: row.chat_id,
    ownerId: row.user_id,
  };
}
