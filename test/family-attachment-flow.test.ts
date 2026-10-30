/** @jest-environment node */
import { jest } from "@jest/globals";
import type { PoolClient } from "pg";

const chatId = "11111111-1111-4111-8111-111111111111",
  userId = "fixture-member",
  userMessageId = "22222222-2222-4222-8222-222222222222",
  assistantId = "33333333-3333-4333-8333-333333333333",
  generationId = "44444444-4444-4444-8444-444444444444";
const date = new Date("2026-01-01T00:00:00Z");
const result = (rows: Record<string, any>[] = []) => ({
  rows,
  rowCount: rows.length,
});
const query =
  jest.fn<
    (sql: string, values?: unknown[]) => Promise<ReturnType<typeof result>>
  >();
const afterJobs: Promise<unknown>[] = [];
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("next/server", () => ({
  after: (job: Promise<unknown>) => afterJobs.push(job),
}));
jest.unstable_mockModule("@/app/family/server/pdf-check", () => ({
  inspectFamilyPdf: async () => ({ pages: 1 }),
}));
jest.unstable_mockModule("@/app/family/server/db", () => ({
  getPool: () => ({ query }),
  transaction: async (run: (client: PoolClient) => Promise<unknown>) => {
    await query("BEGIN");
    try {
      const value = await run({ query } as unknown as PoolClient);
      await query("COMMIT");
      return value;
    } catch (error) {
      await query("ROLLBACK");
      throw error;
    }
  },
}));
const chats = await import("@/app/family/server/chats");
const { digest } = await import("@/app/family/server/errors");
const attachments = await import("@/app/family/server/attachments");
const originalFetch = global.fetch;
const fetchMock = jest.fn<typeof fetch>();
const input = (text = "Fixture file", name = "note.txt") => ({
  name,
  mediaType: "text/plain",
  dataBase64: Buffer.from(text).toString("base64"),
});
let existing: Record<string, any> | undefined,
  foreign = false,
  quota = false,
  savedHash: string | undefined;
let linkedRows: Record<string, any>[],
  insertedMessageRows: Record<string, any>[],
  lastState = "complete";
