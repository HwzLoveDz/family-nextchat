/** @jest-environment jsdom */
import { chooseWorkspaceOption } from "./family-ui-select";
import { jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { TextDecoder, TextEncoder } from "node:util";
import { FamilyApp } from "../app/family/client";
import { FAMILY_SESSION_EVENT } from "../app/family/client-cleanup";
import type {
  FamilyChat,
  FamilyChatDetail,
  FamilyUser,
} from "../app/family/types";

// Synthetic accounts, files and network responses only. No provider is contacted.
const a: FamilyUser = {
  id: "fixture-a",
  name: "合成甲",
  email: "a@example.invalid",
  role: "member",
  status: "approved",
};
const b: FamilyUser = {
  ...a,
  id: "fixture-b",
  name: "合成乙",
  email: "b@example.invalid",
};
const date = "2026-11-02T00:00:00.000Z";
const chat = (id: string): FamilyChat => ({
  id,
  title: `会话 ${id}`,
  model: "fixture-model",
  archived: false,
  createdAt: date,
  updatedAt: date,
});
const detail = (id: string, content = `回复 ${id}`): FamilyChatDetail => ({
  chat: chat(id),
  messages: [
    {
      id: `message-${id}`,
      role: "assistant",
      content,
      status: "complete",
      createdAt: date,
    },
  ],
});
const json = (value: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  }) as Response;
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const read = (blob: Blob): Promise<ArrayBuffer> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
const property = (target: object, key: string, value: unknown) =>
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value,
  });
const descriptors = [
  [Blob.prototype, "arrayBuffer"],
  [Element.prototype, "scrollIntoView"],
  [crypto, "randomUUID"],
  [globalThis, "TextDecoder"],
  [URL, "createObjectURL"],
  [URL, "revokeObjectURL"],
].map(([target, key]) => ({
  target: target as object,
  key: key as string,
  descriptor: Object.getOwnPropertyDescriptor(target, key as string),
}));
const originalFetch = global.fetch;
let identity: FamilyUser;
let handler: (path: string, init?: RequestInit) => Promise<Response>;
let fetchMock: jest.Mock<
  (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
>;
beforeEach(() => {
  history.replaceState(null, "", "/");
  localStorage.clear();
  identity = a;
  property(Blob.prototype, "arrayBuffer", function (this: Blob) {
    return read(this);
  });
  property(Element.prototype, "scrollIntoView", jest.fn());
  property(crypto, "randomUUID", () => "00000000-0000-4000-8000-000000000001");
  property(globalThis, "TextDecoder", TextDecoder);
  property(
    URL,
    "createObjectURL",
    jest.fn(() => "blob:fixture-export"),
  );
  property(URL, "revokeObjectURL", jest.fn());
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  handler = async (path) => {
    if (path === "/api/family/status")
      return json({
        ready: true,
        needsSetup: false,
        dbConfigured: true,
        schemaReady: true,
        schemaVersion: 6,
        notice: "合成工作台",
      });
    if (path === "/api/family/me")
      return json({
        user: identity,
        sessionExpiresAt: "2026-12-01T00:00:00.000Z",
      });
    if (path === "/api/family/models")
      return json({
        models: [
          {
            id: "fixture-model",
            name: "测试模型",
            description: "",
            reasoning: false,
            supportsImages: true,
            supportsPdf: true,
          },
        ],
        defaultModel: "fixture-model",
      });
    if (path === "/api/family/activity") return json({ ok: true });
    if (path === "/api/family/chats")
      return json({
        chats: identity.id === a.id ? [chat("a"), chat("other")] : [chat("b")],
        nextCursor: null,
      });
    if (path === "/api/family/chats/a") return json(detail("a"));
    if (path === "/api/family/chats/other") return json(detail("other"));
    if (path === "/api/family/chats/b") return json(detail("b"));
    if (path === "/api/family/files")
      return json({ files: [], nextCursor: null });
    if (path === "/api/family/me/sessions") return json({ sessions: [] });
    throw new Error(`Unexpected synthetic workspace endpoint: ${path}`);
  };
  fetchMock = jest.fn(async (input, init) => handler(String(input), init));
  global.fetch = fetchMock as typeof fetch;
});
afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
  jest.restoreAllMocks();
  descriptors.forEach(({ target, key, descriptor }) =>
    descriptor
      ? Object.defineProperty(target, key, descriptor)
      : Reflect.deleteProperty(target, key),
  );
});
async function open(id = "a") {
  const view = render(<FamilyApp />);
  fireEvent.click(
    await screen.findByRole("button", { name: new RegExp(`会话 ${id}`) }),
  );
  await screen.findByText(`回复 ${id}`);
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "发送消息" })).toBeEnabled(),
  );
  return view;
}
const paidCalls = () =>
  fetchMock.mock.calls.filter(
    ([path]) =>
      String(path).endsWith("/messages") || String(path).includes("/realtime"),
  );
