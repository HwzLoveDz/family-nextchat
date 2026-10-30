import "server-only";
import { FamilyApiError } from "./errors";
import type { FamilyUsage } from "../types";

export const VOICE_INPUT_MAX = 1_440_044;
export const VOICE_PCM_MAX = 3_599_954; // Even PCM bytes; WAV remains below 3.6 MB.
export const unknownVoiceUsage = (): FamilyUsage => ({
  source: "unknown",
  inputTokens: null,
  outputTokens: null,
});
export function voiceUsage(value: unknown): FamilyUsage {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    value.type === "duration"
  )
    return unknownVoiceUsage();
  if (
    value &&
    typeof value === "object" &&
    "input_tokens" in value &&
    "output_tokens" in value &&
    Number.isSafeInteger(value.input_tokens) &&
    Number.isSafeInteger(value.output_tokens) &&
    (value.input_tokens as number) >= 0 &&
    (value.output_tokens as number) >= 0
  )
    return {
      source: "reported",
      inputTokens: value.input_tokens as number,
      outputTokens: value.output_tokens as number,
    };
  return unknownVoiceUsage();
}
export function reportedVoiceSeconds(value: unknown): number | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("type" in value) ||
    value.type !== "duration" ||
    !("seconds" in value)
  )
    return null;
  return typeof value.seconds === "number" &&
    Number.isFinite(value.seconds) &&
    value.seconds >= 0 &&
    value.seconds <= 75
    ? value.seconds
    : null;
}
export function safeVoiceModel(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(value)
    ? value
    : null;
}

/** Canonical 44-byte WAV only: metadata, extensions and browser MIME are not trusted. */
export function validateVoiceWav(bytes: Uint8Array): { audioSeconds: number } {
  const invalid = () => {
    throw new FamilyApiError(
      400,
      "录音格式无效，请重新录制。",
      "INVALID_VOICE_WAV",
    );
  };
  if (bytes.length < 44 || bytes.length > VOICE_INPUT_MAX) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, text: string) =>
    [...text].every(
      (char, index) => bytes[offset + index] === char.charCodeAt(0),
    );
  if (
    !tag(0, "RIFF") ||
    !tag(8, "WAVE") ||
    !tag(12, "fmt ") ||
    !tag(36, "data") ||
    view.getUint32(4, true) !== bytes.length - 8 ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== 16000 ||
    view.getUint32(28, true) !== 32000 ||
    view.getUint16(32, true) !== 2 ||
    view.getUint16(34, true) !== 16 ||
    view.getUint32(40, true) !== bytes.length - 44 ||
    (bytes.length - 44) % 2 !== 0
  )
    invalid();
  const audioSeconds = (bytes.length - 44) / 32000;
  if (audioSeconds < 0.3 || audioSeconds > 45)
    throw new FamilyApiError(
      400,
      "录音需为 0.3–45 秒。",
      "VOICE_DURATION_LIMIT",
    );
  return { audioSeconds };
}

export function speechParts(markdown: string): {
  parts: string[];
  truncated: boolean;
} {
  const readable = markdown
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/[`*_~|]/g, " ")
    .replace(
      /&(?:amp|lt|gt|quot|apos|nbsp);/g,
      (entity) =>
        ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&apos;": "'",
          "&nbsp;": " ",
        })[entity] ?? " ",
    )
    .replace(/\s+/g, " ")
    .trim();
  const points = Array.from(readable);
  const selected = points.slice(0, 2400);
  const parts: string[] = [];
  for (let index = 0; index < selected.length; index += 240)
    parts.push(selected.slice(index, index + 240).join(""));
  if (!parts.length)
    throw new FamilyApiError(
      400,
      "这条回复没有可朗读的文字。",
      "NO_SPEECH_TEXT",
    );
  return { parts, truncated: points.length > 2400 };
}

export function pcm24kWav(pcm: Uint8Array): Uint8Array {
  if (!pcm.length || pcm.length % 2 || pcm.length > VOICE_PCM_MAX)
    throw new FamilyApiError(502, "语音音频格式无效。", "INVALID_VOICE_OUTPUT");
  const bytes = new Uint8Array(44 + pcm.length);
  const view = new DataView(bytes.buffer);
  for (const [offset, text] of [
    [0, "RIFF"],
    [8, "WAVE"],
    [12, "fmt "],
    [36, "data"],
  ] as const)
    for (let index = 0; index < text.length; index++)
      bytes[offset + index] = text.charCodeAt(index);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, pcm.length, true);
  bytes.set(pcm, 44);
  return bytes;
}
