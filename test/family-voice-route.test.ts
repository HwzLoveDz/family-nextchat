/** @jest-environment node */
import { jest } from "@jest/globals";
import type { FamilyUsage } from "@/app/family/types";

type Evidence = {
  usage: FamilyUsage;
  actualModel: string | null;
  reportedAudioSeconds: number | null;
  audioSeconds?: number;
};
const base = "https://family-voice.test.invalid";
const chatId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const requireUser = jest.fn<(...args: any[]) => Promise<any>>();
const upgrade = jest.fn(async () => {});
const rateLimit = jest.fn(async () => {});
const query = jest.fn<(sql: string, values?: unknown[]) => Promise<any>>();
const begin = jest.fn<(...args: any[]) => Promise<{ id: string }>>();
const finish = jest.fn<(...args: any[]) => Promise<void>>();
const transcribe =
  jest.fn<
    (
      key: string,
      wav: Uint8Array,
      signal: AbortSignal,
      evidence: Evidence,
    ) => Promise<string>
  >();
const speak =
  jest.fn<
    (
      key: string,
      text: string,
      signal: AbortSignal,
      evidence: Evidence,
    ) => Promise<Uint8Array>
  >();
const unknown = (): FamilyUsage => ({
  source: "unknown",
  inputTokens: null,
  outputTokens: null,
});
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("@/app/family/server/auth", () => ({ requireUser }));
jest.unstable_mockModule("@/app/family/server/accounts", () => ({ rateLimit }));
jest.unstable_mockModule("@/app/family/server/upgrades", () => ({
  requireFamilyApplicationUpgrade: upgrade,
}));
jest.unstable_mockModule("@/app/family/server/db", () => ({
  getPool: () => ({ query }),
}));
jest.unstable_mockModule("@/app/family/server/voice-ledger", () => ({
  beginVoiceOperation: begin,
  finishVoiceOperation: finish,
}));
jest.unstable_mockModule("@/app/family/server/voice-provider", () => ({
  requestTranscription: transcribe,
  requestSpeech: speak,
  TRANSCRIBE_MODEL: "gpt-transcribe",
  SPEECH_MODEL: "gpt-realtime-2.1-mini",
  newVoiceEvidence: () => ({
    usage: unknown(),
    actualModel: null,
    reportedAudioSeconds: null,
  }),
}));
const { FamilyApiError } = await import("@/app/family/server/errors");
const media = await import("@/app/family/server/voice-media");
const { POST } = await import("@/app/api/family/voice/[...path]/route");
let foreignChat = false;
let unavailableMessage = false;
let approved = true;
let savedText = "**已保存的回复**";
function wav() {
  const value = media.pcm24kWav(new Uint8Array(32000));
  const view = new DataView(value.buffer);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  return value;
}
function transcriptionRequest(origin = base, audio = wav()) {
  const form = new FormData();
  form.set(
    "audio",
    new Blob([new Uint8Array(audio)], { type: "audio/wav" }),
    "voice.wav",
  );
  form.set("requestId", requestId);
  form.set("chatId", chatId);
  return new Request(`${base}/api/family/voice/transcribe`, {
    method: "POST",
    headers: { origin },
    body: form,
  });
}
function speechRequest(
  extra: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  return new Request(`${base}/api/family/voice/speech`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ chatId, messageId, requestId, ...extra }),
    signal,
  });
}
const route = (path: string, request: Request) =>
  POST(request, { params: Promise.resolve({ path: [path] }) });
