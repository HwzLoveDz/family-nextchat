/** Browser-independent PCM helpers; no devices, networking or application state. */
export const PCM_RATE = 24_000;
export const PCM_FRAME_SAMPLES = 2_400;
export const PCM_MAX_OUTPUT_SAMPLES = PCM_RATE * 30;

/** Stateful area resampler: fractional bins continue across arbitrary blocks. */
export class RealtimeResampler {
  private readonly ratio: number;
  private remaining: number;
  private sum = 0;
  constructor(sourceRate: number) {
    if (
      !Number.isFinite(sourceRate) ||
      sourceRate < 8_000 ||
      sourceRate > 192_000
    )
      throw new Error("无法读取麦克风采样率。");
    this.ratio = sourceRate / PCM_RATE;
    this.remaining = this.ratio;
  }
  reset() {
    this.remaining = this.ratio;
    this.sum = 0;
  }
  push(samples: Float32Array): Float32Array {
    if (samples.length > 192_000) throw new Error("录音数据块超出限制。");
    const output: number[] = [];
    for (const raw of samples) {
      const sample = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
      let left = 1;
      while (left > 1e-9) {
        const take = Math.min(left, this.remaining);
        this.sum += sample * take;
        left -= take;
        this.remaining -= take;
        if (this.remaining <= 1e-9) {
          output.push(this.sum / this.ratio);
          this.sum = 0;
          this.remaining = this.ratio;
        }
      }
    }
    return Float32Array.from(output);
  }
}
export class RealtimePcmFramer {
  private samples = new Float32Array(PCM_FRAME_SAMPLES);
  private offset = 0;
  reset() {
    this.offset = 0;
    this.samples.fill(0);
  }
  push(input: Float32Array): ArrayBuffer[] {
    const frames: ArrayBuffer[] = [];
    for (const value of input) {
      this.samples[this.offset++] = value;
      if (this.offset === PCM_FRAME_SAMPLES) {
        const bytes = new ArrayBuffer(PCM_FRAME_SAMPLES * 2),
          view = new DataView(bytes);
        for (let i = 0; i < this.offset; i++) {
          const sample = Number.isFinite(this.samples[i])
            ? Math.max(-1, Math.min(1, this.samples[i]))
            : 0;
          view.setInt16(
            i * 2,
            Math.round(sample * (sample < 0 ? 32768 : 32767)),
            true,
          );
        }
        frames.push(bytes);
        this.offset = 0;
      }
    }
    return frames;
  }
}
export function decodeRealtimePcm(value: unknown): ArrayBuffer {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 14_000 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error("语音数据格式无效。");
  const decoded = atob(value);
  if (
    !decoded.length ||
    decoded.length % 2 ||
    decoded.length > 9_600 ||
    btoa(decoded) !== value
  )
    throw new Error("语音数据超出限制。");
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0)).buffer;
}
export function pcmFloat(bytes: ArrayBuffer): Float32Array {
  if (!bytes.byteLength || bytes.byteLength % 2 || bytes.byteLength > 9_600)
    throw new Error("语音数据格式无效。");
  const view = new DataView(bytes),
    output = new Float32Array(bytes.byteLength / 2);
  for (let i = 0; i < output.length; i++)
    output[i] = view.getInt16(i * 2, true) / 32768;
  return output;
}
export interface PlayedCursor {
  itemId: string;
  audioEndMs: number;
  idle: boolean;
}
export interface PlaybackSegment {
  itemId: string;
  start: number;
  end: number;
  offset: number;
  samples: number;
}
export function playedSampleOffset(
  segment: PlaybackSegment,
  renderedTime: number,
): number {
  if (!Number.isFinite(renderedTime)) return segment.offset;
  return (
    segment.offset +
    Math.max(
      0,
      Math.min(
        segment.samples,
        Math.floor((renderedTime - segment.start) * PCM_RATE),
      ),
    )
  );
}
