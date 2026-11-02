/** @jest-environment node */
import { jest } from "@jest/globals";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { RealtimeContext } from "../app/family/server/realtime-ledger";

class FixtureSocket extends EventEmitter {
  static instances: FixtureSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  send = jest.fn((value: string) => {
    this.sent.push(JSON.parse(value));
  });
  terminate = jest.fn(() => {
    this.readyState = 3;
    this.emit("close");
  });
  constructor(
    readonly url: string,
    readonly options: Record<string, any>,
  ) {
    super();
    FixtureSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.emit("open");
  }
  event(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }
}
class FixturePeer extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  send = jest.fn((value: string) => {
    this.sent.push(JSON.parse(value));
  });
  close = jest.fn((code: number, reason: string) => {
    this.readyState = 3;
    this.emit("close", code, reason);
  });
  control(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)), false);
  }
  audio(value: Buffer) {
    this.emit("message", value, true);
  }
}
let runtimeDeadline: Date | undefined;
const assertLease = jest.fn<(context: RealtimeContext) => Promise<void>>(
  async () => {},
);
const beginTurn = jest.fn(async (..._args: any[]) => {});
const recordTranscript = jest.fn(async (..._args: any[]) => {});
const recordResponse = jest.fn(async (..._args: any[]) => {});
const markInterrupted = jest.fn(async (..._args: any[]) => {});
const markPlayed = jest.fn(async (..._args: any[]) => {});
const release = jest.fn(async (..._args: any[]) => {});
jest.unstable_mockModule("server-only", () => ({}));
jest.unstable_mockModule("ws", () => ({ default: FixtureSocket }));
jest.unstable_mockModule("@vercel/functions", () => ({
  getDeadline: () => runtimeDeadline,
}));
jest.unstable_mockModule("@/app/family/server/realtime-ledger", () => ({
  assertRealtimeLease: assertLease,
  beginRealtimeTurn: beginTurn,
  recordRealtimeTranscript: recordTranscript,
  recordRealtimeResponse: recordResponse,
  markRealtimeInterrupted: markInterrupted,
  markRealtimePlayed: markPlayed,
  releaseRealtimeConnection: release,
}));
const { startRealtimeRelay } = await import(
  "@/app/family/server/realtime-relay"
);
const { FamilyApiError } = await import("@/app/family/server/errors");
const { REALTIME_MODEL } = await import("@/app/family/realtime-types");
const context: RealtimeContext = {
  callId: "00000000-0000-4000-8000-000000000001",
  userId: "fixture-user",
  sessionId: "fixture-session",
  chatId: "00000000-0000-4000-8000-000000000002",
  connectionId: "00000000-0000-4000-8000-000000000003",
  model: REALTIME_MODEL,
  voice: "coral",
  vad: "natural",
  remainingSeconds: 1800,
  remainingTurns: 100,
  history: [],
};
let running: Promise<void>[];
let peers: FixturePeer[];
let environment: NodeJS.ProcessEnv;
const rawSecret = "fixture-private-provider-value";
async function flush() {
  await jest.advanceTimersByTimeAsync(0);
}
function launch(overrides: Partial<RealtimeContext> = {}) {
  const peer = new FixturePeer();
  peers.push(peer);
  const done = startRealtimeRelay(peer, { ...context, ...overrides });
  running.push(done);
  return { peer, done };
}
async function ready(
  overrides: Partial<RealtimeContext> = {},
  acknowledgeHistory = true,
) {
  const call = launch(overrides);
  await flush();
  const socket = FixtureSocket.instances.at(-1)!;
  socket.open();
  socket.event({
    type: "session.created",
    session: { type: "realtime", model: REALTIME_MODEL },
  });
  socket.event({
    type: "conversation.created",
    conversation: { id: "conv_fixture" },
  });
  socket.event({
    type: "session.updated",
    session: { type: "realtime", model: REALTIME_MODEL },
  });
  if (acknowledgeHistory)
    for (const event of socket.sent.filter(
      (event) => event.type === "conversation.item.create",
    ))
      socket.event({ type: "conversation.item.created", item: event.item });
  await flush();
  if (acknowledgeHistory)
    expect(call.peer.sent.some((event) => event.type === "ready")).toBe(true);
  return { ...call, socket };
}
function createTurn(
  socket: FixtureSocket,
  input = "input_a",
  response = "response_a",
  output = "output_a",
) {
  socket.event({ type: "input_audio_buffer.committed", item_id: input });
  socket.event({ type: "response.created", response: { id: response } });
  socket.event({
    type: "response.output_item.added",
    response_id: response,
    item: { id: output, type: "message", role: "assistant" },
  });
}
function audio(
  socket: FixtureSocket,
  bytes = 4800,
  response = "response_a",
  output = "output_a",
) {
  socket.event({
    type: "response.output_audio.delta",
    response_id: response,
    item_id: output,
    content_index: 0,
    delta: Buffer.alloc(bytes).toString("base64"),
  });
}
function doneTurn(
  socket: FixtureSocket,
  response = "response_a",
  output = "output_a",
  status = "completed",
) {
  socket.event({
    type: "response.done",
    response: {
      id: response,
      status,
      usage: { input_tokens: 11, output_tokens: 7 },
      output: [
        {
          id: output,
          type: "message",
          role: "assistant",
          content: [{ type: "output_audio", transcript: "合成助手字幕" }],
        },
      ],
    },
  });
}
beforeEach(() => {
  jest.useFakeTimers();
  environment = {
    NODE_ENV: "test",
    FAMILY_OPENAI_FALLBACK_ENABLED: "0",
    FAMILY_OPENAI_PRIORITY_KEYS: JSON.stringify([
      { name: "合成优先", key: rawSecret },
    ]),
  };
  jest.replaceProperty(process, "env", environment);
  running = [];
  peers = [];
  FixtureSocket.instances = [];
  runtimeDeadline = undefined;
  jest.clearAllMocks();
  assertLease.mockResolvedValue(undefined);
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  for (const peer of peers)
    if (peer.readyState === 1) peer.control({ type: "end" });
  await jest.advanceTimersByTimeAsync(60_000);
  await Promise.all(running);
  for (const peer of peers) expect(peer.listenerCount("message")).toBe(0);
  for (const socket of FixtureSocket.instances)
    expect(socket.listenerCount("message")).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test("uses fixed GA PCM/VAD settings, bounded history, and no initial generated greeting", async () => {
  const { peer, socket } = await ready({
    history: [
      { role: "user", content: "合成历史问题" },
      { role: "assistant", content: "合成历史回答" },
    ],
  });
  expect(socket.url).toBe(
    `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`,
  );
  expect(socket.options.headers.Authorization).toBe(`Bearer ${rawSecret}`);
  const update = socket.sent.find((event) => event.type === "session.update")!;
  expect(update.session).toMatchObject({
    type: "realtime",
    output_modalities: ["audio"],
    max_output_tokens: 1024,
    tools: [],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        transcription: { model: "gpt-4o-mini-transcribe", language: "zh" },
        turn_detection: {
          type: "semantic_vad",
          eagerness: "auto",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: { format: { type: "audio/pcm", rate: 24000 }, voice: "coral" },
    },
  });
  expect(
    socket.sent
      .filter((event) => event.type === "conversation.item.create")
      .map((event) => event.item.content[0]),
  ).toEqual([
    { type: "input_text", text: "合成历史问题" },
    { type: "output_text", text: "合成历史回答" },
  ]);
  expect(socket.sent.some((event) => event.type === "response.create")).toBe(
    false,
  );
  expect(JSON.stringify(peer.sent)).not.toContain(rawSecret);
});

test("history IDs fit the provider limit and ready waits for every complete acknowledgement", async () => {
  const { peer, socket } = await ready(
    {
      history: [
        { role: "user", content: "合成历史问题" },
        { role: "assistant", content: "合成历史回答" },
      ],
    },
    false,
  );
  const items = socket.sent
    .filter((event) => event.type === "conversation.item.create")
    .map((event) => event.item);
  expect(items).toHaveLength(2);
  for (const item of items) expect(item.id).toMatch(/^[a-zA-Z0-9_-]{1,32}$/);
  expect(new Set(items.map((item) => item.id)).size).toBe(2);
  expect(peer.sent.some((event) => event.type === "ready")).toBe(false);
  expect(
    socket.sent.some((event) => event.type === "input_audio_buffer.append"),
  ).toBe(false);
  socket.event({
    type: "conversation.item.created",
    item: { id: "unrelated" },
  });
  socket.event({ type: "conversation.item.created", item: items[0] });
  socket.event({ type: "conversation.item.created", item: items[0] });
  socket.event({
    type: "conversation.item.added",
    item: { ...items[1], status: "in_progress" },
  });
  expect(peer.sent.some((event) => event.type === "ready")).toBe(false);
  socket.event({
    type: "conversation.item.done",
    item: { ...items[1], status: "completed" },
  });
  socket.event({ type: "conversation.item.created", item: items[1] });
  expect(peer.sent.filter((event) => event.type === "ready")).toHaveLength(1);
  peer.audio(Buffer.alloc(4800));
  expect(socket.sent.at(-1)?.type).toBe("input_audio_buffer.append");
});

test("missing history acknowledgements remain within the startup timeout", async () => {
  const { peer, done } = await ready(
    { history: [{ role: "user", content: "合成历史" }] },
    false,
  );
  await jest.advanceTimersByTimeAsync(15_000);
  await done;
  expect(peer.sent.some((event) => event.type === "ready")).toBe(false);
  expect(peer.sent).toContainEqual(
    expect.objectContaining({
      type: "error",
      fatal: true,
      code: "REALTIME_CONNECT_TIMEOUT",
    }),
  );
});

test.each([true, false])(
  "history rejection logs only explicitly allowlisted diagnostics (%s)",
  async (known) => {
    const { peer, socket, done } = await ready(
      { history: [{ role: "user", content: "合成历史" }] },
      false,
    );
    socket.event({
      type: "error",
      event_id: rawSecret,
      error: {
        code: known ? "invalid_value" : rawSecret,
        type: known ? "invalid_request_error" : rawSecret,
        param: known ? "item.id" : rawSecret,
        message: rawSecret,
        id: rawSecret,
        content: rawSecret,
      },
    });
    await done;
    expect(peer.sent.some((event) => event.type === "ready")).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      "[FamilyRealtime] provider rejected event",
      known
        ? {
            phase: "history",
            code: "invalid_value",
            type: "invalid_request_error",
            param: "item.id",
          }
        : { phase: "history" },
    );
    expect(JSON.stringify(jest.mocked(console.error).mock.calls)).not.toContain(
      rawSecret,
    );
    expect(JSON.stringify(peer.sent)).not.toContain(rawSecret);
    expect(FixtureSocket.instances).toHaveLength(1);
  },
);

test("fast mode uses server VAD and forwards only even bounded input PCM", async () => {
  const { peer, socket } = await ready({ vad: "fast" });
  expect(socket.sent[0].session.audio.input.turn_detection).toMatchObject({
    type: "server_vad",
    threshold: 0.5,
    silence_duration_ms: 700,
  });
  peer.audio(Buffer.alloc(4800));
  expect(socket.sent.at(-1)).toMatchObject({
    type: "input_audio_buffer.append",
    audio: Buffer.alloc(4800).toString("base64"),
  });
  peer.control({ type: "mute", muted: true });
  const before = socket.sent.length;
  peer.audio(Buffer.alloc(4800));
  expect(socket.sent).toHaveLength(before);
});

test.each([1, 9602, 16386])(
  "rejects invalid input frame size %s and cleans both transports",
  async (length) => {
    const { peer, socket, done } = await ready();
    peer.audio(Buffer.alloc(length));
    await done;
    expect(peer.close).toHaveBeenCalledWith(1008, "authorization_lost");
    expect(socket.terminate).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  },
);

test("no microphone frame is accepted before ready and no arbitrary upstream commands pass through", async () => {
  const { peer, done } = launch();
  await flush();
  peer.audio(Buffer.alloc(4800));
  await done;
  expect(FixtureSocket.instances[0].sent).toHaveLength(0);
  expect(peer.sent.find((event) => event.type === "error")).toMatchObject({
    code: "REALTIME_INVALID_INPUT",
  });
});

test("input rate bursts are bounded independently of frame size", async () => {
  const { peer } = await ready();
  for (let index = 0; index < 11; index++) peer.audio(Buffer.alloc(9600));
  expect(peer.close).toHaveBeenCalled();
});

test("arbitrary session updates from a browser never reach the provider", async () => {
  const { peer, socket, done } = await ready();
  const before = socket.sent.length;
  peer.control({
    type: "session.update",
    session: { model: "forbidden-model", instructions: rawSecret },
  });
  await done;
  expect(socket.sent).toHaveLength(before);
  expect(peer.close).toHaveBeenCalledWith(1008, "authorization_lost");
  expect(JSON.stringify(peer.sent)).not.toContain(rawSecret);
});

test("an initially revoked session cannot even open a provider connection", async () => {
  assertLease.mockRejectedValueOnce(new FamilyApiError(403, rawSecret));
  const { peer, done } = launch();
  await done;
  expect(FixtureSocket.instances).toHaveLength(0);
  expect(peer.close).toHaveBeenCalledWith(1008, "authorization_lost");
  expect(JSON.stringify(peer.sent)).not.toContain(rawSecret);
});

test("the whole-call expiry ends rather than creating a resumable segment", async () => {
  const { peer, done } = await ready({ remainingSeconds: 10 });
  await jest.advanceTimersByTimeAsync(10000);
  await done;
  expect(peer.close).toHaveBeenCalledWith(1000, "call_time_limit");
  expect(release).toHaveBeenCalledWith(
    { ...context, remainingSeconds: 10 },
    expect.objectContaining({ resume: false }),
  );
});

test("maps responses by committed FIFO rather than out-of-order ASR and bills ASR independently", async () => {
  const { socket, peer } = await ready();
  socket.event({ type: "input_audio_buffer.committed", item_id: "input_a" });
  socket.event({ type: "input_audio_buffer.committed", item_id: "input_b" });
  for (const name of ["a", "b"]) {
    socket.event({
      type: "response.created",
      response: { id: `response_${name}` },
    });
    socket.event({
      type: "response.output_item.added",
      response_id: `response_${name}`,
      item: { id: `output_${name}`, type: "message", role: "assistant" },
    });
  }
  socket.event({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input_b",
    transcript: "第二个用户字幕",
    usage: { type: "duration", seconds: 2.5 },
  });
  socket.event({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "input_a",
    transcript: "第一个用户字幕",
    usage: { type: "tokens", input_tokens: 3, output_tokens: 2 },
  });
  doneTurn(socket, "response_a", "output_a", "cancelled");
  doneTurn(socket, "response_b", "output_b");
  doneTurn(socket, "response_b", "output_b");
  await flush();
  expect(beginTurn.mock.calls.map((entry) => entry[1])).toEqual([
    "input_a",
    "input_b",
  ]);
  expect(recordResponse.mock.calls.map((entry) => entry[1])).toEqual([
    expect.objectContaining({
      responseId: "response_a",
      inputItemId: "input_a",
      status: "cancelled",
      usage: { source: "reported", inputTokens: 11, outputTokens: 7 },
    }),
    expect.objectContaining({
      responseId: "response_b",
      inputItemId: "input_b",
      status: "completed",
    }),
  ]);
  expect(recordTranscript.mock.calls[0].slice(1, 5)).toEqual([
    "input_b",
    "第二个用户字幕",
    { source: "unknown", inputTokens: null, outputTokens: null },
    2.5,
  ]);
  expect(recordTranscript.mock.calls[1][3]).toEqual({
    source: "reported",
    inputTokens: 3,
    outputTokens: 2,
  });
  expect(peer.sent.filter((event) => event.type === "turn_done")).toHaveLength(
    2,
  );
  expect(markPlayed).not.toHaveBeenCalled();
});

test("subtitles are deltas until their final replacement and output audio is split at 100ms", async () => {
  const { peer, socket } = await ready();
  createTurn(socket);
  socket.event({
    type: "response.output_audio_transcript.delta",
    response_id: "response_a",
    item_id: "output_a",
    content_index: 0,
    delta: "临时",
  });
  socket.event({
    type: "response.output_audio_transcript.done",
    response_id: "response_a",
    item_id: "output_a",
    content_index: 0,
    transcript: "完整最终字幕",
  });
  audio(socket, 14400);
  const subtitles = peer.sent.filter((event) => event.type === "transcript");
  expect(subtitles.map((event) => [event.text, event.final])).toEqual([
    ["临时", false],
    ["完整最终字幕", true],
  ]);
  const frames = peer.sent.filter((event) => event.type === "audio");
  expect(frames).toHaveLength(3);
  expect(
    frames.every((frame) => Buffer.from(frame.audio, "base64").length === 4800),
  ).toBe(true);
});

test("VAD interruption waits for the real playback cursor, clamps it, and never echoes a control loop", async () => {
  const { peer, socket } = await ready();
  createTurn(socket);
  audio(socket, 48000);
  socket.event({
    type: "input_audio_buffer.speech_started",
    item_id: "input_b",
  });
  expect(peer.sent.filter((event) => event.type === "interrupt")).toHaveLength(
    1,
  );
  expect(
    socket.sent.some((event) => event.type === "conversation.item.truncate"),
  ).toBe(false);
  peer.control({ type: "interrupt", itemId: "output_a", audioEndMs: 175 });
  expect(
    socket.sent.filter((event) => event.type === "conversation.item.truncate"),
  ).toEqual([
    {
      type: "conversation.item.truncate",
      item_id: "output_a",
      content_index: 0,
      audio_end_ms: 175,
    },
  ]);
  expect(peer.sent.filter((event) => event.type === "interrupt")).toHaveLength(
    1,
  );
  audio(socket, 4800);
  expect(peer.sent.filter((event) => event.type === "audio")).toHaveLength(10);
  await flush();
  expect(markInterrupted).toHaveBeenCalledWith(context, "output_a", 175);
});

test("a fabricated future playback offset is clamped to generated audio", async () => {
  const { peer, socket } = await ready();
  createTurn(socket);
  audio(socket, 4800);
  peer.control({ type: "interrupt", itemId: "output_a", audioEndMs: 999999 });
  expect(
    socket.sent.find((event) => event.type === "conversation.item.truncate")
      ?.audio_end_ms,
  ).toBe(100);
});

test("VAD blocks a cancelled response's late first audio even before a browser cursor exists", async () => {
  const { peer, socket } = await ready();
  createTurn(socket);
  socket.event({
    type: "input_audio_buffer.speech_started",
    item_id: "input_b",
  });
  audio(socket);
  expect(peer.sent.filter((event) => event.type === "audio")).toHaveLength(0);
  peer.control({ type: "interrupt" });
  expect(
    socket.sent.find((event) => event.type === "conversation.item.truncate"),
  ).toMatchObject({ item_id: "output_a", audio_end_ms: 0 });
});

test("normal end acknowledges only after cancelled usage, writes and lease release finish", async () => {
  const { peer, socket, done } = await ready();
  createTurn(socket);
  audio(socket);
  let finishWrite!: () => void;
  const write = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  let finishRelease!: () => void;
  const released = new Promise<void>((resolve) => {
    finishRelease = resolve;
  });
  recordResponse.mockImplementationOnce(() => write);
  release.mockImplementationOnce(() => released);
  peer.control({ type: "end" });
  expect(peer.close).not.toHaveBeenCalled();
  doneTurn(socket, "response_a", "output_a", "cancelled");
  await jest.advanceTimersByTimeAsync(1200);
  expect(recordResponse).toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(peer.sent.some((event) => event.type === "ended")).toBe(false);
  finishWrite();
  await flush();
  expect(release).toHaveBeenCalledTimes(1);
  expect(peer.close).not.toHaveBeenCalled();
  finishRelease();
  await flush();
  await done;
  expect(peer.sent.at(-1)).toEqual({ type: "ended", reason: "ended" });
  expect(peer.close).toHaveBeenCalledWith(1000, "ended");
});

test("a slow end reports save_pending at four seconds and never sends a false success ACK", async () => {
  const { peer, done } = await ready();
  let finishRelease!: () => void;
  release.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishRelease = resolve;
      }),
  );
  peer.control({ type: "end" });
  await flush();
  await jest.advanceTimersByTimeAsync(4000);
  expect(peer.sent.some((event) => event.type === "ended")).toBe(false);
  expect(peer.sent.find((event) => event.type === "error")).toMatchObject({
    code: "REALTIME_SAVE_PENDING",
    fatal: true,
  });
  expect(peer.close).toHaveBeenCalledWith(1011, "save_pending");
  finishRelease();
  await flush();
  await done;
  expect(peer.sent.some((event) => event.type === "ended")).toBe(false);
});

