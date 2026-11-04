import "server-only";
import WebSocket, { type RawData } from "ws";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { getDeadline } from "@vercel/functions";
import {
  REALTIME_MODEL,
  REALTIME_TRANSCRIBE_MODEL,
  REALTIME_VOICES,
  type RealtimeServerEvent,
} from "../realtime-types";
import type { FamilyUsage } from "../types";
import { FamilyApiError } from "./errors";
import {
  withProviderKey,
  rejectExhaustedQuota,
  isQuotaExhaustedDetails,
  ProviderQuotaExhaustedError,
} from "./provider-keys";
import { voiceUsage, unknownVoiceUsage } from "./voice-media";
import {
  type RealtimeContext,
  assertRealtimeLease,
  beginRealtimeTurn,
  recordRealtimeTranscript,
  recordRealtimeResponse,
  markRealtimeInterrupted,
  markRealtimePlayed,
  releaseRealtimeConnection,
} from "./realtime-ledger";

export interface RealtimePeer {
  on(
    event: "message" | "close" | "error",
    listener: (...args: any[]) => void,
  ): unknown;
  removeListener(
    event: "message" | "close" | "error",
    listener: (...args: any[]) => void,
  ): unknown;
  send(data: string): unknown;
  close(code: number, reason: string): unknown;
  readonly readyState: number;
  readonly bufferedAmount: number;
}

const OPEN = 1;
const PCM_BYTES_PER_SECOND = 48_000;
const MAX_TEXT = 12_000;
const MAX_QUEUE_BYTES = PCM_BYTES_PER_SECOND * 30;
const MAX_BUFFERED_BYTES = 1_048_576;
const MAX_PROVIDER_FRAME = 1_048_576;
const PROVIDER_ID = /^[a-zA-Z0-9_-]{1,200}$/;
const SAFE_ERROR_CODES = new Set([
  "invalid_value",
  "invalid_request_error",
  "invalid_event",
  "missing_required_parameter",
  "unsupported_value",
  "unknown_parameter",
  "string_above_max_length",
  "string_too_long",
  "invalid_api_key",
  "insufficient_quota",
  "rate_limit_exceeded",
  "server_error",
]);
const SAFE_ERROR_TYPES = new Set([
  "invalid_request_error",
  "server_error",
  "authentication_error",
  "rate_limit_error",
]);
const SAFE_ERROR_PARAMS = new Set([
  "item",
  "item.id",
  "item.content",
  "item.content[0]",
  "item.content[0].type",
  "session",
  "session.audio.input",
  "session.audio.input.turn_detection",
  "session.audio.output.voice",
  "response",
]);
function logProviderError(
  error: unknown,
  phase: "session" | "history" | "active",
) {
  const value =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  // Never log provider messages, event/item IDs, user content, or unknown values.
  console.error("[FamilyRealtime] provider rejected event", {
    phase,
    ...(typeof value.code === "string" && SAFE_ERROR_CODES.has(value.code)
      ? { code: value.code }
      : {}),
    ...(typeof value.type === "string" && SAFE_ERROR_TYPES.has(value.type)
      ? { type: value.type }
      : {}),
    ...(typeof value.param === "string" && SAFE_ERROR_PARAMS.has(value.param)
      ? { param: value.param }
      : {}),
  });
}
type FinalStatus = "completed" | "cancelled" | "failed" | "incomplete";
type Turn = {
  responseId: string;
  inputItemId: string;
  outputItemId?: string;
  text: string;
  done: boolean;
  status?: FinalStatus;
};
type Playback = {
  responseId: string;
  generated: number;
  playedMs: number;
  idle: boolean;
  interrupted: boolean;
  heardComplete: boolean;
};

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_REALTIME_OBJECT");
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_ID.test(value))
    throw new Error("INVALID_REALTIME_ID");
  return value;
}
function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_TEXT)
    throw new Error("INVALID_REALTIME_TEXT");
  return value;
}
function rawBytes(value: RawData, limit: number): Buffer {
  const size = Array.isArray(value)
    ? value.reduce((sum, item) => sum + item.byteLength, 0)
    : value.byteLength;
  if (size > limit) throw new Error("REALTIME_FRAME_LIMIT");
  return Buffer.isBuffer(value)
    ? value
    : Array.isArray(value)
    ? Buffer.concat(value, size)
    : Buffer.from(value);
}
function pcm(value: unknown): Buffer {
  if (
    typeof value !== "string" ||
    value.length > MAX_PROVIDER_FRAME ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error("INVALID_REALTIME_AUDIO");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length % 2 || bytes.toString("base64") !== value)
    throw new Error("INVALID_REALTIME_AUDIO");
  return bytes;
}
function actualModel(value: unknown): string | null {
  return typeof value === "string" && /^gpt-[a-zA-Z0-9._-]{1,160}$/.test(value)
    ? value
    : null;
}
function expectedSessionModel(value: unknown, expected: string): boolean {
  return (
    !!actualModel(value) &&
    (value === expected ||
      (typeof value === "string" && value.startsWith(expected + "-")))
  );
}
const providerFailure = () =>
  new FamilyApiError(
    502,
    "实时语音服务暂时不可用，请稍后重试。",
    "REALTIME_PROVIDER_ERROR",
  );

