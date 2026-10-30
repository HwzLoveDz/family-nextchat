/** @jest-environment jsdom */

import { jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FamilyApp } from "../app/family/client";
import type { FamilyChatDetail, FamilyUser } from "../app/family/types";
import { FAMILY_NOTICE } from "../app/family/types";
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import { TextDecoder as NodeTextDecoder, TextEncoder } from "node:util";

// Only synthetic identities and mocked responses are used; no real API calls.
const memberA: FamilyUser = {
  id: "member-a",
  name: "家人甲",
  email: "a@example.test",
  role: "member",
  status: "approved",
};
const memberB: FamilyUser = {
  id: "member-b",
  name: "家人乙",
  email: "b@example.test",
  role: "member",
  status: "approved",
};
const chat = (id: string) => ({
  id,
  title: `聊天 ${id}`,
  model: "model-fast",
  archived: false,
  createdAt: "2026-10-30T00:00:00Z",
  updatedAt: "2026-10-30T00:00:00Z",
});
function json(value: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  } as Response;
}
function detail(content: string): FamilyChatDetail {
  return {
    chat: chat("a"),
    messages: [
      {
        id: "message-a",
        role: "assistant",
        content,
        status: "complete",
        createdAt: "2026-10-30T00:00:00Z",
        usage: { source: "unknown", inputTokens: null, outputTokens: null },
      },
    ],
  };
}
function streamResponse(events: unknown[]): Response {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
  );
  const body = new NodeReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 3)
        controller.enqueue(bytes.slice(index, index + 3));
      controller.close();
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