test("the last allowed turn stops new input immediately and ends after final audio drains", async () => {
  const { peer, socket, done } = await ready({ remainingTurns: 1 });
  createTurn(socket);
  peer.audio(Buffer.alloc(4800));
  expect(
    socket.sent.some((event) => event.type === "input_audio_buffer.append"),
  ).toBe(false);
  expect(
    socket.sent.some((event) => event.type === "input_audio_buffer.clear"),
  ).toBe(true);
  audio(socket);
  doneTurn(socket);
  await flush();
  expect(peer.close).not.toHaveBeenCalled();
  peer.control({
    type: "played",
    itemId: "output_a",
    audioEndMs: 100,
    idle: true,
  });
  await jest.advanceTimersByTimeAsync(1200);
  await done;
  expect(peer.close).toHaveBeenCalledWith(1000, "turn_limit");
  expect(beginTurn).toHaveBeenCalledTimes(1);
});

test("a claimed call with no remaining turns cannot open another provider session", async () => {
  const { peer, done } = launch({ remainingTurns: 0 });
  await done;
  expect(FixtureSocket.instances).toHaveLength(0);
  expect(peer.close).toHaveBeenCalledWith(1000, "turn_limit");
});

test("integer-millisecond drain accepts a fully rendered fractional tail without marking it interrupted", async () => {
  const { peer, socket, done } = await ready();
  createTurn(socket);
  audio(socket, 4802);
  doneTurn(socket);
  peer.control({
    type: "played",
    itemId: "output_a",
    audioEndMs: 100,
    idle: true,
  });
  await flush();
  expect(markPlayed).toHaveBeenCalledWith(context, "output_a", 100, true);
  peer.control({ type: "end" });
  await jest.advanceTimersByTimeAsync(1200);
  await done;
  expect(markInterrupted).not.toHaveBeenCalled();
});