/** Owns both sockets and all per-connection timers. Never replays an accepted session. */
export async function startRealtimeRelay(
  peer: RealtimePeer,
  context: RealtimeContext,
): Promise<void> {
  const controller = new AbortController();
  const sockets = new Set<WebSocket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const turns = new Map<string, Turn>();
  const playback = new Map<string, Playback>();
  const inputs = new Set<string>();
  const inputTranscripts = new Map<string, string>();
  const awaitingResponse: string[] = [];
  const discardedResponses = new Set<string>();
  const manuallyCancelledInputs = new Set<string>();
  const pendingHistory = new Set<string>();
  let upstream: WebSocket | undefined;
  let ready = false;
  let configured = false;
  let created = false;
  let stopping = false;
  let finished = false;
  let resume = false;
  let reason = "connection_closed";
  let deferredPeerClose: {
    code: number;
    reason: string;
    started: number;
  } | null = null;
  let activeResponse: string | null = null;
  let userSpeaking = false;
  let lastPeer = Date.now();
  let lastSpeech = lastPeer;
  let warnedIdle = false;
  let muted = false;
  let inputBytes = 0;
  let inputCredit = PCM_BYTES_PER_SECOND * 2;
  let creditTime = lastPeer;
  let leasePending = false;
  let pendingWrites = 0;
  let writesFailed = false;
  let stopWrites = false;
  let writes = Promise.resolve();
  let reportedModel: string | null = null;
  const started = Date.now();
  const runtimeDeadline = getDeadline();
  const hardBudget = Math.max(
    0,
    Math.min(
      270_000,
      runtimeDeadline ? runtimeDeadline.getTime() - started - 25_000 : 270_000,
    ),
  );
  const rotateAfter = Math.min(240_000, Math.max(0, hardBudget - 30_000));
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const setTimer = (run: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
    return timer;
  };
  const verifyLease = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        assertRealtimeLease(context),
        new Promise<never>((_, reject) => {
          timer = setTimer(
            () => reject(new Error("REALTIME_LEASE_TIMEOUT")),
            8000,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(timer);
      }
    }
  };
  const send = (event: RealtimeServerEvent) => {
    if (stopping || peer.readyState !== OPEN) return;
    if (peer.bufferedAmount > MAX_BUFFERED_BYTES) {
      close("slow_connection", 1011, true);
      return;
    }
    try {
      peer.send(JSON.stringify(event));
    } catch {
      close("connection_closed", 1011, true);
    }
  };
  const providerSend = (event: unknown) => {
    if (upstream?.readyState !== OPEN) throw providerFailure();
    if (upstream.bufferedAmount > MAX_BUFFERED_BYTES) throw providerFailure();
    upstream.send(JSON.stringify(event));
  };
  const persist = (task: () => Promise<void>) => {
    if (stopWrites || writesFailed) return;
    if (++pendingWrites > 24) {
      --pendingWrites;
      writesFailed = true;
      fatal("REALTIME_STORAGE_BUSY", "聊天保存较慢，请稍后重试。", 1011);
      return;
    }
    writes = writes
      .then(async () => {
        if (!stopWrites && !writesFailed) await task();
      })
      .catch(() => {
        writesFailed = true;
        fatal("REALTIME_STORAGE_ERROR", "聊天暂时无法保存，请稍后重试。", 1011);
      })
      .finally(() => {
        --pendingWrites;
      });
  };
  const markInterrupted = (
    itemId: string,
    item: Playback,
    playedMs: number,
  ) => {
    if (item.interrupted) return;
    item.interrupted = true;
    item.idle = true;
    persist(() => markRealtimeInterrupted(context, itemId, playedMs));
  };
  const markHeard = (itemId: string, item: Playback) => {
    const turn = turns.get(item.responseId);
    const generatedMs = Math.floor(
      (item.generated / PCM_BYTES_PER_SECOND) * 1000,
    );
    if (
      !item.interrupted &&
      !item.heardComplete &&
      item.generated > 0 &&
      item.idle &&
      turn?.done &&
      turn.status === "completed" &&
      item.playedMs >= generatedMs
    ) {
      item.heardComplete = true;
      persist(() => markRealtimePlayed(context, itemId, item.playedMs, true));
    }
  };
  function close(why: string, code: number, reconnect: boolean) {
    if (stopping) return;
    stopping = true;
    reason = why;
    resume =
      reconnect && context.remainingSeconds - (Date.now() - started) / 1000 > 2;
    if (!reconnect && code === 1000)
      deferredPeerClose = { code, reason: why, started: Date.now() };
    for (const [itemId, item] of playback) {
      if (
        !item.heardComplete &&
        item.generated > (item.playedMs * PCM_BYTES_PER_SECOND) / 1000
      )
        markInterrupted(itemId, item, item.playedMs);
    }
    if (activeResponse && upstream?.readyState === OPEN) {
      try {
        providerSend({ type: "response.cancel", response_id: activeResponse });
      } catch {
        /* Cancellation cannot prevent final cleanup. */
      }
    }
    if (!reconnect && !deferredPeerClose && peer.readyState === OPEN) {
      try {
        peer.send(
          JSON.stringify({
            type: "ended",
            reason: why,
          } satisfies RealtimeServerEvent),
        );
      } catch {
        /* The peer may already be gone. */
      }
    }
    controller.abort();
    if (!deferredPeerClose) {
      try {
        peer.close(code, why);
      } catch {
        /* Already closed. */
      }
    }
    // Allow the provider's cancelled response.done and ASR usage to arrive.
    if (upstream?.readyState === OPEN && inputs.size) setTimer(finish, 1200);
    else finish();
  }
  function fatal(code: string, message: string, closeCode = 1011) {
    if (
      !stopping &&
      peer.readyState === OPEN &&
      peer.bufferedAmount <= MAX_BUFFERED_BYTES
    ) {
      try {
        peer.send(
          JSON.stringify({
            type: "error",
            code,
            message,
            fatal: true,
          } satisfies RealtimeServerEvent),
        );
      } catch {
        /* Authorization/error cleanup cannot depend on delivery. */
      }
    }
    close(
      closeCode === 1008 ? "authorization_lost" : "service_error",
      closeCode,
      false,
    );
  }
  function checkRotation() {
    if (!ready || stopping || Date.now() - started < rotateAfter) return;
    const pendingAudio = [...playback.values()].some(
      (item) =>
        !item.interrupted &&
        !item.idle &&
        item.generated > (item.playedMs * PCM_BYTES_PER_SECOND) / 1000,
    );
    if (!userSpeaking && !activeResponse && !pendingAudio) {
      send({ type: "rotate" });
      close("rotation", 1012, true);
    }
  }
  function checkTurnLimit() {
    if (
      stopping ||
      inputs.size < context.remainingTurns ||
      activeResponse ||
      awaitingResponse.length
    )
      return;
    const pendingAudio = [...playback.values()].some(
      (item) =>
        !item.interrupted &&
        !item.idle &&
        item.generated > (item.playedMs * PCM_BYTES_PER_SECOND) / 1000,
    );
    if (!pendingAudio) close("turn_limit", 1000, false);
  }
  const interrupt = (itemId?: string, cursor?: number, manual = false) => {
    const manualIntent = manual || !itemId;
    // Bind an early manual stop to already committed inputs, never a future turn.
    if (manualIntent)
      for (const inputId of awaitingResponse)
        manuallyCancelledInputs.add(inputId);
    let selected = itemId;
    if (!selected && activeResponse)
      selected = turns.get(activeResponse)?.outputItemId;
    if (!selected)
      selected = [...playback.entries()]
        .reverse()
        .find(
          ([, item]) =>
            !item.interrupted &&
            item.generated > (item.playedMs * PCM_BYTES_PER_SECOND) / 1000,
        )?.[0];
    const item = selected ? playback.get(selected) : undefined;
    if (selected && !item) throw new Error("UNKNOWN_PLAYBACK_ITEM");
    // A VAD cursor can arrive after a newer response was created. An explicit
    // item cursor belongs only to its own response; a manual bare control may
    // still target the current response.
    if (
      activeResponse &&
      (manualIntent || item?.responseId === activeResponse)
    ) {
      discardedResponses.add(activeResponse);
      providerSend({ type: "response.cancel", response_id: activeResponse });
    }
    if (!selected || !item) return;
    const duration = Math.floor((item.generated / PCM_BYTES_PER_SECOND) * 1000);
    const playedMs = Math.floor(
      Math.min(duration, Math.max(item.playedMs, cursor ?? item.playedMs)),
    );
    item.playedMs = playedMs;
    discardedResponses.add(item.responseId);
    if (item.heardComplete && playedMs >= duration) return;
    if (!item.interrupted) {
      providerSend({
        type: "conversation.item.truncate",
        item_id: selected,
        content_index: 0,
        audio_end_ms: playedMs,
      });
      markInterrupted(selected, item, playedMs);
    }
  };
  const onPeerMessage = (raw: RawData, binary: boolean) => {
    if (stopping) return;
    try {
      const bytes = rawBytes(raw, 16_384);
      if (binary) {
        if (!ready || !bytes.length || bytes.length > 9600 || bytes.length % 2)
          throw new Error("INVALID_INPUT_AUDIO");
        lastPeer = Date.now();
        inputCredit = Math.min(
          PCM_BYTES_PER_SECOND * 2,
          inputCredit +
            ((lastPeer - creditTime) * PCM_BYTES_PER_SECOND * 2) / 1000,
        );
        creditTime = lastPeer;
        if (bytes.length > inputCredit) throw new Error("INPUT_AUDIO_RATE");
        inputCredit -= bytes.length;
        if (!muted && inputs.size < context.remainingTurns) {
          inputBytes += bytes.length;
          providerSend({
            type: "input_audio_buffer.append",
            audio: bytes.toString("base64"),
          });
        }
        return;
      }
      const control = object(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
      const allowed: Record<string, string[]> = {
        ping: ["type"],
        end: ["type"],
        keepalive: ["type"],
        mute: ["type", "muted"],
        interrupt: ["type", "itemId", "audioEndMs", "manual"],
        played: ["type", "itemId", "audioEndMs", "idle"],
      };
      if (
        !allowed[control.type] ||
        Object.keys(control).some((key) => !allowed[control.type].includes(key))
      )
        throw new Error("INVALID_CONTROL");
      lastPeer = Date.now();
      if (control.type === "end") {
        close("ended", 1000, false);
        return;
      }
      if (control.type === "ping") {
        send({ type: "pong" });
        return;
      }
      if (!ready) throw new Error("CONTROL_BEFORE_READY");
      if (control.type === "keepalive") {
        lastSpeech = Date.now();
        warnedIdle = false;
        return;
      }
      if (control.type === "mute") {
        if (typeof control.muted !== "boolean")
          throw new Error("INVALID_CONTROL");
        muted = control.muted;
        if (muted) providerSend({ type: "input_audio_buffer.clear" });
        return;
      }
      if (
        control.audioEndMs !== undefined &&
        (!Number.isSafeInteger(control.audioEndMs) || control.audioEndMs < 0)
      )
        throw new Error("INVALID_PLAYBACK_CURSOR");
      if (control.type === "interrupt") {
        if (control.manual !== undefined && control.manual !== true)
          throw new Error("INVALID_CONTROL");
        interrupt(
          control.itemId === undefined ? undefined : identifier(control.itemId),
          control.audioEndMs,
          control.manual === true,
        );
      } else {
        const itemId = identifier(control.itemId);
        const item = playback.get(itemId);
        if (
          !item ||
          typeof control.idle !== "boolean" ||
          typeof control.audioEndMs !== "number"
        )
          throw new Error("INVALID_PLAYBACK_CURSOR");
        const generatedMs = Math.floor(
          (item.generated / PCM_BYTES_PER_SECOND) * 1000,
        );
        item.playedMs = Math.min(
          generatedMs,
          Math.max(item.playedMs, control.audioEndMs),
        );
        item.idle = control.idle && item.playedMs >= generatedMs;
        markHeard(itemId, item);
        checkTurnLimit();
        checkRotation();
      }
    } catch {
      fatal(
        "REALTIME_INVALID_INPUT",
        "实时语音数据无效，请重新开始通话。",
        1008,
      );
    }
  };
  const onPeerClose = () => close("connection_closed", 1000, true);
  const onPeerError = () => close("connection_closed", 1011, true);

  const handleProvider = (raw: RawData, binary: boolean) => {
    if (finished) return;
    try {
      if (binary) throw new Error("UNEXPECTED_PROVIDER_BINARY");
      const event = object(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            rawBytes(raw, MAX_PROVIDER_FRAME),
          ),
        ),
      );
      if (typeof event.type !== "string")
        throw new Error("MISSING_PROVIDER_TYPE");
      if (
        stopping &&
        ![
          "response.done",
          "conversation.item.input_audio_transcription.completed",
        ].includes(event.type)
      )
        return;
      if (event.type === "session.created") {
        if (created) throw new Error("DUPLICATE_SESSION");
        const session = object(event.session);
        if (
          session.type !== "realtime" ||
          !expectedSessionModel(session.model, context.model)
        )
          throw new Error("INVALID_SESSION");
        created = true;
        reportedModel = actualModel(session.model);
        providerSend({
          type: "session.update",
          session: {
            type: "realtime",
            output_modalities: ["audio"],
            max_output_tokens: 1024,
            instructions:
              "你是家庭日常交流助手。用自然、简洁的中文回答；直接听取用户语音，可被用户打断。不要声称没有依据的事实。",
            tools: [],
            audio: {
              input: {
                format: { type: "audio/pcm", rate: 24000 },
                transcription: {
                  model: REALTIME_TRANSCRIBE_MODEL,
                  language: "zh",
                },
                turn_detection:
                  context.vad === "natural"
                    ? {
                        type: "semantic_vad",
                        eagerness: "auto",
                        create_response: true,
                        interrupt_response: true,
                      }
                    : {
                        type: "server_vad",
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 700,
                        create_response: true,
                        interrupt_response: true,
                      },
              },
              output: {
                format: { type: "audio/pcm", rate: 24000 },
                voice: context.voice,
              },
            },
          },
        });
        return;
      }
      const announceReady = () => {
        if (ready || !configured || pendingHistory.size) return;
        ready = true;
        send({
          type: "ready",
          callId: context.callId,
          chatId: context.chatId,
          model: REALTIME_MODEL,
          voice: context.voice,
          expiresIn: Math.max(
            0,
            Math.floor(
              context.remainingSeconds - (Date.now() - started) / 1000,
            ),
          ),
        });
        send({ type: "state", state: "listening" });
      };
      if (event.type === "session.updated") {
        if (!created || configured) throw new Error("INVALID_SESSION_UPDATE");
        const session = object(event.session);
        if (
          session.type !== "realtime" ||
          !expectedSessionModel(session.model, context.model)
        )
          throw new Error("INVALID_SESSION_UPDATE");
        configured = true;
        for (const [index, item] of context.history.entries()) {
          // Item IDs are scoped to this upstream session and must fit its 32-char limit.
          const historyId = `history_${index}`;
          pendingHistory.add(historyId);
          providerSend({
            type: "conversation.item.create",
            item: {
              id: historyId,
              type: "message",
              role: item.role,
              content: [
                {
                  type: item.role === "user" ? "input_text" : "output_text",
                  text: item.content,
                },
              ],
            },
          });
        }
        announceReady();
        return;
      }
      if (event.type === "error") {
        // A cancellation may race a finished response; all other errors are fatal.
        if (event.error?.code === "response_cancel_not_active") return;
        logProviderError(
          event.error,
          ready ? "active" : configured ? "history" : "session",
        );
        throw providerFailure();
      }
      if (
        configured &&
        [
          "conversation.item.created",
          "conversation.item.done",
          "conversation.item.added",
        ].includes(event.type)
      ) {
        const item = object(event.item);
        // Newer added/done variants must confirm a complete item, not an empty shell.
        if (
          event.type !== "conversation.item.added" ||
          item.status === "completed"
        ) {
          if (pendingHistory.delete(identifier(item.id))) announceReady();
        }
        return;
      }
      if (
        !ready &&
        ["conversation.created", "rate_limits.updated"].includes(event.type)
      )
        return;
      if (!ready && !stopping) throw new Error("PROVIDER_EVENT_BEFORE_READY");
      if (event.type === "input_audio_buffer.speech_started") {
        identifier(event.item_id);
        userSpeaking = true;
        lastSpeech = Date.now();
        warnedIdle = false;
        // The browser supplies its actual playback cursor in its interrupt control.
        if (activeResponse) discardedResponses.add(activeResponse);
        send({ type: "interrupt" });
        send({ type: "state", state: "user_speaking" });
      } else if (event.type === "input_audio_buffer.speech_stopped") {
        identifier(event.item_id);
        userSpeaking = false;
        lastSpeech = Date.now();
        send({ type: "state", state: "thinking" });
      } else if (event.type === "input_audio_buffer.committed") {
        const itemId = identifier(event.item_id);
        if (inputs.has(itemId)) return;
        if (inputs.size >= context.remainingTurns) {
          close("turn_limit", 1000, false);
          return;
        }
        inputs.add(itemId);
        inputTranscripts.set(itemId, "");
        awaitingResponse.push(itemId);
        persist(() => beginRealtimeTurn(context, itemId));
        if (inputs.size >= context.remainingTurns)
          providerSend({ type: "input_audio_buffer.clear" });
      } else if (
        event.type === "conversation.item.input_audio_transcription.completed"
      ) {
        const itemId = identifier(event.item_id);
        if (!inputs.has(itemId)) throw new Error("UNKNOWN_INPUT_ITEM");
        const text = boundedText(event.transcript);
        inputTranscripts.set(itemId, text);
        const rawUsage = event.usage;
        const seconds =
          rawUsage?.type === "duration" &&
          Number.isFinite(rawUsage.seconds) &&
          rawUsage.seconds >= 0 &&
          rawUsage.seconds <= 1800
            ? rawUsage.seconds
            : null;
        const usage = voiceUsage(rawUsage);
        persist(() =>
          recordRealtimeTranscript(
            context,
            itemId,
            text,
            usage,
            seconds,
            actualModel(event.model),
          ),
        );
        if (!stopping)
          send({ type: "transcript", role: "user", itemId, text, final: true });
      } else if (
        event.type === "conversation.item.input_audio_transcription.delta"
      ) {
        const itemId = identifier(event.item_id);
        if (!inputs.has(itemId)) throw new Error("UNKNOWN_INPUT_ITEM");
        const delta = boundedText(event.delta);
        inputTranscripts.set(
          itemId,
          boundedText((inputTranscripts.get(itemId) ?? "") + delta),
        );
        send({
          type: "transcript",
          role: "user",
          itemId,
          text: delta,
          final: false,
        });
      } else if (
        event.type === "conversation.item.input_audio_transcription.failed"
      ) {
        const itemId = identifier(event.item_id);
        if (!inputs.has(itemId)) throw new Error("UNKNOWN_INPUT_ITEM");
        persist(() =>
          recordRealtimeTranscript(
            context,
            itemId,
            "",
            unknownVoiceUsage(),
            null,
            null,
          ),
        );
        send({
          type: "error",
          code: "REALTIME_TRANSCRIPT_FAILED",
          message: "本轮语音字幕暂时无法识别。",
          fatal: false,
        });
      } else if (event.type === "response.created") {
        const response = object(event.response);
        const responseId = identifier(response.id);
        if (turns.has(responseId)) return;
        const inputItemId = awaitingResponse.shift();
        if (!inputItemId || turns.size >= 100)
          throw new Error("UNMAPPED_RESPONSE");
        turns.set(responseId, {
          responseId,
          inputItemId,
          text: "",
          done: false,
        });
        activeResponse = responseId;
        if (manuallyCancelledInputs.delete(inputItemId)) {
          discardedResponses.add(responseId);
          providerSend({ type: "response.cancel", response_id: responseId });
        }
      } else if (event.type === "response.output_item.added") {
        const turn = turns.get(identifier(event.response_id));
        const item = object(event.item);
        const itemId = identifier(item.id);
        if (
          !turn ||
          item.type !== "message" ||
          item.role !== "assistant" ||
          (turn.outputItemId && turn.outputItemId !== itemId)
        )
          throw new Error("INVALID_OUTPUT_ITEM");
        turn.outputItemId = itemId;
        if (!playback.has(itemId))
          playback.set(itemId, {
            responseId: turn.responseId,
            generated: 0,
            playedMs: 0,
            idle: true,
            interrupted: false,
            heardComplete: false,
          });
      } else if (
        [
          "response.output_audio.delta",
          "response.output_audio_transcript.delta",
          "response.output_audio_transcript.done",
        ].includes(event.type)
      ) {
        const turn = turns.get(identifier(event.response_id));
        const itemId = identifier(event.item_id);
        const item = playback.get(itemId);
        if (
          !turn ||
          !item ||
          turn.outputItemId !== itemId ||
          turn.done ||
          event.content_index !== 0
        )
          throw new Error("INVALID_OUTPUT_EVENT");
        if (event.type === "response.output_audio.delta") {
          const audio = pcm(event.delta);
          item.generated += audio.length;
          if (item.generated > PCM_BYTES_PER_SECOND * 120)
            throw new Error("OUTPUT_TURN_LIMIT");
          const queued = [...playback.values()].reduce(
            (sum, entry) =>
              sum +
              (entry.interrupted || discardedResponses.has(entry.responseId)
                ? 0
                : Math.max(
                    0,
                    entry.generated -
                      (entry.playedMs * PCM_BYTES_PER_SECOND) / 1000,
                  )),
            0,
          );
          if (queued > MAX_QUEUE_BYTES) throw new Error("OUTPUT_QUEUE_LIMIT");
          if (!item.interrupted && !discardedResponses.has(turn.responseId)) {
            item.idle = false;
            for (let offset = 0; offset < audio.length; offset += 4800)
              send({
                type: "audio",
                itemId,
                responseId: turn.responseId,
                audio: audio.subarray(offset, offset + 4800).toString("base64"),
              });
          }
        } else {
          turn.text = event.type.endsWith(".done")
            ? boundedText(event.transcript)
            : boundedText(turn.text + boundedText(event.delta));
          send({
            type: "transcript",
            role: "assistant",
            itemId,
            text: event.type.endsWith(".done") ? turn.text : event.delta,
            final: event.type.endsWith(".done"),
          });
        }
      } else if (event.type === "response.done") {
        const response = object(event.response);
        const responseId = identifier(response.id);
        const turn = turns.get(responseId);
        if (
          !turn ||
          !["completed", "cancelled", "failed", "incomplete"].includes(
            response.status,
          )
        )
          throw new Error("INVALID_RESPONSE_DONE");
        if (turn.done) return;
        if (response.output !== undefined) {
          if (!Array.isArray(response.output) || response.output.length > 2)
            throw new Error("INVALID_RESPONSE_OUTPUT");
          for (const output of response.output) {
            if (output.type !== "message" || output.role !== "assistant")
              throw new Error("INVALID_RESPONSE_OUTPUT");
            const itemId = identifier(output.id);
            if (turn.outputItemId && turn.outputItemId !== itemId)
              throw new Error("INVALID_RESPONSE_OUTPUT");
            turn.outputItemId = itemId;
            if (!Array.isArray(output.content) || output.content.length > 2)
              throw new Error("INVALID_RESPONSE_OUTPUT");
            for (const content of output.content) {
              if (
                content.type === "output_audio" &&
                typeof content.transcript === "string"
              )
                turn.text = boundedText(content.transcript);
              else if (content.type === "output_text")
                turn.text = boundedText(content.text);
            }
          }
        }
        turn.done = true;
        turn.status = response.status;
        const usage: FamilyUsage = voiceUsage(response.usage);
        persist(() =>
          recordRealtimeResponse(context, {
            responseId,
            inputItemId: turn.inputItemId,
            outputItemId: turn.outputItemId,
            text: turn.text,
            status: response.status,
            usage,
            actualModel: actualModel(response.model) ?? reportedModel,
          }),
        );
        if (activeResponse === responseId) activeResponse = null;
        if (turn.outputItemId) {
          const item = playback.get(turn.outputItemId);
          if (item) markHeard(turn.outputItemId, item);
        }
        send({ type: "turn_done", responseId, status: response.status, usage });
        send({
          type: "state",
          state: userSpeaking ? "user_speaking" : "listening",
        });
        checkTurnLimit();
        checkRotation();
      }
    } catch {
      if (!stopping)
        fatal("REALTIME_PROVIDER_ERROR", "实时语音连接异常，请重新开始通话。");
    }
  };

  const connect = () =>
    withProviderKey(
      (credential) =>
        new Promise<void>((resolve, reject) => {
          let socket: WebSocket;
          let opened = false;
          let accepted = false;
          let settled = false;
          let rejection: IncomingMessage | undefined;
          const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            controller.signal.removeEventListener("abort", abort);
            rejection?.destroy();
            socket?.removeAllListeners();
            socket?.on("error", () => {});
            if (socket) sockets.delete(socket);
            try {
              socket?.terminate();
            } catch {
              /* Rejection cleanup cannot prevent the next credential attempt. */
            }
            reject(error);
          };
          const abort = () => {
            if (!accepted) fail(new DOMException("请求已取消。", "AbortError"));
          };
          try {
            socket = new WebSocket(
              `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`,
              {
                headers: { Authorization: `Bearer ${credential.key}` },
                handshakeTimeout: 10_000,
                maxPayload: MAX_PROVIDER_FRAME,
              },
            );
            sockets.add(socket);
            controller.signal.addEventListener("abort", abort, { once: true });
            socket.on("open", () => {
              if (settled || stopping) {
                socket.terminate();
                return;
              }
              opened = true;
            });
            socket.on("message", (raw: RawData, binary: boolean) => {
              if (accepted) {
                handleProvider(raw, binary);
                return;
              }
              if (settled) return;
              if (stopping || controller.signal.aborted) {
                abort();
                return;
              }
              try {
                if (!opened || binary) throw providerFailure();
                const event = object(
                  JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(
                      rawBytes(raw, MAX_PROVIDER_FRAME),
                    ),
                  ),
                );
                // HTTP 101 is not session acceptance. An explicit quota rejection
                // in the first frame is safe to retry: upstream is still unset,
                // so no session.update, history, or microphone data was sent.
                if (
                  event.type === "error" &&
                  isQuotaExhaustedDetails(event.error)
                )
                  throw new ProviderQuotaExhaustedError();
                if (event.type !== "session.created") throw providerFailure();
                const session = object(event.session);
                if (
                  session.type !== "realtime" ||
                  !expectedSessionModel(session.model, context.model)
                )
                  throw providerFailure();
                accepted = true;
                settled = true;
                upstream = socket;
                controller.signal.removeEventListener("abort", abort);
                resolve();
                handleProvider(raw, binary);
              } catch (error) {
                fail(
                  error instanceof ProviderQuotaExhaustedError
                    ? error
                    : providerFailure(),
                );
              }
            });
            socket.on("error", () => {
              if (!accepted) fail(providerFailure());
              else close("provider_disconnected", 1011, true);
            });
            socket.on("close", () => {
              if (!accepted) fail(providerFailure());
              else if (!stopping) close("provider_disconnected", 1011, true);
            });
            socket.on("unexpected-response", async (_request, response) => {
              if (opened || settled) {
                response.destroy();
                return;
              }
              rejection = response;
              try {
                if (response.statusCode === 429) {
                  const body = Readable.toWeb(
                    response,
                  ) as ReadableStream<Uint8Array>;
                  await rejectExhaustedQuota(
                    new Response(body, { status: 429 }),
                    controller.signal,
                  );
                }
                fail(providerFailure());
              } catch (error) {
                fail(error);
              } finally {
                response.destroy();
              }
            });
          } catch {
            fail(providerFailure());
          }
        }),
      controller.signal,
    );

  peer.on("message", onPeerMessage);
  peer.on("close", onPeerClose);
  peer.on("error", onPeerError);
  const ticker = setInterval(() => {
    if (stopping) return;
    const now = Date.now();
    if (now - lastPeer > 35_000) {
      close("peer_timeout", 1011, true);
      return;
    }
    if (now - lastSpeech >= 120_000) {
      close("idle_timeout", 1000, false);
      return;
    }
    if (!warnedIdle && now - lastSpeech >= 60_000) {
      warnedIdle = true;
      send({ type: "idle_warning", seconds: 60 });
    }
    checkRotation();
  }, 1000);
  const lease = setInterval(() => {
    if (stopping || leasePending) return;
    leasePending = true;
    void verifyLease()
      .catch(() => {
        fatal(
          "REALTIME_AUTHORIZATION_LOST",
          "登录状态或通话权限已失效。",
          1008,
        );
      })
      .finally(() => {
        leasePending = false;
      });
  }, 5000);
  const heartbeat = setInterval(() => send({ type: "pong" }), 15_000);
  setTimer(() => {
    if (!ready)
      fatal("REALTIME_CONNECT_TIMEOUT", "实时语音连接超时，请稍后重试。");
  }, 15_000);
  setTimer(
    () => {
      if (context.remainingSeconds * 1000 <= hardBudget)
        close("call_time_limit", 1000, false);
      else {
        send({ type: "rotate" });
        close("rotation", 1012, true);
      }
    },
    Math.min(hardBudget, context.remainingSeconds * 1000),
  );
  try {
    if (
      context.model !== REALTIME_MODEL ||
      !REALTIME_VOICES.includes(context.voice) ||
      !["natural", "fast"].includes(context.vad) ||
      !Number.isFinite(context.remainingSeconds) ||
      context.remainingSeconds <= 0 ||
      context.remainingSeconds > 1800 ||
      !Number.isSafeInteger(context.remainingTurns) ||
      context.remainingTurns < 0 ||
      context.remainingTurns > 100 ||
      context.history.length > 24 ||
      context.history.reduce((sum, item) => sum + item.content.length, 0) >
        20_000 ||
      context.history.some(
        (item) =>
          !["user", "assistant"].includes(item.role) ||
          item.content.length > MAX_TEXT,
      )
    )
      throw providerFailure();
    if (context.remainingTurns === 0) {
      close("turn_limit", 1000, false);
      await ended;
      return;
    }
    leasePending = true;
    try {
      await verifyLease();
    } finally {
      leasePending = false;
    }
    if (!stopping) await connect();
    await ended;
  } catch (error) {
    if (!stopping) {
      if (error instanceof FamilyApiError)
        fatal(
          error.code === "PROVIDER_QUOTA_EXHAUSTED"
            ? error.code
            : "REALTIME_UNAVAILABLE",
          error.code === "PROVIDER_QUOTA_EXHAUSTED"
            ? error.message
            : "实时语音暂时不可用，请稍后重试。",
          [401, 403].includes(error.status) ? 1008 : 1011,
        );
      else fatal("REALTIME_UNAVAILABLE", "实时语音暂时不可用，请稍后重试。");
    }
  } finally {
    finished = true;
    stopping = true;
    controller.abort();
    clearInterval(ticker);
    clearInterval(lease);
    clearInterval(heartbeat);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    peer.removeListener("message", onPeerMessage);
    peer.removeListener("close", onPeerClose);
    peer.removeListener("error", onPeerError);
    for (const socket of sockets) {
      socket.removeAllListeners();
      socket.on("error", () => {});
      try {
        socket.terminate();
      } catch {
        /* Already terminated. */
      }
    }
    const bounded = async (
      operation: Promise<unknown>,
      ms: number,
    ): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation.then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), ms);
          }),
        ]);
      } catch {
        return false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const deferred = deferredPeerClose as {
      code: number;
      reason: string;
      started: number;
    } | null;
    let pendingNoticeSent = false;
    const savePending = () => {
      pendingNoticeSent = true;
      if (peer.readyState === OPEN) {
        try {
          peer.send(
            JSON.stringify({
              type: "error",
              code: "REALTIME_SAVE_PENDING",
              message: "通话已停止，聊天记录仍在同步。请稍后刷新确认。",
              fatal: true,
            } satisfies RealtimeServerEvent),
          );
          peer.close(1011, "save_pending");
        } catch {
          /* Delivery cannot block ledger cleanup. */
        }
      }
    };
    const ackTimer = deferred
      ? setTimeout(
          savePending,
          Math.max(0, deferred.started + 4000 - Date.now()),
        )
      : undefined;
    try {
      const written = await bounded(writes, 12_000);
      stopWrites = true;
      const released = await bounded(
        releaseRealtimeConnection(context, {
          resume,
          reason,
          inputAudioSeconds: inputBytes / PCM_BYTES_PER_SECOND,
        }),
        10_000,
      );
      if (deferred && !pendingNoticeSent) {
        if (written && released && !writesFailed && peer.readyState === OPEN) {
          try {
            peer.send(
              JSON.stringify({
                type: "ended",
                reason: deferred.reason,
              } satisfies RealtimeServerEvent),
            );
            peer.close(deferred.code, deferred.reason);
          } catch {
            /* The peer may have disconnected during finalization. */
          }
        } else if (!written || !released || writesFailed) savePending();
      }
    } finally {
      if (ackTimer !== undefined) clearTimeout(ackTimer);
    }
  }
}
