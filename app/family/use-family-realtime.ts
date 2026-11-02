"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeAudioBridge, realtimeAudioSupported } from "./realtime-audio";
import { decodeRealtimePcm, type PlayedCursor } from "./realtime-pcm";
import {
  REALTIME_MAX_CALL_SECONDS,
  REALTIME_MODEL,
  REALTIME_VOICES,
  type RealtimeCallCreated,
  type RealtimeClientControl,
  type RealtimeVad,
  type RealtimeVoice,
} from "./realtime-types";

export type RealtimePhase =
  | "idle"
  | "permission"
  | "connecting"
  | "listening"
  | "user_speaking"
  | "thinking"
  | "speaking"
  | "reconnecting"
  | "paused"
  | "ending"
  | "ended"
  | "error";
export interface RealtimeScope {
  epoch: number;
  userId: string | null;
  chatId: string | null;
  verified: boolean;
  canStart: boolean;
}
export interface RealtimeTranscript {
  role: "user" | "assistant";
  itemId: string;
  text: string;
  final: boolean;
  interrupted?: boolean;
}
interface ActiveCall {
  scope: RealtimeScope;
  bridge: RealtimeAudioBridge;
  abort: AbortController;
  created: RealtimeCallCreated | null;
  socket: WebSocket | null;
  socketVersion: number;
  ready: boolean;
  ending: boolean;
  muted: boolean;
  blocked: boolean;
  identityPaused: boolean;
  started: number;
  connected: number;
  attempts: number;
  rotate: boolean;
  lastPong: number;
  lastPing: number;
  timer: ReturnType<typeof setInterval> | null;
  reconnect: ReturnType<typeof setTimeout> | null;
  handshake: ReturnType<typeof setTimeout> | null;
  endingTimer: ReturnType<typeof setTimeout> | null;
  lastResponse: string | null;
  discarded: Set<string>;
  lastState: "listening" | "user_speaking" | "thinking";
}
const safeId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 160 &&
  /^[a-zA-Z0-9_-]+$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    value,
  );
const failureText = (failure: unknown) =>
  failure instanceof Error && failure.name === "NotAllowedError"
    ? "请允许麦克风权限后再开始通话。"
    : "连续语音暂时无法连接，请检查网络或改用按住说话。";

