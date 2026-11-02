/** @jest-environment jsdom */
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
import { ReadableStream as NodeReadableStream } from "node:stream/web";
import { TextDecoder, TextEncoder } from "node:util";
import type {
  FamilyChatDetail,
  FamilyMessage,
  FamilyModel,
  FamilyUser,
} from "../app/family/types";
import { FAMILY_SESSION_EVENT } from "../app/family/client-cleanup";

// Synthetic accounts, assets and streams only; no provider or microphone is used.
let voiceScope: { getScope: () => { canRecord: boolean } };
let realtimeScope: { getScope: () => { canStart: boolean } };
const nothing = jest.fn();
const voice = {
  phase: "idle",
  seconds: 0,
  playback: { status: "idle", parts: 0 },
  supported: true,
  busy: false,
  startRecording: nothing,
  releaseRecording: nothing,
  cancelGesture: nothing,
  cancelRecording: nothing,
  reset: nothing,
  speak: nothing,
  pause: nothing,
  resume: nothing,
  replay: nothing,
  stopPlayback: nothing,
};
const realtime = {
  busy: false,
  phase: "idle",
  muted: false,
  elapsed: 0,
  supported: true,
  voice: "marin",
  setVoice: nothing,
  vad: "natural",
  setVad: nothing,
  transcripts: [],
  error: "",
  start: nothing,
  end: nothing,
  interrupt: nothing,
  toggleMute: nothing,
  resumeAudio: nothing,
  keepAlive: nothing,
  reset: nothing,
  audioBlocked: false,
  idleWarning: false,
  reconnectAttempt: 0,
  level: 0,
};
jest.unstable_mockModule("@/app/family/use-family-voice", () => ({
  useFamilyVoice: (options: typeof voiceScope) => {
    voiceScope = options;
    return voice;
  },
}));
jest.unstable_mockModule("@/app/family/use-family-realtime", () => ({
  useFamilyRealtime: (options: typeof realtimeScope) => {
    realtimeScope = options;
    return realtime;
  },
}));
const { FamilyApp } = await import("../app/family/client");

const date = "2026-11-03T00:00:00.000Z";
const member: FamilyUser = {
  id: "synthetic-image-owner",
  name: "合成图像用户",
  email: "image@example.invalid",
  role: "member",
  status: "approved",
};
const textIDs = [
  "gpt-4o-mini",
  "gpt-4.1-nano",
  "gpt-4.1-mini",
  "gpt-4.1",
  "gpt-4o",
  "gpt-5.4-mini",
  "gpt-6-luna",
  "gpt-6.1-terra",
  "gpt-6.1-sol",
  "gpt-6-astra",
];
const imageIDs = [
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-1.5",
  "gpt-image-1-mini",
];
const catalog: FamilyModel[] = [...textIDs, ...imageIDs].map((id) => ({
  id,
  name: id,
  description: "合成模型",
  reasoning: false,
  kind: imageIDs.includes(id) ? "image" : "text",
  supportsImages: !imageIDs.includes(id),
  supportsPdf: !imageIDs.includes(id),
}));
const unknownUsage = {
  source: "unknown" as const,
  inputTokens: null,
  outputTokens: null,
};
const image = {
  id: "private-fixture-image",
  name: "合成图片.jpg",
  width: 1024,
  height: 1024,
  mediaType: "image/jpeg" as const,
  byteSize: 32,
  model: imageIDs[0],
  createdAt: date,
};
const userMessage: FamilyMessage = {
  id: "user-fixture",
  role: "user",
  content: "生成一片森林",
  status: "complete",
  createdAt: date,
};
const assistantMessage: FamilyMessage = {
  id: "assistant-fixture",
  role: "assistant",
  content: "",
  status: "complete",
  createdAt: date,
  requestedModel: imageIDs[0],
  model: null,
  generatedImages: [image],
  imageOptions: { size: "1024x1024", quality: "medium" },
  usage: unknownUsage,
};
const json = (value: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
  }) as Response;
