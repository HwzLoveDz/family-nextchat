/** @jest-environment node */
import { jest } from "@jest/globals";
import type { PoolClient } from "pg";

const result = (rows: Record<string, any>[] = []) => ({
  rows,
  rowCount: rows.length,
});
const query =
  jest.fn<
    (sql: string, values?: unknown[]) => Promise<ReturnType<typeof result>>
  >();
const lock = jest.fn(async (..._args: unknown[]) => {});
const realtimeGuard = jest.fn(async (..._args: unknown[]) => {});
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("@/app/family/server/db", () => ({
  getPool: () => ({ query }),
  transaction: async (run: (client: PoolClient) => Promise<any>) =>
    run({ query } as unknown as PoolClient),
}));
jest.unstable_mockModule("@/app/family/server/realtime-ledger", () => ({
  lockRealtimeChat: lock,
  assertNoRealtimeCall: realtimeGuard,
}));
const chats = await import("@/app/family/server/chats");
const files = await import("@/app/family/server/workspace-files");
const paging = await import("@/app/family/server/workspace-pagination");
const owner = "synthetic-workspace-a";
const chatId = "10000000-0000-4000-8000-000000000001";
const messageId = "10000000-0000-4000-8000-000000000002";
const id = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-11-02T00:00:00.123Z");
const chat = () => ({
  id: chatId,
  user_id: owner,
  title: "Fixture",
  model: "gpt-4o-mini",
  created_at: now,
  updated_at: now,
  deleted_at: null,
  pinned_at: null,
});
beforeEach(() => {
  jest.clearAllMocks();
  query.mockImplementation(async () => {
    throw new Error("Unexpected workspace fixture query");
  });
  realtimeGuard.mockResolvedValue();
});

test("literal content search is parameterized, owner scoped and excludes superseded generations", async () => {
  const needle = "%_' OR true--";
  query.mockResolvedValueOnce(
    result([{ ...chat(), match_snippet: "fixture exact match" }]),
  );
  const page = await chats.listChatPage(owner, { q: needle });
  expect(page.chats[0].matchSnippet).toBe("fixture exact match");
  const [sql, values] = query.mock.calls[0];
  expect(sql).toContain("c.user_id=$1");
  expect(sql).toContain("g.user_id=$1");
  expect(sql).toContain("g.superseded_at IS NULL");
  expect(sql).toContain("strpos(lower(m.content),lower($2))>0");
  expect(sql).toContain("c.deleted_at IS NULL");
  expect(sql).toContain("LIMIT 51");
  expect(sql).not.toContain(needle);
  expect(values).toEqual([owner, needle, null, null, null]);
});