test.each(["before", "after"])(
  "heard-complete requires final response and drained actual audio (%s done)",
  async (when) => {
    const { peer, socket } = await ready();
    createTurn(socket);
    audio(socket);
    if (when === "before")
      peer.control({
        type: "played",
        itemId: "output_a",
        audioEndMs: 100,
        idle: true,
      });
    expect(markPlayed).not.toHaveBeenCalled();
    doneTurn(socket);
    if (when === "after") {
      await flush();
      expect(markPlayed).not.toHaveBeenCalled();
      peer.control({
        type: "played",
        itemId: "output_a",
        audioEndMs: 100,
        idle: true,
      });
    }
    await flush();
    expect(markPlayed).toHaveBeenCalledWith(context, "output_a", 100, true);
    expect(markPlayed).toHaveBeenCalledTimes(1);
  },
);

test("a revoked lease closes with 1008, no raw database error, and no overlapping probes", async () => {
  const { peer, socket, done } = await ready();
  assertLease.mockRejectedValueOnce(new FamilyApiError(403, rawSecret));
  await jest.advanceTimersByTimeAsync(5000);
  await done;
  expect(peer.close).toHaveBeenCalledWith(1008, "authorization_lost");
  expect(socket.terminate).toHaveBeenCalled();
  expect(JSON.stringify(peer.sent)).not.toContain(rawSecret);
  expect(release).toHaveBeenCalledWith(
    context,
    expect.objectContaining({ resume: false }),
  );
});

