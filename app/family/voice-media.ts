export const MAX_VOICE_SECONDS = 45;
export type CapturePhase = "idle" | "permission" | "recording" | "processing";

function audioContextConstructor() {
  return (
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext
  );
}

/** Fixed 44-byte PCM header, 16-bit little-endian mono at 16 kHz. */
export function encodeVoiceWav(
  channels: readonly Float32Array[],
  sampleRate: number,
): Blob {
  if (!channels.length || !Number.isFinite(sampleRate) || sampleRate < 8000)
    throw new Error("无法读取录音格式，请重试。");
  const inputLength = Math.min(...channels.map((channel) => channel.length));
  const frames = Math.min(
    16000 * MAX_VOICE_SECONDS,
    Math.floor((inputLength * 16000) / sampleRate),
  );
  if (frames < 4800) throw new Error("录音太短，请按住至少半秒再松开。");
  const bytes = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++)
      view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 2, true);
  const mono = (index: number) =>
    channels.reduce(
      (sum, channel) => sum + (channel[Math.min(inputLength - 1, index)] || 0),
      0,
    ) / channels.length;
  const ratio = sampleRate / 16000;
  for (let frame = 0; frame < frames; frame++) {
    let sample = 0;
    if (ratio >= 1) {
      const start = frame * ratio,
        end = Math.min(inputLength, (frame + 1) * ratio);
      for (let input = Math.floor(start); input < Math.ceil(end); input++)
        sample +=
          mono(input) * (Math.min(end, input + 1) - Math.max(start, input));
      sample /= end - start;
    } else {
      const position = frame * ratio,
        left = Math.floor(position),
        fraction = position - left;
      sample = mono(left) * (1 - fraction) + mono(left + 1) * fraction;
    }
    sample = Math.max(-1, Math.min(1, sample));
    view.setInt16(
      44 + frame * 2,
      Math.round(sample * (sample < 0 ? 32768 : 32767)),
      true,
    );
  }
  return new Blob([bytes], { type: "audio/wav" });
}

export async function recordingToWav(
  blob: Blob,
  signal: AbortSignal,
): Promise<Blob> {
  const Context = audioContextConstructor();
  if (!Context) throw new Error("此浏览器无法处理录音，请改用文字输入。");
  const context = new Context();
  const close = () => {
    if (context.state !== "closed") void context.close().catch(() => undefined);
  };
  signal.addEventListener("abort", close, { once: true });
  try {
    const bytes = await blob.arrayBuffer();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const audio = await context.decodeAudioData(bytes);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return encodeVoiceWav(
      Array.from({ length: audio.numberOfChannels }, (_, channel) =>
        audio.getChannelData(channel),
      ),
      audio.sampleRate,
    );
  } finally {
    signal.removeEventListener("abort", close);
    close();
  }
}

/** No microphone is requested until start() is called by a user gesture. */
export class FamilyVoiceCapture {
  private sequence = 0;
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  private conversion: AbortController | null = null;
  private phase: CapturePhase = "idle";
  private pressed = false;
  constructor(
    private callbacks: {
      state: (phase: CapturePhase, seconds: number) => void;
      audio: (audio: Blob) => void | Promise<void>;
      error: (error: Error) => void;
    },
  ) {}
  private clearTimers() {
    if (this.timer) clearTimeout(this.timer);
    if (this.clock) clearInterval(this.clock);
    this.timer = null;
    this.clock = null;
  }
  private stopTracks() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
  async start() {
    if (this.phase !== "idle") return;
    const sequence = ++this.sequence;
    this.pressed = true;
    this.phase = "permission";
    this.callbacks.state("permission", 0);
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined" ||
        !audioContextConstructor()
      )
        throw new Error(
          "当前浏览器不支持录音，请用支持麦克风的手机浏览器或改用文字。",
        );
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
        video: false,
      });
      if (sequence !== this.sequence || !this.pressed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/mp4;codecs=mp4a.40.2",
        "audio/mp4",
        "audio/webm",
      ].find((mime) => MediaRecorder.isTypeSupported?.(mime));
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType, audioBitsPerSecond: 64000 } : undefined,
      );
      this.recorder = recorder;
      this.chunks = [];
      let size = 0;
      recorder.ondataavailable = (event) => {
        if (sequence !== this.sequence) return;
        size += event.data.size;
        if (size > 12 * 1024 * 1024) {
          this.cancel();
          this.callbacks.error(new Error("录音数据过大，请缩短后重试。"));
        } else if (event.data.size) this.chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (sequence === this.sequence) {
          this.cancel();
          this.callbacks.error(new Error("录音中断，请检查麦克风权限后重试。"));
        }
      };
      recorder.onstop = () => {
        if (sequence !== this.sequence) return;
        if (this.phase === "processing" && !this.pressed)
          void this.convert(sequence, recorder.mimeType || mimeType || "");
        else {
          this.cancel();
          this.callbacks.error(
            new Error("录音已中断，未发送。请重新按住说话。"),
          );
        }
      };
      recorder.start(250);
      this.phase = "recording";
      this.callbacks.state("recording", 0);
      const startedAt = Date.now();
      this.clock = setInterval(
        () =>
          this.callbacks.state(
            "recording",
            Math.min(45, Math.floor((Date.now() - startedAt) / 1000)),
          ),
        1000,
      );
      this.timer = setTimeout(() => this.release(), MAX_VOICE_SECONDS * 1000);
    } catch (failure) {
      if (sequence !== this.sequence) return;
      this.cancel();
      this.callbacks.error(
        new Error(
          failure instanceof DOMException && failure.name === "NotAllowedError"
            ? "麦克风权限未允许。请在浏览器设置中允许后再按住说话。"
            : failure instanceof Error
            ? failure.message
            : "无法开始录音。",
        ),
      );
    }
  }
  release() {
    this.pressed = false;
    if (
      this.phase !== "recording" ||
      !this.recorder ||
      this.recorder.state !== "recording"
    ) {
      if (this.phase === "permission") this.cancel();
      return;
    }
    this.clearTimers();
    this.phase = "processing";
    this.callbacks.state("processing", 0);
    this.recorder.stop();
    this.stopTracks();
  }
  cancelGesture() {
    if (this.pressed) this.cancel();
  }
  cancel() {
    this.sequence++;
    this.pressed = false;
    this.clearTimers();
    this.conversion?.abort();
    this.conversion = null;
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          /* already stopped */
        }
      }
    }
    this.stopTracks();
    this.chunks = [];
    this.phase = "idle";
    this.callbacks.state("idle", 0);
  }
  private async convert(sequence: number, mimeType: string) {
    const conversion = new AbortController();
    this.conversion = conversion;
    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks = [];
    this.recorder = null;
    try {
      const wav = await recordingToWav(blob, conversion.signal);
      if (sequence !== this.sequence || conversion.signal.aborted) return;
      this.phase = "idle";
      this.callbacks.state("idle", 0);
      await this.callbacks.audio(wav);
    } catch (failure) {
      if (sequence === this.sequence && !conversion.signal.aborted) {
        this.phase = "idle";
        this.callbacks.state("idle", 0);
        this.callbacks.error(
          new Error(
            failure instanceof Error
              ? failure.message
              : "录音处理失败，请重试。",
          ),
        );
      }
    } finally {
      if (this.conversion === conversion) this.conversion = null;
    }
  }
}
