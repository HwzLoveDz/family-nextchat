import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { FamilyGeneratedImageMeta } from "../image-types";
import { getPool } from "./db";
import { FamilyApiError } from "./errors";

type Database = Pick<Pool | PoolClient, "query">;
export interface GeneratedImageAsset {
  bytes: Buffer;
  width: number;
  height: number;
  mediaType: "image/jpeg";
  model: string;
}
function meta(row: Record<string, any>): FamilyGeneratedImageMeta {
  return {
    id: row.id,
    name: row.name,
    mediaType: "image/jpeg",
    byteSize: Number(row.byte_size),
    width: row.width,
    height: row.height,
    model: row.model,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
export async function storeGeneratedImage(
  db: Database,
  ownerId: string,
  generationId: string,
  assistantId: string,
  image: GeneratedImageAsset,
): Promise<FamilyGeneratedImageMeta> {
  if (
    !Buffer.isBuffer(image.bytes) ||
    !image.bytes.length ||
    image.bytes.length > 4_194_304 ||
    image.bytes[0] !== 0xff ||
    image.bytes[1] !== 0xd8 ||
    ![image.width, image.height].every(
      (n) => Number.isSafeInteger(n) && n > 0 && n <= 1536,
    )
  )
    throw new FamilyApiError(
      502,
      "图片结果格式无效，已停止保存。",
      "INVALID_GENERATED_IMAGE",
    );
  const id = randomUUID();
  const rows = await db.query(
    `INSERT INTO family_generated_image(id,user_id,chat_id,generation_id,message_id,name,media_type,byte_size,width,height,model,data)
    SELECT $1,g.user_id,g.chat_id,g.id,m.id,$5,'image/jpeg',$6,$7,$8,$9,$10
    FROM family_generation g JOIN family_message m ON m.generation_id=g.id AND m.chat_id=g.chat_id
    JOIN "user" u ON u.id=g.user_id
    WHERE g.id=$2 AND g.user_id=$3 AND m.id=$4 AND m.role='assistant' AND g.state='complete' AND m.status='complete' AND u.status='approved'
    RETURNING id,name,media_type,byte_size,width,height,model,created_at`,
    [
      id,
      generationId,
      ownerId,
      assistantId,
      `AI图片-${id.slice(0, 8)}.jpg`,
      image.bytes.length,
      image.width,
      image.height,
      image.model,
      image.bytes,
    ],
  );
  if (!rows.rows[0])
    throw new FamilyApiError(
      403,
      "图片保存条件已变化，请刷新对话确认。",
      "IMAGE_SAVE_UNAVAILABLE",
    );
  return meta(rows.rows[0]);
}
/** Message IDs come from an already owner-scoped or audited chat detail query. No image bytes here. */
export async function loadGeneratedImages(
  db: Database,
  messageIds: string[],
): Promise<Map<string, FamilyGeneratedImageMeta[]>> {
  const result = new Map<string, FamilyGeneratedImageMeta[]>();
  if (!messageIds.length) return result;
  const rows = await db.query(
    `SELECT i.id,i.message_id,i.name,i.media_type,i.byte_size,i.width,i.height,i.model,i.created_at
    FROM family_generated_image i JOIN family_generation g ON g.id=i.generation_id AND g.user_id=i.user_id AND g.chat_id=i.chat_id
    JOIN family_message m ON m.id=i.message_id AND m.generation_id=g.id AND m.chat_id=i.chat_id
    WHERE i.message_id=ANY($1::uuid[]) AND m.role='assistant' AND g.state='complete' AND m.status='complete' ORDER BY i.created_at,i.id`,
    [messageIds],
  );
  for (const row of rows.rows)
    result.set(row.message_id, [
      ...(result.get(row.message_id) ?? []),
      meta(row),
    ]);
  return result;
}
export async function readGeneratedImage(id: string, ownerId?: string) {
  const rows = await getPool().query(
    `SELECT i.*,g.user_id AS owner_id
    FROM family_generated_image i
    JOIN family_generation g ON g.id=i.generation_id AND g.user_id=i.user_id AND g.chat_id=i.chat_id
    JOIN family_message m ON m.id=i.message_id AND m.generation_id=g.id AND m.chat_id=i.chat_id
    JOIN family_chat c ON c.id=i.chat_id AND c.user_id=i.user_id
    WHERE i.id=$1 AND m.role='assistant' AND g.state='complete' AND m.status='complete'` +
      (ownerId
        ? " AND c.user_id=$2 AND c.deleted_at IS NULL AND g.superseded_at IS NULL"
        : ""),
    ownerId ? [id, ownerId] : [id],
  );
  const row = rows.rows[0];
  if (!row)
    throw new FamilyApiError(404, "图片不存在或暂不可用。", "IMAGE_NOT_FOUND");
  return {
    meta: meta(row),
    bytes: row.data as Buffer,
    ownerId: row.owner_id as string,
    chatId: row.chat_id as string,
  };
}