const menu = () => {
  fireEvent.click(screen.getByLabelText("对话操作"));
};

test("conversation actions support arrow navigation and Escape without changing the chat", async () => {
  await open();
  const trigger = screen.getByLabelText("对话操作");
  fireEvent.click(trigger);
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(
    screen.getByRole("button", { name: "置顶对话", exact: true }),
  ).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "End" });
  expect(
    screen.getByRole("button", { name: "归档对话", exact: true }),
  ).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(trigger.closest("details")).not.toHaveAttribute("open");
  expect(trigger).toHaveFocus();
  expect(paidCalls()).toHaveLength(0);
});

test.each(["我的文件", "我的用量"])(
  "%s can return to a new unsaved conversation with the same draft and file input",
  async (destination) => {
    const base = handler;
    handler = async (path, init) =>
      path === "/api/family/usage?days=all"
        ? json({ error: "合成用量暂不可用" }, 503)
        : base(path, init);
    const view = render(<FamilyApp />);
    const composer = await screen.findByRole("textbox", { name: "发送消息" });
    await waitFor(() => expect(composer).toBeEnabled());
    fireEvent.change(composer, { target: { value: "尚未创建会话的草稿" } });
    const input = view.container.querySelector('input[type="file"]')!;
    fireEvent.change(input, {
      target: {
        files: [new File(["keep"], "draft-keep.txt", { type: "text/plain" })],
      },
    });
    await screen.findByText("draft-keep.txt");
    fireEvent.click(
      screen.getByRole("button", { name: destination, exact: true }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "返回聊天", exact: true }),
    );
    expect(screen.getByRole("textbox", { name: "发送消息" })).toBe(composer);
    expect(composer).toHaveValue("尚未创建会话的草稿");
    expect(view.container.querySelector('input[type="file"]')).toBe(input);
    expect(screen.getByText("draft-keep.txt")).toBeInTheDocument();
    expect(paidCalls()).toHaveLength(0);
  },
);

test("server full-text matches are displayed even when the title does not match; stale query cannot replace them", async () => {
  const old = deferred();
  const base = handler;
  handler = async (path, init) =>
    path === "/api/family/chats?q=old"
      ? old.promise
      : path === "/api/family/chats?q=needle"
      ? json({
          chats: [
            {
              ...chat("hit"),
              title: "无关标题",
              matchSnippet: "正文里的 needle",
            },
          ],
        })
      : base(path, init);
  render(<FamilyApp />);
  const search = await screen.findByRole("searchbox", { name: "搜索聊天" });
  await screen.findByRole("button", { name: /会话 a/ });
  fireEvent.change(search, { target: { value: "old" } });
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([path]) => path === "/api/family/chats?q=old"),
    ).toBe(true),
  );
  fireEvent.change(search, { target: { value: "needle" } });
  expect(
    await screen.findByRole("button", { name: /无关标题.*正文里的 needle/ }),
  ).toBeInTheDocument();
  await act(async () => {
    old.resolve(json({ chats: [{ ...chat("stale"), title: "旧查询结果" }] }));
    await old.promise;
  });
  expect(screen.queryByText("旧查询结果")).not.toBeInTheDocument();
  expect(screen.getByText("正文里的 needle")).toBeInTheDocument();
  expect(paidCalls()).toHaveLength(0);
});