const stream = (events: unknown[]): Response => {
  const bytes = new TextEncoder().encode(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
  );
  return {
    ok: true,
    status: 200,
    body: new NodeReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  } as unknown as Response;
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
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
let detail: FamilyChatDetail;
let handler: (path: string, init?: RequestInit) => Promise<Response>;
let fetchMock: jest.Mock<typeof fetch>;
beforeEach(() => {
  history.replaceState(null, "", "/");
  localStorage.clear();
  identity = member;
  detail = {
    chat: {
      id: "fixture-chat",
      title: "图片工作台验收",
      model: textIDs[0],
      archived: false,
      createdAt: date,
      updatedAt: date,
    },
    messages: [],
  };
  property(Blob.prototype, "arrayBuffer", function (this: Blob) {
    return read(this);
  });
  property(Element.prototype, "scrollIntoView", jest.fn());
  property(crypto, "randomUUID", () => "00000000-0000-4000-8000-000000000001");
  property(globalThis, "TextDecoder", TextDecoder);
  property(
    URL,
    "createObjectURL",
    jest.fn(() => "blob:private-generated"),
  );
  property(URL, "revokeObjectURL", jest.fn());
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  nothing.mockClear();
  handler = async (path, init) => {
    if (path === "/api/family/status")
      return json({
        ready: true,
        needsSetup: false,
        dbConfigured: true,
        schemaReady: true,
      });
    if (path === "/api/family/me")
      return json({
        user: identity,
        sessionExpiresAt: "2026-12-01T00:00:00.000Z",
      });
    if (path === "/api/family/models")
      return json({ models: catalog, defaultModel: textIDs[0] });
    if (path === "/api/family/chats") return json({ chats: [detail.chat] });
    if (path === "/api/family/chats/fixture-chat") {
      if (init?.method === "PATCH") {
        detail.chat.model = JSON.parse(String(init.body)).model;
        return json({ chat: { ...detail.chat } });
      }
      return json(detail);
    }
    if (path === "/api/family/chats/fixture-chat/messages")
      return json({ error: "合成验收，不调用真实模型" }, 400);
    if (path === `/api/family/generated-images/${image.id}`)
      return {
        ok: true,
        status: 200,
        blob: async () => new Blob(["synthetic-jpeg"], { type: "image/jpeg" }),
      } as Response;
    if (path === "/api/family/activity") return json({ ok: true });
    throw new Error(`Unexpected synthetic image endpoint: ${path}`);
  };
  fetchMock = jest.fn(async (input, init) => handler(String(input), init));
  global.fetch = fetchMock;
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
const requests = () =>
  fetchMock.mock.calls.filter(([path]) => String(path).endsWith("/messages"));
const payload = () => JSON.parse(String(requests().at(-1)?.[1]?.body));
async function open() {
  const view = render(<FamilyApp />);
  fireEvent.click(
    await screen.findByRole("button", { name: /图片工作台验收/ }),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "发送消息" })).toBeEnabled(),
  );
  return view;
}
async function chooseImage() {
  fireEvent.change(screen.getByRole("combobox", { name: "选择模型" }), {
    target: { value: imageIDs[0] },
  });
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "图片比例" })).toBeEnabled(),
  );
}

test("catalog preserves ten chat models and groups image models; selection/options never generate and block both voice scopes", async () => {
  await open();
  const picker = screen.getByRole("combobox", { name: "选择模型" });
  expect(
    within(screen.getByRole("group", { name: "文字聊天" })).getAllByRole(
      "option",
    ),
  ).toHaveLength(10);
  expect(
    within(screen.getByRole("group", { name: "图片生成" })).getAllByRole(
      "option",
    ),
  ).toHaveLength(4);
  const composer = screen.getByRole("textbox", { name: "发送消息" });
  const fileInput = screen.getByLabelText("选择附件文件");
  expect(voiceScope.getScope().canRecord).toBe(true);
  expect(realtimeScope.getScope().canStart).toBe(true);
  fireEvent.change(composer, { target: { value: "还未发送的图像描述" } });
  await chooseImage();
  fireEvent.change(screen.getByRole("combobox", { name: "图片比例" }), {
    target: { value: "1536x1024" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "图片质量" }), {
    target: { value: "high" },
  });
  expect(screen.getByRole("textbox", { name: "发送消息" })).toBe(composer);
  expect(screen.getByLabelText("选择附件文件")).toBe(fileInput);
  expect(composer).toHaveValue("还未发送的图像描述");
  expect(composer).toHaveAttribute("placeholder", "描述想生成的画面…");
  expect(voiceScope.getScope().canRecord).toBe(false);
  expect(realtimeScope.getScope().canStart).toBe(false);
  expect(screen.getByRole("button", { name: "开始连续语音" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "按住说话，松开发送，移出取消" }),
  ).toBeDisabled();
  expect(requests()).toHaveLength(0);
  fireEvent.change(picker, { target: { value: textIDs[0] } });
  await waitFor(() =>
    expect(
      screen.queryByRole("combobox", { name: "图片比例" }),
    ).not.toBeInTheDocument(),
  );
  expect(requests()).toHaveLength(0);
});