export function useFamilyRealtime(options: {
  getScope: () => RealtimeScope;
  onError: (message: string) => void;
  onUnauthorized: () => void;
  onFinished: (chatId: string) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const mounted = useRef(true),
    active = useRef<ActiveCall | null>(null);
  const [phase, setPhase] = useState<RealtimePhase>("idle"),
    phaseRef = useRef<RealtimePhase>("idle");
  const [supported, setSupported] = useState(false),
    [muted, setMuted] = useState(false),
    [elapsed, setElapsed] = useState(0);
  const [voice, updateVoice] = useState<RealtimeVoice>("marin"),
    [vad, updateVad] = useState<RealtimeVad>("natural");
  const [transcripts, setTranscripts] = useState<RealtimeTranscript[]>([]),
    [error, setError] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false),
    [idleWarning, setIdleWarning] = useState<number | null>(null),
    [reconnectAttempt, setReconnectAttempt] = useState(0),
    [level, setLevel] = useState(0);
  const updatePhase = useCallback((next: RealtimePhase) => {
    if (phaseRef.current === next) return;
    phaseRef.current = next;
    if (mounted.current) setPhase(next);
  }, []);
  const ownerMatches = useCallback((call: ActiveCall) => {
    const scope = latest.current.getScope();
    return (
      call.scope.epoch === scope.epoch &&
      call.scope.userId === scope.userId &&
      (scope.chatId === call.scope.chatId ||
        (call.scope.chatId === null && scope.chatId === call.created?.chat.id))
    );
  }, []);
  const send = useCallback(
    (call: ActiveCall, message: RealtimeClientControl) => {
      if (active.current !== call || call.socket?.readyState !== 1)
        return false;
      if (call.socket.bufferedAmount > 128_000) return false;
      try {
        call.socket.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    },
    [],
  );
  const endServer = useCallback((callId: string) => {
    // Best-effort revocation supplements socket-close and server lease expiry.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    void fetch("/api/family/realtime", {
      method: "DELETE",
      credentials: "include",
      cache: "no-store",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callId }),
      signal: controller.signal,
    })
      .then((response) => response.body?.cancel())
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  }, []);
  const cleanup = useCallback(
    (
      call: ActiveCall,
      settings: { phase: RealtimePhase; notify: boolean; revoke: boolean },
    ) => {
      if (active.current !== call) return;
      active.current = null;
      call.ready = false;
      call.ending = true;
      call.abort.abort();
      void call.bridge.dispose();
      if (call.timer) clearInterval(call.timer);
      if (call.reconnect) clearTimeout(call.reconnect);
      if (call.handshake) clearTimeout(call.handshake);
      if (call.endingTimer) clearTimeout(call.endingTimer);
      const socket = call.socket;
      call.socket = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.onerror = null;
        try {
          socket.close(1000, "ended");
        } catch {}
      }
      if (settings.revoke && call.created) endServer(call.created.callId);
      if (mounted.current) {
        setLevel(0);
        setAudioBlocked(false);
        setIdleWarning(null);
        setReconnectAttempt(0);
        setMuted(false);
      }
      updatePhase(settings.phase);
      if (settings.notify && call.created && ownerMatches(call))
        latest.current.onFinished(call.created.chat.id);
    },
    [endServer, ownerMatches, updatePhase],
  );
  const fail = useCallback(
    (call: ActiveCall, message: string) => {
      if (active.current !== call) return;
      if (mounted.current) setError(message);
      cleanup(call, { phase: "error", notify: true, revoke: true });
      if (ownerMatches(call)) latest.current.onError(message);
    },
    [cleanup, ownerMatches],
  );
  const updateGate = useCallback(
    (call: ActiveCall) => {
      const verified = latest.current.getScope().verified;
      call.bridge.setInputEnabled(
        call.ready &&
          !call.ending &&
          !call.muted &&
          !call.blocked &&
          verified &&
          ownerMatches(call),
      );
    },
    [ownerMatches],
  );
  const reportCursor = useCallback(
    (call: ActiveCall, cursor: PlayedCursor | null = call.bridge.cursor()) => {
      if (cursor && call.ready) send(call, { type: "played", ...cursor });
      if (
        cursor?.idle &&
        call.ready &&
        !call.ending &&
        phaseRef.current === "speaking"
      )
        updatePhase(
          call.blocked || !latest.current.getScope().verified
            ? "paused"
            : call.lastState === "user_speaking"
            ? "user_speaking"
            : "listening",
        );
    },
    [send, updatePhase],
  );
  const interruptCall = useCallback(
    (call: ActiveCall, notify = true, manual = true) => {
      const wasPlaying = call.bridge.cursor()?.idle === false;
      const cursor = call.bridge.interrupt();
      if (call.lastResponse) call.discarded.add(call.lastResponse);
      if (call.discarded.size > 120) {
        fail(call, "通话轮数已达上限，请重新开始。");
        return;
      }
      if (cursor) reportCursor(call, cursor);
      // A VAD acknowledgement only truncates audio that this browser actually
      // played. A bare acknowledgement could cancel a newer thinking response.
      // Explicit user/privacy actions still cancel the current server response,
      // even when the retained playback cursor belongs to an older response.
      if (notify && (manual || cursor))
        send(call, {
          type: "interrupt",
          ...(manual ? { manual: true as const } : {}),
          ...(cursor
            ? { itemId: cursor.itemId, audioEndMs: cursor.audioEndMs }
            : {}),
        });
      if (mounted.current && wasPlaying && cursor)
        setTranscripts((previous) =>
          previous.map((item) =>
            item.role === "assistant" && item.itemId === cursor.itemId
              ? { ...item, interrupted: true }
              : item,
          ),
        );
    },
    [fail, reportCursor, send],
  );
  const connectRef = useRef<(call: ActiveCall) => void>(() => {});
  const scheduleReconnect = useCallback(
    (call: ActiveCall) => {
      if (active.current !== call || call.ending || call.reconnect) return;
      if (!ownerMatches(call)) {
        cleanup(call, { phase: "idle", notify: false, revoke: true });
        return;
      }
      if (!latest.current.getScope().verified) {
        updatePhase("paused");
        return;
      }
      if (call.attempts >= 5) {
        fail(call, "语音连接多次中断，请重新开始通话。");
        return;
      }
      call.attempts++;
      if (mounted.current) setReconnectAttempt(call.attempts);
      updatePhase("reconnecting");
      call.reconnect = setTimeout(
        () => {
          call.reconnect = null;
          connectRef.current(call);
        },
        Math.min(8000, 500 * 2 ** (call.attempts - 1)),
      );
    },
    [cleanup, fail, ownerMatches, updatePhase],
  );
  const connect = useCallback(
    (call: ActiveCall) => {
      if (active.current !== call || call.ending || !call.created) return;
      if (
        !ownerMatches(call) ||
        document.visibilityState !== "visible" ||
        navigator.onLine === false
      ) {
        cleanup(call, { phase: "ended", notify: true, revoke: true });
        return;
      }
      if (!latest.current.getScope().verified) {
        updatePhase("paused");
        return;
      }
      call.ready = false;
      call.rotate = false;
      call.lastResponse = null;
      call.discarded.clear();
      call.bridge.setInputEnabled(false);
      call.bridge.resetPlayback();
      const version = ++call.socketVersion;
      const target = new URL(call.created.wsPath, location.origin);
      target.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      let socket: WebSocket;
      try {
        socket = new WebSocket(target.href);
      } catch {
        scheduleReconnect(call);
        return;
      }
      call.socket = socket;
      call.connected = Date.now();
      call.lastPong = Date.now();
      call.handshake = setTimeout(() => {
        if (active.current === call && version === call.socketVersion) {
          fail(call, "语音连接准备超时，请重新开始通话。");
        }
      }, 25_000);
      const current = () =>
        active.current === call &&
        version === call.socketVersion &&
        ownerMatches(call);
      socket.onopen = () => {
        if (!current()) {
          try {
            socket.close();
          } catch {}
          return;
        }
      };
      socket.onmessage = (event) => {
        if (!current()) return;
        try {
          if (typeof event.data !== "string" || event.data.length > 16_384)
            throw new Error();
          const message = JSON.parse(event.data);
          if (
            !message ||
            typeof message !== "object" ||
            typeof message.type !== "string"
          )
            throw new Error();
          switch (message.type) {
            case "ready":
              if (
                message.callId !== call.created!.callId ||
                message.chatId !== call.created!.chat.id ||
                message.model !== REALTIME_MODEL ||
                message.voice !== call.created!.voice
              )
                throw new Error();
              if (call.handshake) clearTimeout(call.handshake);
              call.handshake = null;
              call.ready = true;
              call.attempts = 0;
              if (mounted.current) setReconnectAttempt(0);
              call.lastPong = Date.now();
              call.lastState = "listening";
              send(call, { type: "mute", muted: call.muted });
              if (mounted.current) setError("");
              updateGate(call);
              updatePhase(
                call.blocked || !latest.current.getScope().verified
                  ? "paused"
                  : "listening",
              );
              break;
            case "state":
              if (
                !["listening", "user_speaking", "thinking"].includes(
                  message.state,
                )
              )
                throw new Error();
              call.lastState = message.state;
              if (message.state === "user_speaking" && mounted.current)
                setIdleWarning(null);
              if (
                !call.blocked &&
                latest.current.getScope().verified &&
                !call.ending
              )
                updatePhase(message.state);
              break;
            case "audio":
              if (
                !call.ready ||
                call.ending ||
                call.identityPaused ||
                call.blocked ||
                !latest.current.getScope().verified
              )
                break;
              if (!safeId(message.itemId) || !safeId(message.responseId))
                throw new Error();
              if (call.discarded.has(message.responseId)) break;
              call.lastResponse = message.responseId;
              call.bridge.append(
                message.itemId,
                message.responseId,
                decodeRealtimePcm(message.audio),
              );
              updatePhase("speaking");
              break;
            case "transcript":
              if (
                !safeId(message.itemId) ||
                !["user", "assistant"].includes(message.role) ||
                typeof message.text !== "string" ||
                message.text.length > 12_000 ||
                typeof message.final !== "boolean"
              )
                throw new Error();
              if (!latest.current.getScope().verified || call.identityPaused)
                break;
              if (mounted.current)
                setTranscripts((previous) => {
                  const found = previous.find(
                    (item) =>
                      item.itemId === message.itemId &&
                      item.role === message.role,
                  );
                  const text = message.final
                    ? message.text
                    : (found?.text ?? "") + message.text;
                  if (text.length > 12_000) return previous;
                  const next: RealtimeTranscript = {
                    role: message.role,
                    itemId: message.itemId,
                    text,
                    final: message.final,
                    ...(found?.interrupted ? { interrupted: true } : {}),
                  };
                  return (
                    found
                      ? previous.map((item) => (item === found ? next : item))
                      : [...previous, next]
                  ).slice(-40);
                });
              break;
            case "interrupt":
              interruptCall(call, true, false);
              break;
            case "turn_done":
              if (
                !safeId(message.responseId) ||
                !["completed", "cancelled", "failed", "incomplete"].includes(
                  message.status,
                )
              )
                throw new Error();
              if (
                message.status !== "completed" &&
                message.responseId === call.lastResponse
              )
                interruptCall(call, false);
              if (call.bridge.cursor()?.idle && !call.blocked && !call.ending)
                updatePhase("listening");
              break;
            case "idle_warning":
              if (mounted.current)
                setIdleWarning(
                  Number.isFinite(message.seconds)
                    ? Math.max(0, Math.min(120, message.seconds))
                    : 60,
                );
              break;
            case "rotate":
              call.rotate = true;
              call.ready = false;
              call.bridge.setInputEnabled(false);
              updatePhase("reconnecting");
              break;
            case "pong":
              call.lastPong = Date.now();
              break;
            case "ended":
              cleanup(call, { phase: "ended", notify: true, revoke: false });
              break;
            case "error":
              if (
                typeof message.message !== "string" ||
                message.message.length > 200 ||
                typeof message.code !== "string"
              )
                throw new Error();
              if (
                [
                  "UNAUTHENTICATED",
                  "ACCOUNT_UNAVAILABLE",
                  "FORBIDDEN",
                ].includes(message.code)
              ) {
                cleanup(call, { phase: "idle", notify: false, revoke: true });
                latest.current.onUnauthorized();
              } else if (message.fatal) fail(call, message.message);
              else if (mounted.current) setError(message.message);
              break;
            default:
              throw new Error();
          }
        } catch {
          fail(call, "语音连接返回了无法处理的数据，请重新开始。");
        }
      };
      socket.onerror = () => {
        if (current() && mounted.current)
          setError("语音网络暂时中断，正在等待连接恢复。");
      };
      socket.onclose = (event) => {
        if (!current()) return;
        if (call.handshake) clearTimeout(call.handshake);
        call.handshake = null;
        call.socket = null;
        call.ready = false;
        call.bridge.setInputEnabled(false);
        interruptCall(call, false);
        if (call.ending) {
          cleanup(call, { phase: "ended", notify: true, revoke: false });
          return;
        }
        if (event.code === 1008) {
          cleanup(call, { phase: "idle", notify: false, revoke: true });
          latest.current.onUnauthorized();
          return;
        }
        if (
          (event.code === 1012 && call.rotate) ||
          event.code === 1006 ||
          event.code === 1011
        ) {
          scheduleReconnect(call);
          return;
        }
        cleanup(call, { phase: "ended", notify: true, revoke: false });
      };
    },
    [
      cleanup,
      fail,
      interruptCall,
      ownerMatches,
      scheduleReconnect,
      updateGate,
      updatePhase,
    ],
  );
  connectRef.current = connect;

  const reset = useCallback(() => {
    const call = active.current;
    if (call) cleanup(call, { phase: "idle", notify: false, revoke: true });
    if (mounted.current) {
      setTranscripts([]);
      setError("");
      setElapsed(0);
    }
    updatePhase("idle");
  }, [cleanup, updatePhase]);
  const end = useCallback(() => {
    const call = active.current;
    if (!call || call.ending) return;
    call.ending = true;
    call.ready = false;
    call.bridge.setInputEnabled(false);
    const cursor = call.bridge.interrupt();
    if (cursor) send(call, { type: "played", ...cursor });
    void call.bridge.dispose();
    updatePhase("ending");
    const sent = send(call, { type: "end" });
    if (!sent) {
      cleanup(call, { phase: "ended", notify: true, revoke: true });
      return;
    }
    call.endingTimer = setTimeout(
      () => cleanup(call, { phase: "ended", notify: true, revoke: true }),
      5000,
    );
  }, [cleanup, send, updatePhase]);
  const start = useCallback(async () => {
    if (active.current) return;
    const scope = latest.current.getScope();
    if (
      !scope.verified ||
      !scope.userId ||
      !scope.canStart ||
      document.visibilityState !== "visible" ||
      !realtimeAudioSupported()
    ) {
      setError("请确认已登录，或改用按住说话。");
      return;
    }
    let call!: ActiveCall;
    const bridge = new RealtimeAudioBridge({
      onPcm: (bytes) => {
        if (
          active.current !== call ||
          !call.ready ||
          call.ending ||
          call.muted ||
          call.blocked ||
          !ownerMatches(call) ||
          !latest.current.getScope().verified
        )
          return;
        const socket = call.socket;
        if (socket?.readyState !== 1) return;
        if (socket.bufferedAmount > 96_000) {
          fail(call, "网络发送积压，通话已停止。请检查网络后再试。");
          return;
        }
        try {
          socket.send(bytes);
        } catch {
          fail(call, "录音暂时无法发送，请重新开始。");
        }
      },
      onBlocked: (blocked) => {
        if (active.current !== call) return;
        call.blocked = blocked;
        if (mounted.current) setAudioBlocked(blocked);
        if (blocked) {
          interruptCall(call);
          updatePhase("paused");
        } else if (call.ready && !call.ending) updatePhase(call.lastState);
        updateGate(call);
      },
      onMicrophoneEnded: () =>
        fail(call, "麦克风已断开，请重新允许权限或重新开始。"),
      onDrained: () => {
        if (active.current !== call) return;
        reportCursor(call);
        if (call.ready && !call.blocked && !call.ending)
          updatePhase(
            call.lastState === "user_speaking" ? "user_speaking" : "listening",
          );
      },
      onLevel: (value) => {
        if (active.current === call && mounted.current) setLevel(value);
      },
    });
    call = {
      scope: { ...scope },
      bridge,
      abort: new AbortController(),
      created: null,
      socket: null,
      socketVersion: 0,
      ready: false,
      ending: false,
      muted: false,
      blocked: false,
      identityPaused: false,
      started: Date.now(),
      connected: Date.now(),
      attempts: 0,
      rotate: false,
      lastPong: Date.now(),
      lastPing: Date.now(),
      timer: null,
      reconnect: null,
      handshake: null,
      endingTimer: null,
      lastResponse: null,
      discarded: new Set(),
      lastState: "listening",
    };
    active.current = call;
    setError("");
    setTranscripts([]);
    setMuted(false);
    setElapsed(0);
    updatePhase("permission");
    const startup = setTimeout(() => {
      if (active.current === call && !call.created)
        fail(call, "麦克风或连接准备超时，请重新开始。");
    }, 25_000);
    call.handshake = startup;
    try {
      await bridge.start(call.abort.signal);
      if (active.current !== call || !ownerMatches(call)) return;
      if (!latest.current.getScope().verified)
        throw new Error("Identity pending");
      updatePhase("connecting");
      const response = await fetch("/api/family/realtime", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        signal: call.abort.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          chatId: scope.chatId,
          voice,
          vad,
        }),
      });
      const value = await response.json();
      if (active.current !== call || !ownerMatches(call)) {
        if (response.ok && uuid(value?.callId)) endServer(value.callId);
        return;
      }
      if (!response.ok) {
        if ([401, 403].includes(response.status))
          latest.current.onUnauthorized();
        throw new Error("Call preparation rejected");
      }
      if (
        !uuid(value?.callId) ||
        !uuid(value?.chat?.id) ||
        value.model !== REALTIME_MODEL ||
        value.voice !== voice ||
        value.vad !== vad ||
        typeof value.wsPath !== "string"
      )
        throw new Error("Invalid call");
      const path = new URL(value.wsPath, location.origin);
      if (
        path.origin !== location.origin ||
        path.username ||
        path.password ||
        path.pathname !== "/api/family/realtime" ||
        path.searchParams.get("callId") !== value.callId ||
        path.searchParams.getAll("callId").length !== 1 ||
        [...path.searchParams.keys()].some((key) => key !== "callId") ||
        path.hash
      )
        throw new Error("Invalid socket path");
      if (active.current !== call || !ownerMatches(call)) {
        endServer(value.callId);
        return;
      }
      call.created = value as RealtimeCallCreated;
      clearTimeout(startup);
      call.handshake = null;
      call.timer = setInterval(() => {
        if (active.current !== call) return;
        if (
          !ownerMatches(call) ||
          document.visibilityState !== "visible" ||
          navigator.onLine === false
        ) {
          cleanup(call, {
            phase: "ended",
            notify: ownerMatches(call),
            revoke: true,
          });
          return;
        }
        const seconds = Math.floor((Date.now() - call.started) / 1000);
        if (mounted.current) setElapsed(seconds);
        if (seconds >= REALTIME_MAX_CALL_SECONDS) {
          end();
          return;
        }
        if (!latest.current.getScope().verified) {
          call.bridge.setInputEnabled(false);
          return;
        }
        reportCursor(call);
        if (call.ready && Date.now() - call.lastPong >= 35_000) {
          try {
            call.socket?.close();
          } catch {}
          fail(call, "语音连接长时间没有响应，请重新开始。");
          return;
        }
        if (call.ready && Date.now() - call.lastPing >= 15_000) {
          call.lastPing = Date.now();
          send(call, { type: "ping" });
        }
        if (call.ready && Date.now() - call.connected > 275_000)
          fail(call, "语音连接未能及时更新，请重新开始。");
      }, 250);
      connectRef.current(call);
    } catch (failure) {
      if (active.current === call) fail(call, failureText(failure));
    } finally {
      clearTimeout(startup);
      if (call.handshake === startup) call.handshake = null;
    }
  }, [
    voice,
    vad,
    cleanup,
    end,
    endServer,
    fail,
    interruptCall,
    ownerMatches,
    reportCursor,
    send,
    updateGate,
    updatePhase,
  ]);

  const interrupt = useCallback(() => {
    const call = active.current;
    if (call && call.ready && latest.current.getScope().verified)
      interruptCall(call);
  }, [interruptCall]);
  const toggleMute = useCallback(() => {
    const call = active.current;
    if (!call || call.ending) return;
    call.muted = !call.muted;
    setMuted(call.muted);
    send(call, { type: "mute", muted: call.muted });
    updateGate(call);
  }, [send, updateGate]);
  const resumeAudio = useCallback(async () => {
    const call = active.current;
    if (!call || !ownerMatches(call) || !latest.current.getScope().verified)
      return;
    try {
      await call.bridge.resume();
      if (active.current !== call || !ownerMatches(call)) return;
      updateGate(call);
    } catch {
      if (active.current === call && ownerMatches(call))
        setError("请再次点击继续音频，或重新开始通话。");
    }
  }, [ownerMatches, updateGate]);
  const keepAlive = useCallback(() => {
    const call = active.current;
    if (call && latest.current.getScope().verified) {
      send(call, { type: "keepalive" });
      setIdleWarning(null);
    }
  }, [send]);
  useEffect(() => {
    const call = active.current;
    if (!call) return;
    if (!ownerMatches(call)) {
      reset();
      return;
    }
    const verified = latest.current.getScope().verified;
    if (!verified && !call.identityPaused) {
      call.identityPaused = true;
      call.bridge.setInputEnabled(false);
      interruptCall(call);
      updatePhase("paused");
    } else if (verified && call.identityPaused) {
      call.identityPaused = false;
      updateGate(call);
      if (call.ready) updatePhase(call.blocked ? "paused" : call.lastState);
      else if (!call.socket) scheduleReconnect(call);
    }
  });
  useEffect(() => {
    mounted.current = true;
    setSupported(realtimeAudioSupported());
    const leave = () => {
      const call = active.current;
      if (call) cleanup(call, { phase: "ended", notify: true, revoke: true });
    };
    const hidden = () => {
      if (document.visibilityState !== "visible") leave();
    };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    window.addEventListener("offline", leave);
    return () => {
      mounted.current = false;
      const call = active.current;
      if (call) cleanup(call, { phase: "idle", notify: false, revoke: true });
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("offline", leave);
    };
  }, [cleanup]);
  return {
    busy: !["idle", "ended", "error"].includes(phase),
    phase,
    muted,
    elapsed,
    supported,
    voice,
    setVoice: (value: RealtimeVoice) => {
      if (!active.current && REALTIME_VOICES.includes(value))
        updateVoice(value);
    },
    vad,
    setVad: (value: RealtimeVad) => {
      if (!active.current && (value === "natural" || value === "fast"))
        updateVad(value);
    },
    transcripts,
    error,
    start,
    end,
    interrupt,
    toggleMute,
    resumeAudio,
    keepAlive,
    reset,
    audioBlocked,
    idleWarning,
    reconnectAttempt,
    level,
  };
}
export type RealtimeController = ReturnType<typeof useFamilyRealtime>;
