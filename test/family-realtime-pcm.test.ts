/** @jest-environment node */
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import {
  RealtimeResampler,
  RealtimePcmFramer,
  decodeRealtimePcm,
  pcmFloat,
  playedSampleOffset,
} from "../app/family/realtime-pcm";

test.each([44100, 48000, 96000, 24000])(
  "streaming %sHz resampling is independent of render quantum boundaries",
  (rate) => {
    const samples = Float32Array.from({ length: rate }, (_, index) =>
      Math.sin((index / rate) * Math.PI * 800),
    );
    const whole = new RealtimeResampler(rate).push(samples);
    const split = new RealtimeResampler(rate),
      parts: Float32Array[] = [];
    for (let offset = 0; offset < samples.length; offset += 137)
      parts.push(split.push(samples.subarray(offset, offset + 137)));
    const joined = Float32Array.from(parts.flatMap((part) => Array.from(part)));
    expect(whole.length).toBe(24000);
    expect(joined).toEqual(whole);
  },
);
test("PCM framer clips safely, preserves little endian sign and drops pre-gate partial samples", () => {
  const framer = new RealtimePcmFramer();
  expect(framer.push(new Float32Array(1200).fill(1))).toHaveLength(0);
  framer.reset();
  const frames = framer.push(
    Float32Array.from({ length: 2400 }, (_, i) => (i % 2 ? -2 : 2)),
  );
  expect(frames).toHaveLength(1);
  expect(frames[0].byteLength).toBe(4800);
  const view = new DataView(frames[0]);
  expect(view.getInt16(0, true)).toBe(32767);
  expect(view.getInt16(2, true)).toBe(-32768);
});
test.each(["data:audio/pcm;base64,AAAA", "AAA", "AB==", "AA==", "A==="])(
  "untrusted PCM base64 %p is rejected",
  (value) => {
    expect(() => decodeRealtimePcm(value)).toThrow();
  },
);
test("PCM audio decodes with a bounded exact binary format", () => {
  const data = decodeRealtimePcm("AIAAQA==");
  expect(Array.from(pcmFloat(data))).toEqual([-1, 0.5]);
  expect(() =>
    decodeRealtimePcm(Buffer.alloc(9602).toString("base64")),
  ).toThrow();
});
test("played cursor clamps the actually elapsed segment instead of counting its full buffer", () => {
  const segment = {
    itemId: "item",
    start: 1,
    end: 2,
    offset: 0,
    samples: 24000,
  };
  expect(playedSampleOffset(segment, 0.5)).toBe(0);
  expect(playedSampleOffset(segment, 1.25)).toBe(6000);
  expect(playedSampleOffset(segment, 5)).toBe(24000);
});
test("trusted worklet keeps capturing after real buffer transfers, bounds unacknowledged batches and produces silent monitor output", () => {
  let Processor: any;
  const { port1, port2 } = new MessageChannel();
  const messages: any[] = [];
  const context = {
    AudioWorkletProcessor: class {
      port = {
        onmessage: null as any,
        postMessage: (message: any, transfer: ArrayBuffer[]) => {
          const sendingSamples = message.samples;
          port1.postMessage(message, transfer);
          // This is the native transfer behavior, rather than a postMessage
          // mock that accidentally leaves the sender's buffer usable.
          expect(sendingSamples.length).toBe(0);
          expect(sendingSamples.buffer.byteLength).toBe(0);
          const received = receiveMessageOnPort(port2);
          expect(received).toBeDefined();
          messages.push(received!.message);
        },
      };
    },
    sampleRate: 48000,
    Float32Array,
    Number,
    Math,
    registerProcessor: (_name: string, value: any) => {
      Processor = value;
    },
  };
  try {
    runInNewContext(
      readFileSync(
        new URL("../public/family-realtime-worklet.js", import.meta.url),
        "utf8",
      ),
      context,
    );
    const instance = new Processor(),
      output = [new Float32Array(257).fill(1)];
    instance.process([[new Float32Array(257).fill(0.5)]], [output]);
    expect(messages).toHaveLength(0);
    expect(output[0].every((value) => value === 0)).toBe(true);
    instance.port.onmessage({ data: { type: "gate", enabled: true } });
    const feed = (quanta = 20) => {
      for (let i = 0; i < quanta; i++)
        instance.process([[new Float32Array(257).fill(0.5)]], [output]);
    };
    for (let batch = 0; batch < 5; batch++) {
      if (batch)
        instance.port.onmessage({ data: { type: "ack", generation: 0 } });
      feed();
      expect(messages).toHaveLength(batch + 1);
      expect(messages[batch].samples.length).toBe(4800);
      expect(
        messages[batch].samples.every((value: number) => value === 0.5),
      ).toBe(true);
    }
    for (let i = 0; i < 200; i++)
      instance.process([[new Float32Array(257).fill(0.5)]], [output]);
    expect(messages).toHaveLength(5);
    instance.port.onmessage({ data: { type: "ack", generation: 99 } });
    feed();
    expect(messages).toHaveLength(5);
    instance.port.onmessage({ data: { type: "ack", generation: 0 } });
    feed();
    expect(messages).toHaveLength(6);
    instance.port.onmessage({ data: { type: "gate", enabled: false } });
    feed();
    expect(messages).toHaveLength(6);
    instance.port.onmessage({
      data: { type: "gate", enabled: true, generation: 1 },
    });
    feed();
    expect(messages).toHaveLength(7);
    instance.port.onmessage({ data: { type: "ack", generation: 0 } });
    feed();
    expect(messages).toHaveLength(7);
    instance.port.onmessage({ data: { type: "ack", generation: 1 } });
    feed();
    expect(messages).toHaveLength(8);
  } finally {
    port1.close();
    port2.close();
  }
});
