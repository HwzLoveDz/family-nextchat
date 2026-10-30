/** @jest-environment node */
import { jest } from "@jest/globals";

const result = (rows: Record<string, any>[] = []) => ({
  rows,
  rowCount: rows.length,
});
const query =
  jest.fn<
    (sql: string, values?: unknown[]) => Promise<ReturnType<typeof result>>
  >();
const committed = jest.fn();
const transaction = jest.fn(
  async (run: (client: { query: typeof query }) => Promise<unknown>) => {
    const value = await run({ query });
    committed();
    return value;
  },
);
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("@/app/family/server/db", () => ({
  getPool: () => ({ query }),
  transaction,
}));
jest.unstable_mockModule("@/app/family/server/auth", () => ({
  createFamilyAuth: jest.fn(),
}));
jest.unstable_mockModule("better-auth/db/migration", () => ({
  getMigrations: jest.fn(),
}));
const ledger = await import("@/app/family/server/voice-ledger");
const { listUsers } = await import("@/app/family/server/accounts");
const { FAMILY_APPLICATION_UPGRADE_SQL, applicationUpgradeStatus } =
  await import("@/app/family/server/upgrades");

describe("voice admission, privacy, and usage ledger", () => {
  const userId = "fixture-approved-member";
  const requestId = "11111111-1111-4111-8111-111111111111";
  const id = "22222222-2222-4222-8222-222222222222";
  const originalFetch = global.fetch;
  const outbound = jest.fn<typeof fetch>(async () => {
    throw new Error("No live voice requests in ledger tests");
  });
  const start = () => ({
    requestId,
    kind: "transcribe" as const,
    requestedModel: "gpt-transcribe",
    audioSeconds: 1.25,
  });
  const finish = () => ({
    state: "complete" as const,
    usageSource: "unknown" as const,
    inputTokens: null,
    outputTokens: null,
  });
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = outbound;
    query.mockImplementation(async (sql) => {
      if (sql.startsWith("SELECT pg_advisory")) return result();
      if (sql.startsWith('SELECT id FROM "user"'))
        return result([{ id: userId }]);
      if (sql.startsWith("SELECT id FROM family_voice_usage")) return result();
      if (sql.startsWith("SELECT count(*)")) return result([{ count: 0 }]);
      if (sql.startsWith("SELECT state FROM family_voice_usage"))
        return result([{ state: "running" }]);
      if (/^(INSERT|UPDATE)\b/.test(sql)) return result();
      throw new Error(`Unexpected fixture query: ${sql.slice(0, 60)}`);
    });
  });
  afterEach(() => {
    expect(outbound).not.toHaveBeenCalled();
    global.fetch = originalFetch;
  });

  test("admission serializes per approved user and records only bounded metadata", async () => {
    await expect(
      ledger.beginVoiceOperation(userId, start()),
    ).resolves.toMatchObject({ id: expect.any(String) });
    expect(query.mock.calls[0]).toEqual([
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      [`family-voice:${userId}`],
    ]);
    const insert = query.mock.calls.find(([sql]) => sql.startsWith("INSERT"))!;
    expect(insert[1]?.slice(1)).toEqual([
      userId,
      requestId,
      "transcribe",
      "gpt-transcribe",
      null,
      null,
      null,
      1.25,
    ]);
    expect(insert[0]).not.toMatch(/\b(?:audio|text|transcript|content)\b/);
    expect(committed).toHaveBeenCalledTimes(1);
  });
  test("disabled or unapproved accounts cannot acquire a voice operation", async () => {
    query.mockImplementation(async (sql) =>
      sql.startsWith("SELECT pg_advisory") ? result() : result(),
    );
    await expect(
      ledger.beginVoiceOperation(userId, start()),
    ).rejects.toMatchObject({ status: 403, code: "ACCOUNT_UNAVAILABLE" });
    expect(
      query.mock.calls.some(([sql]) => /^(INSERT|UPDATE)\b/.test(sql)),
    ).toBe(false);
  });
  test("a duplicate request id is never sent again or overwritten", async () => {
    query.mockImplementation(async (sql) => {
      if (sql.startsWith("SELECT pg_advisory")) return result();
      if (sql.startsWith('SELECT id FROM "user"'))
        return result([{ id: userId }]);
      if (sql.startsWith("SELECT id FROM family_voice_usage"))
        return result([{ id }]);
      throw new Error("Duplicate must stop before mutation");
    });
    await expect(
      ledger.beginVoiceOperation(userId, start()),
    ).rejects.toMatchObject({ status: 409, code: "VOICE_REQUEST_EXISTS" });
    expect(committed).not.toHaveBeenCalled();
  });
  test("two running operations block another operation while stale cleanup can commit", async () => {
    query.mockImplementation(async (sql) => {
      if (sql.startsWith('SELECT id FROM "user"'))
        return result([{ id: userId }]);
      if (sql.startsWith("SELECT count(*)")) return result([{ count: 2 }]);
      return result();
    });
    await expect(
      ledger.beginVoiceOperation(userId, start()),
    ).rejects.toMatchObject({ status: 429, code: "VOICE_BUSY" });
    expect(committed).toHaveBeenCalledTimes(1);
    expect(
      query.mock.calls.find(([sql]) => sql.startsWith("UPDATE"))?.[0],
    ).toMatch(
      /state='error'.*input_tokens=NULL.*usage_source='unknown'.*60 seconds/s,
    );
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
      false,
    );
  });
  test.each([
    { requestId: "not-a-uuid" },
    { kind: "arbitrary" },
    { requestedModel: "https://collector.invalid/model" },
    { audioSeconds: Infinity },
    { audioSeconds: -1 },
    { audioSeconds: 76 },
    { part: 10 },
    { part: -1 },
    { messageId: id },
  ])(
    "invalid metadata %p is rejected before accessing the ledger",
    async (extra) => {
      await expect(
        ledger.beginVoiceOperation(userId, { ...start(), ...extra } as any),
      ).rejects.toMatchObject({ status: 400, code: "INVALID_VOICE_METADATA" });
      expect(query).not.toHaveBeenCalled();
    },
  );
  test("duration-only upstream usage preserves separate reported seconds and unknown tokens", async () => {
    await ledger.finishVoiceOperation(id, {
      ...finish(),
      audioSeconds: 1.25,
      reportedAudioSeconds: 2,
    });
    const update = query.mock.calls.find(([sql]) => sql.startsWith("UPDATE"))!;
    expect(update[1]).toEqual([
      "complete",
      null,
      null,
      null,
      "unknown",
      1.25,
      2,
      id,
    ]);
    expect(update[0]).toContain(
      "reported_audio_seconds=COALESCE($7,reported_audio_seconds)",
    );
  });
  test("reported zero tokens remain distinct from missing tokens", async () => {
    await ledger.finishVoiceOperation(id, {
      ...finish(),
      usageSource: "reported",
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(
      query.mock.calls.find(([sql]) => sql.startsWith("UPDATE"))?.[1],
    ).toEqual(["complete", null, 0, 0, "reported", null, null, id]);
  });
  test.each([
    { usageSource: "unknown", inputTokens: 0, outputTokens: 0 },
    { usageSource: "reported", inputTokens: 7, outputTokens: null },
    { usageSource: "reported", inputTokens: -1, outputTokens: 4 },
  ])(
    "incomplete or unknown token usage %p cannot become fabricated token counts",
    async (usage) => {
      await ledger.finishVoiceOperation(id, { ...finish(), ...usage } as any);
      expect(
        query.mock.calls
          .find(([sql]) => sql.startsWith("UPDATE"))?.[1]
          ?.slice(2, 5),
      ).toEqual([null, null, "unknown"]);
    },
  );
  test("network failure keeps an error ledger with unknown usage and measured duration intact", async () => {
    await ledger.finishVoiceOperation(id, { ...finish(), state: "error" });
    expect(query.mock.calls[0][0]).toContain("FOR UPDATE");
    const update = query.mock.calls.find(([sql]) => sql.startsWith("UPDATE"))!;
    expect(update[1]).toEqual([
      "error",
      null,
      null,
      null,
      "unknown",
      null,
      null,
      id,
    ]);
    expect(update[0]).toContain("audio_seconds=COALESCE($6,audio_seconds)");
    expect(query.mock.calls.some(([sql]) => /^DELETE\b/.test(sql))).toBe(false);
  });
  test.each(["complete", "error"])(
    "terminal %s records cannot be rewritten by a delayed finish",
    async (state) => {
      query.mockResolvedValue(result([{ state }]));
      await ledger.finishVoiceOperation(id, {
        ...finish(),
        usageSource: "reported",
        inputTokens: 123,
        outputTokens: 456,
      });
      expect(query).toHaveBeenCalledTimes(1);
    },
  );
  test("raw audio, transcript, or provider error extras never enter ledger parameters", async () => {
    await ledger.finishVoiceOperation(id, {
      ...finish(),
      transcript: "private-transcript-fixture",
      audio: "private-audio-fixture",
      error: "private-provider-error",
    } as any);
    expect(JSON.stringify(query.mock.calls)).not.toContain("private-");
    expect(FAMILY_APPLICATION_UPGRADE_SQL).not.toMatch(
      /\b(?:audio|transcript|content)\s+(?:text|bytea|json)/i,
    );
  });
  test("v2 or a v3 marker without voice columns remains unavailable through SELECT-only readiness", async () => {
    query
      .mockResolvedValueOnce(
        result([{ version_table_exists: true, columns_ready: false }]),
      )
      .mockResolvedValueOnce(result([{ version: 3 }]));
    await expect(applicationUpgradeStatus()).resolves.toEqual({
      schemaReady: false,
      schemaVersion: 3,
    });
    expect(
      query.mock.calls.every(([sql]) => sql.trim().startsWith("SELECT")),
    ).toBe(true);
    expect(query.mock.calls[0][0]).toContain("'reported_audio_seconds'");
  });
  test("admin totals combine preaggregated chat and voice usage without multiplying rows", async () => {
    query.mockResolvedValueOnce(
      result([
        {
          id: userId,
          name: "Fixture",
          email: "fixture@test.invalid",
          role: "member",
          status: "approved",
          created_at: new Date("2026-01-01"),
          last_seen_at: null,
          active_seconds: 0,
          input_tokens: "31",
          output_tokens: "19",
          unknown_requests: "2",
          voice_requests: "3",
          voice_input_tokens: "11",
          voice_output_tokens: "7",
          voice_unknown_requests: "1",
          voice_audio_seconds: 4.5,
        },
      ]),
    );
    const users = await listUsers();
    expect(users[0]).toMatchObject({
      inputTokens: 31,
      outputTokens: 19,
      unknownUsageRequests: 2,
      voiceRequests: 3,
      voiceInputTokens: 11,
      voiceOutputTokens: 7,
      voiceUnknownUsageRequests: 1,
      voiceAudioSeconds: 4.5,
    });
    const sql = query.mock.calls[0][0];
    expect(sql.match(/GROUP BY user_id/g) || []).toHaveLength(2);
    expect(sql).toContain(
      "COALESCE(g.input_tokens,0)+COALESCE(v.input_tokens,0)",
    );
    expect(sql).not.toContain("JOIN family_voice_usage");
  });

});
