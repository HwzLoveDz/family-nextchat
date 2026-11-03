/** @jest-environment jsdom */
import { chooseWorkspaceOption } from "./family-ui-select";
import { jest } from "@jest/globals";
import {
  act,
  renderHook,
  render,
  screen,
  fireEvent,
  cleanup as cleanupView,
} from "@testing-library/react";
import {
  REALTIME_MODEL,
  type RealtimeCallCreated,
} from "../app/family/realtime-types";
import type { RealtimeScope } from "../app/family/use-family-realtime";

class Bridge {
  static instances: Bridge[] = [];
  static wait: Promise<void> | null = null;
  enabled = false;
  position: { itemId: string; audioEndMs: number; idle: boolean } | null = {
    itemId: "item-a",
    audioEndMs: 123,
    idle: false,
  };
  start = jest.fn(async (_signal: AbortSignal) => {
    if (Bridge.wait) await Bridge.wait;
  });
  append = jest.fn(
    (itemId: string, _responseId: string, _bytes: ArrayBuffer) => {
      this.position = { itemId, audioEndMs: 123, idle: false };
    },
  );
  dispose = jest.fn(async () => {});
  setInputEnabled = jest.fn((value: boolean) => {
    this.enabled = value;
  });
  interrupt = jest.fn(() =>
    this.position ? { ...this.position, idle: true } : null,
  );
  cursor = jest.fn(() => this.position);
  resetPlayback = jest.fn(() => {
    this.position = null;
  });
  resume = jest.fn(async () => {
    this.callbacks.onBlocked(false);
  });
  constructor(readonly callbacks: any) {
    Bridge.instances.push(this);
  }
}
jest.unstable_mockModule("@/app/family/realtime-audio", () => ({
  RealtimeAudioBridge: Bridge,
  realtimeAudioSupported: () => true,
}));
const { useFamilyRealtime } = await import("../app/family/use-family-realtime");
const { RealtimePanel } = await import("../app/family/realtime-panel");
class Socket {
  static instances: Socket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  onerror: any = null;
  send = jest.fn<(value: string | ArrayBuffer) => void>();
  close = jest.fn((_code?: number, _reason?: string) => {
    this.readyState = 3;
  });
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  peerClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  ready() {
    this.readyState = 1;
    this.onopen?.({});
    this.message({
      type: "ready",
      callId: created.callId,
      chatId: created.chat.id,
      model: REALTIME_MODEL,
      voice: created.voice,
      expiresIn: 240,
    });
  }
}
const created: RealtimeCallCreated = {
  callId: "11111111-1111-4111-8111-111111111111",
  chat: {
    id: "22222222-2222-4222-8222-222222222222",
    title: "合成通话",
    model: "gpt-4o-mini",
    archived: false,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
  model: REALTIME_MODEL,
  voice: "marin",
  vad: "natural",
  maxCallSeconds: 1800,
  wsPath: "/api/family/realtime?callId=11111111-1111-4111-8111-111111111111",
};
let scope: RealtimeScope,
  fetchMock: ReturnType<typeof jest.fn>,
  onFinished: ReturnType<typeof jest.fn>,
  onUnauthorized: ReturnType<typeof jest.fn>;
const originalFetch = global.fetch,
  randomDescriptor = Object.getOwnPropertyDescriptor(crypto, "randomUUID"),
  socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket"),
  visibilityDescriptor = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState",
  );