test("chat pages retain microseconds, pin ordering and query/owner/view cursor isolation", async () => {
  query.mockResolvedValueOnce(
    result(
      Array.from({ length: 51 }, (_, n) => ({
        ...chat(),
        id: id(n),
        cursor_at: "2026-11-02T00:00:00.123456Z",
        cursor_pin: "2026-11-01T00:00:00.987654Z",
        pinned_at: now,
      })),
    ),
  );
  const first = await chats.listChatPage(owner, {
    q: "fixture",
    view: "archived",
  });
  expect(first.chats).toHaveLength(50);
  expect(first.nextCursor).toBeTruthy();
  const anchor = JSON.parse(
    Buffer.from(first.nextCursor!, "base64url").toString(),
  );
  expect(anchor.at).toBe("2026-11-02T00:00:00.123456Z");
  expect(anchor.pin).toBe("2026-11-01T00:00:00.987654Z");
  query.mockResolvedValueOnce(result());
  await chats.listChatPage(owner, {
    q: "fixture",
    view: "archived",
    cursor: first.nextCursor,
  });
  expect(query.mock.calls[1][1]).toEqual([
    owner,
    "fixture",
    anchor.at,
    anchor.pin,
    id(49),
  ]);
  expect(query.mock.calls[1][0]).toContain("c.deleted_at IS NOT NULL");
  expect(query.mock.calls[1][0]).toContain(
    "c.pinned_at DESC NULLS LAST,c.updated_at DESC,c.id DESC",
  );
  for (const options of [
    { q: "other", view: "archived" },
    { q: "fixture", view: "active" },
  ])
    await expect(
      chats.listChatPage(owner, { ...options, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  await expect(
    chats.listChatPage("other-owner", {
      q: "fixture",
      view: "archived",
      cursor: first.nextCursor,
    }),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  expect(query).toHaveBeenCalledTimes(2);
});

test.each([
  "x".repeat(801),
  "!",
  Buffer.from('{"scope":"bad"}').toString("base64url"),
])("invalid cursor is rejected before SQL", async (cursor) => {
  await expect(chats.listChatPage(owner, { cursor })).rejects.toMatchObject({
    status: 400,
  });
  expect(query).not.toHaveBeenCalled();
});
test("invalid search/view is rejected before SQL", async () => {
  await expect(
    chats.listChatPage(owner, { q: "x".repeat(201) }),
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    chats.listChatPage(owner, { view: "all-users" }),
  ).rejects.toMatchObject({ status: 400 });
  expect(query).not.toHaveBeenCalled();
});

test("latest 80 messages are returned chronologically, with a usable older-page anchor", async () => {
  query.mockResolvedValueOnce(result([chat()]));
  query.mockResolvedValueOnce(
    result(
      Array.from({ length: 81 }, (_, n) => ({
        id: id(500 - n),
        role: "assistant",
        content: `fixture ${500 - n}`,
        status: "complete",
        created_at: now,
      })),
    ),
  );
  const detail = await chats.chatDetail(chatId, owner);
  expect(detail.messages).toHaveLength(80);
  expect(detail.messages[0].id).toBe(id(421));
  expect(detail.messages.at(-1)?.id).toBe(id(500));
  expect(detail.hasMoreMessages).toBe(true);
  expect(detail.nextBeforeMessageId).toBe(id(421));
  expect(query.mock.calls[1][0]).toContain("ORDER BY m.position DESC LIMIT 81");
  expect(query.mock.calls[1][1]).toEqual([chatId, null]);
});

test("older-page anchor must belong to the owned chat and current generation", async () => {
  query.mockResolvedValueOnce(result([chat()])).mockResolvedValueOnce(result());
  await expect(
    chats.chatDetail(chatId, owner, false, messageId),
  ).rejects.toMatchObject({ status: 404 });
  expect(query.mock.calls[1][1]).toEqual([messageId, chatId, owner]);
  expect(query.mock.calls[1][0]).toContain("m.chat_id=$2");
  expect(query.mock.calls[1][0]).toContain("g.user_id=$3");
  expect(query.mock.calls[1][0]).toContain("g.superseded_at IS NULL");
  expect(query).toHaveBeenCalledTimes(2);
});

test("valid older page uses server-owned position instead of trusting a client offset", async () => {
  query
    .mockResolvedValueOnce(result([chat()]))
    .mockResolvedValueOnce(result([{ position: "9007199254740993" }]))
    .mockResolvedValueOnce(result());
  const detail = await chats.chatDetail(chatId, owner, false, messageId);
  expect(query.mock.calls[2][1]).toEqual([chatId, "9007199254740993"]);
  expect(detail.hasMoreMessages).toBe(false);
  expect(detail.nextBeforeMessageId).toBeNull();
});

test.each([
  { pinned: true },
  { archived: false },
  { pinned: false, archived: true },
])(
  "pin/archive mutation %p preserves owner and live-generation locks",
  async (body) => {
    query
      .mockResolvedValueOnce(result([chat()]))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(
        result([
          {
            ...chat(),
            pinned_at: body.pinned ? now : null,
            deleted_at: body.archived ? now : null,
          },
        ]),
      );
    await chats.updateChat(chatId, owner, body);
    expect(lock).toHaveBeenCalledWith(expect.anything(), owner, chatId);
    expect(realtimeGuard).toHaveBeenCalledWith(
      expect.anything(),
      owner,
      chatId,
    );
    expect(query.mock.calls[0][1]).toEqual([chatId, owner]);
    expect(query.mock.calls[1][0]).toContain("state='running'");
    expect(query.mock.calls[2][0]).toContain("WHERE id=$3 AND user_id=$4");
    expect(query.mock.calls[2][1]).toEqual([
      "Fixture",
      "gpt-4o-mini",
      chatId,
      owner,
      body.pinned ?? null,
      body.archived ?? null,
    ]);
    if (body.archived === false)
      expect(query.mock.calls[0][0]).not.toContain("deleted_at IS NULL");
  },
);

test("foreign chat cannot be restored and a running generation cannot be pinned", async () => {
  query.mockResolvedValueOnce(result());
  await expect(
    chats.updateChat(chatId, owner, { archived: false }),
  ).rejects.toMatchObject({ status: 404 });
  expect(query).toHaveBeenCalledTimes(1);
  query.mockClear();
  query
    .mockResolvedValueOnce(result([chat()]))
    .mockResolvedValueOnce(result([{ exists: 1 }]));
  await expect(
    chats.updateChat(chatId, owner, { pinned: true }),
  ).rejects.toMatchObject({ code: "GENERATION_BUSY" });
  expect(query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(
    false,
  );
});

test.each([
  { pinned: 1 },
  { archived: "false" },
  { userId: "foreign" },
  { deleted_at: null },
])("mutation rejects untrusted fields %p", async (body) => {
  await expect(chats.updateChat(chatId, owner, body)).rejects.toMatchObject({
    status: 400,
  });
  expect(query).not.toHaveBeenCalled();
});

test("file library never selects bytes/text content and uses EXISTS to avoid duplicate inherited files", async () => {
  query.mockResolvedValueOnce(
    result([
      {
        id: messageId,
        name: "fixture.txt",
        kind: "text",
        media_type: "text/plain",
        byte_size: 7,
        chat_id: chatId,
        chat_title: "Archived fixture",
        chat_archived: true,
        created_at: now,
        data: Buffer.from("private bytes"),
        text_content: "private text",
      },
    ]),
  );
  const page = await files.listWorkspaceFiles(owner, { q: "%_", chatId });
  const [sql, values] = query.mock.calls[0];
  expect(sql).toContain("a.user_id=$1 AND c.user_id=$1");
  expect(sql).toContain("AND EXISTS(");
  expect(sql).toContain("g.user_id=$1 AND g.superseded_at IS NULL");
  expect(sql).not.toMatch(/SELECT\s+a\.\*|a\.data\b|a\.text_content\b/);
  expect(values).toEqual([owner, "%_", chatId, null, null]);
  expect(page.files[0]).toMatchObject({
    id: messageId,
    chatArchived: true,
    chatId,
  });
  expect(JSON.stringify(page)).not.toContain("private");
});

test("file page cursors are owner/search/chat scoped with exact timestamp", async () => {
  query.mockResolvedValueOnce(
    result(
      Array.from({ length: 51 }, (_, n) => ({
        id: id(n),
        name: "fixture.txt",
        kind: "text",
        media_type: "text/plain",
        byte_size: 7,
        chat_id: chatId,
        chat_title: "Fixture",
        created_at: now,
        cursor_at: "2026-11-02T00:00:00.123456Z",
      })),
    ),
  );
  const first = await files.listWorkspaceFiles(owner, { chatId, q: "fixture" });
  expect(first.files).toHaveLength(50);
  query.mockResolvedValueOnce(result());
  await files.listWorkspaceFiles(owner, {
    chatId,
    q: "fixture",
    cursor: first.nextCursor,
  });
  expect(query.mock.calls[1][1]).toEqual([
    owner,
    "fixture",
    chatId,
    "2026-11-02T00:00:00.123456Z",
    id(49),
  ]);
  await expect(
    files.listWorkspaceFiles("foreign", {
      chatId,
      q: "fixture",
      cursor: first.nextCursor,
    }),
  ).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  expect(query).toHaveBeenCalledTimes(2);
});

test("cursor decoder accepts exact database microseconds but rejects non-dates", () => {
  const scope = paging.cursorScope("fixture");
  const cursor = { id: messageId, at: "2026-11-02T00:00:00.123456Z", scope };
  expect(
    paging.decodeWorkspaceCursor(paging.encodeWorkspaceCursor(cursor), scope),
  ).toEqual(cursor);
  expect(() =>
    paging.decodeWorkspaceCursor(
      paging.encodeWorkspaceCursor({ ...cursor, at: "infinity" }),
      scope,
    ),
  ).toThrow();
});
