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
import { ReadableStream } from "node:stream/web";
import { TextDecoder, TextEncoder } from "node:util";
import ReactMarkdown from "react-markdown";
import { FamilyApp } from "../app/family/client";
import { MessageAttachments } from "../app/family/attachments";
import { prepareAttachment } from "../app/family/attachment-browser";
import type {
  FamilyAttachmentMeta,
  FamilyChatDetail,
  FamilyMessage,
  FamilyUser,
} from "../app/family/types";

function read(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
}
const property = (target: object, key: string, value: unknown) =>
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value,
  });
const createdAt = "2026-10-31T00:00:00Z";
const chat = {
  id: "chat-a",
  title: "附件测试",
  model: "model-a",
  archived: false,
  createdAt,
  updatedAt: createdAt,
};
const memberA: FamilyUser = {
  id: "member-a",
  name: "合成甲",
  email: "a@example.test",
  role: "member",
  status: "approved",
};
const memberB: FamilyUser = {
  id: "member-b",
  name: "合成乙",
  email: "b@example.test",
  role: "member",
  status: "approved",
};
const metadata: FamilyAttachmentMeta = {
  id: "private-attachment-a",
  name: "note.txt",
  kind: "text",
  mediaType: "text/plain",
  byteSize: 6,
};
function json(value: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  } as Response;
}
function events(values: unknown[]): Response {
  const bytes = new TextEncoder().encode(
    values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""),
  );
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  } as unknown as Response;
}