test("lease probes do not overlap while a prior probe is pending", async () => {
  const { peer } = await ready();
  let finishProbe!: () => void;
  assertLease.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishProbe = resolve;
      }),
  );
  await jest.advanceTimersByTimeAsync(11000);
  expect(assertLease).toHaveBeenCalledTimes(2);
  finishProbe();
  await flush();
  peer.control({ type: "ping" });
  await jest.advanceTimersByTimeAsync(4000);
  expect(assertLease).toHaveBeenCalledTimes(3);
});

test("a stuck lease check times out closed instead of leaving the connection indefinitely active", async () => {
  const { peer, done } = await ready();
  assertLease.mockImplementationOnce(() => new Promise<void>(() => {}));
  await jest.advanceTimersByTimeAsync(13000);
  await done;
  expect(peer.close).toHaveBeenCalledWith(1008, "authorization_lost");
});

test("ping and silence do not keep an idle user alive", async () => {
  const { peer, done } = await ready();
  for (let index = 0; index < 8; index++) {
    peer.control({ type: "ping" });
    await jest.advanceTimersByTimeAsync(15000);
  }
  await done;
  expect(peer.sent).toContainEqual({ type: "idle_warning", seconds: 60 });
  expect(peer.close).toHaveBeenCalledWith(1000, "idle_timeout");
});

