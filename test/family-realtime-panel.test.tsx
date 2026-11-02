/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RealtimePanel } from "../app/family/realtime-panel";
import type { RealtimeController } from "../app/family/use-family-realtime";

function controller(
  overrides: Partial<RealtimeController> = {},
): RealtimeController {
  return {
    busy: true,
    phase: "listening",
    muted: false,
    elapsed: 12,
    supported: true,
    voice: "marin",
    setVoice: jest.fn(),
    vad: "natural",
    setVad: jest.fn(),
    transcripts: [],
    error: "",
    start: jest.fn(async () => {}),
    end: jest.fn(),
    interrupt: jest.fn(),
    toggleMute: jest.fn(),
    resumeAudio: jest.fn(async () => {}),
    keepAlive: jest.fn(),
    reset: jest.fn(),
    audioBlocked: false,
    idleWarning: null,
    reconnectAttempt: 0,
    level: 0.2,
    ...overrides,
  } as RealtimeController;
}
afterEach(cleanup);
test("embedded idle mode yields the workspace while active controls retain their call actions", () => {
  const c = controller({ busy: false, phase: "idle" });
  const view = render(<RealtimePanel controller={c} embedded />);
  expect(screen.queryByRole("button", { name: "开始连续语音" })).toBeNull();
  view.rerender(
    <RealtimePanel
      controller={{ ...c, busy: true, phase: "listening" }}
      embedded
    />,
  );
  expect(screen.getByRole("button", { name: "挂断" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "打断回答" }));
  expect(c.interrupt).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "静音麦克风" }));
  expect(c.toggleMute).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(c.end).toHaveBeenCalledTimes(1);
});
test("new transcript deltas do not pull the user away from older subtitles", () => {
  const c = controller({
    transcripts: [
      { role: "assistant", itemId: "one", text: "第一句", final: false },
    ],
  });
  const view = render(<RealtimePanel controller={c} embedded />);
  const list = screen.getByRole("list", { name: "实时语音字幕" });
  Object.defineProperties(list, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 200 },
  });
  list.scrollTop = 100;
  fireEvent.scroll(list);
  expect(
    screen.getByRole("button", { name: "回到最新字幕 ↓" }),
  ).toBeInTheDocument();
  view.rerender(
    <RealtimePanel
      controller={{
        ...c,
        transcripts: [{ ...c.transcripts[0], text: "第一句正在继续" }],
      }}
      embedded
    />,
  );
  expect(list.scrollTop).toBe(100);
  fireEvent.click(screen.getByRole("button", { name: "回到最新字幕 ↓" }));
  expect(list.scrollTop).toBe(1000);
  expect(screen.queryByRole("button", { name: "回到最新字幕 ↓" })).toBeNull();
  list.scrollTop = 800;
  fireEvent.scroll(list);
  Object.defineProperty(list, "scrollHeight", {
    configurable: true,
    value: 1200,
  });
  view.rerender(
    <RealtimePanel
      controller={{
        ...c,
        transcripts: [{ ...c.transcripts[0], text: "完整句子", final: true }],
      }}
      embedded
    />,
  );
  expect(list.scrollTop).toBe(1200);
});