function hook() {
  return renderHook(() =>
    useFamilyRealtime({
      getScope: () => scope,
      onError: jest.fn(),
      onUnauthorized,
      onFinished,
    }),
  );
}
beforeEach(() => {
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: () => "33333333-3333-4333-8333-333333333333",
  });
  Bridge.instances = [];
  Bridge.wait = null;
  Socket.instances = [];
  scope = {
    epoch: 1,
    userId: "synthetic-owner",
    chatId: created.chat.id,
    verified: true,
    canStart: true,
  };
  onFinished = jest.fn();
  onUnauthorized = jest.fn();
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: Socket,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  fetchMock = jest.fn(async (_url: any, init: any) => ({
    ok: true,
    status: 200,
    json: async () => created,
    body: { cancel: async () => {} },
  }));
  global.fetch = fetchMock as typeof fetch;
});
afterEach(async () => {
  cleanupView();
  await act(async () => {
    await Promise.resolve();
  });
  global.fetch = originalFetch;
  if (socketDescriptor)
    Object.defineProperty(globalThis, "WebSocket", socketDescriptor);
  else Reflect.deleteProperty(globalThis, "WebSocket");
  if (visibilityDescriptor)
    Object.defineProperty(document, "visibilityState", visibilityDescriptor);
  else Reflect.deleteProperty(document, "visibilityState");
  if (randomDescriptor)
    Object.defineProperty(crypto, "randomUUID", randomDescriptor);
  else Reflect.deleteProperty(crypto, "randomUUID");
  jest.useRealTimers();
});
async function start(view: ReturnType<typeof hook>) {
  await act(async () => {
    await view.result.current.start();
  });
  const socket = Socket.instances.at(-1)!;
  act(() => socket.ready());
  return socket;
}
test("same-origin gesture call sends no PCM before ready, mutes capture, and waits for end ACK before refreshing history", async () => {
  const view = hook();
  await act(async () => {
    await view.result.current.start();
  });
  const audio = Bridge.instances[0],
    socket = Socket.instances[0];
  act(() => audio.callbacks.onPcm(new ArrayBuffer(4800)));
  expect(socket.send).not.toHaveBeenCalled();
  act(() => socket.ready());
  act(() => audio.callbacks.onPcm(new ArrayBuffer(4800)));
  expect(
    socket.send.mock.calls.some(([frame]) => frame instanceof ArrayBuffer),
  ).toBe(true);
  act(() => view.result.current.toggleMute());
  expect(audio.enabled).toBe(false);
  expect(view.result.current.muted).toBe(true);
  const before = socket.send.mock.calls.length;
  act(() => audio.callbacks.onPcm(new ArrayBuffer(4800)));
  expect(socket.send).toHaveBeenCalledTimes(before);
  act(() => view.result.current.end());
  expect(view.result.current.phase).toBe("ending");
  expect(audio.dispose).toHaveBeenCalled();
  expect(onFinished).not.toHaveBeenCalled();
  act(() => socket.message({ type: "ended", reason: "user" }));
  expect(onFinished).toHaveBeenCalledWith(created.chat.id);
  expect(view.result.current.busy).toBe(false);
  expect(fetchMock.mock.calls[0][0]).toBe("/api/family/realtime");
  expect(
    JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string),
  ).toMatchObject({ voice: "marin", vad: "natural" });
});
test("VAD interrupt reports played cursor and rejects stale old-response audio while preserving caption identity", async () => {
  const view = hook(),
    socket = await start(view),
    audio = Bridge.instances[0];
  act(() => {
    socket.message({
      type: "transcript",
      role: "user",
      itemId: "input-a",
      text: "合成",
      final: false,
    });
    socket.message({
      type: "transcript",
      role: "assistant",
      itemId: "item-a",
      text: "你好",
      final: false,
    });
    socket.message({
      type: "transcript",
      role: "user",
      itemId: "input-a",
      text: "合成问题",
      final: true,
    });
    socket.message({
      type: "audio",
      itemId: "item-a",
      responseId: "response-a",
      audio: "AAAAAA==",
    });
    socket.message({ type: "interrupt" });
    socket.message({
      type: "audio",
      itemId: "item-a",
      responseId: "response-a",
      audio: "AAAAAA==",
    });
  });
  expect(audio.append).toHaveBeenCalledTimes(1);
  const acknowledgements = socket.send.mock.calls
    .filter(([frame]) => typeof frame === "string")
    .map(([frame]) => JSON.parse(frame as string))
    .filter((message) => message.type === "interrupt");
  expect(acknowledgements).toEqual([
    { type: "interrupt", itemId: "item-a", audioEndMs: 123 },
  ]);
  expect(view.result.current.transcripts.map((item) => item.itemId)).toEqual([
    "input-a",
    "item-a",
  ]);
  expect(view.result.current.transcripts[0].text).toBe("合成问题");
  expect(view.result.current.transcripts[1].interrupted).toBe(true);
});

