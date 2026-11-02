/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  MessageAttachments,
  type AttachmentScope,
} from "../app/family/attachments";
import { ImageGenerationControls } from "../app/family/image-controls";
import type { FamilyAttachmentMeta } from "../app/family/types";

const image: FamilyAttachmentMeta = {
  id: "synthetic-generated-image",
  name: "生成图片.jpg",
  kind: "image",
  mediaType: "image/jpeg",
  byteSize: 12,
  width: 1024,
  height: 1024,
};
const originalFetch = global.fetch;
const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
const createURL = jest.fn<(blob: Blob) => string>();
const revokeURL = jest.fn<(url: string) => void>();
const fetchMock = jest.fn<typeof fetch>();
const unauthorized = jest.fn();
const okay = () =>
  new Blob(["synthetic-raster-test-fixture"], { type: "image/jpeg" });
const response = (blob = okay(), status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    blob: async () => blob,
  }) as Response;
const scope = (key = "epoch-a:owner-a", current = true): AttachmentScope => ({
  key,
  readable: current,
  isCurrent: () => current,
});
const restore = (key: string, descriptor: PropertyDescriptor | undefined) =>
  descriptor
    ? Object.defineProperty(URL, key, descriptor)
    : Reflect.deleteProperty(URL, key);

beforeEach(() => {
  let count = 0;
  createURL
    .mockReset()
    .mockImplementation(() => `blob:private-image-${++count}`);
  revokeURL.mockReset();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeURL,
  });
  global.fetch = fetchMock;
  fetchMock.mockReset().mockImplementation(async () => response());
  unauthorized.mockClear();
});
afterEach(() => {
  global.fetch = originalFetch;
  restore("createObjectURL", originalCreate);
  restore("revokeObjectURL", originalRevoke);
  jest.restoreAllMocks();
});

test.each([false, true])(
  "generated image loads only its private owner/admin path (%s)",
  async (admin) => {
    render(
      <MessageAttachments
        attachments={[image]}
        source="generated"
        admin={admin}
        scope={scope()}
        onUnauthorized={unauthorized}
      />,
    );
    expect(
      screen.getByRole("list", { name: "生成的图片" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("img", { name: image.name }),
    ).toHaveAttribute("src", "blob:private-image-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/family/${admin ? "admin/" : ""}generated-images/${image.id}`,
    );
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      credentials: "include",
      cache: "no-store",
    });
    expect(screen.getByText(/1024 × 1024/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载图片" })).toBeEnabled();
    const expand = screen.getByRole("button", {
      name: `放大图片 ${image.name}`,
    });
    fireEvent.click(expand);
    expect(
      screen.getByRole("button", { name: `收起图片 ${image.name}` }),
    ).toBeInTheDocument();
  },
);

test("default attachment source preserves the original private route and limit", async () => {
  fetchMock.mockResolvedValue(
    response(new Blob([new Uint8Array(1_000_001)], { type: "image/jpeg" })),
  );
  render(
    <MessageAttachments
      attachments={[image]}
      scope={scope()}
      onUnauthorized={unauthorized}
    />,
  );
  expect(screen.getByRole("list", { name: "消息附件" })).toBeInTheDocument();
  expect(await screen.findByText("附件数据超出限制。")).toBeInTheDocument();
  expect(fetchMock.mock.calls[0][0]).toBe(
    `/api/family/attachments/${image.id}`,
  );
  expect(createURL).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "下载附件" })).toBeInTheDocument();
});

test("generated images accept more than the upload limit, but reject above 4 MiB", async () => {
  fetchMock
    .mockResolvedValueOnce(
      response(
        new Blob([new Uint8Array(2 * 1024 * 1024)], { type: "image/jpeg" }),
      ),
    )
    .mockResolvedValueOnce(
      response(
        new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: "image/jpeg" }),
      ),
    );
  const { rerender } = render(
    <MessageAttachments
      attachments={[image]}
      source="generated"
      scope={scope()}
      onUnauthorized={unauthorized}
    />,
  );
  expect(
    await screen.findByRole("img", { name: image.name }),
  ).toBeInTheDocument();
  rerender(
    <MessageAttachments
      attachments={[{ ...image, id: "oversize" }]}
      source="generated"
      scope={scope()}
      onUnauthorized={unauthorized}
    />,
  );
  expect(await screen.findByText("图片数据超出限制。")).toBeInTheDocument();
  expect(createURL).toHaveBeenCalledTimes(1);
});

