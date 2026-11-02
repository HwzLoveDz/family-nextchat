import "server-only";
import { getPool } from "./db";
import { FamilyApiError } from "./errors";
import { attachmentMeta } from "./attachments";
import {
  cursorScope,
  decodeWorkspaceCursor,
  encodeWorkspaceCursor,
  workspaceQuery,
  WORKSPACE_PAGE_SIZE,
} from "./workspace-pagination";
import type { FamilyFilePage } from "../workspace-types";

/** Metadata only. Existing attachment downloads independently check active-chat ownership. */
export async function listWorkspaceFiles(
  userId: string,
  options: {
    q?: string | null;
    chatId?: string | null;
    cursor?: string | null;
  } = {},
): Promise<FamilyFilePage> {
  const q = workspaceQuery(options.q);
  const chatId = options.chatId || null;
  if (
    chatId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      chatId,
    )
  )
    throw new FamilyApiError(400, "对话编号无效。");
  const scope = cursorScope("files", userId, q, chatId ?? "");
  const cursor = decodeWorkspaceCursor(options.cursor, scope);
  const rows = (
    await getPool().query(
      `SELECT a.id,a.name,a.kind,a.media_type,a.byte_size,a.width,a.height,a.pages,a.created_at,
      to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
      c.id AS chat_id,c.title AS chat_title,c.deleted_at IS NOT NULL AS chat_archived
    FROM family_attachment a JOIN family_chat c ON c.id=a.chat_id AND c.user_id=a.user_id
    WHERE a.user_id=$1 AND c.user_id=$1 AND ($2='' OR strpos(lower(a.name),lower($2))>0 OR strpos(lower(c.title),lower($2))>0)
      AND ($3::uuid IS NULL OR c.id=$3::uuid)
      AND EXISTS(SELECT 1 FROM family_message_attachment l
        JOIN family_message m ON m.id=l.message_id AND m.chat_id=l.chat_id
        JOIN family_generation g ON g.id=m.generation_id AND g.chat_id=m.chat_id
        WHERE l.attachment_id=a.id AND l.chat_id=c.id AND m.role='user'
          AND g.user_id=$1 AND g.superseded_at IS NULL)
      AND ($4::timestamptz IS NULL OR (a.created_at,a.id)<($4::timestamptz,$5::uuid))
    ORDER BY a.created_at DESC,a.id DESC LIMIT 51`,
      [userId, q, chatId, cursor?.at ?? null, cursor?.id ?? null],
    )
  ).rows;
  const page = rows.slice(0, WORKSPACE_PAGE_SIZE);
  const last = page.at(-1);
  return {
    files: page.map((row) => ({
      ...attachmentMeta(row),
      chatId: row.chat_id,
      chatTitle: row.chat_title,
      chatArchived: !!row.chat_archived,
      createdAt: row.created_at.toISOString(),
    })),
    nextCursor:
      rows.length > WORKSPACE_PAGE_SIZE && last
        ? encodeWorkspaceCursor({ id: last.id, at: last.cursor_at, scope })
        : null,
  };
}