test("explicit generation sends image options and renders only its authenticated private raster result", async () => {
  const base = handler;
  handler = async (path, init) => {
    if (!path.endsWith("/messages")) return base(path, init);
    detail.messages = [userMessage, assistantMessage];
    return stream([
      {
        type: "start",
        userMessage,
        assistantMessage: {
          ...assistantMessage,
          generatedImages: [],
          status: "streaming",
        },
      },
      { type: "done", message: assistantMessage, usage: unknownUsage },
    ]);
  };
  await open();
  await chooseImage();
  fireEvent.change(screen.getByRole("combobox", { name: "图片比例" }), {
    target: { value: "1024x1536" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "图片质量" }), {
    target: { value: "low" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
    target: { value: userMessage.content },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "生成图片", exact: true }),
  );
  const result = await screen.findByRole("img", { name: image.name });
  expect(payload()).toMatchObject({
    model: imageIDs[0],
    content: userMessage.content,
    imageOptions: { size: "1024x1536", quality: "low" },
  });
  expect(result).toHaveAttribute("src", "blob:private-generated");
  expect(screen.getByRole("list", { name: "生成的图片" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "下载图片" })).toBeInTheDocument();
  expect(
    screen.getByText(`请求模型 ${imageIDs[0]}（未报告实际模型）`),
  ).toBeInTheDocument();
  const privateFetch = fetchMock.mock.calls.find(([path]) =>
    String(path).includes("generated-images"),
  );
  expect(privateFetch?.[0]).toBe(`/api/family/generated-images/${image.id}`);
  expect(privateFetch?.[1]).toMatchObject({
    credentials: "include",
    cache: "no-store",
  });
  expect(requests()).toHaveLength(1);
});

test("text sends never inherit hidden image options", async () => {
  await open();
  await chooseImage();
  fireEvent.change(screen.getByRole("combobox", { name: "图片质量" }), {
    target: { value: "high" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "选择模型" }), {
    target: { value: textIDs[0] },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "发送 ↑" })).toBeInTheDocument(),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
    target: { value: "普通文字" },
  });
  fireEvent.click(screen.getByRole("button", { name: "发送 ↑" }));
  await screen.findByText("合成验收，不调用真实模型");
  expect(payload()).toMatchObject({ model: textIDs[0], content: "普通文字" });
  expect(payload()).not.toHaveProperty("imageOptions");
});

test.each(["edit", "retry", "regenerate"] as const)(
  "%s uses the selected image options on the explicit turn action",
  async (mode) => {
    detail.chat.model = imageIDs[0];
    detail.messages = [
      userMessage,
      {
        ...assistantMessage,
        generatedImages: [],
        status: mode === "retry" ? "error" : "complete",
      },
    ];
    await open();
    fireEvent.change(screen.getByRole("combobox", { name: "图片比例" }), {
      target: { value: "1536x1024" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "图片质量" }), {
      target: { value: "high" },
    });
    if (mode === "edit") {
      fireEvent.click(screen.getByRole("button", { name: "编辑上一条提问" }));
      fireEvent.change(screen.getByRole("textbox", { name: "发送消息" }), {
        target: { value: "改成雪山" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "保存并重新生成图片" }),
      );
    } else
      fireEvent.click(
        screen.getByRole("button", {
          name: mode === "retry" ? "重试回复" : "重新生成",
        }),
      );
    await screen.findByText("合成验收，不调用真实模型");
    expect(payload()).toMatchObject({
      model: imageIDs[0],
      mode,
      sourceMessageId: mode === "edit" ? userMessage.id : assistantMessage.id,
      imageOptions: { size: "1536x1024", quality: "high" },
    });
    expect(requests()).toHaveLength(1);
  },
);

test("routine identity probes preserve editor/file DOM, draft image options and chosen files; image mode refuses attachments without losing them", async () => {
  await open();
  const composer = screen.getByRole("textbox", { name: "发送消息" });
  const fileInput = screen.getByLabelText("选择附件文件");
  fireEvent.change(composer, { target: { value: "保留这个草稿" } });
  fireEvent.change(fileInput, {
    target: {
      files: [new File(["private"], "private.txt", { type: "text/plain" })],
    },
  });
  await screen.findByRole("button", { name: "移除附件 private.txt" });
  await chooseImage();
  fireEvent.change(screen.getByRole("combobox", { name: "图片比例" }), {
    target: { value: "1536x1024" },
  });
  expect(
    screen.getByText("图片生成暂不支持附件，请先移除附件。"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "生成图片", exact: true }),
  ).toBeDisabled();
  fireEvent.submit(composer.closest("form")!);
  const pending = deferred<Response>();
  const base = handler;
  handler = (path, init) =>
    path === "/api/family/me" ? pending.promise : base(path, init);
  fireEvent.focus(window);
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(([path]) => path === "/api/family/me"),
    ).toHaveLength(2),
  );
  expect(screen.getByRole("textbox", { name: "发送消息" })).toBe(composer);
  expect(screen.getByLabelText("选择附件文件")).toBe(fileInput);
  await act(async () =>
    pending.resolve(
      json({ user: identity, sessionExpiresAt: "2026-12-01T00:00:00.000Z" }),
    ),
  );
  expect(composer).toHaveValue("保留这个草稿");
  expect(screen.getByRole("combobox", { name: "图片比例" })).toHaveValue(
    "1536x1024",
  );
  expect(
    screen.getByRole("button", { name: "移除附件 private.txt" }),
  ).toBeInTheDocument();
  expect(requests()).toHaveLength(0);
});