test("search and file browsing wait for a passive identity probe while retaining the editor", async () => {
  await open();
  const composer = screen.getByRole("textbox", { name: "发送消息" });
  fireEvent.change(composer, { target: { value: "身份确认期间保留的草稿" } });
  const probe = deferred();
  const base = handler;
  handler = async (path, init) => {
    if (path === "/api/family/me") return probe.promise;
    if (path === "/api/family/chats?q=paused")
      return json({ chats: [{ ...chat("hit"), title: "确认后搜索结果" }] });
    if (path === "/api/family/files?q=private")
      return json({ files: [], nextCursor: null });
    return base(path, init);
  };
  const meCount = fetchMock.mock.calls.filter(
    ([path]) => path === "/api/family/me",
  ).length;
  fireEvent.focus(window);
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(([path]) => path === "/api/family/me"),
    ).toHaveLength(meCount + 1),
  );
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索聊天" }), {
    target: { value: "paused" },
  });
  fireEvent.click(screen.getByRole("button", { name: "我的文件" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索文件" }), {
    target: { value: "private" },
  });
  // Let both debounce windows elapse: unverified identity must prevent dispatch.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  expect(
    fetchMock.mock.calls.some(([path]) =>
      String(path).startsWith("/api/family/files"),
    ),
  ).toBe(false);
  expect(
    fetchMock.mock.calls.some(
      ([path]) => path === "/api/family/chats?q=paused",
    ),
  ).toBe(false);
  expect(composer.isConnected).toBe(true);
  expect(composer).toHaveValue("身份确认期间保留的草稿");
  await act(async () => {
    probe.resolve(
      json({ user: a, sessionExpiresAt: "2026-12-01T00:00:00.000Z" }),
    );
    await probe.promise;
  });
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([path]) => path === "/api/family/chats?q=paused",
      ),
    ).toBe(true),
  );
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([path]) => path === "/api/family/files?q=private",
      ),
    ).toBe(true),
  );
  expect(composer).toHaveValue("身份确认期间保留的草稿");
  expect(paidCalls()).toHaveLength(0);
});

test("search results received during an identity probe are ignored and refreshed after confirmation", async () => {
  await open();
  const oldSearch = deferred();
  const probe = deferred();
  const base = handler;
  let searchRequests = 0;
  handler = async (path, init) => {
    if (path === "/api/family/chats?q=late") {
      searchRequests++;
      return searchRequests === 1
        ? oldSearch.promise
        : json({ chats: [{ ...chat("fresh"), title: "确认后的新结果" }] });
    }
    if (path === "/api/family/me") return probe.promise;
    return base(path, init);
  };
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索聊天" }), {
    target: { value: "late" },
  });
  await waitFor(() => expect(searchRequests).toBe(1));
  const meCount = fetchMock.mock.calls.filter(
    ([path]) => path === "/api/family/me",
  ).length;
  fireEvent.focus(window);
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(([path]) => path === "/api/family/me"),
    ).toHaveLength(meCount + 1),
  );
  await act(async () => {
    oldSearch.resolve(
      json({ chats: [{ ...chat("old"), title: "未经重新确认的私密结果" }] }),
    );
    await oldSearch.promise;
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  expect(screen.queryByText("未经重新确认的私密结果")).not.toBeInTheDocument();
  expect(searchRequests).toBe(1);
  await act(async () => {
    probe.resolve(
      json({ user: a, sessionExpiresAt: "2026-12-01T00:00:00.000Z" }),
    );
    await probe.promise;
  });
  expect(
    await screen.findByRole("button", { name: /确认后的新结果/ }),
  ).toBeInTheDocument();
  expect(searchRequests).toBe(2);
  expect(screen.queryByText("未经重新确认的私密结果")).not.toBeInTheDocument();
});