test("an idle segment rotates at 240 seconds and releases a resumable lease", async () => {
  const { peer, done } = await ready();
  for (let index = 0; index < 24; index++) {
    peer.control({ type: "keepalive" });
    await jest.advanceTimersByTimeAsync(10000);
  }
  await done;
  expect(peer.sent).toContainEqual({ type: "rotate" });
  expect(peer.sent.some((event) => event.type === "ended")).toBe(false);
  expect(peer.close).toHaveBeenCalledWith(1012, "rotation");
  expect(release).toHaveBeenCalledWith(
    context,
    expect.objectContaining({ resume: true }),
  );
});

test("a busy segment has a hard 270-second cutoff and records unplayed generated audio", async () => {
  const { peer, socket, done } = await ready();
  createTurn(socket);
  audio(socket);
  socket.event({
    type: "input_audio_buffer.speech_started",
    item_id: "input_b",
  });
  for (let index = 0; index < 27; index++) {
    peer.control({ type: "keepalive" });
    await jest.advanceTimersByTimeAsync(10000);
  }
  await jest.advanceTimersByTimeAsync(1200);
  await done;
  expect(peer.close).toHaveBeenCalledWith(1012, "rotation");
  expect(markInterrupted).toHaveBeenCalledWith(context, "output_a", 0);
});

