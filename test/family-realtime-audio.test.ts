/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import {
  RealtimeAudioBridge,
  realtimeAudioSupported,
} from "../app/family/realtime-audio";

class Track extends EventTarget {
  stop = jest.fn();
}
class Source {
  buffer: any;
  onended: (() => void) | null = null;
  start = jest.fn();
  stop = jest.fn();
  disconnect = jest.fn();
  connect = jest.fn();
}
class Context {
  static instances: Context[] = [];
  state = "running";
  sampleRate = 48000;
  currentTime = 0;
  baseLatency = 0;
  outputLatency = 0;
  destination = {};
  onstatechange: (() => void) | null = null;
  audioWorklet = { addModule: jest.fn(async () => {}) };
  sources: Source[] = [];
  resume = jest.fn(async () => {
    this.state = "running";
    this.onstatechange?.();
  });
  close = jest.fn(async () => {
    this.state = "closed";
  });
  constructor() {
    Context.instances.push(this);
  }
  createMediaStreamSource = jest.fn(() => ({
    connect: jest.fn(),
    disconnect: jest.fn(),
  }));
  createGain = () => ({
    gain: { value: 0 },
    connect: jest.fn(),
    disconnect: jest.fn(),
  });
  createBuffer = (_channels: number, length: number, _rate: number) => ({
    getChannelData: () => new Float32Array(length),
  });
  createBufferSource = () => {
    const source = new Source();
    this.sources.push(source);
    return source;
  };
  getOutputTimestamp = () => ({
    contextTime: this.currentTime,
    performanceTime: 0,
  });
}
Object.defineProperty(Context.prototype, "audioWorklet", {
  value: { addModule: async () => {} },
  configurable: true,
  writable: true,
});
class Worklet {
  static instances: Worklet[] = [];
  port = { onmessage: null as any, postMessage: jest.fn(), close: jest.fn() };
  connect = jest.fn();
  disconnect = jest.fn();
  constructor() {
    Worklet.instances.push(this);
  }
}
const names = [
  [window, "AudioContext"],
  [globalThis, "AudioWorkletNode"],
  [navigator, "mediaDevices"],
] as const;
const descriptors = names.map(([target, key]) =>
  Object.getOwnPropertyDescriptor(target, key),
);
let track: Track,
  mic: ReturnType<typeof jest.fn>,
  bridges: RealtimeAudioBridge[];
