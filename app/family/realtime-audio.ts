"use client";
import {
  PCM_MAX_OUTPUT_SAMPLES,
  PCM_RATE,
  RealtimePcmFramer,
  RealtimeResampler,
  pcmFloat,
  playedSampleOffset,
  type PlayedCursor,
  type PlaybackSegment,
} from "./realtime-pcm";

export function realtimeAudioSupported(): boolean {
  const Context =
    typeof window !== "undefined" &&
    (window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext);
  return (
    !!Context &&
    "audioWorklet" in Context.prototype &&
    typeof AudioWorkletNode !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia
  );
}
type Segment = PlaybackSegment & {
  node: AudioBufferSourceNode;
  stopped: boolean;
};
export class RealtimeAudioBridge {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private input: MediaStreamAudioSourceNode | null = null;
  private capture: AudioWorkletNode | null = null;
  private silent: GainNode | null = null;
  private gain: GainNode | null = null;
  private readonly cancellation = new AbortController();
  private closed = false;
  private inputEnabled = false;
  private inputGeneration = 0;
  private resampler: RealtimeResampler | null = null;
  private framer = new RealtimePcmFramer();
  private segments = new Set<Segment>();
  private generated = new Map<string, number>();
  private played = new Map<string, number>();
  private lastItem: string | null = null;
  private responseId: string | null = null;
  private nextStart = 0;
  private closePromise: Promise<void> | null = null;
  constructor(
    private callbacks: {
      onPcm: (bytes: ArrayBuffer) => void;
      onBlocked: (blocked: boolean) => void;
      onMicrophoneEnded: () => void;
      onDrained: () => void;
      onLevel?: (level: number) => void;
    },
  ) {}