test("late VAD interrupts without a playback cursor never send a bare cancellation of the next response", async () => {
  const view = hook(),
    socket = await start(view),
    audio = Bridge.instances[0];
  audio.position = null;
  act(() => {
    socket.message({ type: "state", state: "user_speaking" });
    socket.message({ type: "state", state: "thinking" });
    socket.message({ type: "interrupt" });
    socket.message({ type: "interrupt" });
  });
  expect(audio.interrupt).toHaveBeenCalledTimes(2);
  expect(
    socket.send.mock.calls
      .filter(([frame]) => typeof frame === "string")
      .map(([frame]) => JSON.parse(frame as string))
      .filter((message) => message.type === "interrupt"),
  ).toEqual([]);
  act(() =>
    socket.message({
      type: "audio",
      itemId: "item-b",
      responseId: "response-b",
      audio: "AAAAAA==",
    }),
  );
  expect(audio.append).toHaveBeenCalledTimes(1);
  expect(audio.append.mock.calls.at(-1)?.[1]).toBe("response-b");
});

test("manual interruption during thinking is explicit even when only the finished response A cursor remains", async () => {
  const view = hook(),
    socket = await start(view),
    audio = Bridge.instances[0];
  act(() =>
    socket.message({
      type: "audio",
      itemId: "item-a",
      responseId: "response-a",
      audio: "AAAAAA==",
    }),
  );
  audio.position = { itemId: "item-a", audioEndMs: 123, idle: true };
  act(() => {
    socket.message({ type: "state", state: "thinking" });
    socket.message({ type: "interrupt" });
    view.result.current.interrupt();
  });
  expect(
    socket.send.mock.calls
      .filter(([frame]) => typeof frame === "string")
      .map(([frame]) => JSON.parse(frame as string))
      .filter((message) => message.type === "interrupt"),
  ).toEqual([
    { type: "interrupt", itemId: "item-a", audioEndMs: 123 },
    { type: "interrupt", manual: true, itemId: "item-a", audioEndMs: 123 },
  ]);
  audio.position = null;
  act(() => view.result.current.interrupt());
  expect(JSON.parse(socket.send.mock.calls.at(-1)![0] as string)).toEqual({
    type: "interrupt",
    manual: true,
  });
});
test("identity probes gate audio without discarding state; owner switch disposes without refreshing the old account", async () => {
  const view = hook(),
    socket = await start(view),
    audio = Bridge.instances[0];
  scope = { ...scope, verified: false };
  view.rerender();
  expect(audio.enabled).toBe(false);
  expect(view.result.current.phase).toBe("paused");
  const count = audio.append.mock.calls.length;
  act(() =>
    socket.message({
      type: "audio",
      itemId: "item-a",
      responseId: "response-a",
      audio: "AAAAAA==",
    }),
  );
  expect(audio.append).toHaveBeenCalledTimes(count);
  scope = { ...scope, verified: true };
  view.rerender();
  expect(audio.enabled).toBe(true);
  scope = { ...scope, epoch: 2, userId: "another-owner" };
  view.rerender();
  expect(audio.dispose).toHaveBeenCalled();
  expect(view.result.current.busy).toBe(false);
  expect(onFinished).not.toHaveBeenCalled();
  act(() =>
    socket.message({
      type: "transcript",
      role: "assistant",
      itemId: "late",
      text: "私有迟到字幕",
      final: true,
    }),
  );
  expect(view.result.current.transcripts).toHaveLength(0);
});
test("announced rotation reconnects the same call without replaying microphone data; unauthorized close never retries", async () => {
  jest.useFakeTimers();
  const view = hook(),
    first = await start(view),
    audio = Bridge.instances[0];
  act(() => {
    first.message({
      type: "audio",
      itemId: "item-a",
      responseId: "response-a",
      audio: "AAAAAA==",
    });
    first.message({ type: "rotate" });
    first.peerClose(1012);
  });
  expect(view.result.current.phase).toBe("reconnecting");
  await act(async () => {
    await jest.advanceTimersByTimeAsync(500);
  });
  expect(Socket.instances).toHaveLength(2);
  expect(
    fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit).method === "POST",
    ),
  ).toHaveLength(1);
  act(() => Socket.instances[1].ready());
  expect(audio.enabled).toBe(true);
  expect(audio.resetPlayback).toHaveBeenCalledTimes(2);
  expect(audio.position).toBeNull();
  act(() => Socket.instances[1].message({ type: "interrupt" }));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(250);
  });
  expect(
    Socket.instances[1].send.mock.calls
      .filter(([frame]) => typeof frame === "string")
      .map(([frame]) => JSON.parse(frame as string))
      .filter((message) => ["played", "interrupt"].includes(message.type)),
  ).toEqual([]);
  expect(
    Socket.instances[1].send.mock.calls.every(
      ([frame]) => typeof frame === "string",
    ),
  ).toBe(true);
  act(() =>
    Socket.instances[1].message({
      type: "audio",
      itemId: "item-b",
      responseId: "response-b",
      audio: "AAAAAA==",
    }),
  );
  await act(async () => {
    await jest.advanceTimersByTimeAsync(250);
  });
  expect(
    Socket.instances[1].send.mock.calls
      .filter(([frame]) => typeof frame === "string")
      .map(([frame]) => JSON.parse(frame as string))
      .filter((message) => message.type === "played"),
  ).toEqual([
    { type: "played", itemId: "item-b", audioEndMs: 123, idle: false },
  ]);
  act(() => Socket.instances[1].peerClose(1008));
  expect(onUnauthorized).toHaveBeenCalledTimes(1);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(20_000);
  });
  expect(Socket.instances).toHaveLength(2);
});
test("five failed reconnects stop, hidden stops immediately, and hangup timeout cannot leak timers", async () => {
  jest.useFakeTimers();
  const view = hook(),
    socket = await start(view);
  act(() => socket.peerClose(1006));
  for (const delay of [500, 1000, 2000, 4000, 8000]) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(delay);
    });
    act(() => Socket.instances.at(-1)!.peerClose(1006));
  }
  expect(view.result.current.busy).toBe(false);
  expect(Socket.instances).toHaveLength(6);
  await act(async () => {
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(0);
  });
  expect(jest.getTimerCount()).toBe(0);
  const second = hook();
  await start(second);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(second.result.current.busy).toBe(false);
  expect(Bridge.instances.at(-1)!.dispose).toHaveBeenCalled();
});
test("thirty-minute total call cap ends even when server rotates connections", async () => {
  jest.useFakeTimers();
  const view = hook(),
    socket = await start(view);
  // Advance the wall clock, not 30 minutes of synthetic network traffic.
  const base = Date.now();
  jest.setSystemTime(base + 1_800_000);
  await act(async () => {
    await jest.advanceTimersByTimeAsync(250);
  });
  expect(view.result.current.phase).toBe("ending");
  await act(async () => {
    await jest.advanceTimersByTimeAsync(5000);
  });
  expect(view.result.current.busy).toBe(false);
  expect(Bridge.instances[0].dispose).toHaveBeenCalled();
  expect(
    socket.send.mock.calls.some(
      ([text]) => typeof text === "string" && JSON.parse(text).type === "end",
    ),
  ).toBe(true);
});
test("panel offers four voices, natural/fast VAD and accessible call controls without starting a device", async () => {
  const view = hook();
  const panel = render(<RealtimePanel controller={view.result.current} />);
  fireEvent.click(screen.getByText("声音与停句"));
  fireEvent.click(screen.getByRole("combobox", { name: "声音" }));
  expect(screen.getAllByRole("option")).toHaveLength(4);
  fireEvent.click(screen.getByRole("combobox", { name: "声音" }));
  fireEvent.click(screen.getByRole("combobox", { name: "停句方式" }));
  expect(screen.getAllByRole("option")).toHaveLength(2);
  fireEvent.click(screen.getByRole("combobox", { name: "停句方式" }));
  chooseWorkspaceOption(
    screen.getByRole("combobox", { name: "声音" }),
    "cedar",
  );
  expect(view.result.current.voice).toBe("cedar");
  expect(Bridge.instances).toHaveLength(0);
  panel.unmount();
});