test("source change cannot reuse a same-ID generated preview for an uploaded attachment", async () => {
  const { rerender } = render(
    <MessageAttachments
      attachments={[image]}
      source="generated"
      scope={scope()}
      onUnauthorized={unauthorized}
    />,
  );
  await screen.findByRole("img", { name: image.name });
  rerender(
    <MessageAttachments
      attachments={[image]}
      scope={scope()}
      onUnauthorized={unauthorized}
    />,
  );
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    `/api/family/generated-images/${image.id}`,
    `/api/family/attachments/${image.id}`,
  ]);
  expect(revokeURL).toHaveBeenCalledWith("blob:private-image-1");
});

test("an old account's delayed image body cannot appear after switching owner", async () => {
  let resolveOld!: (blob: Blob) => void;
  const oldBody = new Promise<Blob>((resolve) => {
    resolveOld = resolve;
  });
  const readOld = jest.fn(async () => oldBody);
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      blob: readOld,
    } as unknown as Response)
    .mockResolvedValueOnce(response());
  const { rerender } = render(
    <MessageAttachments
      attachments={[image]}
      source="generated"
      scope={scope()}
      onUnauthorized={unauthorized}
    />,
  );
  await waitFor(() => expect(readOld).toHaveBeenCalledTimes(1));
  const oldSignal = fetchMock.mock.calls[0][1]?.signal;
  rerender(
    <MessageAttachments
      attachments={[{ ...image, name: "当前账户图片.jpg" }]}
      source="generated"
      scope={scope("epoch-b:owner-b")}
      onUnauthorized={unauthorized}
    />,
  );
  expect(oldSignal?.aborted).toBe(true);
  await screen.findByRole("img", { name: "当前账户图片.jpg" });
  await act(async () => {
    resolveOld(okay());
    await oldBody;
  });
  expect(
    screen.queryByRole("img", { name: image.name }),
  ).not.toBeInTheDocument();
  expect(createURL).toHaveBeenCalledTimes(1);
});

test("unmount aborts pending image loads and releases already created private URLs", async () => {
  const { unmount } = render(
    <MessageAttachments
      attachments={[image]}
      source="generated"
      scope={scope()}
      onUnauthorized={unauthorized}
    />,
  );
  await screen.findByRole("img", { name: image.name });
  const signal = fetchMock.mock.calls[0][1]?.signal;
  unmount();
  expect(signal?.aborted).toBe(true);
  expect(revokeURL).toHaveBeenCalledWith("blob:private-image-1");
});

test("passive identity checks retain loaded preview but block reads/downloads until verified", async () => {
  let verified = true;
  const identity: AttachmentScope = {
    key: "epoch-a:owner-a",
    readable: true,
    isCurrent: () => verified,
  };
  const { rerender } = render(
    <MessageAttachments
      attachments={[image]}
      source="generated"
      scope={identity}
      onUnauthorized={unauthorized}
    />,
  );
  const preview = await screen.findByRole("img", { name: image.name });
  verified = false;
  rerender(
    <MessageAttachments
      attachments={[image]}
      source="generated"
      scope={{ ...identity, readable: false }}
      onUnauthorized={unauthorized}
    />,
  );
  expect(screen.getByRole("img", { name: image.name })).toBe(preview);
  expect(screen.getByRole("button", { name: "下载图片" })).toBeDisabled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(revokeURL).not.toHaveBeenCalled();
});

test("live identity guard prevents a fetch even if readable prop has not updated", async () => {
  render(
    <MessageAttachments
      attachments={[image]}
      source="generated"
      scope={{ key: "old-owner", readable: true, isCurrent: () => false }}
      onUnauthorized={unauthorized}
    />,
  );
  await act(async () => {});
  expect(fetchMock).not.toHaveBeenCalled();
  expect(createURL).not.toHaveBeenCalled();
});