describe("atomic family attachments with synthetic files and mock APIs", () => {
  const descriptors = [
    [Blob.prototype, "arrayBuffer"],
    [Element.prototype, "scrollIntoView"],
    [crypto, "randomUUID"],
    [globalThis, "TextDecoder"],
    [URL, "createObjectURL"],
    [URL, "revokeObjectURL"],
    [window, "Image"],
    [HTMLCanvasElement.prototype, "getContext"],
    [HTMLCanvasElement.prototype, "toBlob"],
  ].map(([target, key]) => ({
    target: target as object,
    key: key as string,
    descriptor: Object.getOwnPropertyDescriptor(target, key as string),
  }));
  const originalFetch = global.fetch;
  let identity: FamilyUser;
  let record: FamilyChatDetail;
  let handler: (url: string, init?: RequestInit) => Promise<Response>;
  let fetchMock: ReturnType<typeof makeFetch>;
  function makeFetch() {
    return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init),
    );
  }
  beforeEach(() => {
    let uuid = 0;
    history.replaceState(null, "", "/");
    property(
      crypto,
      "randomUUID",
      () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    );
    property(Blob.prototype, "arrayBuffer", function (this: Blob) {
      return read(this);
    });
    property(Element.prototype, "scrollIntoView", jest.fn());
    property(globalThis, "TextDecoder", TextDecoder);
    property(
      URL,
      "createObjectURL",
      jest.fn(() => "blob:synthetic-attachment"),
    );
    property(URL, "revokeObjectURL", jest.fn());
    identity = memberA;
    record = { chat, messages: [] };
    handler = async (url) => {
      if (url === "/api/family/status")
        return json({
          ready: true,
          needsSetup: false,
          dbConfigured: true,
          schemaReady: true,
          notice: "合成附件测试",
        });
      if (url === "/api/family/me")
        return json({ user: identity, sessionExpiresAt: createdAt });
      if (url === "/api/family/activity") return json({ ok: true });
      if (url === "/api/family/models")
        return json({
          models: [
            {
              id: "model-a",
              name: "附件模型",
              description: "",
              reasoning: false,
              supportsImages: true,
              supportsPdf: true,
            },
          ],
          defaultModel: "model-a",
        });
      if (url === "/api/family/chats")
        return json({ chats: identity.id === memberA.id ? [chat] : [] });
      if (url === "/api/family/chats/chat-a") return json(record);
      throw new Error(`Unexpected synthetic endpoint: ${url}`);
    };
    fetchMock = makeFetch();
    global.fetch = fetchMock as typeof fetch;
  });
  afterEach(() => {
    cleanup();
    descriptors.forEach(({ target, key, descriptor }) =>
      descriptor
        ? Object.defineProperty(target, key, descriptor)
        : Reflect.deleteProperty(target, key),
    );
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });
  async function open() {
    const view = render(<FamilyApp />);
    fireEvent.click(await screen.findByRole("button", { name: /附件测试/ }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "发送消息" })).toBeEnabled(),
    );
    return view;
  }
  async function select(files: File[]) {
    fireEvent.change(screen.getByLabelText("选择附件文件"), {
      target: { files },
    });
    await waitFor(() =>
      expect(screen.queryByText("正在处理…")).not.toBeInTheDocument(),
    );
  }
  function complete(content: string, attachments = [metadata]) {
    const user: FamilyMessage = {
      id: "saved-user",
      role: "user",
      content: content || "请分析这些附件。",
      status: "complete",
      createdAt,
      attachments,
    };
    const assistant: FamilyMessage = {
      id: "saved-assistant",
      role: "assistant",
      content: "附件已分析",
      status: "complete",
      createdAt,
    };
    record = { chat, messages: [user, assistant] };
    return events([
      {
        type: "start",
        userMessage: user,
        assistantMessage: { ...assistant, content: "", status: "streaming" },
      },
      {
        type: "done",
        message: assistant,
        usage: { source: "unknown", inputTokens: null, outputTokens: null },
      },
    ]);
  }

  test("removing a selection and retrying a pre-start rejection preserves files and text, then submits strict base64 atomically", async () => {
    const base = handler;
    let attempts = 0;
    handler = async (url, init) => {
      if (url === "/api/family/chats/chat-a/messages") {
        const body = JSON.parse(String(init?.body));
        expect(body.content).toBe("请看看这份笔记");
        expect(body.attachments).toEqual([
          {
            name: "note.txt",
            mediaType: "text/plain",
            dataBase64: btoa("note-a"),
          },
        ]);
        return ++attempts === 1
          ? json({ error: "合成发送拒绝" }, 503)
          : complete(body.content);
      }
      return base(url, init);
    };
    await open();
    fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
      target: { value: "请看看这份笔记" },
    });
    await select([
      new File(["note-a"], "note.txt", { type: "text/plain" }),
      new File(["other"], "remove.txt", { type: "text/plain" }),
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "移除附件 remove.txt" }),
    );
    expect(screen.queryByText("remove.txt")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "按住说话，松开发送，移出取消" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "发送 ↑" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("合成发送拒绝");
    expect(screen.getByRole("textbox", { name: "发送消息" })).toHaveValue(
      "请看看这份笔记",
    );
    expect(
      screen.getByRole("button", { name: "移除附件 note.txt" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "发送 ↑" }));
    expect(await screen.findByText("附件已分析")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "移除附件 note.txt" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "消息附件" })).toHaveTextContent(
      "note.txt",
    );
    expect(
      fetchMock.mock.calls.some(([url]) =>
        /upload|attachments\//.test(String(url)),
      ),
    ).toBe(false);
  });

  test("an attachment-only message is allowed and canonical metadata replaces the local selection", async () => {
    const base = handler;
    handler = async (url, init) => {
      if (url === "/api/family/chats/chat-a/messages") {
        const body = JSON.parse(String(init?.body));
        expect(body.content).toBe("");
        expect(body.attachments).toHaveLength(1);
        return complete(body.content);
      }
      return base(url, init);
    };
    await open();
    await select([new File(["note-a"], "note.txt", { type: "text/plain" })]);
    expect(screen.getByRole("button", { name: "发送 ↑" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "发送 ↑" }));
    expect(await screen.findByText("请分析这些附件。")).toBeInTheDocument();
    expect(await screen.findByText("附件已分析")).toBeInTheDocument();
  });

  test("a pending attachment survives edit cancellation and reply retry does not resend it", async () => {
    const originalUser: FamilyMessage = {
      id: "original-user",
      role: "user",
      content: "原提问",
      status: "complete",
      createdAt,
      attachments: [metadata],
    };
    const originalAssistant: FamilyMessage = {
      id: "original-assistant",
      role: "assistant",
      content: "原回复",
      status: "partial",
      createdAt,
    };
    record = { chat, messages: [originalUser, originalAssistant] };
    const base = handler;
    handler = async (url, init) => {
      if (url === "/api/family/chats/chat-a/messages") {
        const body = JSON.parse(String(init?.body));
        expect(body.mode).toBe("retry");
        expect(body.sourceMessageId).toBe(originalAssistant.id);
        expect(body).not.toHaveProperty("attachments");
        const user = { ...originalUser, id: "retry-user" },
          assistant = {
            ...originalAssistant,
            id: "retry-assistant",
            content: "重试后的回复",
            status: "complete",
          };
        record = { chat, messages: [user, assistant as FamilyMessage] };
        return events([
          {
            type: "start",
            userMessage: user,
            assistantMessage: {
              ...assistant,
              content: "",
              status: "streaming",
            },
            replacedMessageIds: [originalUser.id, originalAssistant.id],
          },
          {
            type: "done",
            message: assistant,
            usage: { source: "unknown", inputTokens: null, outputTokens: null },
          },
        ]);
      }
      return base(url, init);
    };
    await open();
    expect(await screen.findByText("原回复")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
      target: { value: "未发送草稿" },
    });
    await select([new File(["later"], "later.txt", { type: "text/plain" })]);
    fireEvent.click(screen.getByRole("button", { name: "编辑上一条提问" }));
    expect(screen.getByLabelText("选择附件文件")).toBeDisabled();
    expect(screen.getByText("原附件会一并保留")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "移除附件 later.txt" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消编辑" }));
    expect(screen.getByRole("textbox", { name: "发送消息" })).toHaveValue(
      "未发送草稿",
    );
    expect(
      screen.getByRole("button", { name: "移除附件 later.txt" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重试回复" }));
    expect(await screen.findByText("重试后的回复")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "移除附件 later.txt" }),
    ).toBeEnabled();
  });

  test("an encoding result arriving after an account switch cannot send A's attachment as B", async () => {
    let resolveBytes!: (bytes: ArrayBuffer) => void;
    const delayed = new Promise<ArrayBuffer>((resolve) => {
      resolveBytes = resolve;
    });
    let reads = 0;
    property(Blob.prototype, "arrayBuffer", function (this: File) {
      if (this.name === "late.txt" && ++reads > 1) return delayed;
      return read(this);
    });
    await open();
    await select([new File(["late-a"], "late.txt", { type: "text/plain" })]);
    fireEvent.click(screen.getByRole("button", { name: "发送 ↑" }));
    await waitFor(() => expect(reads).toBe(2));
    identity = memberB;
    fireEvent.focus(window);
    expect(await screen.findByText(memberB.name)).toBeInTheDocument();
    await act(async () => {
      resolveBytes(new TextEncoder().encode("late-a").buffer as ArrayBuffer);
      await delayed;
    });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith("/messages")),
    ).toBe(false);
    expect(screen.queryByText("late.txt")).not.toBeInTheDocument();
  });

  test("late private image bytes cannot create a Blob URL after their scope is removed", async () => {
    let finish!: (blob: Blob) => void;
    const body = new Promise<Blob>((resolve) => {
      finish = resolve;
    });
    let valid = true;
    let signal: AbortSignal | null = null;
    global.fetch = jest.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal as AbortSignal;
        return { ok: true, status: 200, blob: () => body } as Response;
      },
    ) as typeof fetch;
    const createUrl = jest.fn(() => "blob:must-not-create");
    property(URL, "createObjectURL", createUrl);
    const view = render(
      <MessageAttachments
        attachments={[{ ...metadata, kind: "image", mediaType: "image/jpeg" }]}
        scope={{ key: "owner-a", isCurrent: () => valid }}
        onUnauthorized={() => {}}
      />,
    );
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    valid = false;
    view.unmount();
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    await act(async () => {
      finish(new Blob(["synthetic"], { type: "image/jpeg" }));
      await body;
    });
    expect(createUrl).not.toHaveBeenCalled();
  });

  test("Markdown export contains only attachment metadata and no private URL, ID, or encoded data", async () => {
    const maliciousName = "![x](data:,bad)`[open](data:,more).txt";
    record = {
      chat,
      messages: [
        {
          id: "user-export",
          role: "user",
          content: "文件说明",
          status: "complete",
          createdAt,
          attachments: [
            metadata,
            { ...metadata, id: "another-private-id", name: maliciousName },
          ],
        },
      ],
    };
    let exported: Blob | null = null;
    property(
      URL,
      "createObjectURL",
      jest.fn((blob: Blob) => {
        exported = blob;
        return "blob:export-only";
      }),
    );
    jest
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const view = await open();
    fireEvent.click(screen.getByRole("button", { name: "导出 Markdown" }));
    await waitFor(() => expect(exported).not.toBeNull());
    const text = new TextDecoder().decode(await read(exported!));
    expect(text).toContain("note.txt");
    expect(text).toContain("text/plain");
    expect(text).not.toContain(metadata.id);
    expect(text).not.toMatch(/dataBase64|blob:|\/api\/family\/attachments/);
    const markdown = render(<ReactMarkdown>{text}</ReactMarkdown>);
    expect(markdown.container.textContent).toContain(maliciousName);
    expect(markdown.container.querySelectorAll("a,img")).toHaveLength(0);
    markdown.unmount();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  test("image dimensions are limited before decode and supported photos are resized to JPEG", async () => {
    const png = (width: number, height: number) => {
      const data = new Uint8Array(24);
      data.set([137, 80, 78, 71, 13, 10, 26, 10]);
      const view = new DataView(data.buffer);
      view.setUint32(8, 13);
      data.set([73, 72, 68, 82], 12);
      view.setUint32(16, width);
      view.setUint32(20, height);
      return new File([data], "photo.png", { type: "image/png" });
    };
    const controller = new AbortController();
    await expect(
      prepareAttachment(png(10000, 10000), 900000, controller.signal),
    ).rejects.toThrow("像素过大");
    class SyntheticImage {
      naturalWidth = 3000;
      naturalHeight = 1500;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        if (value) queueMicrotask(() => this.onload?.());
      }
    }
    property(window, "Image", SyntheticImage);
    const draw = jest.fn();
    property(HTMLCanvasElement.prototype, "getContext", () => ({
      fillStyle: "",
      fillRect: jest.fn(),
      drawImage: draw,
    }));
    property(
      HTMLCanvasElement.prototype,
      "toBlob",
      (callback: (blob: Blob) => void) =>
        callback(new Blob([new Uint8Array(100)], { type: "image/jpeg" })),
    );
    const image = await prepareAttachment(
      png(3000, 1500),
      900000,
      controller.signal,
    );
    expect(image.kind).toBe("image");
    expect(image.file.type).toBe("image/jpeg");
    expect(image.width).toBe(2048);
    expect(image.height).toBe(1024);
    expect(image.file.size).toBeLessThanOrEqual(900000);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });
});
