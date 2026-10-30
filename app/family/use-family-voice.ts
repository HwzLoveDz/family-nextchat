"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FamilyMessage } from "./types";
import { FamilyVoiceCapture, type CapturePhase } from "./voice-media";

export type VoiceScope = {
  epoch: number;
  userId: string | null;
  chatId: string | null;
  model: string;
  verified: boolean;
  canRecord: boolean;
};
type PlaybackStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "ready"
  | "ended";
type Playback = {
  status: PlaybackStatus;
  messageId: string | null;
  part: number;
  parts: number;
  truncated: boolean;
};
type SavedVoice = {
  parts: Map<number, Blob>;
  count: number;
  truncated: boolean;
  scope: VoiceScope;
  chatId: string;
  message: FamilyMessage;
};
const IDLE_PLAYBACK: Playback = {
  status: "idle",
  messageId: null,
  part: 0,
  parts: 0,
  truncated: false,
};

export function useFamilyVoice(options: {
  getScope: () => VoiceScope;
  onTranscript: (text: string, scope: VoiceScope) => void | Promise<void>;
  onError: (message: string) => void;
  onUnauthorized: () => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [phase, setPhase] = useState<CapturePhase | "transcribing">("idle");
  const [seconds, setSeconds] = useState(0);
  const [playback, setPlayback] = useState<Playback>(IDLE_PLAYBACK);
  const [supported, setSupported] = useState(false);
  const phaseRef = useRef<typeof phase>("idle");
  const playbackRef = useRef<Playback>(IDLE_PLAYBACK);
  const capture = useRef<FamilyVoiceCapture | null>(null);
  const captureScope = useRef<VoiceScope | null>(null);
  const captureSequence = useRef(0);
  const playSequence = useRef(0);
  const requests = useRef(new Map<AbortController, "capture" | "play">());
  const timers = useRef(new Set<number>());
  const audio = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef<string | null>(null);
  const saved = useRef(new Map<string, SavedVoice>());
  const currentSaved = useRef<SavedVoice | null>(null);
  const mounted = useRef(true);
  const updatePhase = useCallback((next: typeof phase) => {
    phaseRef.current = next;
    if (mounted.current) setPhase(next);
  }, []);
  const updatePlayback = useCallback((next: Playback) => {
    playbackRef.current = next;
    if (mounted.current) setPlayback(next);
  }, []);
  const matches = useCallback((scope: VoiceScope) => {
    const now = latest.current.getScope();
    return (
      now.verified &&
      scope.epoch === now.epoch &&
      scope.userId === now.userId &&
      scope.chatId === now.chatId &&
      scope.model === now.model &&
      document.visibilityState === "visible"
    );
  }, []);
  const releaseAudio = useCallback(() => {
    if (audio.current) {
      audio.current.onended = null;
      audio.current.onerror = null;
      audio.current.pause();
      audio.current.removeAttribute("src");
      audio.current.load();
      audio.current = null;
    }
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }, []);
  const stopPlayback = useCallback(() => {
    playSequence.current++;
    requests.current.forEach((kind, controller) => {
      if (kind === "play") controller.abort();
    });
    releaseAudio();
    updatePlayback(IDLE_PLAYBACK);
  }, [releaseAudio, updatePlayback]);
  const cancelRecording = useCallback(() => {
    captureSequence.current++;
    capture.current?.cancel();
    captureScope.current = null;
    requests.current.forEach((kind, controller) => {
      if (kind === "capture") controller.abort();
    });
    updatePhase("idle");
    if (mounted.current) setSeconds(0);
  }, [updatePhase]);
  const reset = useCallback(() => {
    cancelRecording();
    stopPlayback();
    requests.current.forEach((_, controller) => controller.abort());
    requests.current.clear();
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.clear();
    saved.current.clear();
    currentSaved.current = null;
  }, [cancelRecording, stopPlayback]);
  const fetchVoice = useCallback(
    async (
      path: string,
      init: RequestInit,
      scope: VoiceScope,
      kind: "capture" | "play",
    ) => {
      const controller = new AbortController();
      requests.current.set(controller, kind);
      const timer = window.setTimeout(() => controller.abort(), 65000);
      timers.current.add(timer);
      try {
        const response = await fetch(path, {
          ...init,
          credentials: "include",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!matches(scope)) throw new DOMException("Aborted", "AbortError");
        if (!response.ok) {
          const failure = await response.json().catch(() => ({}));
          if (response.status === 401 || response.status === 403)
            latest.current.onUnauthorized();
          throw new Error(
            typeof failure.error === "string"
              ? failure.error
              : "语音请求没有完成，请稍后重试。",
          );
        }
        const payload =
          kind === "capture" ? await response.json() : await response.blob();
        if (controller.signal.aborted || !matches(scope))
          throw new DOMException("Aborted", "AbortError");
        return { response, payload };
      } finally {
        controller.abort();
        window.clearTimeout(timer);
        timers.current.delete(timer);
        requests.current.delete(controller);
      }
    },
    [matches],
  );

  useEffect(() => {
    mounted.current = true;
    setSupported(
      !!navigator.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== "undefined" &&
        !!(
          window.AudioContext ||
          (window as Window & { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext
        ),
    );
    capture.current = new FamilyVoiceCapture({
      state: (next, elapsed) => {
        updatePhase(next);
        if (mounted.current) setSeconds(elapsed);
      },
      error: (failure) => {
        if (mounted.current) latest.current.onError(failure.message);
      },
      audio: async (wav) => {
        const scope = captureScope.current;
        const sequence = captureSequence.current;
        if (!scope || !matches(scope)) return;
        updatePhase("transcribing");
        try {
          const body = new FormData();
          body.append("audio", wav, "voice.wav");
          body.append("requestId", crypto.randomUUID());
          if (scope.chatId) body.append("chatId", scope.chatId);
          const { payload } = await fetchVoice(
            "/api/family/voice/transcribe",
            { method: "POST", body },
            scope,
            "capture",
          );
          const result = payload as { text?: unknown };
          if (sequence !== captureSequence.current || !matches(scope)) return;
          if (typeof result.text !== "string" || !result.text.trim())
            throw new Error("没有识别到清楚的语音，请靠近麦克风再试。");
          updatePhase("idle");
          await latest.current.onTranscript(result.text.trim(), scope);
        } catch (failure) {
          if (sequence === captureSequence.current && matches(scope))
            latest.current.onError(
              failure instanceof DOMException && failure.name === "AbortError"
                ? "语音识别超时或中断，请重新录音。"
                : failure instanceof Error
                ? failure.message
                : "语音识别失败，请重试。",
            );
        } finally {
          if (sequence === captureSequence.current) updatePhase("idle");
        }
      },
    });
    const hidden = () => {
      if (document.visibilityState !== "visible") reset();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mounted.current = false;
      reset();
      capture.current = null;
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [fetchVoice, matches, reset, updatePhase]);

  const startRecording = useCallback(() => {
    const scope = latest.current.getScope();
    if (phaseRef.current !== "idle") return;
    if (!scope.verified || !scope.userId || !scope.canRecord) {
      latest.current.onError(
        "请先发送或清空输入框，并等待当前操作结束后再录音。",
      );
      return;
    }
    stopPlayback();
    captureSequence.current++;
    captureScope.current = scope;
    void capture.current?.start();
  }, [stopPlayback]);
  const releaseRecording = useCallback(() => capture.current?.release(), []);
  const cancelGesture = useCallback(() => capture.current?.cancelGesture(), []);

  const playPartRef = useRef<
    (
      item: SavedVoice,
      part: number,
      sequence: number,
      cachedOnly: boolean,
    ) => Promise<void>
  >(async () => {});
  const playPart = useCallback(
    async (
      item: SavedVoice,
      part: number,
      sequence: number,
      cachedOnly: boolean,
    ) => {
      if (sequence !== playSequence.current || !matches(item.scope)) return;
      try {
        let blob = item.parts.get(part);
        if (!blob) {
          if (cachedOnly) {
            releaseAudio();
            updatePlayback({ ...playbackRef.current, status: "ended" });
            return;
          }
          updatePlayback({
            status: "loading",
            messageId: item.message.id,
            part,
            parts: item.count,
            truncated: item.truncated,
          });
          const { response, payload } = await fetchVoice(
            "/api/family/voice/speech",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chatId: item.chatId,
                messageId: item.message.id,
                requestId: crypto.randomUUID(),
                part,
              }),
            },
            item.scope,
            "play",
          );
          const count = Number(response.headers.get("X-Family-Voice-Parts")),
            actualPart = Number(response.headers.get("X-Family-Voice-Part"));
          if (
            !Number.isInteger(count) ||
            count < 1 ||
            count > 10 ||
            actualPart !== part ||
            part >= count ||
            !/^audio\/wav(?:;|$)/i.test(
              response.headers.get("Content-Type") ?? "",
            )
          )
            throw new Error("语音响应格式不正确，请稍后重试。");
          blob = payload as Blob;
          if (sequence !== playSequence.current || !matches(item.scope)) return;
          if (blob.size > 8 * 1024 * 1024)
            throw new Error("语音片段过大，请稍后重试。");
          item.count = count;
          item.truncated = ["1", "true"].includes(
            response.headers.get("X-Family-Voice-Truncated") ?? "",
          );
          item.parts.set(part, blob);
        }
        if (sequence !== playSequence.current || !matches(item.scope)) return;
        releaseAudio();
        objectUrl.current = URL.createObjectURL(blob);
        const player = new Audio(objectUrl.current);
        audio.current = player;
        player.onended = () => {
          if (sequence !== playSequence.current || !matches(item.scope)) return;
          releaseAudio();
          if (part + 1 < item.count)
            void playPartRef.current(item, part + 1, sequence, cachedOnly);
          else
            updatePlayback({
              status: "ended",
              messageId: item.message.id,
              part,
              parts: item.count,
              truncated: item.truncated,
            });
        };
        player.onerror = () => {
          if (sequence === playSequence.current) {
            releaseAudio();
            updatePlayback(IDLE_PLAYBACK);
            latest.current.onError("语音播放失败，可点朗读重试。");
          }
        };
        try {
          await player.play();
          if (sequence === playSequence.current && matches(item.scope))
            updatePlayback({
              status: "playing",
              messageId: item.message.id,
              part,
              parts: item.count,
              truncated: item.truncated,
            });
        } catch {
          if (sequence === playSequence.current && matches(item.scope))
            updatePlayback({
              status: "ready",
              messageId: item.message.id,
              part,
              parts: item.count,
              truncated: item.truncated,
            });
        }
      } catch (failure) {
        if (sequence === playSequence.current && matches(item.scope)) {
          releaseAudio();
          updatePlayback(IDLE_PLAYBACK);
          latest.current.onError(
            failure instanceof DOMException && failure.name === "AbortError"
              ? "语音请求超时或中断，请稍后重试。"
              : failure instanceof Error
              ? failure.message
              : "朗读失败，请重试。",
          );
        }
      }
    },
    [fetchVoice, matches, releaseAudio, updatePlayback],
  );
  playPartRef.current = playPart;
  const speak = useCallback(
    async (chatId: string, message: FamilyMessage) => {
      const scope = latest.current.getScope();
      if (
        !scope.verified ||
        !scope.userId ||
        scope.chatId !== chatId ||
        message.role !== "assistant" ||
        !["complete", "partial"].includes(message.status) ||
        message.superseded ||
        phaseRef.current !== "idle"
      )
        return;
      stopPlayback();
      const key = `${scope.epoch}:${scope.userId}:${chatId}:${message.id}`;
      let item = saved.current.get(key);
      if (!item) {
        saved.current.clear();
        item = {
          parts: new Map(),
          count: 1,
          truncated: false,
          scope,
          chatId,
          message,
        };
        saved.current.set(key, item);
      }
      currentSaved.current = item;
      await playPart(item, 0, playSequence.current, false);
    },
    [playPart, stopPlayback],
  );
  const pause = useCallback(() => {
    audio.current?.pause();
    updatePlayback({ ...playbackRef.current, status: "paused" });
  }, [updatePlayback]);
  const resume = useCallback(async () => {
    const item = currentSaved.current,
      player = audio.current,
      sequence = playSequence.current;
    if (!item || !player || !matches(item.scope)) return;
    try {
      await player.play();
      if (sequence === playSequence.current && matches(item.scope))
        updatePlayback({ ...playbackRef.current, status: "playing" });
    } catch {
      if (sequence === playSequence.current)
        latest.current.onError("浏览器暂时无法播放，请再次点击播放。");
    }
  }, [matches, updatePlayback]);
  const replay = useCallback(() => {
    const item = currentSaved.current;
    if (!item || !matches(item.scope)) return;
    stopPlayback();
    void playPart(item, 0, playSequence.current, true);
  }, [matches, playPart, stopPlayback]);
  return {
    phase,
    seconds,
    playback,
    supported,
    busy:
      phase !== "idle" ||
      ["loading", "playing", "paused", "ready"].includes(playback.status),
    startRecording,
    releaseRecording,
    cancelGesture,
    cancelRecording,
    reset,
    speak,
    pause,
    resume,
    replay,
    stopPlayback,
  };
}