const sourceRow = () => ({
  id: generationId,
  state: lastState,
  role: "assistant",
});
beforeEach(() => {
  query.mockReset();
  fetchMock.mockReset();
  afterJobs.length = 0;
  existing = undefined;
  foreign = false;
  quota = false;
  savedHash = undefined;
  linkedRows = [];
  insertedMessageRows = [];
  lastState = "complete";
  process.env.OPENAI_API_KEY = "fixture-not-a-real-provider-key";
  process.env.FAMILY_OPENAI_MODEL = "gpt-4o-mini";
  process.env.FAMILY_OPENAI_MODELS = "gpt-4o-mini,gpt-5-mini";
  global.fetch = fetchMock;
  fetchMock.mockImplementation(async (url) => {
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    return new Response(
      'data: {"model":"gpt-4o-mini","choices":[{"delta":{"content":"Fixture reply"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\ndata: [DONE]\n\n',
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  query.mockImplementation(async (sql, values = []) => {
    if (
      ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) ||
      sql.startsWith("SELECT pg_advisory_xact_lock")
    )
      return result();
    if (sql.startsWith("SELECT 1 FROM family_chat"))
      return result(foreign ? [] : [{ exists: 1 }]);
    if (sql.startsWith("SELECT * FROM family_chat"))
      return result(
        foreign
          ? []
          : [
              {
                id: chatId,
                user_id: userId,
                model: "gpt-4o-mini",
                title: "新对话",
                created_at: date,
                updated_at: date,
              },
            ],
      );
    if (sql.startsWith("SELECT *,EXISTS"))
      return result(existing ? [existing] : []);
    if (sql.startsWith("SELECT m.*,g.model"))
      return result([
        {
          id: userMessageId,
          role: "user",
          content: "Fixture question",
          status: "complete",
          created_at: date,
        },
        {
          id: assistantId,
          role: "assistant",
          content: "Old reply",
          status: "complete",
          created_at: date,
        },
      ]);
    if (sql.startsWith("SELECT l.message_id")) return result(linkedRows);
    if (
      sql.startsWith("UPDATE family_generation SET state='partial'") ||
      sql.startsWith("SELECT chat_id FROM family_generation")
    )
      return result();
    if (sql.startsWith("SELECT g.id,g.state,m.role"))
      return result([sourceRow()]);
    if (sql.startsWith("SELECT g.id,g.state,u.id"))
      return result([
        {
          id: generationId,
          state: lastState,
          user_message_id: userMessageId,
          user_content: "Fixture question",
          assistant_message_id: assistantId,
        },
      ]);
    if (sql.startsWith("SELECT count(*)::int")) return result([{ count: 2 }]);
    if (sql.startsWith("SELECT m.id,m.generation_id")) return result();
    if (sql.startsWith("INSERT INTO family_generation(")) {
      savedHash = values[4] as string;
      return result();
    }
    if (sql.startsWith("INSERT INTO family_message(")) {
      insertedMessageRows = [
        {
          id: values[0],
          role: "user",
          content: values[3],
          status: "complete",
          created_at: date,
        },
        {
          id: values[4],
          role: "assistant",
          content: "",
          status: "streaming",
          created_at: date,
        },
      ];
      return result(insertedMessageRows);
    }
    if (sql.includes("AS site_bytes"))
      return result([
        {
          site_bytes: quota ? String(attachments.ATTACHMENT_SITE_QUOTA) : "0",
          user_bytes: "0",
        },
      ]);
    if (
      sql.startsWith("INSERT INTO family_attachment(") ||
      sql.startsWith("INSERT INTO family_message_attachment") ||
      sql.startsWith("UPDATE family_generation SET superseded_at") ||
      sql.startsWith("UPDATE family_chat SET") ||
      sql.startsWith("INSERT INTO family_activity")
    )
      return result();
    if (sql.startsWith("SELECT cancel_requested_at"))
      return result([{ cancel_requested_at: null }]);
    if (sql.startsWith("UPDATE family_generation SET state=$1"))
      return result();
    if (sql.startsWith("UPDATE family_message SET content=$1"))
      return result([
        {
          id: values[2],
          role: "assistant",
          content: values[0],
          status: values[1],
          created_at: date,
        },
      ]);
    throw new Error("Unexpected offline fixture query: " + sql.slice(0, 60));
  });
});
afterEach(async () => {
  await Promise.all(afterJobs);
  global.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
  delete process.env.FAMILY_OPENAI_MODEL;
  delete process.env.FAMILY_OPENAI_MODELS;
});
async function generate(body: Record<string, unknown>) {
  const response = await chats.generate(
    new Request("https://fixture.test.invalid/api/family/chats"),
    userId,
    chatId,
    { requestId: "fixture-request-123", ...body },
  );
  const bodyText = await response.text();
  await Promise.all(afterJobs);
  return bodyText;
}
function oldGeneration(hash: string, hasAttachments = false) {
  return {
    id: generationId,
    chat_id: chatId,
    user_id: userId,
    model: "gpt-4o-mini",
    request_hash: hash,
    state: "complete",
    has_attachments: hasAttachments,
    usage_source: "unknown",
    input_tokens: null,
    output_tokens: null,
  };
}

test("attachment-only send saves one private blob atomically and includes its text in fixed upstream payload", async () => {
  const stream = await generate({ content: "", attachments: [input()] });
  const start = JSON.parse(stream.split("\n\n")[0].slice(6));
  expect(start.userMessage.content).toBe("请分析这些附件。");
  expect(start.userMessage.attachments).toEqual([
    expect.objectContaining({ name: "note.txt", kind: "text", byteSize: 12 }),
  ]);
  expect(JSON.stringify(start)).not.toContain("dataBase64");
  const payload = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
  expect(payload.messages[0].content[1].text).toContain("Fixture file");
  const sql = query.mock.calls.map(([sql]) => sql);
  expect(
    sql.filter((value) => value.startsWith("INSERT INTO family_attachment(")),
  ).toHaveLength(1);
  expect(sql.indexOf("COMMIT")).toBeGreaterThan(
    sql.findIndex((value) =>
      value.startsWith("INSERT INTO family_message_attachment"),
    ),
  );
  expect(stream).toContain('"inputTokens":12');
});
test("the same attachment request replays without inserting bytes or making a second provider request", async () => {
  const files = [input()];
  await generate({ content: "Fixture question", attachments: files });
  const hash = savedHash!;
  fetchMock.mockClear();
  query.mockClear();
  afterJobs.length = 0;
  existing = oldGeneration(hash, true);
  linkedRows = [
    {
      message_id: userMessageId,
      id: "saved-file",
      name: "note.txt",
      kind: "text",
      media_type: "text/plain; charset=utf-8",
      byte_size: 12,
    },
  ];
  const stream = await generate({
    content: "Fixture question",
    attachments: files,
  });
  expect(stream).toContain("saved-file");
  expect(fetchMock).not.toHaveBeenCalled();
  expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
});
test("changed bytes or order under a reused request ID conflicts before any provider call", async () => {
  await generate({
    content: "Fixture question",
    attachments: [input("first"), input("second", "other.txt")],
  });
  existing = oldGeneration(savedHash!, true);
  fetchMock.mockClear();
  afterJobs.length = 0;
  await expect(
    generate({
      content: "Fixture question",
      attachments: [input("second", "other.txt"), input("first")],
    }),
  ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  await expect(
    generate({
      content: "Fixture question",
      attachments: [input("changed"), input("second", "other.txt")],
    }),
  ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  expect(fetchMock).not.toHaveBeenCalled();
});
test("legacy hash compatibility requires both original DB links and incoming attachments to be empty", async () => {
  existing = oldGeneration(
    digest(JSON.stringify({ chatId, content: "Fixture question" })),
    true,
  );
  await expect(generate({ content: "Fixture question" })).rejects.toMatchObject(
    { code: "REQUEST_CONFLICT" },
  );
  existing = oldGeneration(
    digest(JSON.stringify({ chatId, content: "Fixture question" })),
    false,
  );
  await expect(
    generate({ content: "Fixture question", attachments: [input()] }),
  ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  expect(fetchMock).not.toHaveBeenCalled();
});
test.each(["edit", "retry", "regenerate"])(
  "%s rejects client attachment replacement instead of trusting user-selected source files",
  async (mode) => {
    await expect(
      generate({
        mode,
        sourceMessageId: userMessageId,
        ...(mode === "edit" ? { content: "Edited" } : {}),
        attachments: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_MESSAGE_PARAMETERS" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql === "BEGIN")).toBe(false);
  },
);
test.each(["retry", "regenerate"])(
  "%s inherits the owned source attachment without copying its bytes or quota",
  async (mode) => {
    lastState = mode === "retry" ? "partial" : "complete";
    linkedRows = [
      {
        message_id: userMessageId,
        id: "source-file",
        name: "note.txt",
        kind: "text",
        media_type: "text/plain; charset=utf-8",
        byte_size: 12,
        data: Buffer.from("Fixture file"),
        text_content: "Fixture file",
        text_characters: 12,
      },
    ];
    const stream = await generate({ mode, sourceMessageId: assistantId });
    expect(stream).toContain("source-file");
    expect(
      query.mock.calls.some(([sql]) =>
        sql.startsWith("INSERT INTO family_attachment("),
      ),
    ).toBe(false);
    expect(
      query.mock.calls.some(([sql]) => sql.includes("AS site_bytes")),
    ).toBe(false);
    expect(
      query.mock.calls.some(
        ([sql, values]) =>
          sql.startsWith("INSERT INTO family_message_attachment") &&
          values?.[1] === userMessageId,
      ),
    ).toBe(true);
    expect(
      JSON.parse(fetchMock.mock.calls[0][1]!.body as string).messages[0]
        .content[1].text,
    ).toContain("Fixture file");
  },
);
test("quota failure rolls back message/blob transaction and never sends a provider request", async () => {
  quota = true;
  await expect(
    generate({ content: "Fixture question", attachments: [input()] }),
  ).rejects.toMatchObject({ code: "ATTACHMENT_QUOTA_EXCEEDED" });
  expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  expect(fetchMock).not.toHaveBeenCalled();
});
test("foreign chat ownership rejects before file parsing or any attachment lookup", async () => {
  foreign = true;
  await expect(
    generate({
      content: "Question",
      attachments: [
        { name: "foreign", mediaType: "image/jpeg", dataBase64: "bad" },
      ],
    }),
  ).rejects.toMatchObject({ status: 404 });
  expect(query).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});
test("an image/PDF unsupported model fails before INSERT or generation", async () => {
  await expect(
    generate({
      model: "gpt-5-mini",
      content: "Question",
      attachments: [
        {
          name: "file.pdf",
          mediaType: "application/pdf",
          dataBase64: Buffer.from("%PDF-fixture").toString("base64"),
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "MODEL_ATTACHMENT_UNSUPPORTED" });
  expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
    false,
  );
  expect(fetchMock).not.toHaveBeenCalled();
});