describe("family client account isolation", () => {
  const originalFetch = global.fetch;
  const originalScroll = Element.prototype.scrollIntoView;
  const originalUUID = Object.getOwnPropertyDescriptor(
    window.crypto,
    "randomUUID",
  );
  const originalDecoder = global.TextDecoder;
  let identity: FamilyUser | null;
  let requestHandler: (path: string, init?: RequestInit) => Promise<Response>;
  let fetchMock: ReturnType<typeof makeFetchMock>;
  function makeFetchMock() {
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      requestHandler(String(input), init),
    );
  }
  beforeAll(() => {
    Element.prototype.scrollIntoView = jest.fn();
    Object.defineProperty(window.crypto, "randomUUID", {
      configurable: true,
      value: () => "00000000-0000-4000-8000-000000000001",
    });
    global.TextDecoder = NodeTextDecoder as typeof global.TextDecoder;
  });
  afterAll(() => {
    Element.prototype.scrollIntoView = originalScroll;
    if (originalUUID)
      Object.defineProperty(window.crypto, "randomUUID", originalUUID);
    else Reflect.deleteProperty(window.crypto, "randomUUID");
    global.TextDecoder = originalDecoder;
  });
  beforeEach(() => {
    history.replaceState(null, "", "/");
    localStorage.clear();
    identity = memberA;
    requestHandler = async (path) => {
      if (path === "/api/family/status")
        return json({
          ready: true,
          needsSetup: false,
          dbConfigured: true,
          notice: FAMILY_NOTICE,
        });
      if (path === "/api/family/me")
        return identity
          ? json({ user: identity, sessionExpiresAt: "2026-11-29T00:00:00Z" })
          : json({ error: "请先登录" }, 401);
      if (path === "/api/family/chats")
        return json({ chats: [chat(identity?.id === memberB.id ? "b" : "a")] });
      if (path === "/api/family/activity") return json({ ok: true });
      if (path === "/api/family/models")
        return json({
          models: [
            {
              id: "model-fast",
              name: "快速模型",
              description: "日常聊天",
              reasoning: false,
            },
            {
              id: "model-think",
              name: "思考模型",
              description: "复杂问题",
              reasoning: true,
            },
          ],
          defaultModel: "model-fast",
        });
      if (path === "/api/family/chats/a") return json(detail("甲的私密回复"));
      throw new Error(`Unexpected fixture endpoint: ${path}`);
    };
    fetchMock = makeFetchMock();
    global.fetch = fetchMock as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("login and signup omit the requested sentence and retain service status", async () => {
    identity = null;
    const removedSentence =
      "管理员可查看账号、聊天内容、模型回复、用量和前台活跃时长估算。";
    const baseHandler = requestHandler;
    requestHandler = async (path, init) =>
      path === "/api/family/status"
        ? json({
            ready: true,
            needsSetup: false,
            dbConfigured: true,
            notice: `${FAMILY_NOTICE} 模型 API 尚未配置。`,
          })
        : baseHandler(path, init);
    const { container } = render(<FamilyApp />);
    expect(
      await screen.findByRole("button", { name: "登录" }),
    ).toBeInTheDocument();
    expect(container.textContent).not.toContain(removedSentence);
    expect(container.textContent).toContain("模型 API 尚未配置。");
    fireEvent.click(screen.getByRole("button", { name: "有邀请？申请加入" }));
    expect(
      await screen.findByRole("heading", { name: "加入家庭聊天" }),
    ).toBeInTheDocument();
    expect(container.textContent).not.toContain(removedSentence);
    expect(container.textContent).toContain("模型 API 尚未配置。");
  });

  test("changing appearance preserves the selected chat, model and unsent draft without an API mutation", async () => {
    const { container } = render(<FamilyApp />);
    fireEvent.click(await screen.findByRole("button", { name: /聊天 a/ }));
    expect(await screen.findByText("甲的私密回复")).toBeInTheDocument();
    const composer = screen.getByRole("textbox", { name: "发送消息" });
    fireEvent.change(composer, { target: { value: "尚未发送的草稿" } });
    const mutations = () =>
      fetchMock.mock.calls.filter(
        ([path, init]) =>
          init?.method &&
          init.method !== "GET" &&
          path !== "/api/family/activity",
      ).length;
    const before = mutations();
    fireEvent.click(screen.getByRole("button", { name: /^主题$/ }));
    fireEvent.click(screen.getByRole("radio", { name: /^午夜灰$/ }));
    expect(container.querySelector("main")).toHaveAttribute(
      "data-family-theme",
      "midnight",
    );
    expect(composer).toHaveValue("尚未发送的草稿");
    expect(screen.getByText("甲的私密回复")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "选择模型" })).toHaveValue(
      "model-fast",
    );
    expect(mutations()).toBe(before);
  });

  test("last-turn editing preserves an earlier draft and IME/Shift+Enter do not submit", async () => {
    const createdAt = "2026-10-30T00:00:00Z";
    let record: FamilyChatDetail = {
      chat: chat("a"),
      messages: [
        {
          id: "old-user",
          role: "user",
          content: "原来的提问",
          status: "complete",
          createdAt,
        },
        {
          id: "old-assistant",
          role: "assistant",
          content: "原来的回复",
          status: "complete",
          createdAt,
        },
      ],
    };
    const baseHandler = requestHandler;
    requestHandler = async (path, init) => {
      if (path === "/api/family/chats/a") return json(record);
      if (path === "/api/family/chats/a/messages") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          mode: "edit",
          sourceMessageId: "old-user",
          content: "已编辑的新提问",
          model: "model-fast",
        });
        const userMessage = {
          id: "new-user",
          role: "user" as const,
          content: "已编辑的新提问",
          status: "complete" as const,
          createdAt,
        };
        const assistantMessage = {
          id: "new-assistant",
          role: "assistant" as const,
          content: "编辑后的新回复",
          status: "complete" as const,
          createdAt,
        };
        record = { chat: chat("a"), messages: [userMessage, assistantMessage] };
        return streamResponse([
          {
            type: "start",
            userMessage,
            assistantMessage: {
              ...assistantMessage,
              content: "",
              status: "streaming",
            },
            replacedMessageIds: ["old-user", "old-assistant"],
          },
          {
            type: "done",
            message: assistantMessage,
            usage: { source: "unknown", inputTokens: null, outputTokens: null },
          },
        ]);
      }
      return baseHandler(path, init);
    };
    render(<FamilyApp />);
    fireEvent.click(await screen.findByRole("button", { name: /聊天 a/ }));
    expect(await screen.findByText("原来的回复")).toBeInTheDocument();
    const input = screen.getByRole("textbox", { name: "发送消息" });
    fireEvent.change(input, { target: { value: "尚未发送的原草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "编辑上一条提问" }));
    expect(input).toHaveValue("原来的提问");
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "输入法确认中的中文" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(
      fetchMock.mock.calls.some(
        ([path]) => path === "/api/family/chats/a/messages",
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "取消编辑" }));
    expect(input).toHaveValue("尚未发送的原草稿");
    fireEvent.click(screen.getByRole("button", { name: "编辑上一条提问" }));
    fireEvent.change(input, { target: { value: "已编辑的新提问" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并重新回复" }));
    expect(await screen.findByText("编辑后的新回复")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "停止回复" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("原来的回复")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "发送消息" })).toHaveValue(
      "尚未发送的原草稿",
    );
  });

  test("a delayed owner export cannot download A's data after identity changes to B", async () => {
    const originalCreate = Object.getOwnPropertyDescriptor(
      URL,
      "createObjectURL",
    );
    const originalRevoke = Object.getOwnPropertyDescriptor(
      URL,
      "revokeObjectURL",
    );
    const createUrl = jest.fn(() => "blob:synthetic-family-export");
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: jest.fn(),
    });
    let resolveExport!: (response: Response) => void;
    const delayedExport = new Promise<Response>((resolve) => {
      resolveExport = resolve;
    });
    let detailReads = 0;
    const baseHandler = requestHandler;
    requestHandler = async (path, init) => {
      if (path === "/api/family/chats/a" && ++detailReads > 1)
        return delayedExport;
      return baseHandler(path, init);
    };
    const view = render(<FamilyApp />);
    try {
      fireEvent.click(await screen.findByRole("button", { name: /聊天 a/ }));
      expect(await screen.findByText("甲的私密回复")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "导出 Markdown" }));
      await waitFor(() => expect(detailReads).toBe(2));
      identity = memberB;
      fireEvent.focus(window);
      expect(await screen.findByText(memberB.name)).toBeInTheDocument();
      await act(async () => {
        resolveExport(json(detail("不应导出的甲的私密回复")));
        await delayedExport;
      });
      expect(createUrl).not.toHaveBeenCalled();
      expect(
        screen.queryByText("不应导出的甲的私密回复"),
      ).not.toBeInTheDocument();
    } finally {
      view.unmount();
      if (originalCreate)
        Object.defineProperty(URL, "createObjectURL", originalCreate);
      else Reflect.deleteProperty(URL, "createObjectURL");
      if (originalRevoke)
        Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
      else Reflect.deleteProperty(URL, "revokeObjectURL");
    }
  });

  test("invitation stays in memory, is removed from URL, and registration waits for approval", async () => {
    identity = null;
    localStorage.setItem("chat-next-web-store", "legacy-private-fixture");
    localStorage.setItem("unfinished-input-old", "legacy-draft-fixture");
    localStorage.setItem("unrelated-setting", "keep-fixture");
    history.replaceState(
      null,
      "",
      "/#/register?invite=single-use-fixture-token",
    );
    const baseHandler = requestHandler;
    requestHandler = async (path, init) =>
      path === "/api/family/register"
        ? json({ ok: true, status: "pending" })
        : baseHandler(path, init);
    render(<FamilyApp />);
    const invitation = await screen.findByLabelText("邀请口令");
    await waitFor(() =>
      expect(invitation).toHaveValue("single-use-fixture-token"),
    );
    expect(location.hash).toBe("#/register");
    expect(localStorage.getItem("chat-next-web-store")).toBeNull();
    expect(localStorage.getItem("unfinished-input-old")).toBeNull();
    expect(localStorage.getItem("unrelated-setting")).toBe("keep-fixture");
    fireEvent.change(screen.getByLabelText("称呼"), {
      target: { value: "家人新成员" },
    });
    fireEvent.change(screen.getByLabelText("邮箱"), {
      target: { value: "new@example.test" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "fixture-password-never-used" },
    });
    fireEvent.click(screen.getByRole("button", { name: "注册并申请加入" }));
    expect(
      await screen.findByRole("heading", { name: "等待管理员批准" }),
    ).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(
      ([path]) => path === "/api/family/register",
    );
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      inviteToken: "single-use-fixture-token",
      email: "new@example.test",
    });
    expect(Object.values(localStorage).join(" ")).not.toContain(
      "single-use-fixture-token",
    );
    expect(Object.values(localStorage).join(" ")).not.toContain(
      "fixture-password-never-used",
    );
    expect(
      screen.queryByRole("textbox", { name: "发送消息" }),
    ).not.toBeInTheDocument();
  });

  test("chat Markdown has no active HTML or remote images, and private fetches bypass caches", async () => {
    const baseHandler = requestHandler;
    requestHandler = async (path, init) =>
      path === "/api/family/chats/a"
        ? json(
            detail(
              '安全 **文字**\n\n![tracker](https://tracker.example/pixel.png)\n\n<img src="https://tracker.example/html.png"><script>alert(1)</script>',
            ),
          )
        : baseHandler(path, init);
    const { container } = render(<FamilyApp />);
    fireEvent.click(await screen.findByRole("button", { name: /聊天 a/ }));
    expect(
      await screen.findByText("文字", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(
      container.querySelectorAll("img,script,iframe,object,embed"),
    ).toHaveLength(0);
    expect(screen.getByText("用量未知")).toBeInTheDocument();
    for (const [path, init] of fetchMock.mock.calls) {
      expect(String(path)).toMatch(/^\/api\/family\//);
      expect(init).toMatchObject({ credentials: "include", cache: "no-store" });
    }
  });

  test("focus revalidation clears A's data and ignores a late A response after the cookie belongs to B", async () => {
    let resolveDetail!: (response: Response) => void;
    const lateDetail = new Promise<Response>((resolve) => {
      resolveDetail = resolve;
    });
    const baseHandler = requestHandler;
    requestHandler = async (path, init) =>
      path === "/api/family/chats/a" ? lateDetail : baseHandler(path, init);
    render(<FamilyApp />);
    fireEvent.click(await screen.findByRole("button", { name: /聊天 a/ }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([path]) => path === "/api/family/chats/a"),
      ).toBe(true),
    );
    identity = memberB;
    fireEvent.focus(window);
    expect(await screen.findByText("家人乙")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: /聊天 b/ }),
    ).toBeInTheDocument();
    await act(async () => {
      resolveDetail(json(detail("甲的迟到私密回复")));
      await lateDetail;
    });
    expect(screen.queryByText("甲的迟到私密回复")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /聊天 a/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "发送消息" })).toHaveValue("");
  });

  test.each(["chat", "admin"] as const)(
    "%s private DOM is unmounted while revalidating and restored only for the same identity",
    async (view) => {
      if (view === "admin") identity = { ...memberA, role: "admin" };
      const baseHandler = requestHandler;
      requestHandler = async (path, init) => {
        if (path === "/api/family/admin/users") {
          return json({
            users: [
              {
                ...memberB,
                name: "管理页私密账户",
                createdAt: "2026-10-30T00:00:00Z",
                lastSeenAt: null,
                activeSeconds: 60,
                inputTokens: 1,
                outputTokens: 2,
                unknownUsageRequests: 0,
              },
            ],
          });
        }
        return baseHandler(path, init);
      };
      const { container } = render(<FamilyApp />);
      if (view === "chat") {
        fireEvent.click(await screen.findByRole("button", { name: /聊天 a/ }));
        expect(await screen.findByText("甲的私密回复")).toBeInTheDocument();
        fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
          target: { value: "同账号的未发送草稿" },
        });
      } else {
        fireEvent.click(
          await screen.findByRole("button", { name: "账户与用量管理" }),
        );
        expect(await screen.findByText("管理页私密账户")).toBeInTheDocument();
      }
      let confirmIdentity!: (response: Response) => void;
      const pendingIdentity = new Promise<Response>((resolve) => {
        confirmIdentity = resolve;
      });
      const authenticatedHandler = requestHandler;
      requestHandler = async (path, init) =>
        path === "/api/family/me"
          ? pendingIdentity
          : authenticatedHandler(path, init);
      fireEvent.focus(window);
      expect(
        await screen.findByText("正在重新确认登录状态…"),
      ).toBeInTheDocument();
      expect(container.textContent).not.toContain("甲的私密回复");
      expect(container.textContent).not.toContain("管理页私密账户");
      expect(container.textContent).not.toContain("a@example.test");
      expect(
        container.querySelectorAll("button,input,textarea,a"),
      ).toHaveLength(0);
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(([path]) => path === "/api/family/me")
            .length,
        ).toBeGreaterThan(1),
      );
      await act(async () => {
        confirmIdentity(
          json({ user: identity, sessionExpiresAt: "2026-11-29T00:00:00Z" }),
        );
        await pendingIdentity;
      });
      expect(
        await screen.findByText(
          view === "chat" ? "甲的私密回复" : "管理页私密账户",
        ),
      ).toBeInTheDocument();
      if (view === "chat")
        expect(screen.getByRole("textbox", { name: "发送消息" })).toHaveValue(
          "同账号的未发送草稿",
        );
    },
  );

  test("archiving confirms before hiding the conversation", async () => {
    let archived = false;
    const baseHandler = requestHandler;
    requestHandler = async (path, init) => {
      if (path === "/api/family/chats/a" && init?.method === "DELETE") {
        archived = true;
        return json({ ok: true });
      }
      if (path === "/api/family/chats")
        return json({ chats: archived ? [] : [chat("a")] });
      return baseHandler(path, init);
    };
    render(<FamilyApp />);
    fireEvent.click(await screen.findByRole("button", { name: /聊天 a/ }));
    expect(await screen.findByText("甲的私密回复")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "归档对话" }));
    expect(
      screen.getByText("归档后从你的列表隐藏。"),
    ).toBeInTheDocument();
    expect(archived).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    expect(
      await screen.findByText("对话已归档。"),
    ).toBeInTheDocument();
    expect(archived).toBe(true);
    expect(screen.queryByText("甲的私密回复")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /聊天 a/ }),
    ).not.toBeInTheDocument();
  });

  test("administrator can read a conversation that is visibly marked archived", async () => {
    identity = { ...memberA, role: "admin" };
    const baseHandler = requestHandler;
    requestHandler = async (path, init) => {
      if (path === "/api/family/admin/users")
        return json({
          users: [
            {
              ...memberB,
              createdAt: "2026-10-30T00:00:00Z",
              lastSeenAt: null,
              activeSeconds: 0,
              inputTokens: 0,
              outputTokens: 0,
              unknownUsageRequests: 0,
            },
          ],
        });
      if (path === `/api/family/admin/users/${memberB.id}/chats`)
        return json({ chats: [{ ...chat("a"), archived: true }] });
      if (path === "/api/family/admin/chats/a") {
        const record = detail("归档保留的完整回复");
        return json({ ...record, chat: { ...record.chat, archived: true } });
      }
      return baseHandler(path, init);
    };
    render(<FamilyApp />);
    fireEvent.click(
      await screen.findByRole("button", { name: "账户与用量管理" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "查看完整聊天" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /聊天 a · 已归档/ }),
    );
    expect(await screen.findByText("归档保留的完整回复")).toBeInTheDocument();
    expect(screen.getByText("已归档")).toBeInTheDocument();
  });

  test.each(["approved", "pending"] as const)(
    "login requests a persistent session and handles %s account feedback without storing credentials",
    async (accountStatus) => {
      identity = null;
      const baseHandler = requestHandler;
      requestHandler = async (path, init) => {
        if (path === "/api/auth/sign-in/email") {
          if (accountStatus === "pending")
            return json(
              { message: "账号尚未获批或已停用，请联系管理员。" },
              403,
            );
          identity = memberA;
          return json({ user: memberA });
        }
        return baseHandler(path, init);
      };
      render(<FamilyApp />);
      fireEvent.change(await screen.findByLabelText("邮箱"), {
        target: { value: memberA.email },
      });
      fireEvent.change(screen.getByLabelText("密码"), {
        target: { value: "synthetic-login-password" },
      });
      fireEvent.click(screen.getByRole("button", { name: "登录" }));
      if (accountStatus === "approved")
        expect(await screen.findByText(memberA.name)).toBeInTheDocument();
      else {
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "账号尚未获批或已停用，请联系管理员。",
        );
        expect(
          screen.queryByRole("textbox", { name: "发送消息" }),
        ).not.toBeInTheDocument();
      }
      const call = fetchMock.mock.calls.find(
        ([path]) => path === "/api/auth/sign-in/email",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
        rememberMe: true,
      });
      expect(Object.values(localStorage).join(" ")).not.toContain(
        "synthetic-login-password",
      );
    },
  );

  test("HTTP rejection before SSE removes optimistic messages and keeps the unsent draft", async () => {
    const baseHandler = requestHandler;
    requestHandler = async (path, init) =>
      path === "/api/family/chats/a/messages"
        ? json({ error: "模型 API 尚未配置。" }, 503)
        : baseHandler(path, init);
    const { container } = render(<FamilyApp />);
    fireEvent.click(await screen.findByRole("button", { name: /聊天 a/ }));
    expect(await screen.findByText("甲的私密回复")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
      target: { value: "稍后重试的草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送 ↑" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "模型 API 尚未配置。",
    );
    expect(screen.getByRole("textbox", { name: "发送消息" })).toHaveValue(
      "稍后重试的草稿",
    );
    expect(container.querySelectorAll("article")).toHaveLength(1);
    expect(screen.queryByText(/回复未完成/)).not.toBeInTheDocument();
  });

  test("an account-disabled SSE error immediately revalidates identity and removes private UI", async () => {
    let revoked = false;
    const baseHandler = requestHandler;
    requestHandler = async (path, init) => {
      if (path === "/api/family/me" && revoked)
        return json({ error: "账号已停用，请联系管理员。" }, 403);
      if (path === "/api/family/chats/a/messages") {
        revoked = true;
        return streamResponse([{ type: "error", message: "本次请求已停止。" }]);
      }
      return baseHandler(path, init);
    };
    render(<FamilyApp />);
    fireEvent.click(await screen.findByRole("button", { name: /聊天 a/ }));
    expect(await screen.findByText("甲的私密回复")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
      target: { value: "禁用期间的输入" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送 ↑" }));
    expect(
      await screen.findByRole("button", { name: "登录" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "账号已停用，请联系管理员。",
    );
    expect(screen.queryByText("甲的私密回复")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "发送消息" }),
    ).not.toBeInTheDocument();
  });

  test("a list refresh failure after done does not relabel the saved reply as partial", async () => {
    let completed = false;
    const baseHandler = requestHandler;
    requestHandler = async (path, init) => {
      if (path === "/api/family/chats" && completed)
        throw new Error("synthetic offline refresh");
      if (path === "/api/family/chats/a/messages") {
        completed = true;
        const assistantMessage = {
          id: "server-complete",
          role: "assistant",
          content: "已保存的最终回复",
          status: "complete",
          createdAt: "2026-10-30T00:00:00Z",
        };
        return streamResponse([
          {
            type: "start",
            userMessage: {
              id: "server-user",
              role: "user",
              content: "新问题",
              status: "complete",
              createdAt: assistantMessage.createdAt,
            },
            assistantMessage: {
              ...assistantMessage,
              content: "",
              status: "streaming",
            },
          },
          {
            type: "done",
            message: assistantMessage,
            usage: { source: "reported", inputTokens: 3, outputTokens: 4 },
          },
        ]);
      }
      return baseHandler(path, init);
    };
    render(<FamilyApp />);
    fireEvent.click(await screen.findByRole("button", { name: /聊天 a/ }));
    expect(await screen.findByText("甲的私密回复")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
      target: { value: "新问题" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送 ↑" }));
    expect(await screen.findByText("已保存的最终回复")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "回复已完成，但会话列表暂时未刷新。",
    );
    expect(screen.getByText("输入 3 / 输出 4 token")).toBeInTheDocument();
    expect(screen.queryByText(/回复未完成/)).not.toBeInTheDocument();
  });

  test("split UTF-8 SSE is reconciled to the server's final message and reported token usage", async () => {
    const baseHandler = requestHandler;
    requestHandler = async (path, init) => {
      if (path === "/api/family/chats/a")
        return json({ chat: chat("a"), messages: [] });
      if (path !== "/api/family/chats/a/messages")
        return baseHandler(path, init);
      const payload = JSON.parse(String(init?.body));
      expect(payload).toEqual({
        content: "用户的新问题",
        requestId: "00000000-0000-4000-8000-000000000001",
        model: "model-fast",
      });
      const userMessage = {
        id: "server-user",
        role: "user",
        content: payload.content,
        status: "complete",
        createdAt: "2026-10-30T00:00:00Z",
      };
      const assistantMessage = {
        id: "server-assistant",
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: "2026-10-30T00:00:00Z",
      };
      const usage = { source: "reported", inputTokens: 11, outputTokens: 22 };
      const events = [
        { type: "start", userMessage, assistantMessage },
        { type: "delta", text: "临时中文片段" },
        {
          type: "done",
          message: {
            ...assistantMessage,
            content: "服务端最终回复",
            status: "complete",
          },
          usage,
        },
      ];
      const bytes = new TextEncoder().encode(
        events
          .map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`)
          .join(""),
      );
      const body = new NodeReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < bytes.length; index += 3)
            controller.enqueue(bytes.slice(index, index + 3));
          controller.close();
        },
      });
      return { ok: true, status: 200, body } as unknown as Response;
    };
    render(<FamilyApp />);
    fireEvent.click(await screen.findByRole("button", { name: /聊天 a/ }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "发送消息" })).toBeEnabled(),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
      target: { value: "用户的新问题" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送 ↑" }));
    expect(await screen.findByText("服务端最终回复")).toBeInTheDocument();
    expect(screen.queryByText("临时中文片段")).not.toBeInTheDocument();
    expect(screen.getByText("输入 11 / 输出 22 token")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "停止回复" }),
      ).not.toBeInTheDocument(),
    );
  });

  test("stop waits for the server cancellation ACK before aborting and restores the authoritative partial reply", async () => {
    const order: string[] = [];
    let signal: AbortSignal | null = null;
    let acknowledge!: (response: Response) => void;
    const cancellation = new Promise<Response>((resolve) => {
      acknowledge = resolve;
    });
    const createdAt = "2026-10-30T00:00:00Z";
    const userMessage = {
      id: "server-stop-user",
      role: "user" as const,
      content: "停止测试",
      status: "complete" as const,
      createdAt,
    };
    let assistantMessage: FamilyChatDetail["messages"][number] = {
      id: "server-stop-assistant",
      role: "assistant",
      content: "已保存的部分回复",
      status: "streaming",
      createdAt,
    };
    let generating = false;
    const baseHandler = requestHandler;
    requestHandler = async (path, init) => {
      if (
        path === "/api/family/chats/a/messages/server-stop-assistant/cancel"
      ) {
        order.push("cancel-request");
        expect(init?.method).toBe("POST");
        expect(signal?.aborted).toBe(false);
        return cancellation;
      }
      if (path === "/api/family/chats/a") {
        if (generating) order.push("read-record");
        return json({
          chat: chat("a"),
          messages: generating ? [userMessage, assistantMessage] : [],
        });
      }
      if (path === "/api/family/chats/a/messages") {
        generating = true;
        signal = init?.signal as AbortSignal;
        const body = new NodeReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  type: "start",
                  userMessage,
                  assistantMessage,
                })}\n\n`,
              ),
            );
            signal!.addEventListener(
              "abort",
              () => {
                order.push("stream-abort");
                controller.error(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          },
        });
        return { ok: true, status: 200, body } as unknown as Response;
      }
      return baseHandler(path, init);
    };
    render(<FamilyApp />);
    fireEvent.click(await screen.findByRole("button", { name: /聊天 a/ }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "发送消息" })).toBeEnabled(),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
      target: { value: "停止测试" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送 ↑" }));
    fireEvent.click(await screen.findByRole("button", { name: "停止回复" }));
    await waitFor(() => expect(order).toContain("cancel-request"));
    expect(screen.getByRole("button", { name: "正在停止…" })).toBeDisabled();
    expect(order).not.toContain("stream-abort");
    expect(
      screen.queryByRole("button", { name: "重试回复" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      assistantMessage = {
        ...assistantMessage,
        status: "partial",
        usage: { source: "unknown", inputTokens: null, outputTokens: null },
      };
      order.push("ack");
      acknowledge(json({ ok: true }));
      await cancellation;
    });
    expect(
      await screen.findByText("服务器已结束本次生成，已同步保存的回复与用量。"),
    ).toBeInTheDocument();
    expect(order.indexOf("stream-abort")).toBeGreaterThan(order.indexOf("ack"));
    expect(order.indexOf("read-record")).toBeGreaterThan(
      order.indexOf("stream-abort"),
    );
    expect(screen.getByText("已保存的部分回复")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "重试回复" })).toBeEnabled(),
    );
  });
});