test("the runtime deadline shortens rotation and leaves finalization time", async () => {
  runtimeDeadline = new Date(Date.now() + 70_000);
  const { peer, done } = await ready();
  peer.control({ type: "keepalive" });
  await jest.advanceTimersByTimeAsync(15000);
  await done;
  expect(peer.close).toHaveBeenCalledWith(1012, "rotation");
});

test("only explicit quota before open switches credentials, and no opened provider error retries", async () => {
  environment.FAMILY_OPENAI_PRIORITY_KEYS = JSON.stringify([
    { name: "第一", key: "fixture-key-one" },
    { name: "第二", key: "fixture-key-two" },
  ]);
  const call = launch();
  await flush();
  const first = FixtureSocket.instances[0];
  const response = Readable.from([
    Buffer.from(JSON.stringify({ error: { code: "insufficient_quota" } })),
  ]);
  Object.assign(response, { statusCode: 429 });
  first.emit("unexpected-response", {}, response);
  await flush();
  expect(FixtureSocket.instances).toHaveLength(2);
  const second = FixtureSocket.instances[1];
  second.open();
  second.event({
    type: "session.created",
    session: { type: "realtime", model: REALTIME_MODEL },
  });
  second.event({
    type: "session.updated",
    session: { type: "realtime", model: REALTIME_MODEL },
  });
  second.event({
    type: "error",
    error: { code: "insufficient_quota", message: rawSecret },
  });
  await call.done;
  expect(FixtureSocket.instances).toHaveLength(2);
  expect(JSON.stringify(call.peer.sent)).not.toContain(rawSecret);
});