  /** Call synchronously from a trusted click before awaiting any server request. */
  async start(signal: AbortSignal): Promise<void> {
    if (!realtimeAudioSupported() || this.closed || this.context)
      throw new Error("此浏览器暂不支持连续语音，请使用按住说话。");
    const Context =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext!;
    const context = new Context({ latencyHint: "interactive" });
    this.context = context;
    const stop = () => {
      void this.dispose();
    };
    signal.addEventListener("abort", stop, { once: true });
    const resumed = context.resume();
    const permission = navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: { ideal: 1 },
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    // getUserMedia has no standard AbortSignal. A late permission result must
    // still release its tracks after end/reset/timeout or a context failure.
    void permission.then(
      (stream) => {
        if (this.closed || signal.aborted)
          stream.getTracks().forEach((track) => track.stop());
        else this.stream = stream;
      },
      () => {},
    );
    let aborted = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      aborted = () => reject(new DOMException("Cancelled", "AbortError"));
      this.cancellation.signal.addEventListener("abort", aborted, {
        once: true,
      });
    });
    try {
      if (signal.aborted) {
        stop();
        throw new DOMException("Cancelled", "AbortError");
      }
      const [, stream] = await Promise.race([
        Promise.all([resumed, permission]),
        cancelled,
      ]);
      if (this.closed || signal.aborted)
        throw new DOMException("Cancelled", "AbortError");
      this.stream = stream;
      await Promise.race([
        context.audioWorklet.addModule("/family-realtime-worklet.js"),
        cancelled,
      ]);
      if (this.closed || signal.aborted)
        throw new DOMException("Cancelled", "AbortError");
      this.resampler = new RealtimeResampler(context.sampleRate);
      this.input = context.createMediaStreamSource(stream);
      this.capture = new AudioWorkletNode(context, "family-realtime-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.silent = context.createGain();
      this.silent.gain.value = 0;
      this.gain = context.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(context.destination);
      this.input.connect(this.capture);
      this.capture.connect(this.silent);
      this.silent.connect(context.destination);
      this.capture.port.onmessage = (event) => {
        try {
          if (this.closed || !this.inputEnabled || context.state !== "running")
            return;
          if (
            typeof event.data.generation === "number" &&
            event.data.generation !== this.inputGeneration
          )
            return;
          if (
            typeof event.data.capturedAt === "number" &&
            (!Number.isFinite(event.data.capturedAt) ||
              context.currentTime - event.data.capturedAt > 0.5 ||
              event.data.capturedAt - context.currentTime > 0.2)
          ) {
            this.resampler?.reset();
            this.framer.reset();
            return;
          }
          const samples = event.data?.samples;
          if (
            event.data?.type !== "samples" ||
            !(samples instanceof Float32Array) ||
            samples.length > Math.ceil(context.sampleRate / 5)
          )
            return;
          const normalized = this.resampler!.push(samples);
          let energy = 0;
          for (const sample of normalized) energy += sample * sample;
          this.callbacks.onLevel?.(
            normalized.length
              ? Math.min(1, Math.sqrt(energy / normalized.length) * 4)
              : 0,
          );
          for (const bytes of this.framer.push(normalized))
            this.callbacks.onPcm(bytes);
        } finally {
          this.capture?.port.postMessage({
            type: "ack",
            generation: event.data?.generation,
          });
        }
      };
      context.onstatechange = () => {
        if (this.closed) return;
        this.updateInputGate();
        this.callbacks.onBlocked(context.state !== "running");
      };
      for (const track of stream.getTracks())
        track.addEventListener("ended", this.onTrackEnded);
      this.updateInputGate();
      this.callbacks.onBlocked(context.state !== "running");
    } catch (error) {
      await this.dispose();
      throw error;
    } finally {
      signal.removeEventListener("abort", stop);
      this.cancellation.signal.removeEventListener("abort", aborted);
    }
  }
  private onTrackEnded = () => {
    if (!this.closed) this.callbacks.onMicrophoneEnded();
  };
  private updateInputGate() {
    const enabled =
      this.inputEnabled && !this.closed && this.context?.state === "running";
    this.inputGeneration++;
    this.capture?.port.postMessage({
      type: "gate",
      enabled,
      generation: this.inputGeneration,
    });
    if (!enabled) {
      this.resampler?.reset();
      this.framer.reset();
    }
  }
  setInputEnabled(enabled: boolean) {
    this.inputEnabled = enabled;
    this.updateInputGate();
  }
  private renderedTime(): number {
    const context = this.context;
    if (!context) return 0;
    try {
      const timestamp = context.getOutputTimestamp?.();
      if (
        timestamp &&
        Number.isFinite(timestamp.contextTime) &&
        timestamp.contextTime! > 0
      )
        return Math.max(
          0,
          Math.min(context.currentTime, timestamp.contextTime!),
        );
    } catch {}
    const latency =
      typeof context.outputLatency === "number" &&
      Number.isFinite(context.outputLatency)
        ? context.outputLatency
        : context.baseLatency || 0;
    return Math.max(0, context.currentTime - Math.max(0, latency));
  }
  cursor(): PlayedCursor | null {
    const time = this.renderedTime();
    for (const segment of this.segments) {
      if (time < segment.start) continue;
      const offset = playedSampleOffset(segment, time);
      this.played.set(
        segment.itemId,
        Math.max(this.played.get(segment.itemId) ?? 0, offset),
      );
      this.lastItem = segment.itemId;
      if (time >= segment.end) {
        this.segments.delete(segment);
        segment.node.onended = null;
        segment.node.disconnect();
      }
    }
    const itemId = this.lastItem;
    if (!itemId) return null;
    return {
      itemId,
      audioEndMs: Math.floor(
        ((this.played.get(itemId) ?? 0) / PCM_RATE) * 1000,
      ),
      idle: this.segments.size === 0,
    };
  }
  append(itemId: string, responseId: string, bytes: ArrayBuffer) {
    const context = this.context,
      gain = this.gain;
    if (this.closed || !context || !gain || context.state !== "running") return;
    if (this.responseId && this.responseId !== responseId) this.interrupt();
    this.responseId = responseId;
    const samples = pcmFloat(bytes),
      time = this.renderedTime();
    const queued = [...this.segments].reduce(
      (sum, segment) =>
        sum +
        segment.samples -
        (playedSampleOffset(segment, time) - segment.offset),
      0,
    );
    if (
      queued + samples.length > PCM_MAX_OUTPUT_SAMPLES ||
      this.segments.size >= 600
    )
      throw new Error("播放缓冲已满，通话已暂停。请检查网络后重新开始。");
    const buffer = context.createBuffer(1, samples.length, PCM_RATE);
    buffer.getChannelData(0).set(samples);
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(gain);
    const start = Math.max(context.currentTime + 0.035, this.nextStart),
      offset = this.generated.get(itemId) ?? 0;
    const segment: Segment = {
      node,
      itemId,
      start,
      end: start + samples.length / PCM_RATE,
      offset,
      samples: samples.length,
      stopped: false,
    };
    this.generated.set(itemId, offset + samples.length);
    if (!this.segments.size) this.lastItem = itemId;
    this.nextStart = segment.end;
    this.segments.add(segment);
    node.onended = () => {
      if (segment.stopped) return;
      node.onended = null;
      node.disconnect();
      // Graph completion can precede device output. Keep timing metadata until
      // getOutputTimestamp/currentTime-latency reaches this segment's end.
      if (this.cursor()?.idle) this.callbacks.onDrained();
    };
    node.start(start);
  }
  interrupt(): PlayedCursor | null {
    const cursor = this.cursor();
    for (const segment of this.segments) {
      segment.stopped = true;
      segment.node.onended = null;
      try {
        segment.node.stop();
      } catch {}
      segment.node.disconnect();
    }
    this.segments.clear();
    this.nextStart = this.context?.currentTime ?? 0;
    this.responseId = null;
    return cursor ? { ...cursor, idle: true } : null;
  }
  resetPlayback(): void {
    // Playback item IDs and sample offsets belong to one relay connection.
    // Reconnecting retains capture/context, but the new relay cannot accept
    // cursors from the previous connection's playback map.
    this.interrupt();
    this.generated.clear();
    this.played.clear();
    this.lastItem = null;
    this.responseId = null;
    this.nextStart = 0;
  }
  async resume(): Promise<void> {
    if (!this.context || this.closed) throw new Error("请重新开始通话。");
    await this.context.resume();
    if (this.context.state !== "running")
      throw new Error("请再次点击继续播放以恢复手机音频。");
    this.updateInputGate();
    this.callbacks.onBlocked(false);
  }
  dispose(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.inputEnabled = false;
    this.cancellation.abort();
    this.interrupt();
    this.capture?.port.postMessage({ type: "gate", enabled: false });
    if (this.capture) {
      this.capture.port.onmessage = null;
      this.capture.port.close();
      this.capture.disconnect();
    }
    this.input?.disconnect();
    this.silent?.disconnect();
    this.gain?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) {
      track.removeEventListener("ended", this.onTrackEnded);
      track.stop();
    }
    this.stream = null;
    this.capture = null;
    this.input = null;
    this.silent = null;
    this.gain = null;
    this.generated.clear();
    this.played.clear();
    this.lastItem = null;
    const context = this.context;
    this.context = null;
    if (context) context.onstatechange = null;
    this.closePromise =
      context && context.state !== "closed"
        ? context.close().catch(() => {})
        : Promise.resolve();
    return this.closePromise;
  }
}
