/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import { TextDecoder } from "node:util";
import type { useFamilyRealtime as RealtimeHook } from "../app/family/use-family-realtime";
import type { FamilyChatDetail, FamilyUser } from "../app/family/types";
import { FAMILY_SESSION_EVENT } from "../app/family/client-cleanup";

type RealtimeOptions = Parameters<typeof RealtimeHook>[0];
type TestController = {
  busy: boolean;
  start: () => Promise<void>;
  end: () => void;
  reset: () => void;
};
let latestOptions: RealtimeOptions | undefined;
let updateBusy: ((busy: boolean) => void) | null = null;
const resetRealtime = jest.fn(() => updateBusy?.(false));
const startRealtime = jest.fn(async () => {
  const scope = latestOptions!.getScope();
  if (scope.verified && scope.canStart) updateBusy?.(true);
});
const endRealtime = jest.fn(() => {
  updateBusy?.(false);
  latestOptions!.onFinished("chat-a");
});
jest.unstable_mockModule("@/app/family/use-family-realtime", () => ({
  useFamilyRealtime: (options: RealtimeOptions): TestController => {
    latestOptions = options;
    const [busy, setBusy] = useState(false);
    updateBusy = setBusy;
    useEffect(
      () => () => {
        updateBusy = null;
      },
      [],
    );
    return {
      busy,
      start: startRealtime,
      end: endRealtime,
      reset: resetRealtime,
    };
  },
}));
jest.unstable_mockModule("@/app/family/realtime-panel", () => ({
  RealtimePanel: ({ controller }: { controller: TestController }) => (
    <section aria-label="合成实时控制器">
      <span role="status">
        {controller.busy ? "合成通话中" : "合成通话空闲"}
      </span>
      <button
        type="button"
        disabled={controller.busy}
        onClick={() => void controller.start()}
      >
        开始合成通话
      </button>
      <button
        type="button"
        disabled={!controller.busy}
        onClick={controller.end}
      >
        结束合成通话
      </button>
    </section>
  ),
}));
const { FamilyApp } = await import("@/app/family/client");

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
const date = "2026-11-02T00:00:00Z";
const memberA: FamilyUser = {
  id: "synthetic-a",
  name: "合成用户甲",
  email: "a@example.invalid",
  role: "member",
  status: "approved",
};
const memberB: FamilyUser = {
  id: "synthetic-b",
  name: "合成用户乙",
  email: "b@example.invalid",
  role: "member",
  status: "approved",
};
const chatA = {
  id: "chat-a",
  title: "甲的合成对话",
  model: "fixture-text",
  archived: false,
  createdAt: date,
  updatedAt: date,
};
const chatB = { ...chatA, id: "chat-b", title: "乙的合成对话" };
function json(value: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  } as Response;
}
function detail(text: string): FamilyChatDetail {
  return {
    chat: chatA,
    messages: [
      {
        id: "message-a",
        role: "assistant",
        content: text,
        status: "complete",
        createdAt: date,
      },
    ],
  };
}
const descriptors = [
  [Blob.prototype, "arrayBuffer"],
  [Element.prototype, "scrollIntoView"],
  [crypto, "randomUUID"],
  [globalThis, "TextDecoder"],
  [document, "visibilityState"],
  [navigator, "mediaDevices"],
  [window, "MediaRecorder"],
  [window, "AudioContext"],
].map(([target, key]) => ({
  target: target as object,
  key: key as string,
  descriptor: Object.getOwnPropertyDescriptor(target, key as string),
}));
const originalFetch = global.fetch;
const microphone = jest.fn(async () => {
  throw new Error("A real microphone must never open in this integration test");
});
let identity: FamilyUser | null, record: FamilyChatDetail;
let handler: (url: string, init?: RequestInit) => Promise<Response>;
let fetchMock: ReturnType<typeof createFetch>;
function createFetch() {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  latestOptions = undefined;
  updateBusy = null;
  history.replaceState(null, "", "/");
  localStorage.clear();
  let count = 0;
  property(
    crypto,
    "randomUUID",
    () => "00000000-0000-4000-8000-" + String(++count).padStart(12, "0"),
  );
  property(Element.prototype, "scrollIntoView", jest.fn());
  property(globalThis, "TextDecoder", TextDecoder);
  property(Blob.prototype, "arrayBuffer", function (this: Blob) {
    return bytes(this);
  });
  property(document, "visibilityState", "visible");
  // Presence enables the existing legacy voice button, but none of these APIs
  // can actually acquire media. The real voice hook remains mounted and gated.
  property(navigator, "mediaDevices", { getUserMedia: microphone });
  property(window, "MediaRecorder", class SyntheticRecorder {});
  property(
    window,
    "AudioContext",
    class SyntheticAudioContext {
      constructor() {
        throw new Error("No audio context in root integration fixtures");
      }
    },
  );
  identity = memberA;
  record = detail("通话前的合成回复");
  handler = async (url) => {
    if (url === "/api/family/status")
      return json({
        ready: true,
        needsSetup: false,
        dbConfigured: true,
        schemaReady: true,
        schemaVersion: 5,
        modelConfigured: true,
        notice: "合成状态",
      });
    if (url === "/api/family/me")
      return identity
        ? json({ user: identity, sessionExpiresAt: "2026-12-02T00:00:00Z" })
        : json({ error: "合成会话已失效" }, 401);
    if (url === "/api/family/activity") return json({ ok: true });
    if (url === "/api/family/models")
      return json({
        defaultModel: "fixture-text",
        models: [
          {
            id: "fixture-text",
            name: "合成文字模型",
            description: "",
            reasoning: false,
            supportsImages: true,
            supportsPdf: true,
          },
        ],
      });
    if (url === "/api/family/chats")
      return json({ chats: identity?.id === memberB.id ? [chatB] : [chatA] });
    if (url === "/api/family/chats/chat-a")
      return identity?.id === memberA.id
        ? json(record)
        : json({ error: "合成对话不存在" }, 404);
    if (url === "/api/family/chats/chat-b")
      return json({ chat: chatB, messages: [] });
    throw new Error("Unexpected mocked endpoint: " + url);
  };
  fetchMock = createFetch();
  global.fetch = fetchMock as typeof fetch;
});
afterEach(() => {
  cleanup();
  expect(microphone).not.toHaveBeenCalled();
  global.fetch = originalFetch;
  for (const { target, key, descriptor } of descriptors)
    descriptor
      ? Object.defineProperty(target, key, descriptor)
      : Reflect.deleteProperty(target, key);
  jest.restoreAllMocks();
  latestOptions = undefined;
  updateBusy = null;
});
async function open() {
  const view = render(<FamilyApp />);
  fireEvent.click(await screen.findByRole("button", { name: /甲的合成对话/ }));
  await screen.findByText("通话前的合成回复");
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "发送消息" })).toBeEnabled(),
  );
  return view;
}
async function draftAndFile() {
  const composer = screen.getByRole("textbox", {
    name: "发送消息",
  }) as HTMLTextAreaElement;
  const picker = screen.getByLabelText("选择附件文件") as HTMLInputElement;
  fireEvent.change(composer, { target: { value: "尚未发送的文字草稿" } });
  fireEvent.change(picker, {
    target: {
      files: [
        new File(["Synthetic private note"], "draft-note.txt", {
          type: "text/plain",
        }),
      ],
    },
  });
  await waitFor(() =>
    expect(screen.queryByText("正在处理…")).not.toBeInTheDocument(),
  );
  expect(
    screen.getByRole("button", { name: "移除附件 draft-note.txt" }),
  ).toBeEnabled();
  return {
    composer,
    picker,
    form: composer.form!,
    send: screen.getByRole("button", { name: "发送 ↑" }),
    legacyVoice: screen.getByRole("button", {
      name: "按住说话，松开发送，移出取消",
    }),
  };
}
async function start() {
  fireEvent.click(screen.getByRole("button", { name: "开始合成通话" }));
  await screen.findByText("合成通话中");
}
function assertNoLegacyGeneration() {
  expect(
    fetchMock.mock.calls.some(
      ([url]) =>
        String(url).includes("/messages") ||
        String(url).startsWith("/api/family/voice/") ||
        String(url).startsWith("https://"),
    ),
  ).toBe(false);
}

