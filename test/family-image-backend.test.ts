/** @jest-environment node */
import { jest } from "@jest/globals";
import type { PoolClient } from "pg";

const owner = "synthetic-image-owner";
const chatId = "10000000-0000-4000-8000-000000000001";
const imageModel = "gpt-image-2.5-flare";
const now = new Date("2026-11-03T00:00:00Z");
const result = (rows: Record<string, any>[] = []) => ({
  rows,
  rowCount: rows.length,
});
const query =
  jest.fn<
    (sql: string, values?: unknown[]) => Promise<ReturnType<typeof result>>
  >();
const provider = jest.fn<(args: any) => Promise<any>>();
const realtimeGuard = jest.fn(async () => {});
let generation: Record<string, any> | null;
let messages: Record<string, any>[];
let stored: Record<string, any> | null;
let status: string;
let archived: boolean;
let transactionDepth = 0;
const noNetwork = jest.fn<typeof fetch>(async () => {
  throw new Error("Network forbidden in image backend tests");
});
const originalFetch = global.fetch;
const usage = { source: "reported" as const, inputTokens: 0, outputTokens: 7 };
const generated = () => ({
  bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  width: 1024,
  height: 1024,
  mediaType: "image/jpeg",
  actualModel: null,
  usage,
});
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("next/server", () => ({
  after: (_promise: Promise<unknown>) => {},
}));
jest.unstable_mockModule("@/app/family/server/db", () => ({
  getPool: () => ({ query }),
  transaction: async (run: (client: PoolClient) => Promise<any>) => {
    transactionDepth++;
    try {
      return await run({ query } as unknown as PoolClient);
    } finally {
      transactionDepth--;
    }
  },
}));
jest.unstable_mockModule("@/app/family/server/realtime-ledger", () => ({
  lockRealtimeChat: jest.fn(async () => {}),
  assertNoRealtimeCall: realtimeGuard,
}));
jest.unstable_mockModule("@/app/family/server/image-provider", () => ({
  requestGeneratedImage: provider,
}));
const { generate, cancelGeneration, chatDetail, validatedImageOptions } =
  await import("@/app/family/server/chats");
const { modelCatalog, allowedModel, completionBody } = await import(
  "@/app/family/server/models"
);
const { digest } = await import("@/app/family/server/errors");
const { readGeneratedImage, storeGeneratedImage } = await import(
  "@/app/family/server/generated-images"
);