beforeEach(() => {
  jest.clearAllMocks();
  foreignChat = false;
  unavailableMessage = false;
  approved = true;
  savedText = "**已保存的回复**";
  process.env.FAMILY_MODE = "1";
  process.env.BETTER_AUTH_URL = base;
  process.env.BETTER_AUTH_SECRET =
    "synthetic-auth-secret-not-real-00000000000000000000";
  process.env.OPENAI_API_KEY = "synthetic-provider-key-not-real";
  requireUser.mockResolvedValue({
    user: { id: "fixture-owner", role: "member", status: "approved" },
    authHeaders: new Headers({
      "set-cookie": "fixture-session=opaque; Path=/; Secure; HttpOnly",
    }),
  });
  begin.mockResolvedValue({ id: operationId });
  finish.mockResolvedValue(undefined);
  query.mockImplementation(async (sql) => {
    if (sql.startsWith('SELECT 1 FROM "user"'))
      return { rows: approved ? [{}] : [], rowCount: approved ? 1 : 0 };
    if (sql.startsWith("SELECT 1 FROM family_chat"))
      return { rows: foreignChat ? [] : [{}], rowCount: foreignChat ? 0 : 1 };
    if (sql.startsWith("SELECT 1 FROM family_message"))
      return {
        rows: unavailableMessage ? [] : [{}],
        rowCount: unavailableMessage ? 0 : 1,
      };
    if (sql.startsWith("SELECT m.content"))
      return { rows: [{ content: savedText }], rowCount: 1 };
    throw new Error("Unexpected synthetic voice query");
  });
  transcribe.mockImplementation(async (_key, _wav, _signal, evidence) => {
    evidence.reportedAudioSeconds = 2;
    return "识别结果";
  });
  speak.mockImplementation(async (_key, _text, _signal, evidence) => {
    evidence.usage = { source: "reported", inputTokens: 11, outputTokens: 7 };
    evidence.actualModel = "gpt-realtime-2.1-mini";
    evidence.audioSeconds = 0.2;
    return media.pcm24kWav(new Uint8Array(9600));
  });
});
afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.BETTER_AUTH_URL;
  delete process.env.FAMILY_MODE;
  jest.useRealTimers();
});