test("pins and archived restores use explicit owner-scoped mutations without generating chat replies", async () => {
  const base = handler;
  let pinned = false;
  let restored = false;
  handler = async (path, init) => {
    if (path === "/api/family/chats/a" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      if (body.pinned === true) pinned = true;
      if (body.archived === false) restored = true;
      return json({ chat: { ...chat("a"), pinnedAt: pinned ? date : null } });
    }
    if (path === "/api/family/chats?view=archived")
      return json({
        chats: restored ? [] : [{ ...chat("a"), archived: true }],
      });
    if (path === "/api/family/chats")
      return json({
        chats: [{ ...chat("a"), pinnedAt: pinned ? date : null }],
      });
    return base(path, init);
  };
  await open();
  menu();
  fireEvent.click(screen.getByRole("button", { name: "置顶对话" }));
  await waitFor(() => expect(pinned).toBe(true));
  expect(await screen.findByText("已置顶")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看归档" }));
  fireEvent.click(
    await screen.findByRole("button", { name: /会话 a.*点击恢复/ }),
  );
  await waitFor(() => expect(restored).toBe(true));
  expect(
    await screen.findByText("聊天已恢复，可在最近聊天中打开。"),
  ).toBeInTheDocument();
  expect(paidCalls()).toHaveLength(0);
});

test("cancelling a chat switch preserves the exact composer and File; confirming discards both", async () => {
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
  await open();
  const composer = screen.getByRole("textbox", { name: "发送消息" });
  fireEvent.change(composer, { target: { value: "没有发送的内容" } });
  fireEvent.change(screen.getByLabelText("选择附件文件"), {
    target: {
      files: [new File(["hello"], "keep.txt", { type: "text/plain" })],
    },
  });
  await screen.findByRole("button", { name: "移除附件 keep.txt" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /会话 other/ })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: /会话 other/ }));
  await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("textbox", { name: "发送消息" })).toBe(composer);
  expect(composer).toHaveValue("没有发送的内容");
  expect(
    screen.getByRole("button", { name: "移除附件 keep.txt" }),
  ).toBeInTheDocument();
  expect(
    fetchMock.mock.calls.some(([path]) => path === "/api/family/chats/other"),
  ).toBe(false);
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: /会话 other/ }));
  await screen.findByText("回复 other");
  expect(composer).toHaveValue("");
  expect(
    screen.queryByRole("button", { name: "移除附件 keep.txt" }),
  ).not.toBeInTheDocument();
});

test("returning to the same chat through Files preserves an unsent draft without a discard prompt", async () => {
  const confirm = jest.spyOn(window, "confirm").mockReturnValue(false);
  await open();
  const composer = screen.getByRole("textbox", { name: "发送消息" });
  fireEvent.change(composer, { target: { value: "稍后再发" } });
  fireEvent.click(screen.getByRole("button", { name: "我的文件" }));
  await screen.findByRole("region", { name: "我的文件库" });
  fireEvent.click(screen.getByRole("button", { name: /会话 a/ }));
  expect(screen.getByRole("textbox", { name: "发送消息" })).toBe(composer);
  expect(composer).toHaveValue("稍后再发");
  expect(confirm).not.toHaveBeenCalled();
  expect(paidCalls()).toHaveLength(0);
});

test("a late file library response from another account is discarded after cross-tab login", async () => {
  const old = deferred();
  const base = handler;
  handler = async (path, init) =>
    path === "/api/family/files" && identity.id === a.id
      ? old.promise
      : base(path, init);
  await open();
  fireEvent.click(screen.getByRole("button", { name: "我的文件" }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([path]) => path === "/api/family/files"),
    ).toBe(true),
  );
  identity = b;
  fireEvent(
    window,
    new StorageEvent("storage", {
      key: FAMILY_SESSION_EVENT,
      newValue: JSON.stringify({ kind: "login", id: "synthetic-b-login" }),
    }),
  );
  await screen.findByText(b.name);
  await act(async () => {
    old.resolve(
      json({
        files: [
          {
            id: "private-a",
            name: "甲的私密文件.txt",
            kind: "text",
            mediaType: "text/plain",
            byteSize: 5,
            chatId: "a",
            chatTitle: "私密",
            createdAt: date,
          },
        ],
      }),
    );
    await old.promise;
  });
  expect(screen.queryByText("甲的私密文件.txt")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "我的文件" }));
  await screen.findByText("发送过的附件会显示在这里。");
  expect(screen.queryByText("甲的私密文件.txt")).not.toBeInTheDocument();
});