beforeEach(() => {
  jest.clearAllMocks();
  jest.replaceProperty(process, "env", {
    NODE_ENV: "test",
    OPENAI_API_KEY: "synthetic-image-provider-key",
    FAMILY_OPENAI_MODEL: "gpt-4o-mini",
    FAMILY_OPENAI_MODELS: "gpt-4o-mini",
  });
  global.fetch = noNetwork;
  generation = null;
  messages = [];
  stored = null;
  status = "approved";
  archived = false;
  query.mockImplementation(async (sql, values = []) => {
    if (sql.startsWith("SELECT 1 FROM family_chat"))
      return result(archived ? [] : [{ id: chatId }]);
    if (sql.startsWith("SELECT * FROM family_chat"))
      return result(
        archived
          ? []
          : [
              {
                id: chatId,
                user_id: owner,
                title: "新对话",
                model: imageModel,
                created_at: now,
                updated_at: now,
              },
            ],
      );
    if (sql.startsWith("SELECT *,EXISTS"))
      return result(generation?.request_id === values[1] ? [generation] : []);
    if (sql.startsWith("UPDATE family_generation SET state='partial'"))
      return result();
    if (sql.startsWith("SELECT chat_id FROM family_generation"))
      return result(
        generation?.state === "running" ? [{ chat_id: chatId }] : [],
      );
    if (sql.startsWith("SELECT l.message_id,a.id")) return result();
    if (sql.startsWith("SELECT count(*)"))
      return result([{ count: messages.length }]);
    if (sql.startsWith("SELECT m.id,m.generation_id")) return result();
    if (sql.startsWith("INSERT INTO family_generation")) {
      generation = {
        id: values[0],
        user_id: values[1],
        chat_id: values[2],
        request_id: values[3],
        request_hash: values[4],
        model: values[5],
        mode: values[6],
        source_generation_id: values[7],
        state: "running",
        image_size: values[8],
        image_quality: values[9],
      };
      return result();
    }
    if (sql.startsWith("INSERT INTO family_message(")) {
      messages = [
        {
          id: values[0],
          chat_id: chatId,
          generation_id: values[2],
          role: "user",
          content: values[3],
          status: "complete",
          position: 1,
          created_at: now,
        },
        {
          id: values[4],
          chat_id: chatId,
          generation_id: values[2],
          role: "assistant",
          content: "",
          status: "streaming",
          position: 2,
          created_at: now,
        },
      ];
      return result(messages);
    }
    if (
      sql.startsWith("UPDATE family_chat") ||
      sql.startsWith("INSERT INTO family_activity")
    )
      return result();
    if (sql.startsWith("SELECT cancel_requested_at"))
      return result([
        { cancel_requested_at: generation?.cancel_requested_at ?? null },
      ]);
    if (sql.startsWith('SELECT status FROM "user"')) {
      expect(transactionDepth).toBe(1);
      expect(sql).toContain("FOR SHARE");
      return result([{ status }]);
    }
    if (sql.startsWith("UPDATE family_generation SET state=$1")) {
      Object.assign(generation!, {
        state: values[0],
        input_tokens: values[1],
        output_tokens: values[2],
        usage_source: values[3],
        actual_model: values[5],
      });
      return result();
    }
    if (sql.startsWith("UPDATE family_message SET content=$1,status=$2")) {
      Object.assign(messages[1], { content: values[0], status: values[1] });
      return result([messages[1]]);
    }
    if (sql.startsWith("INSERT INTO family_generated_image")) {
      expect(transactionDepth).toBe(1);
      expect(generation?.state).toBe("complete");
      stored = {
        id: values[0],
        user_id: owner,
        chat_id: chatId,
        generation_id: generation?.id,
        message_id: messages[1].id,
        name: values[4],
        media_type: "image/jpeg",
        byte_size: values[5],
        width: values[6],
        height: values[7],
        model: values[8],
        data: values[9],
        created_at: now,
        owner_id: owner,
      };
      return result([stored]);
    }
    if (sql.startsWith("SELECT m.*,g.model AS requested_model"))
      return result(
        (sql.includes("ORDER BY m.position DESC")
          ? [...messages].reverse()
          : messages
        ).map((m) => ({
          ...m,
          requested_model: generation?.model,
          actual_model: generation?.actual_model,
          input_tokens: generation?.input_tokens,
          output_tokens: generation?.output_tokens,
          usage_source: generation?.usage_source,
          image_size: generation?.image_size,
          image_quality: generation?.image_quality,
        })),
      );
    if (sql.startsWith("SELECT i.id,i.message_id"))
      return result(stored ? [stored] : []);
    if (sql.startsWith("SELECT i.*,g.user_id")) {
      const own = values.length === 1 || values[1] === owner;
      return result(
        stored &&
          own &&
          (values.length === 1 || (!archived && !generation?.superseded_at))
          ? [stored]
          : [],
      );
    }
    if (sql.startsWith("SELECT g.id,g.state FROM family_generation"))
      return result(
        generation ? [{ id: generation.id, state: generation.state }] : [],
      );
    if (sql.startsWith("UPDATE family_generation SET cancel_requested_at")) {
      generation!.cancel_requested_at = now;
      return result();
    }
    throw new Error("Unexpected synthetic image DB query: " + sql.slice(0, 90));
  });
  provider.mockImplementation(async (args) => {
    args.onUsage?.(usage, null);
    return generated();
  });
});
afterEach(() => {
  global.fetch = originalFetch;
  expect(noNetwork).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});
const body = () => ({
  requestId: "synthetic-image-request-0001",
  model: imageModel,
  content: "A tiny blue test bird",
  imageOptions: { size: "1024x1024", quality: "low" },
});
const request = () =>
  new Request(
    "https://image.test.invalid/api/family/chats/" + chatId + "/messages",
    { method: "POST" },
  );