test.each([401, 403])(
  "private generated image %s triggers auth revalidation without a blob",
  async (status) => {
    fetchMock.mockResolvedValue(response(okay(), status));
    render(
      <MessageAttachments
        attachments={[image]}
        source="generated"
        scope={scope()}
        onUnauthorized={unauthorized}
      />,
    );
    expect(
      await screen.findByText("图片暂不可用，请稍后重试。"),
    ).toBeInTheDocument();
    expect(unauthorized).toHaveBeenCalledTimes(1);
    expect(createURL).not.toHaveBeenCalled();
  },
);

test("generated HTML/SVG payload cannot become a preview or download URL", async () => {
  fetchMock.mockResolvedValue(
    response(
      new Blob(["<svg><script>private()</script></svg>"], {
        type: "image/svg+xml",
      }),
    ),
  );
  render(
    <MessageAttachments
      attachments={[image]}
      source="generated"
      scope={scope()}
      onUnauthorized={unauthorized}
    />,
  );
  expect(await screen.findByText("图片格式无法读取。")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下载图片" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(createURL).not.toHaveBeenCalled();
});

test("generated download uses a private Blob URL and a safe filename, then unmount cleans it", async () => {
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.href).toMatch(/^blob:private-image-/);
      expect(this.download).not.toMatch(/[\\/<>]/);
      expect(this.download).toContain("图片");
    });
  const { unmount } = render(
    <MessageAttachments
      attachments={[{ ...image, name: "../图片.jpg" }]}
      source="generated"
      scope={scope()}
      onUnauthorized={unauthorized}
    />,
  );
  await screen.findByRole("img", { name: "../图片.jpg" });
  fireEvent.click(screen.getByRole("button", { name: "下载图片" }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  unmount();
  expect(revokeURL).toHaveBeenCalledWith("blob:private-image-1");
  expect(revokeURL).toHaveBeenCalledWith("blob:private-image-2");
});

test("image option controls preserve the other enum and never generate by themselves", () => {
  const change = jest.fn();
  const { rerender } = render(
    <ImageGenerationControls
      options={{ size: "1024x1024", quality: "medium" }}
      onChange={change}
      disabled={false}
    />,
  );
  expect(screen.getByRole("combobox", { name: "图片比例" })).toHaveValue(
    "1024x1024",
  );
  fireEvent.change(screen.getByRole("combobox", { name: "图片比例" }), {
    target: { value: "1536x1024" },
  });
  expect(change).toHaveBeenLastCalledWith({
    size: "1536x1024",
    quality: "medium",
  });
  rerender(
    <ImageGenerationControls
      options={{ size: "1536x1024", quality: "medium" }}
      onChange={change}
      disabled={false}
    />,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "图片质量" }), {
    target: { value: "high" },
  });
  expect(change).toHaveBeenLastCalledWith({
    size: "1536x1024",
    quality: "high",
  });
  expect(screen.getByText(/每次生成 1 张/)).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("disabled or invalid image selections cannot dispatch setting changes", () => {
  const change = jest.fn();
  const { rerender } = render(
    <ImageGenerationControls
      options={{ size: "1024x1024", quality: "medium" }}
      onChange={change}
      disabled
    />,
  );
  const size = screen.getByRole("combobox", { name: "图片比例" });
  expect(size).toBeDisabled();
  fireEvent.change(size, { target: { value: "1536x1024" } });
  expect(change).not.toHaveBeenCalled();
  rerender(
    <ImageGenerationControls
      options={{ size: "1024x1024", quality: "medium" }}
      onChange={change}
      disabled={false}
    />,
  );
  fireEvent.change(screen.getByRole("combobox", { name: "图片比例" }), {
    target: { value: "untrusted" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "图片质量" }), {
    target: { value: "max" },
  });
  expect(change).not.toHaveBeenCalled();
});
