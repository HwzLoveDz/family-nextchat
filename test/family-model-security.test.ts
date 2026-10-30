/** @jest-environment node */

import { jest } from "@jest/globals";

type QueryResult = { rows: Record<string, any>[]; rowCount: number };
const result = (rows: Record<string, any>[] = []): QueryResult => ({
  rows,
  rowCount: rows.length,
});
const poolQuery =
  jest.fn<(sql: string, values?: unknown[]) => Promise<QueryResult>>();
const clientQuery =
  jest.fn<(sql: string, values?: unknown[]) => Promise<QueryResult>>();
const release = jest.fn();
const end = jest.fn(async () => {});
const poolOptions: Record<string, unknown>[] = [];

class FixturePool {
  constructor(options: Record<string, unknown>) {
    poolOptions.push(options);
  }
  query = poolQuery;
  on() {}
  end = end;
  async connect() {
    return { query: clientQuery, release };
  }
}

jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("pg", () => ({ Pool: FixturePool }));

const database = await import("@/app/family/server/db");
const upgrades = await import("@/app/family/server/upgrades");
const models = await import("@/app/family/server/models");
const { FamilyApiError, digest } = await import("@/app/family/server/errors");
const chats = await import("@/app/family/server/chats");
const { OpenAIStreamDecoder } = await import(
  "@/app/family/server/openai-stream"
);

