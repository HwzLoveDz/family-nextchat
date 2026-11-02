import type { FamilyChat, FamilyUsage } from "./types";

export const REALTIME_MODEL = "gpt-realtime-2.1-mini";
export const REALTIME_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
export const REALTIME_VOICES = ["marin", "cedar", "coral", "sage"] as const;
export type RealtimeVoice = (typeof REALTIME_VOICES)[number];
export type RealtimeVad = "natural" | "fast";
export const REALTIME_SAMPLE_RATE = 24000;
export const REALTIME_MAX_CALL_SECONDS = 1800;
export const REALTIME_SEGMENT_SECONDS = 240;

export interface RealtimeCallCreated {
  callId: string;
  chat: FamilyChat;
  model: string;
  voice: RealtimeVoice;
  vad: RealtimeVad;
  maxCallSeconds: number;
  wsPath: string;
}
export type RealtimeClientControl =
  | { type: "ping" }
  | { type: "interrupt"; itemId?: string; audioEndMs?: number }
  | { type: "played"; itemId: string; audioEndMs: number; idle: boolean }
  | { type: "mute"; muted: boolean }
  | { type: "keepalive" }
  | { type: "end" };

// Raw upstream frames, credentials, tools and session configuration never cross
// this boundary. Microphone PCM16/mono/24kHz travels as bounded binary frames.
export type RealtimeServerEvent =
  | {
      type: "ready";
      callId: string;
      chatId: string;
      model: string;
      voice: RealtimeVoice;
      expiresIn: number;
    }
  | { type: "state"; state: "listening" | "user_speaking" | "thinking" }
  | { type: "audio"; itemId: string; responseId: string; audio: string }
  | {
      type: "transcript";
      role: "user" | "assistant";
      itemId: string;
      text: string;
      final: boolean;
    }
  | { type: "interrupt" }
  | {
      type: "turn_done";
      responseId: string;
      status: "completed" | "cancelled" | "failed" | "incomplete";
      usage: FamilyUsage;
    }
  | { type: "idle_warning"; seconds: number }
  | { type: "rotate" }
  | { type: "pong" }
  | { type: "ended"; reason: string }
  | { type: "error"; code: string; message: string; fatal: boolean };