test("older pages prepend without losing scroll position and explicit export fetches all pages", async () => {
  const base = handler;
  const current: FamilyChatDetail = {
    chat: chat("a"),
    messages: Array.from({ length: 80 }, (_, n) => ({
      id: `msg-${n + 80}`,
      role: "assistant",
      content: `最新消息 ${n + 80}`,
      status: "complete",
      createdAt: date,
    })),
    hasMoreMessages: true,
    nextBeforeMessageId: "msg-80",
  };
  const earlier: FamilyChatDetail = {
    chat: chat("a"),
    messages: [
      {
        id: "msg-79",
        role: "assistant",
        content: "更早的完整内容",
        status: "complete",
        createdAt: date,
      },
    ],
    hasMoreMessages: false,
    nextBeforeMessageId: null,
  };
  handler = async (path, init) =>
    path === "/api/family/chats/a"
      ? json(current)
      : path === "/api/family/chats/a?before=msg-80"
      ? json(earlier)
      : base(path, init);
  const { container } = render(<FamilyApp />);
  fireEvent.click(await screen.findByRole("button", { name: /会话 a/ }));
  await screen.findByText("最新消息 159");
  const host = container.querySelector(
    '[aria-label="聊天记录"]',
  ) as HTMLDivElement;
  Object.defineProperty(host, "scrollHeight", {
    configurable: true,
    get: () => (host.textContent?.includes("更早的完整内容") ? 1200 : 800),
  });
  Object.defineProperty(host, "clientHeight", {
    configurable: true,
    value: 200,
  });
  host.scrollTop = 200;
  fireEvent.scroll(host);
  const scroll = Element.prototype.scrollIntoView as jest.Mock;
  scroll.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "加载更早消息" }));
  await screen.findByText("更早的完整内容");
  await waitFor(() => expect(host.scrollTop).toBe(600));
  expect(scroll).not.toHaveBeenCalled();
  menu();
  fireEvent.click(screen.getByRole("button", { name: "导出 Markdown" }));
  await screen.findByText("已导出当前聊天。下载的文件由你自行保管。");
  const exported = (URL.createObjectURL as jest.Mock).mock.calls.at(
    -1,
  )?.[0] as Blob;
  const text = new TextDecoder().decode(await read(exported));
  expect(text).toContain("更早的完整内容");
  expect(text).toContain("最新消息 159");
  expect(
    fetchMock.mock.calls.filter(
      ([path]) => path === "/api/family/chats/a?before=msg-80",
    ),
  ).toHaveLength(2);
});

test("mod-Enter preference preserves normal Enter and IME composition, and submits only an explicit shortcut", async () => {
  localStorage.setItem(
    "family-workspace-preferences",
    JSON.stringify({ font: "large", density: "compact", sendKey: "mod-enter" }),
  );
  const base = handler;
  handler = async (path, init) =>
    path === "/api/family/chats/a/messages"
      ? json({ error: "合成验收，不调用模型" }, 400)
      : base(path, init);
  const { container } = await open();
  const composer = screen.getByRole("textbox", { name: "发送消息" });
  expect(container.querySelector("main")).toHaveAttribute(
    "data-family-font",
    "large",
  );
  fireEvent.change(composer, { target: { value: "只在明确按键后发送" } });
  fireEvent.keyDown(composer, { key: "Enter" });
  fireEvent.compositionStart(composer);
  fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true, keyCode: 229 });
  fireEvent.compositionEnd(composer);
  fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true, shiftKey: true });
  expect(paidCalls()).toHaveLength(0);
  fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
  await waitFor(() => expect(paidCalls()).toHaveLength(1));
  expect(JSON.parse(String(paidCalls()[0][1]?.body))).toMatchObject({
    content: "只在明确按键后发送",
    model: "fixture-model",
  });
});

test("workspace shortcuts focus search and open settings; suggestion chips only prefill", async () => {
  render(<FamilyApp />);
  await screen.findByRole("button", { name: /会话 a/ });
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  await waitFor(() =>
    expect(screen.getByRole("searchbox", { name: "搜索聊天" })).toHaveFocus(),
  );
  fireEvent.keyDown(window, { key: ",", metaKey: true });
  const dialog = await screen.findByRole("dialog", { name: "设置" });
  chooseWorkspaceOption(
    within(dialog).getByRole("combobox", { name: "文字大小" }),
    "large",
  );
  fireEvent.keyDown(document, { key: "Escape" });
  expect(
    screen.queryByRole("dialog", { name: "设置" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "帮我梳理一个想法" }));
  expect(screen.getByRole("textbox", { name: "发送消息" })).toHaveValue(
    "帮我梳理一个想法",
  );
  expect(paidCalls()).toHaveLength(0);
});