const events = async (response: Response) =>
  (await response.text()).split(/\r?\n\r?\n/).flatMap((frame) => {
    const data = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    return data ? [JSON.parse(data)] : [];
  });

test("curated image models remain available with a text-only env catalog and never use chat completions", () => {
  const catalog = modelCatalog();
  expect(
    catalog.models.filter((m) => m.kind === "image").map((m) => m.id),
  ).toEqual([
    imageModel,
    "gpt-image-2.5-sunburst",
    "gpt-image-1.5",
    "gpt-image-1-mini",
  ]);
  expect(catalog.models.filter((m) => m.kind !== "image")).toHaveLength(1);
  expect(() => completionBody(allowedModel(imageModel), [])).toThrow(
    "图片模型",
  );
});
test.each([
  null,
  [],
  { n: 4 },
  { size: "4096x4096" },
  { quality: "max" },
  { quality: 4 },
  { url: "https://private.invalid" },
])("rejects unsupported image options %j", (option) =>
  expect(() => validatedImageOptions(option)).toThrow(),
);

test("image request uses the image provider, atomically stores private metadata and reports true usage without raw bytes", async () => {
  const frames = await events(await generate(request(), owner, chatId, body()));
  expect(frames.map((e) => e.type)).toEqual(["start", "done"]);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(provider.mock.calls[0][0]).toMatchObject({
    model: imageModel,
    prompt: body().content,
    userId: owner,
    options: body().imageOptions,
  });
  expect(frames[1].usage).toEqual(usage);
  expect(frames[1].message.model).toBeNull();
  expect(frames[1].message.requestedModel).toBe(imageModel);
  expect(frames[1].message.generatedImages).toEqual([
    expect.objectContaining({
      width: 1024,
      height: 1024,
      mediaType: "image/jpeg",
      byteSize: 4,
      model: imageModel,
    }),
  ]);
  expect(JSON.stringify(frames)).not.toContain("dataBase64");
  expect(JSON.stringify(frames)).not.toContain('"bytes"');
  expect(JSON.stringify(frames)).not.toContain('"data"');
  expect(
    query.mock.calls.find(([sql]) =>
      sql.startsWith("UPDATE family_generation SET state='partial'"),
    )?.[0],
  ).toContain("240 seconds");
});
test("replaying the same request restores persisted image metadata with no second paid attempt", async () => {
  const first = await events(await generate(request(), owner, chatId, body()));
  const replay = await events(await generate(request(), owner, chatId, body()));
  expect(provider).toHaveBeenCalledTimes(1);
  expect(replay[1].message.generatedImages).toEqual(
    first[1].message.generatedImages,
  );
  await expect(
    generate(request(), owner, chatId, {
      ...body(),
      imageOptions: { size: "1024x1024", quality: "high" },
    }),
  ).rejects.toMatchObject({ status: 409, code: "REQUEST_CONFLICT" });
  expect(provider).toHaveBeenCalledTimes(1);
});
test("cancel committed before image finalization prevents asset publication but retains reported usage", async () => {
  let release!: (value: any) => void;
  provider.mockImplementation(
    (args) =>
      new Promise((resolve) => {
        release = (value) => {
          args.onUsage?.(usage, null);
          resolve(value);
        };
      }),
  );
  const response = await generate(request(), owner, chatId, body());
  while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
  await cancelGeneration(chatId, owner, messages[1].id);
  release(generated());
  const frames = await events(response);
  expect(frames.at(-1).type).toBe("error");
  expect(stored).toBeNull();
  expect(generation).toMatchObject({
    state: "error",
    usage_source: "reported",
    input_tokens: 0,
    output_tokens: 7,
  });
});
test("fresh account revocation wins before private image is stored", async () => {
  provider.mockImplementation(async (args) => {
    status = "disabled";
    args.onUsage?.(usage, null);
    return generated();
  });
  const frames = await events(await generate(request(), owner, chatId, body()));
  expect(frames.at(-1).type).toBe("error");
  expect(stored).toBeNull();
  expect(messages[1].content).toBe("");
  expect(generation?.state).toBe("error");
});
test("reported usage survives a provider image-decode failure", async () => {
  provider.mockImplementation(async (args) => {
    args.onUsage?.(usage, null);
    throw new Error("Synthetic decoder failure");
  });
  const frames = await events(await generate(request(), owner, chatId, body()));
  expect(frames.at(-1).type).toBe("error");
  expect(stored).toBeNull();
  expect(generation).toMatchObject({
    usage_source: "reported",
    input_tokens: 0,
    output_tokens: 7,
  });
});
test("asset storage failure never leaves an image success stub or triggers another paid attempt", async () => {
  const base = query.getMockImplementation()!;
  query.mockImplementation(async (sql, values) => {
    if (sql.startsWith("INSERT INTO family_generated_image"))
      throw new Error("Synthetic storage failure");
    return base(sql, values);
  });
  const frames = await events(await generate(request(), owner, chatId, body()));
  expect(frames.at(-1).type).toBe("error");
  expect(messages[1]).toMatchObject({ content: "", status: "error" });
  expect(generation).toMatchObject({
    state: "error",
    usage_source: "reported",
    input_tokens: 0,
    output_tokens: 7,
  });
  expect(stored).toBeNull();
  expect(provider).toHaveBeenCalledTimes(1);
});
test("owner detail reload restores image metadata and private asset ownership/archive/supersession gates", async () => {
  await events(await generate(request(), owner, chatId, body()));
  const detail = await chatDetail(chatId, owner);
  expect(detail.messages[1].generatedImages).toHaveLength(1);
  await expect(
    readGeneratedImage(stored!.id, "foreign-synthetic-owner"),
  ).rejects.toMatchObject({ status: 404 });
  const own = await readGeneratedImage(stored!.id, owner);
  expect(own.bytes).toEqual(generated().bytes);
  generation!.superseded_at = now;
  await expect(readGeneratedImage(stored!.id, owner)).rejects.toMatchObject({
    status: 404,
  });
  archived = true;
  await expect(readGeneratedImage(stored!.id, owner)).rejects.toMatchObject({
    status: 404,
  });
  await expect(readGeneratedImage(stored!.id)).resolves.toMatchObject({
    ownerId: owner,
    chatId,
  });
  const sql = query.mock.calls.filter(([q]) =>
    q.startsWith("SELECT i.*,g.user_id"),
  );
  expect(sql[0][0]).toContain("c.user_id=$2");
  expect(sql[0][0]).toContain("g.superseded_at IS NULL");
  expect(sql.at(-1)![0]).not.toContain("c.deleted_at IS NULL");
});

