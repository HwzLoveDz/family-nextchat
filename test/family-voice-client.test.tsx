/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { encodeVoiceWav, FamilyVoiceCapture } from "../app/family/voice-media";
import {
  useFamilyVoice,
  type VoiceScope,
} from "../app/family/use-family-voice";
import type { FamilyMessage } from "../app/family/types";
import { FamilyApp } from "../app/family/client";
import { ReadableStream } from "node:stream/web";
import { TextDecoder, TextEncoder } from "node:util";

const property = (target: object, key: string, value: unknown) =>
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value,
  });
function bytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}

describe("family voice browser lifecycle without real media or networks", () => {
  const descriptors = [
    [navigator, "mediaDevices"],
    [window, "MediaRecorder"],
    [window, "AudioContext"],
    [window, "Audio"],
    [URL, "createObjectURL"],
    [URL, "revokeObjectURL"],
    [crypto, "randomUUID"],
    [Blob.prototype, "arrayBuffer"],
    [Element.prototype, "scrollIntoView"],
    [globalThis, "TextDecoder"],
  ].map(([target, key]) => ({
    target: target as object,
    key: key as string,
    descriptor: Object.getOwnPropertyDescriptor(target, key as string),
  }));
  const originalFetch = global.fetch;
  afterEach(() => {
    descriptors.forEach(({ target, key, descriptor }) =>
      descriptor
        ? Object.defineProperty(target, key, descriptor)
        : Reflect.deleteProperty(target, key),
    );
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  test("resamples real duration to canonical mono PCM and bounds the payload to 45 seconds", async () => {
    const source = new Float32Array(24000).fill(0.5);
    const wav = encodeVoiceWav([source, source], 48000);
    const view = new DataView(await bytes(wav));
    expect(String.fromCharCode(...new Uint8Array(view.buffer, 0, 4))).toBe(
      "RIFF",
    );
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.byteLength).toBe(44 + 8000 * 2);
    expect(view.getInt16(44, true)).toBe(16384);
    const long = encodeVoiceWav([new Float32Array(16000 * 46)], 16000);
    expect(long.size).toBe(44 + 16000 * 45 * 2);
    expect(() => encodeVoiceWav([new Float32Array(1600)], 16000)).toThrow(
      "录音太短",
    );
  });

  test("release during permission wait cancels and closes a late microphone stream without sending", async () => {
    let grant!: (stream: MediaStream) => void;
    const permission = new Promise<MediaStream>((resolve) => {
      grant = resolve;
    });
    const stop = jest.fn();
    const audio = jest.fn(() => undefined);
    const constructor = jest.fn();
    property(navigator, "mediaDevices", {
      getUserMedia: jest.fn(() => permission),
    });
    property(
      window,
      "MediaRecorder",
      Object.assign(constructor, { isTypeSupported: () => true }),
    );
    property(window, "AudioContext", function SyntheticContext() {});
    const capture = new FamilyVoiceCapture({
      state: jest.fn(),
      audio,
      error: jest.fn(),
    });
    const starting = capture.start();
    capture.release();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await starting;
    expect(stop).toHaveBeenCalledTimes(1);
    expect(constructor).not.toHaveBeenCalled();
    expect(audio).not.toHaveBeenCalled();
    capture.cancel();
  });

  test("pointer cancellation closes active tracks and timers and ignores an obsolete recorder stop", async () => {
    jest.useFakeTimers();
    const stop = jest.fn();
    const onAudio = jest.fn(() => undefined);
    let recorder!: SyntheticRecorder;
    class SyntheticRecorder {
      static isTypeSupported() {
        return true;
      }
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        recorder = this;
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    }
    property(navigator, "mediaDevices", {
      getUserMedia: jest.fn(async () => ({ getTracks: () => [{ stop }] })),
    });
    property(window, "MediaRecorder", SyntheticRecorder);
    property(window, "AudioContext", function SyntheticContext() {});
    const capture = new FamilyVoiceCapture({
      state: jest.fn(),
      audio: onAudio,
      error: jest.fn(),
    });
    await capture.start();
    const obsoleteStop = recorder.onstop;
    capture.cancelGesture();
    obsoleteStop?.();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(recorder.state).toBe("inactive");
    expect(onAudio).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test("playback rejects ineligible messages and a late WAV body cannot play after an owner change", async () => {
    let scope: VoiceScope = {
      epoch: 1,
      userId: "member-a",
      chatId: "chat-a",
      model: "model-a",
      verified: true,
      canRecord: true,
    };
    const message: FamilyMessage = {
      id: "assistant-a",
      role: "assistant",
      status: "complete",
      content: "合成回复",
      createdAt: "2026-10-30T00:00:00Z",
    };
    const AudioFactory = jest.fn();
    const createUrl = jest.fn(() => "blob:synthetic");
    property(window, "Audio", AudioFactory);
    property(URL, "createObjectURL", createUrl);
    property(URL, "revokeObjectURL", jest.fn());
    property(
      crypto,
      "randomUUID",
      () => "00000000-0000-4000-8000-000000000001",
    );
    let resolveBody!: (blob: Blob) => void;
    const body = new Promise<Blob>((resolve) => {
      resolveBody = resolve;
    });
    let signal: AbortSignal | null = null;
    const fetchMock = jest.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal as AbortSignal;
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            "Content-Type": "audio/wav",
            "X-Family-Voice-Parts": "1",
            "X-Family-Voice-Part": "0",
            "X-Family-Voice-Truncated": "false",
          }),
          blob: () => body,
        } as Response;
      },
    );
    global.fetch = fetchMock as typeof fetch;
    const hook = renderHook(() =>
      useFamilyVoice({
        getScope: () => scope,
        onTranscript: jest.fn(() => undefined),
        onError: jest.fn(),
        onUnauthorized: jest.fn(),
      }),
    );
    await act(async () => {
      await hook.result.current.speak("other-chat", message);
      await hook.result.current.speak("chat-a", { ...message, role: "user" });
      await hook.result.current.speak("chat-a", {
        ...message,
        status: "streaming",
      });
    });
    expect(fetchMock).not.toHaveBeenCalled();
    let playing!: Promise<void>;
    act(() => {
      playing = hook.result.current.speak("chat-a", message);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    scope = { ...scope, epoch: 2, userId: "member-b", chatId: "chat-b" };
    act(() => hook.result.current.reset());
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    await act(async () => {
      resolveBody(new Blob([new Uint8Array(44)], { type: "audio/wav" }));
      await playing;
    });
    expect(AudioFactory).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
    hook.unmount();
  });

  test("released capture transcribes Chinese, sends it through the selected model and automatically reads the saved reply", async () => {
    const transcript = "帮我整理明天的家庭安排";
    const micStop = jest.fn();
    const played = jest.fn(async () => undefined);
    const pause = jest.fn();
    let id = 0;
    property(
      crypto,
      "randomUUID",
      () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    );
    property(globalThis, "TextDecoder", TextDecoder);
    property(Element.prototype, "scrollIntoView", jest.fn());
    property(Blob.prototype, "arrayBuffer", function (this: Blob) {
      return bytes(this);
    });
    property(navigator, "mediaDevices", {
      getUserMedia: jest.fn(async () => ({
        getTracks: () => [{ stop: micStop }],
      })),
    });
    class SyntheticRecorder {
      static isTypeSupported() {
        return true;
      }
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob(["synthetic-compressed-audio"], {
            type: this.mimeType,
          }),
        });
        this.onstop?.();
      }
    }
    class SyntheticContext {
      state = "suspended";
      async decodeAudioData() {
        return {
          sampleRate: 48000,
          numberOfChannels: 1,
          getChannelData: () => new Float32Array(24000).fill(0.1),
        };
      }
      async close() {
        this.state = "closed";
      }
    }
    class SyntheticAudio {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      play = played;
      pause = pause;
      removeAttribute() {}
      load() {}
    }
    property(window, "MediaRecorder", SyntheticRecorder);
    property(window, "AudioContext", SyntheticContext);
    property(window, "Audio", SyntheticAudio);
    property(
      URL,
      "createObjectURL",
      jest.fn(() => "blob:voice-positive"),
    );
    property(URL, "revokeObjectURL", jest.fn());
    const createdAt = "2026-10-30T00:00:00Z";
    const chat = {
      id: "voice-chat",
      title: "语音测试",
      model: "model-think",
      archived: false,
      createdAt,
      updatedAt: createdAt,
    };
    const reply: FamilyMessage = {
      id: "saved-voice-reply",
      role: "assistant",
      content: "明天先买菜，再一起做晚饭。",
      status: "complete",
      createdAt,
    };
    let transcriptionId = "",
      speechId = "";
    const json = (value: unknown) =>
      ({ ok: true, status: 200, json: async () => value }) as Response;
    const fetchMock = jest.fn(
      async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (url === "/api/family/status")
          return json({
            ready: true,
            needsSetup: false,
            dbConfigured: true,
            schemaReady: true,
            notice: "合成测试",
          });
        if (url === "/api/family/me")
          return json({
            user: {
              id: "voice-owner",
              name: "合成家人",
              email: "voice@example.test",
              role: "member",
              status: "approved",
            },
            sessionExpiresAt: createdAt,
          });
        if (url === "/api/family/activity") return json({ ok: true });
        if (url === "/api/family/chats") return json({ chats: [chat] });
        if (url === "/api/family/models")
          return json({
            models: [
              {
                id: "model-fast",
                name: "快速",
                description: "",
                reasoning: false,
              },
              {
                id: "model-think",
                name: "思考",
                description: "",
                reasoning: true,
              },
            ],
            defaultModel: "model-fast",
          });
        if (url === "/api/family/chats/voice-chat")
          return json({ chat, messages: [] });
        if (url === "/api/family/voice/transcribe") {
          const data = init?.body as FormData;
          const file = data.get("audio") as File;
          expect(file.name).toBe("voice.wav");
          expect(file.type).toBe("audio/wav");
          const wav = new DataView(await file.arrayBuffer());
          expect(wav.getUint32(24, true)).toBe(16000);
          expect(wav.getUint16(22, true)).toBe(1);
          expect(data.get("chatId")).toBe(chat.id);
          transcriptionId = String(data.get("requestId"));
          return json({
            text: transcript,
            usage: { source: "unknown", inputTokens: null, outputTokens: null },
          });
        }
        if (url === "/api/family/chats/voice-chat/messages") {
          expect(JSON.parse(String(init?.body))).toMatchObject({
            content: transcript,
            model: "model-think",
          });
          const events = [
            {
              type: "start",
              userMessage: {
                id: "saved-transcript",
                role: "user",
                content: transcript,
                status: "complete",
                createdAt,
              },
              assistantMessage: { ...reply, content: "", status: "streaming" },
            },
            {
              type: "done",
              message: reply,
              usage: {
                source: "unknown",
                inputTokens: null,
                outputTokens: null,
              },
            },
          ];
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  events
                    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                    .join(""),
                ),
              );
              controller.close();
            },
          });
          return { ok: true, status: 200, body } as unknown as Response;
        }
        if (url === "/api/family/voice/speech") {
          const body = JSON.parse(String(init?.body));
          expect(body).toMatchObject({
            chatId: chat.id,
            messageId: reply.id,
            part: 0,
          });
          speechId = body.requestId;
          return {
            ok: true,
            status: 200,
            headers: new Headers({
              "Content-Type": "audio/wav",
              "X-Family-Voice-Parts": "1",
              "X-Family-Voice-Part": "0",
              "X-Family-Voice-Truncated": "0",
            }),
            blob: async () =>
              new Blob([new Uint8Array(44)], { type: "audio/wav" }),
          } as Response;
        }
        throw new Error(`Unexpected synthetic endpoint: ${url}`);
      },
    );
    global.fetch = fetchMock as typeof fetch;
    const view = render(<FamilyApp />);
    try {
      fireEvent.click(await screen.findByRole("button", { name: /语音测试/ }));
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "发送消息" })).toBeEnabled(),
      );
      fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
        target: { value: "尚未发送的旧草稿" },
      });
      expect(
        screen.getByRole("button", { name: "按住说话，松开发送，移出取消" }),
      ).toBeDisabled();
      fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
        target: { value: "" },
      });
      fireEvent.click(screen.getByRole("button", { name: "点击录音模式" }));
      const record = screen.getByRole("button", {
        name: "点击录音，再次点击发送",
      });
      fireEvent.click(record);
      await waitFor(() => expect(record).toHaveTextContent("结束并发送"));
      fireEvent.click(record);
      expect(await screen.findByText(transcript)).toBeInTheDocument();
      expect(await screen.findByText(reply.content)).toBeInTheDocument();
      await waitFor(() => expect(played).toHaveBeenCalledTimes(1));
      expect(transcriptionId).not.toBe(speechId);
      expect(micStop).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("textbox", { name: "发送消息" })).toHaveValue("");
    } finally {
      view.unmount();
    }
    expect(pause).toHaveBeenCalled();
  });
});