function bridge() {
  const onPcm = jest.fn<(bytes: ArrayBuffer) => void>(),
    onDrained = jest.fn(),
    onBlocked = jest.fn(),
    onMicrophoneEnded = jest.fn();
  const audio = new RealtimeAudioBridge({
    onPcm,
    onDrained,
    onBlocked,
    onMicrophoneEnded,
  });
  bridges.push(audio);
  return { audio, onPcm, onDrained, onBlocked, onMicrophoneEnded };
}
beforeEach(() => {
  Context.instances = [];
  Worklet.instances = [];
  bridges = [];
  track = new Track();
  mic = jest.fn(async () => ({ getTracks: () => [track] }));
  Object.defineProperty(window, "AudioContext", {
    configurable: true,
    value: Context,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    value: Worklet,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: mic },
  });
});
afterEach(async () => {
  await Promise.all(bridges.map((audio) => audio.dispose()));
  names.forEach(([target, key], index) => {
    const descriptor = descriptors[index];
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  });
});
test("feature detection never opens a microphone and start unlocks the context in its gesture", async () => {
  expect(realtimeAudioSupported()).toBe(true);
  expect(mic).not.toHaveBeenCalled();
  const { audio, onPcm } = bridge();
  const pending = audio.start(new AbortController().signal);
  expect(Context.instances[0].resume).toHaveBeenCalledTimes(1);
  expect(mic).toHaveBeenCalledTimes(1);
  await pending;
  expect(Context.instances[0].audioWorklet.addModule).toHaveBeenCalledWith(
    "/family-realtime-worklet.js",
  );
  audio.setInputEnabled(true);
  Worklet.instances[0].port.onmessage({
    data: { type: "samples", samples: new Float32Array(4800).fill(0.5) },
  });
  expect(onPcm).toHaveBeenCalledTimes(1);
  expect(onPcm.mock.calls[0][0].byteLength).toBe(4800);
  audio.setInputEnabled(false);
  Worklet.instances[0].port.onmessage({
    data: { type: "samples", samples: new Float32Array(4800).fill(0.5) },
  });
  expect(onPcm).toHaveBeenCalledTimes(1);
});
test("a late permission result after cancellation is stopped and cannot create a worklet", async () => {
  let resolve!: (stream: any) => void;
  mic.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { audio } = bridge();
  const controller = new AbortController();
  const pending = audio.start(controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await rejected;
  resolve({ getTracks: () => [track] });
  await Promise.resolve();
  await Promise.resolve();
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(Worklet.instances).toHaveLength(0);
  expect(Context.instances[0].close).toHaveBeenCalledTimes(1);
});
test("rendered cursor ignores future chunks, clears scheduled sources, and queue cannot exceed 30 seconds", async () => {
  const { audio } = bridge();
  await audio.start(new AbortController().signal);
  const context = Context.instances[0];
  const chunk = new ArrayBuffer(4800);
  audio.append("item", "response", chunk);
  audio.append("item", "response", chunk);
  expect(audio.cursor()?.audioEndMs).toBe(0);
  context.currentTime = 0.085;
  expect(audio.cursor()?.audioEndMs).toBe(50);
  const cursor = audio.interrupt();
  expect(cursor?.audioEndMs).toBe(50);
  expect(
    context.sources.every((source) => source.stop.mock.calls.length === 1),
  ).toBe(true);
  for (let i = 0; i < 300; i++) audio.append("next", "next-response", chunk);
  expect(() => audio.append("next", "next-response", chunk)).toThrow("缓冲");
});
test("system interruption gates capture and idempotent dispose releases tracks, ports, nodes and context", async () => {
  const { audio, onBlocked, onMicrophoneEnded } = bridge();
  await audio.start(new AbortController().signal);
  audio.setInputEnabled(true);
  const context = Context.instances[0];
  context.state = "interrupted";
  context.onstatechange?.();
  expect(onBlocked).toHaveBeenLastCalledWith(true);
  expect(Worklet.instances[0].port.postMessage).toHaveBeenLastCalledWith({
    type: "gate",
    enabled: false,
    generation: expect.any(Number),
  });
  track.dispatchEvent(new Event("ended"));
  expect(onMicrophoneEnded).toHaveBeenCalledTimes(1);
  await audio.resume();
  expect(onBlocked).toHaveBeenLastCalledWith(false);
  await audio.dispose();
  await audio.dispose();
  expect(track.stop).toHaveBeenCalledTimes(1);
  expect(context.close).toHaveBeenCalledTimes(1);
  expect(Worklet.instances[0].port.close).toHaveBeenCalledTimes(1);
});

test("stale microphone batches are acknowledged and dropped rather than replayed after a main-thread stall", async () => {
  const { audio, onPcm } = bridge();
  await audio.start(new AbortController().signal);
  audio.setInputEnabled(true);
  const context = Context.instances[0],
    port = Worklet.instances[0].port;
  context.currentTime = 2;
  port.onmessage({
    data: { type: "samples", samples: new Float32Array(4800), capturedAt: 0 },
  });
  expect(onPcm).not.toHaveBeenCalled();
  expect(port.postMessage).toHaveBeenLastCalledWith({
    type: "ack",
    generation: undefined,
  });
  port.onmessage({
    data: { type: "samples", samples: new Float32Array(4800), capturedAt: 2 },
  });
  expect(onPcm).toHaveBeenCalledTimes(1);
});