test("a busy realtime call keeps the exact draft/file DOM mounted while legacy submission is gated", async () => {
  const { container } = await open();
  const elements = await draftAndFile();
  expect(latestOptions!.getScope()).toMatchObject({
    userId: memberA.id,
    chatId: chatA.id,
    verified: true,
    canStart: true,
  });
  const baselineReset = resetRealtime.mock.calls.length;
  await start();
  expect(container.contains(elements.composer)).toBe(true);
  expect(container.contains(elements.picker)).toBe(true);
  expect(elements.composer).toHaveValue("尚未发送的文字草稿");
  expect(elements.form).not.toBeVisible();
  expect(elements.composer).toBeDisabled();
  expect(elements.picker).toBeDisabled();
  expect(elements.send).toBeDisabled();
  expect(elements.legacyVoice).toBeDisabled();
  expect(container.textContent).toContain("draft-note.txt");
  expect(resetRealtime).toHaveBeenCalledTimes(baselineReset);
  // Forced DOM submission still cannot bypass the callback's busy guard.
  fireEvent.submit(elements.form);
  fireEvent.keyDown(elements.composer, { key: "Enter" });
  await act(async () => {});
  assertNoLegacyGeneration();
  expect(elements.composer).toHaveValue("尚未发送的文字草稿");
});