test("cross-origin audio cannot reach authentication, ledger or provider", async () => {
  const response = await route(
    "transcribe",
    transcriptionRequest("https://foreign.test.invalid"),
  );
  expect(response.status).toBe(403);
  expect(requireUser).not.toHaveBeenCalled();
  expect(begin).not.toHaveBeenCalled();
  expect(transcribe).not.toHaveBeenCalled();
});
test("unapproved or unauthenticated clients cannot begin voice operations", async () => {
  requireUser.mockRejectedValueOnce(
    new FamilyApiError(401, "请先登录。", "UNAUTHENTICATED"),
  );
  expect((await route("speech", speechRequest())).status).toBe(401);
  expect(begin).not.toHaveBeenCalled();
});
test("malformed PCM is rejected before ledger admission and provider", async () => {
  const audio = wav();
  new DataView(audio.buffer).setUint16(22, 2, true);
  expect(
    (await route("transcribe", transcriptionRequest(base, audio))).status,
  ).toBe(400);
  expect(begin).not.toHaveBeenCalled();
  expect(transcribe).not.toHaveBeenCalled();
});
test("oversized multipart envelope is rejected before buffering and provider", async () => {
  const request = new Request(`${base}/api/family/voice/transcribe`, {
    method: "POST",
    headers: {
      origin: base,
      "content-type": "multipart/form-data; boundary=fixture",
      "content-length": "1600000",
    },
    body: "fixture",
  });
  expect((await route("transcribe", request)).status).toBe(413);
  expect(begin).not.toHaveBeenCalled();
});
test("a foreign or archived chat cannot be used for transcription", async () => {
  foreignChat = true;
  expect((await route("transcribe", transcriptionRequest())).status).toBe(404);
  expect(begin).not.toHaveBeenCalled();
  expect(transcribe).not.toHaveBeenCalled();
});
test("only a saved owner assistant reply can reach speech provider", async () => {
  unavailableMessage = true;
  expect((await route("speech", speechRequest())).status).toBe(404);
  expect(begin).not.toHaveBeenCalled();
  expect(speak).not.toHaveBeenCalled();
  const conditions = query.mock.calls.find(([sql]) =>
    sql.startsWith("SELECT 1 FROM family_message"),
  )?.[0];
  expect(conditions).toContain("g.user_id=$3");
  expect(conditions).toContain("g.superseded_at IS NULL");
  expect(conditions).toContain("m.role='assistant'");
});
test("client text, URLs and models cannot bypass saved-message speech", async () => {
  for (const field of ["text", "url", "model", "voice", "userId"]) {
    expect(
      (await route("speech", speechRequest({ [field]: "forged-value" })))
        .status,
    ).toBe(400);
  }
  expect(begin).not.toHaveBeenCalled();
  expect(speak).not.toHaveBeenCalled();
});
test("an out-of-range speech part never creates a billed operation", async () => {
  expect((await route("speech", speechRequest({ part: 10 }))).status).toBe(400);
  expect((await route("speech", speechRequest({ part: 1 }))).status).toBe(400);
  expect(begin).not.toHaveBeenCalled();
});
test("a duplicate request stops at ledger and cannot issue another provider request", async () => {
  begin.mockRejectedValueOnce(
    new FamilyApiError(409, "此请求已提交。", "VOICE_REQUEST_EXISTS"),
  );
  expect((await route("speech", speechRequest())).status).toBe(409);
  expect(speak).not.toHaveBeenCalled();
  expect(finish).not.toHaveBeenCalled();
});
test("successful transcription preserves unknown tokens, measured seconds and reported seconds separately", async () => {
  const response = await route("transcribe", transcriptionRequest());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "识别结果", usage: unknown() });
  expect(begin).toHaveBeenCalledWith(
    "fixture-owner",
    expect.objectContaining({ kind: "transcribe", audioSeconds: 1 }),
  );
  expect(finish).toHaveBeenCalledWith(
    operationId,
    expect.objectContaining({
      state: "complete",
      inputTokens: null,
      outputTokens: null,
      usageSource: "unknown",
      audioSeconds: 1,
      reportedAudioSeconds: 2,
    }),
  );
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.getSetCookie()[0]).toContain("fixture-session");
});
test("speech sends only normalized stored text and returns all private metadata headers", async () => {
  const response = await route("speech", speechRequest());
  expect(response.status).toBe(200);
  expect(speak.mock.calls[0][1]).toBe("已保存的回复");
  expect(response.headers.get("x-family-voice-parts")).toBe("1");
  expect(response.headers.get("x-family-voice-part")).toBe("0");
  expect(response.headers.get("x-family-voice-truncated")).toBe("0");
  expect(JSON.parse(response.headers.get("x-family-voice-usage")!)).toEqual({
    source: "reported",
    inputTokens: 11,
    outputTokens: 7,
  });
  expect(response.headers.get("x-family-voice-model")).toBe(
    "reported:gpt-realtime-2.1-mini",
  );
  expect(response.headers.get("content-type")).toBe("audio/wav");
  expect((await response.arrayBuffer()).byteLength).toBe(9644);
  expect(finish).toHaveBeenCalledWith(
    operationId,
    expect.objectContaining({
      state: "complete",
      usageSource: "reported",
      inputTokens: 11,
      outputTokens: 7,
    }),
  );
});
test("access revoked during provider processing withholds audio and preserves charged usage", async () => {
  speak.mockImplementationOnce(async (_key, _text, _signal, evidence) => {
    evidence.usage = { source: "reported", inputTokens: 3, outputTokens: 4 };
    approved = false;
    return media.pcm24kWav(new Uint8Array(2));
  });
  const response = await route("speech", speechRequest());
  expect(response.status).toBe(403);
  expect(finish).toHaveBeenCalledWith(
    operationId,
    expect.objectContaining({
      state: "error",
      usageSource: "reported",
      inputTokens: 3,
      outputTokens: 4,
    }),
  );
});
test("35-second hard deadline aborts provider, finalizes unknown usage and clears all timers", async () => {
  jest.useFakeTimers();
  speak.mockImplementationOnce(
    async (_key, _text, signal) =>
      new Promise<Uint8Array>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
      }),
  );
  const pending = route("speech", speechRequest());
  await jest.advanceTimersByTimeAsync(35_000);
  const response = await pending;
  expect(response.status).toBe(504);
  expect(finish).toHaveBeenCalledWith(
    operationId,
    expect.objectContaining({
      state: "error",
      usageSource: "unknown",
      inputTokens: null,
      outputTokens: null,
    }),
  );
  expect(jest.getTimerCount()).toBe(0);
});