describe("family application upgrade boundaries", () => {
  const initialNodeEnv = process.env.NODE_ENV;
  const initialVercelEnv = process.env.VERCEL_ENV;
  const initialSchema = process.env.FAMILY_DATABASE_SCHEMA;
  const initialModel = process.env.FAMILY_OPENAI_MODEL;
  const initialModels = process.env.FAMILY_OPENAI_MODELS;
  const initialFetch = global.fetch;
  const fetchMock = jest.fn<typeof fetch>(async () => {
    throw new Error("Outbound network is forbidden in model boundary tests");
  });

  beforeEach(async () => {
    await database.closeFamilyDatabase();
    jest.clearAllMocks();
    poolOptions.length = 0;
    Reflect.set(process.env, "NODE_ENV", "test");
    process.env.VERCEL_ENV = "preview";
    delete process.env.FAMILY_DATABASE_SCHEMA;
    process.env.FAMILY_OPENAI_MODEL = "gpt-4o-mini";
    process.env.FAMILY_OPENAI_MODELS = "gpt-4o-mini";
    // These are synthetic fixtures. No real credential or connection string is read.
    process.env.DATABASE_URL =
      "postgresql://fixture:fixture@database.test.invalid/family?sslmode=require";
    process.env.OPENAI_API_KEY = "fixture-not-a-real-provider-key";
    global.fetch = fetchMock;
    poolQuery.mockImplementation(async (sql) => {
      throw new Error(`Unexpected fixture query: ${sql.slice(0, 70)}`);
    });
    clientQuery.mockImplementation(async () => result());
  });

  afterEach(async () => {
    await database.closeFamilyDatabase();
    global.fetch = initialFetch;
    delete process.env.DATABASE_URL;
    delete process.env.OPENAI_API_KEY;
    if (initialNodeEnv === undefined)
      Reflect.deleteProperty(process.env, "NODE_ENV");
    else Reflect.set(process.env, "NODE_ENV", initialNodeEnv);
    if (initialVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = initialVercelEnv;
    if (initialSchema === undefined) delete process.env.FAMILY_DATABASE_SCHEMA;
    else process.env.FAMILY_DATABASE_SCHEMA = initialSchema;
    if (initialModel === undefined) delete process.env.FAMILY_OPENAI_MODEL;
    else process.env.FAMILY_OPENAI_MODEL = initialModel;
    if (initialModels === undefined) delete process.env.FAMILY_OPENAI_MODELS;
    else process.env.FAMILY_OPENAI_MODELS = initialModels;
    expect(fetchMock).not.toHaveBeenCalled();
  });

  function readyMetadata(columns = true) {
    return result([{ version_table_exists: true, columns_ready: columns }]);
  }

  test("an initialized old database reports an upgrade requirement without issuing DDL", async () => {
    poolQuery.mockResolvedValueOnce(
      result([{ version_table_exists: false, columns_ready: false }]),
    );
    await expect(upgrades.applicationUpgradeStatus()).resolves.toEqual({
      schemaReady: false,
      schemaVersion: 0,
    });
    expect(poolQuery).toHaveBeenCalledTimes(1);
    expect(poolQuery.mock.calls[0][0].trim()).toMatch(/^SELECT\b/);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  test("ordinary requests fail closed until the application upgrade is present", async () => {
    poolQuery.mockResolvedValueOnce(
      result([{ version_table_exists: false, columns_ready: false }]),
    );
    await expect(
      upgrades.requireFamilyApplicationUpgrade(),
    ).rejects.toMatchObject({
      status: 503,
      code: "APPLICATION_UPGRADE_REQUIRED",
    });
    expect(clientQuery).not.toHaveBeenCalled();
  });

  test("a version marker alone cannot enable requests when required columns are missing", async () => {
    poolQuery
      .mockResolvedValueOnce(readyMetadata(false))
      .mockResolvedValueOnce(result([{ version: 2 }]));
    await expect(
      upgrades.requireFamilyApplicationUpgrade(),
    ).rejects.toBeInstanceOf(FamilyApiError);
    expect(
      poolQuery.mock.calls.every(([sql]) => /^SELECT\b/.test(sql.trim())),
    ).toBe(true);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  test.each([undefined, 0, 1, "2", -1])(
    "missing, old, or invalid version %p cannot pass readiness",
    async (version) => {
      poolQuery
        .mockResolvedValueOnce(readyMetadata())
        .mockResolvedValueOnce(
          result(version === undefined ? [] : [{ version }]),
        );
      await expect(
        upgrades.requireFamilyApplicationUpgrade(),
      ).rejects.toMatchObject({
        code: "APPLICATION_UPGRADE_REQUIRED",
      });
    },
  );

  test("a complete v2 schema is accepted through SELECTs alone", async () => {
    poolQuery
      .mockResolvedValueOnce(readyMetadata())
      .mockResolvedValueOnce(result([{ version: 2 }]));
    await expect(
      upgrades.requireFamilyApplicationUpgrade(),
    ).resolves.toBeUndefined();
    expect(
      poolQuery.mock.calls.every(([sql]) => /^SELECT\b/.test(sql.trim())),
    ).toBe(true);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  test("explicit upgrade takes the shared schema lock and commits additive application DDL", async () => {
    await upgrades.ensureFamilyApplicationUpgrade();
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock(714209830)",
      upgrades.FAMILY_APPLICATION_UPGRADE_SQL,
      "COMMIT",
    ]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(poolQuery).not.toHaveBeenCalled();
    // No destructive operation or auth/account rewrite belongs in this upgrade.
    expect(upgrades.FAMILY_APPLICATION_UPGRADE_SQL).not.toMatch(
      /\b(?:DROP|DELETE|TRUNCATE)\b|\b(?:UPDATE|ALTER\s+TABLE)\s+"?(?:user|session|account)"?\b/i,
    );
    expect(upgrades.FAMILY_APPLICATION_UPGRADE_SQL).toContain(
      "GREATEST(family_schema_version.version,EXCLUDED.version)",
    );
  });

  test("failed upgrade rolls back instead of advertising a completed version", async () => {
    clientQuery.mockImplementation(async (sql) => {
      if (sql === upgrades.FAMILY_APPLICATION_UPGRADE_SQL)
        throw new Error("synthetic migration failure");
      return result();
    });
    await expect(upgrades.ensureFamilyApplicationUpgrade()).rejects.toThrow(
      "synthetic migration failure",
    );
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock(714209830)",
      upgrades.FAMILY_APPLICATION_UPGRADE_SQL,
      "ROLLBACK",
    ]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("explicit Preview migration creates only its validated schema after acquiring the shared lock", async () => {
    process.env.FAMILY_DATABASE_SCHEMA = "family_test_0123456789abcdef";
    await upgrades.ensureFamilyApplicationUpgrade();
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock(714209830)",
      'CREATE SCHEMA IF NOT EXISTS "family_test_0123456789abcdef"',
      upgrades.FAMILY_APPLICATION_UPGRADE_SQL,
      "COMMIT",
    ]);
  });

  test.each(["production", undefined])(
    "a production runtime with deployment marker %p rejects a test schema before Pool construction",
    (deployment) => {
      Reflect.set(process.env, "NODE_ENV", "production");
      if (deployment === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = deployment;
      process.env.FAMILY_DATABASE_SCHEMA = "family_test_0123456789abcdef";
      expect(() => database.getPool()).toThrow(
        "TEST_SCHEMA_FORBIDDEN_IN_PRODUCTION",
      );
      expect(poolOptions).toHaveLength(0);
    },
  );

  test("a Vercel Preview production build pins search_path to its own validated schema", () => {
    Reflect.set(process.env, "NODE_ENV", "production");
    process.env.VERCEL_ENV = "preview";
    process.env.FAMILY_DATABASE_SCHEMA = "family_test_0123456789abcdef";
    database.getPool();
    expect(poolOptions).toHaveLength(1);
    expect(poolOptions[0].options).toBe(
      "-c search_path=family_test_0123456789abcdef",
    );
    expect(String(poolOptions[0].options)).not.toContain("public");
    expect(
      new URL(String(poolOptions[0].connectionString)).searchParams.get(
        "sslmode",
      ),
    ).toBe("verify-full");
  });

  test.each([
    "public",
    "family_test_0123456789abcde",
    "family_test_0123456789abcdef,public",
    "family_test_0123456789abcdef;DROP SCHEMA public",
  ])("invalid schema %p cannot become a PostgreSQL option", (schema) => {
    process.env.FAMILY_DATABASE_SCHEMA = schema;
    expect(() => database.getPool()).toThrow("INVALID_TEST_SCHEMA");
    expect(poolOptions).toHaveLength(0);
  });

  test("the catalog exposes only configured static profiles and deduplicates them", () => {
    process.env.FAMILY_OPENAI_MODELS = " gpt-4o-mini, gpt-5-mini,gpt-4o-mini ";
    const catalog = models.modelCatalog();
    expect(catalog.defaultModel).toBe("gpt-4o-mini");
    expect(catalog.models.map((model) => model.id)).toEqual([
      "gpt-4o-mini",
      "gpt-5-mini",
    ]);
    for (const model of catalog.models)
      expect(Object.keys(model).sort()).toEqual([
        "description",
        "id",
        "name",
        "reasoning",
      ]);
    expect(poolOptions).toHaveLength(0);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  test.each([
    "",
    "gpt-5-mini",
    "gpt-4o-mini,https://collector.test.invalid/model",
    "gpt-4o-mini,__proto__",
    "gpt-4o-mini,constructor",
  ])("unsafe or incomplete server catalog %p fails closed", (catalog) => {
    process.env.FAMILY_OPENAI_MODELS = catalog;
    expect(() => models.modelCatalog()).toThrow(
      expect.objectContaining({
        status: 503,
        code: "MODEL_CATALOG_MISCONFIGURED",
      }),
    );
  });

  test.each([
    "gpt-4o",
    "https://collector.test.invalid/v1/chat/completions",
    "gpt-4o-mini ",
    "__proto__",
    { id: "gpt-4o-mini", baseURL: "https://collector.test.invalid" },
    null,
  ])("client model claim %p cannot escape the allowlist", (claim) => {
    expect(() => models.allowedModel(claim)).toThrow(
      expect.objectContaining({ status: 400, code: "MODEL_NOT_ALLOWED" }),
    );
    expect(poolQuery).not.toHaveBeenCalled();
  });

  test("completion payload uses an admitted model and fixed server output limits", () => {
    process.env.FAMILY_OPENAI_MODELS = "gpt-4o-mini,gpt-5-mini";
    const payload = models.completionBody(models.allowedModel("gpt-5-mini"), [
      { role: "user", content: "Synthetic test only" },
    ]);
    expect(payload).toEqual({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "Synthetic test only" }],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 2048,
      reasoning_effort: "low",
    });
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("baseURL");
    expect(payload).not.toHaveProperty("apiKey");
  });

  const chatId = "11111111-1111-4111-8111-111111111111";
  const sourceMessageId = "22222222-2222-4222-8222-222222222222";
  const generationId = "33333333-3333-4333-8333-333333333333";
  const userId = "fixture-member-a";
  const content = "Synthetic existing question";
  const requestId = "fixture-request-123";
  const date = new Date("2026-01-01T00:00:00.000Z");
  const request = () =>
    new Request("https://preview.test.invalid/api/family/chats");
  const chatRow = () => ({
    id: chatId,
    user_id: userId,
    model: "gpt-4o-mini",
    title: "Synthetic conversation",
    deleted_at: null,
    created_at: date,
    updated_at: date,
  });
  function legacyGeneration() {
    return {
      id: generationId,
      user_id: userId,
      chat_id: chatId,
      model: "gpt-4o-mini",
      request_id: requestId,
      request_hash: digest(JSON.stringify({ chatId, content })),
      state: "complete",
      usage_source: "unknown",
      input_tokens: null,
      output_tokens: null,
      actual_model: null,
      superseded_at: null,
    };
  }
  function configurePreparation(
    options: {
      existing?: Record<string, any>;
      source?: Record<string, any>;
      last?: Record<string, any>;
    } = {},
  ) {
    poolQuery.mockImplementation(async (sql, values) => {
      if (sql.startsWith("SELECT 1 FROM family_chat")) {
        expect(values).toEqual([chatId, userId]);
        return result([{ exists: 1 }]);
      }
      throw new Error("Unexpected nontransaction fixture query");
    });
    clientQuery.mockImplementation(async (sql, values) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return result();
      if (sql.startsWith("SELECT pg_advisory_xact_lock")) return result();
      if (sql.startsWith("SELECT * FROM family_chat")) {
        expect(sql).toContain("user_id=$2 AND deleted_at IS NULL FOR UPDATE");
        expect(values).toEqual([chatId, userId]);
        return result([chatRow()]);
      }
      if (sql.startsWith("SELECT * FROM family_generation")) {
        expect(values).toEqual([userId, requestId]);
        return result(options.existing ? [options.existing] : []);
      }
      if (sql.startsWith("SELECT m.*,g.model AS requested_model"))
        return result([
          {
            id: sourceMessageId,
            role: "user",
            content,
            status: "complete",
            requested_model: options.existing?.model,
            actual_model: null,
            created_at: date,
          },
          {
            id: "44444444-4444-4444-8444-444444444444",
            role: "assistant",
            content: "Synthetic historical reply",
            status: "complete",
            requested_model: options.existing?.model,
            actual_model: null,
            usage_source: "unknown",
            created_at: date,
          },
        ]);
      if (sql.startsWith("UPDATE family_generation SET state='partial'"))
        return result();
      if (sql.startsWith("SELECT chat_id FROM family_generation"))
        return result();
      if (sql.startsWith("SELECT g.id,g.state,m.role")) {
        expect(sql).toContain("g.chat_id=$1 AND g.user_id=$2 AND m.id=$3");
        expect(values).toEqual([chatId, userId, sourceMessageId]);
        return result(options.source ? [options.source] : []);
      }
      if (sql.startsWith("SELECT g.id,g.state,u.id")) {
        expect(sql).toContain("g.superseded_at IS NULL");
        return result(options.last ? [options.last] : []);
      }
      throw new Error(
        `Unexpected fixture transaction query: ${sql.slice(0, 80)}`,
      );
    });
  }

  test.each([undefined, "gpt-4o-mini"])(
    "legacy request replay with matching model %p returns old messages without a new generation",
    async (model) => {
      configurePreparation({ existing: legacyGeneration() });
      const response = await chats.generate(request(), userId, chatId, {
        content,
        requestId,
        ...(model === undefined ? {} : { model }),
      });
      const events = (await response.text())
        .split("\n\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line.slice(6)));
      expect(events.map((event) => event.type)).toEqual(["start", "done"]);
      expect(events[1].message).toMatchObject({
        content: "Synthetic historical reply",
        model: null,
        requestedModel: "gpt-4o-mini",
      });
      expect(
        clientQuery.mock.calls.some(([sql]) => /^INSERT\b/.test(sql)),
      ).toBe(false);
    },
  );

  test.each(["gpt-5-mini", "https://collector.test.invalid/model"])(
    "legacy hash cannot be reused with a different requested model %p",
    async (model) => {
      configurePreparation({ existing: legacyGeneration() });
      await expect(
        chats.generate(request(), userId, chatId, {
          content,
          requestId,
          model,
        }),
      ).rejects.toMatchObject({ status: 409, code: "REQUEST_CONFLICT" });
      expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
      expect(
        clientQuery.mock.calls.some(([sql]) => /^INSERT\b/.test(sql)),
      ).toBe(false);
    },
  );

  test("legacy hash from another conversation cannot replay even if its supplied hash matches", async () => {
    configurePreparation({
      existing: {
        ...legacyGeneration(),
        chat_id: "55555555-5555-4555-8555-555555555555",
      },
    });
    await expect(
      chats.generate(request(), userId, chatId, { content, requestId }),
    ).rejects.toMatchObject({ status: 409, code: "REQUEST_CONFLICT" });
  });

  test("superseded historical requests cannot resurrect a hidden old reply", async () => {
    configurePreparation({
      existing: { ...legacyGeneration(), superseded_at: date },
    });
    await expect(
      chats.generate(request(), userId, chatId, { content, requestId }),
    ).rejects.toMatchObject({ status: 409, code: "REQUEST_SUPERSEDED" });
  });

  test("a nonowner is rejected before generation or source lookup", async () => {
    poolQuery.mockResolvedValueOnce(result());
    await expect(
      chats.generate(request(), "fixture-member-b", chatId, {
        requestId,
        mode: "regenerate",
        sourceMessageId,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(poolQuery.mock.calls[0][1]).toEqual([chatId, "fixture-member-b"]);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  test.each([
    { baseURL: "https://collector.test.invalid" },
    { userId: "fixture-member-b" },
    { provider: "openai" },
    { sourceMessageId },
  ])(
    "send does not accept hidden model, owner or source controls %p",
    async (extra) => {
      configurePreparation();
      await expect(
        chats.generate(request(), userId, chatId, {
          content,
          requestId,
          ...extra,
        }),
      ).rejects.toMatchObject({ status: 400 });
      expect(clientQuery).not.toHaveBeenCalled();
    },
  );

  test("a source from another owner or conversation is absent from the bound source lookup", async () => {
    configurePreparation();
    await expect(
      chats.generate(request(), userId, chatId, {
        requestId,
        mode: "regenerate",
        sourceMessageId,
      }),
    ).rejects.toMatchObject({ status: 404, code: "MESSAGE_NOT_FOUND" });
  });

  test("editing an older turn is rejected before superseding or creating anything", async () => {
    configurePreparation({
      source: { id: generationId, role: "user", state: "complete" },
      last: { id: "55555555-5555-4555-8555-555555555555", state: "complete" },
    });
    await expect(
      chats.generate(request(), userId, chatId, {
        requestId,
        mode: "edit",
        sourceMessageId,
        content: "Synthetic edited question",
      }),
    ).rejects.toMatchObject({ status: 409, code: "LAST_TURN_ONLY" });
    expect(
      clientQuery.mock.calls.some(([sql]) =>
        /superseded_at=now|^INSERT\b/.test(sql),
      ),
    ).toBe(false);
  });

  test.each([
    ["retry", "complete", "RETRY_REQUIRES_FAILURE"],
    ["regenerate", "partial", "REGENERATE_REQUIRES_COMPLETE"],
  ])(
    "%s cannot operate on an incompatible last-turn state %s",
    async (mode, state, code) => {
      configurePreparation({
        source: { id: generationId, role: "assistant", state },
        last: { id: generationId, state },
      });
      await expect(
        chats.generate(request(), userId, chatId, {
          requestId,
          mode,
          sourceMessageId,
        }),
      ).rejects.toMatchObject({ status: 409, code });
    },
  );

  test("chat detail preserves the stored per-generation model instead of the current preference", async () => {
    poolQuery
      .mockResolvedValueOnce(result([{ ...chatRow(), model: "gpt-5-mini" }]))
      .mockResolvedValueOnce(
        result([
          {
            id: sourceMessageId,
            role: "assistant",
            content: "Synthetic historical reply",
            status: "complete",
            requested_model: "gpt-4o-mini",
            actual_model: "gpt-4o-mini-2024-07-18",
            superseded_at: null,
            created_at: date,
          },
        ]),
      );
    const detail = await chats.chatDetail(chatId, userId);
    expect(detail.chat.model).toBe("gpt-5-mini");
    expect(detail.messages[0]).toMatchObject({
      requestedModel: "gpt-4o-mini",
      model: "gpt-4o-mini-2024-07-18",
    });
    expect(poolQuery.mock.calls[0][0]).toContain("AND user_id=$2");
    expect(poolQuery.mock.calls[1][0]).toContain("g.superseded_at IS NULL");
  });

  test("upstream absence of model identity stays unknown and conflicting model identities are rejected", () => {
    const parser = new OpenAIStreamDecoder(() => {});
    const frame = (data: unknown) =>
      new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
    parser.write(
      frame({ choices: [{ delta: { content: "Synthetic reply" } }] }),
    );
    expect(parser.actualModel).toBeNull();
    parser.write(frame({ model: "gpt-4o-mini-2024-07-18", choices: [] }));
    expect(parser.actualModel).toBe("gpt-4o-mini-2024-07-18");
    expect(() =>
      parser.write(frame({ model: "different-model", choices: [] })),
    ).toThrow(expect.objectContaining({ status: 502 }));
  });
});