test("onFinished refreshes committed chat data without replacing or clearing the local draft and TXT selection", async () => {
  const { container } = await open();
  const elements = await draftAndFile();
  await start();
  const priorDetailReads = fetchMock.mock.calls.filter(
    ([url]) => String(url) === "/api/family/chats/chat-a",
  ).length;
  record = detail("通话结束后已保存的合成回复");
  fireEvent.click(screen.getByRole("button", { name: "结束合成通话" }));
  await screen.findByText("通话结束后已保存的合成回复");
  expect(
    fetchMock.mock.calls.filter(
      ([url]) => String(url) === "/api/family/chats/chat-a",
    ),
  ).toHaveLength(priorDetailReads + 1);
  expect(screen.getByRole("textbox", { name: "发送消息" })).toBe(
    elements.composer,
  );
  expect(screen.getByLabelText("选择附件文件")).toBe(elements.picker);
  expect(elements.composer).toHaveValue("尚未发送的文字草稿");
  expect(elements.composer).toBeEnabled();
  expect(elements.form).toBeVisible();
  expect(
    screen.getByRole("button", { name: "移除附件 draft-note.txt" }),
  ).toBeEnabled();
  expect(container.textContent).toContain("draft-note.txt");
  expect(screen.getByRole("combobox", { name: "选择模型" })).toHaveValue(
    "fixture-text",
  );
  assertNoLegacyGeneration();
});

test("busy alone disables the previously available legacy push-to-talk path", async () => {
  await open();
  const legacy = screen.getByRole("button", {
    name: "按住说话，松开发送，移出取消",
  });
  await waitFor(() => expect(legacy).toBeEnabled());
  await start();
  expect(legacy).toBeInTheDocument();
  expect(legacy).toBeDisabled();
  fireEvent.pointerDown(legacy, { pointerType: "mouse", button: 0 });
  fireEvent.pointerUp(legacy, { pointerType: "mouse", button: 0 });
  await act(async () => {});
  expect(microphone).not.toHaveBeenCalled();
  assertNoLegacyGeneration();
});

test("an account change resets the realtime controller and removes the previous owner's drafts and files", async () => {
  const { container } = await open();
  await draftAndFile();
  await start();
  const before = resetRealtime.mock.calls.length;
  identity = memberB;
  fireEvent(
    window,
    new StorageEvent("storage", {
      key: FAMILY_SESSION_EVENT,
      newValue: JSON.stringify({ kind: "login", id: "synthetic-login-b" }),
    }),
  );
  await screen.findByText(memberB.name);
  expect(resetRealtime.mock.calls.length).toBeGreaterThan(before);
  expect(screen.getByRole("textbox", { name: "发送消息" })).toHaveValue("");
  expect(container.textContent).not.toContain("draft-note.txt");
  expect(container.textContent).not.toContain("通话前的合成回复");
  expect(
    screen.queryByRole("button", { name: /甲的合成对话/ }),
  ).not.toBeInTheDocument();
  assertNoLegacyGeneration();
});

test("a stale onFinished detail response cannot restore A's data after identity changes to B", async () => {
  const { container } = await open();
  await draftAndFile();
  await start();
  let finishDetail!: (response: Response) => void;
  const delayed = new Promise<Response>((resolve) => {
    finishDetail = resolve;
  });
  const originalHandler = handler;
  let blocked = false;
  handler = async (url, init) => {
    if (url === "/api/family/chats/chat-a") {
      blocked = true;
      return delayed;
    }
    return originalHandler(url, init);
  };
  fireEvent.click(screen.getByRole("button", { name: "结束合成通话" }));
  await waitFor(() => expect(blocked).toBe(true));
  identity = memberB;
  fireEvent(
    window,
    new StorageEvent("storage", {
      key: FAMILY_SESSION_EVENT,
      newValue: JSON.stringify({ kind: "login", id: "synthetic-late-login-b" }),
    }),
  );
  await screen.findByText(memberB.name);
  await act(async () => {
    finishDetail(json(detail("不得恢复的甲的迟到通话回复")));
    await delayed;
  });
  expect(container.textContent).not.toContain("不得恢复的甲的迟到通话回复");
  expect(container.textContent).not.toContain("draft-note.txt");
  expect(screen.getByRole("textbox", { name: "发送消息" })).toHaveValue("");
});

test("a real auth rejection resets an active realtime controller and unmounts private composition", async () => {
  const { container } = await open();
  await draftAndFile();
  await start();
  const before = resetRealtime.mock.calls.length;
  identity = null;
  act(() => latestOptions!.onUnauthorized());
  await screen.findByRole("button", { name: "登录" });
  expect(resetRealtime.mock.calls.length).toBeGreaterThan(before);
  expect(
    screen.queryByRole("textbox", { name: "发送消息" }),
  ).not.toBeInTheDocument();
  expect(container.textContent).not.toContain("draft-note.txt");
});

test("unmounting FamilyApp resets its active realtime controller", async () => {
  const view = await open();
  await start();
  const before = resetRealtime.mock.calls.length;
  view.unmount();
  expect(resetRealtime.mock.calls.length).toBeGreaterThan(before);
  assertNoLegacyGeneration();
});