test("a late cancelled completion for response A cannot interrupt the already-playing response B", async () => {
  const view = hook(),
    socket = await start(view),
    audio = Bridge.instances[0];
  act(() => {
    socket.message({
      type: "audio",
      itemId: "item-a",
      responseId: "response-a",
      audio: "AAAAAA==",
    });
    socket.message({ type: "interrupt" });
    socket.message({
      type: "audio",
      itemId: "item-b",
      responseId: "response-b",
      audio: "AAAAAA==",
    });
  });
  const before = audio.interrupt.mock.calls.length;
  act(() =>
    socket.message({
      type: "turn_done",
      responseId: "response-a",
      status: "cancelled",
      usage: { source: "unknown", inputTokens: null, outputTokens: null },
    }),
  );
  expect(audio.interrupt).toHaveBeenCalledTimes(before);
  act(() =>
    socket.message({
      type: "audio",
      itemId: "item-b",
      responseId: "response-b",
      audio: "AAAAAA==",
    }),
  );
  expect(audio.append).toHaveBeenCalledTimes(3);
  expect(audio.append.mock.calls.at(-1)?.[1]).toBe("response-b");
});
test("cancelling the permission phase never prepares a server call when the late permission result arrives", async () => {
  let release!: () => void;
  Bridge.wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const view = hook();
  let pending!: Promise<void>;
  act(() => {
    pending = view.result.current.start();
  });
  expect(view.result.current.phase).toBe("permission");
  act(() => view.result.current.end());
  expect(Bridge.instances[0].dispose).toHaveBeenCalled();
  await act(async () => {
    release();
    await pending;
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(Socket.instances).toHaveLength(0);
  expect(onFinished).not.toHaveBeenCalled();
});

test("late prepare rejection and late audio-resume failure from owner A cannot change owner B", async () => {
  let resolve!: (value: any) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = hook();
  let pending!: Promise<void>;
  await act(async () => {
    pending = view.result.current.start();
    await Promise.resolve();
  });
  scope = { ...scope, epoch: 2, userId: "owner-b" };
  view.rerender();
  await act(async () => {
    resolve({
      ok: false,
      status: 403,
      json: async () => ({ error: "stale-a" }),
    });
    await pending;
  });
  expect(onUnauthorized).not.toHaveBeenCalled();
  expect(view.result.current.error).toBe("");
  await start(view);
  let reject!: (error: Error) => void;
  Bridge.instances.at(-1)!.resume.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  let resuming!: Promise<void>;
  act(() => {
    resuming = view.result.current.resumeAudio();
  });
  scope = { ...scope, epoch: 3, userId: "owner-c" };
  view.rerender();
  await act(async () => {
    reject(new Error("late-audio"));
    await resuming;
  });
  expect(view.result.current.error).toBe("");
  expect(onUnauthorized).not.toHaveBeenCalled();
});