test("generated asset byte limits use the same inclusive 4 MiB boundary as provider and browser", async () => {
  generation = {
    id: "10000000-0000-4000-8000-000000000003",
    state: "complete",
  };
  messages = [{}, { id: "10000000-0000-4000-8000-000000000004" }];
  const bytes = Buffer.alloc(4 * 1024 * 1024);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  // This helper is used only within finishGeneration's transaction.
  transactionDepth++;
  try {
    const saved = await storeGeneratedImage(
      { query } as any,
      owner,
      generation.id,
      messages[1].id,
      {
        bytes,
        width: 1024,
        height: 1024,
        mediaType: "image/jpeg",
        model: imageModel,
      },
    );
    expect(saved.byteSize).toBe(4194304);
  } finally {
    transactionDepth--;
  }
  query.mockClear();
  const over = Buffer.alloc(4194305);
  over[0] = 0xff;
  over[1] = 0xd8;
  await expect(
    storeGeneratedImage(
      { query } as any,
      owner,
      generation.id,
      messages[1].id,
      {
        bytes: over,
        width: 1024,
        height: 1024,
        mediaType: "image/jpeg",
        model: imageModel,
      },
    ),
  ).rejects.toMatchObject({ code: "INVALID_GENERATED_IMAGE" });
  expect(query).not.toHaveBeenCalled();
});