test("opening and explicit refresh restore saved image settings; a new chat resets them", async () => {
  detail.chat.model = imageIDs[0];
  detail.messages = [
    userMessage,
    {
      ...assistantMessage,
      generatedImages: [],
      imageOptions: { size: "1024x1536", quality: "low" },
    },
  ];
  await open();
  expect(screen.getByRole("combobox", { name: "图片比例" })).toHaveValue(
    "1024x1536",
  );
  expect(screen.getByRole("combobox", { name: "图片质量" })).toHaveValue("low");
  fireEvent.change(screen.getByRole("combobox", { name: "图片比例" }), {
    target: { value: "1536x1024" },
  });
  fireEvent.click(screen.getByLabelText("对话操作"));
  fireEvent.click(screen.getByRole("button", { name: "刷新", exact: true }));
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "图片比例" })).toHaveValue(
      "1024x1536",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: /新聊天/ }));
  fireEvent.change(screen.getByRole("combobox", { name: "选择模型" }), {
    target: { value: imageIDs[0] },
  });
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "图片比例" })).toHaveValue(
      "1024x1024",
    ),
  );
  expect(screen.getByRole("combobox", { name: "图片质量" })).toHaveValue(
    "medium",
  );
  expect(requests()).toHaveLength(0);
});

test("an image body arriving after account replacement cannot create or display a private Blob URL", async () => {
  detail.chat.model = imageIDs[0];
  detail.messages = [userMessage, assistantMessage];
  const body = deferred<Blob>();
  const base = handler;
  handler = (path, init) =>
    path.includes("/generated-images/")
      ? Promise.resolve({
          ok: true,
          status: 200,
          blob: () => body.promise,
        } as Response)
      : base(path, init);
  await open();
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([path]) =>
        String(path).includes("/generated-images/"),
      ),
    ).toBe(true),
  );
  identity = { ...member, id: "synthetic-new-owner" };
  detail.messages = [];
  fireEvent(
    window,
    new StorageEvent("storage", {
      key: FAMILY_SESSION_EVENT,
      newValue: JSON.stringify({
        kind: "login",
        id: "synthetic-account-switch",
      }),
    }),
  );
  await act(async () =>
    body.resolve(new Blob(["private"], { type: "image/jpeg" })),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("list", { name: "生成的图片" }),
    ).not.toBeInTheDocument(),
  );
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(requests()).toHaveLength(0);
});

test("export includes safe generation metadata without embedding files, provider URLs or raw HTML", async () => {
  detail.chat.model = imageIDs[0];
  detail.messages = [
    userMessage,
    {
      ...assistantMessage,
      content:
        "<script>window.imageLeak=true</script>\n![remote](https://untrusted.invalid/a.jpg)",
    },
  ];
  const { container } = await open();
  await screen.findByRole("img", { name: image.name });
  expect(
    container.querySelector("script,iframe,img[src^='https:']"),
  ).toBeNull();
  fireEvent.click(screen.getByLabelText("对话操作"));
  fireEvent.click(screen.getByRole("button", { name: "导出 Markdown" }));
  await screen.findByText("已导出当前聊天。下载的文件由你自行保管。");
  const exported = (URL.createObjectURL as jest.Mock).mock.calls.at(
    -1,
  )?.[0] as Blob;
  const text = new TextDecoder().decode(await read(exported));
  expect(text).toContain("图片生成设置：1024x1024 / medium");
  expect(text).toContain("生成的图片（文件内容未打包）：");
  expect(text).toContain("合成图片.jpg · 1024 × 1024 · image/jpeg");
  expect(text).not.toContain("data:image");
  expect(text).not.toContain("base64");
  expect(
    fetchMock.mock.calls.every(([path]) => String(path).startsWith("/api/")),
  ).toBe(true);
});