test("unknown/rate-limit handshake errors never consume a second credential", async () => {
  environment.FAMILY_OPENAI_PRIORITY_KEYS = JSON.stringify([
    { name: "第一", key: "fixture-key-one" },
    { name: "第二", key: "fixture-key-two" },
  ]);
  const call = launch();
  await flush();
  const response = Readable.from([
    Buffer.from(
      JSON.stringify({
        error: {
          code: "rate_limit_exceeded",
          type: "insufficient_quota",
          message: rawSecret,
        },
      }),
    ),
  ]);
  Object.assign(response, { statusCode: 429 });
  FixtureSocket.instances[0].emit("unexpected-response", {}, response);
  await flush();
  await call.done;
  expect(FixtureSocket.instances).toHaveLength(1);
  expect(JSON.stringify(call.peer.sent)).not.toContain(rawSecret);
});

test("unplayed audio cannot exceed the thirty-second queue bound", async () => {
  const { peer, socket } = await ready();
  createTurn(socket);
  for (let index = 0; index < 31; index++) audio(socket, 48000);
  expect(peer.close).toHaveBeenCalled();
  expect(peer.sent.filter((event) => event.type === "audio")).toHaveLength(300);
});

test("a peer with excessive network backpressure stops the relay without enqueuing more audio", async () => {
  const { peer, socket } = await ready();
  createTurn(socket);
  const before = peer.sent.filter((event) => event.type === "audio").length;
  peer.bufferedAmount = 1_048_577;
  audio(socket);
  expect(peer.close).toHaveBeenCalledWith(1011, "slow_connection");
  expect(peer.sent.filter((event) => event.type === "audio")).toHaveLength(
    before,
  );
});

test("after disconnect there are no late transcripts, responses or peer handlers", async () => {
  const { peer, socket, done } = await ready();
  peer.control({ type: "end" });
  await done;
  const before = peer.sent.length;
  socket.event({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "foreign",
    transcript: rawSecret,
  });
  expect(peer.sent).toHaveLength(before);
  expect(recordTranscript).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});
