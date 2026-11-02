/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { FamilyMarkdown } from "../app/family/message-markdown";

const source = "```javascript\nconsole.log('hello');\n```";
const writeText = jest.fn<(...args: any[]) => Promise<void>>();
beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test("raw HTML/remote media remain inert and only web links become anchors", () => {
  const { container } = render(
    <FamilyMarkdown
      content={
        '<script>alert(1)</script>\n<img src="https://remote.test.invalid/pixel">\n\n![pixel](https://remote.test.invalid/tracker)\n\n[web](https://example.com) [mail](mailto:secret@example.com) [relative](/account) [bad](javascript:alert(1))'
      }
    />,
  );
  expect(
    container.querySelectorAll("img,script,iframe,video,audio,form,input"),
  ).toHaveLength(0);
  expect(container.querySelectorAll("a")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "web" })).toHaveAttribute(
    "rel",
    "noopener noreferrer nofollow",
  );
  expect(global.fetch).not.toHaveBeenCalled();
});

test("code actions copy exact plain text and wrap code without interpreting it", async () => {
  const { container } = render(<FamilyMarkdown content={source} />);
  expect(
    screen.getByRole("region", { name: "javascript代码块" }),
  ).toBeInTheDocument();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "复制代码" })),
  );
  expect(writeText).toHaveBeenCalledWith("console.log('hello');");
  expect(screen.getByRole("status")).toHaveTextContent("已复制");
  fireEvent.click(screen.getByRole("button", { name: "代码自动换行" }));
  expect(screen.getByRole("button", { name: "代码自动换行" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(container.querySelector("pre pre")).toBeNull();
  expect(container.querySelector("pre code")).toHaveTextContent(
    "console.log('hello');",
  );
});

test("inline code has no action toolbar and tables/task lists render safely", () => {
  const { container } = render(
    <FamilyMarkdown
      content={
        "Use `inline()`\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n- [x] checked"
      }
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(container.querySelector("code")).toHaveTextContent("inline()");
  expect(container.querySelector("table")).toBeInTheDocument();
  expect(container.querySelector("input")).toBeNull();
});

test.each([{ streaming: true }, { actionsDisabled: true }])(
  "privacy/streaming lock prevents code copy and download: %p",
  async (props) => {
    render(<FamilyMarkdown content={source} {...props} />);
    expect(screen.getByRole("button", { name: "复制代码" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下载代码" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
    expect(writeText).not.toHaveBeenCalled();
  },
);

test("latest owner guard blocks copy/download before a lock render commits", () => {
  let readable = true;
  render(<FamilyMarkdown content={source} canAct={() => readable} />);
  readable = false;
  fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
  fireEvent.click(screen.getByRole("button", { name: "下载代码" }));
  expect(writeText).not.toHaveBeenCalled();
  expect(screen.queryByRole("status")).toBeNull();
});

test("explicit download uses a text blob and safe extension; unmount releases pending URL", () => {
  jest.useFakeTimers();
  const create = jest.fn<(blob: Blob) => string>(() => "blob:synthetic-code");
  const revoke = jest.fn();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: create,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revoke,
  });
  const click = jest
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("code.js");
      expect(this.href).toBe("blob:synthetic-code");
    });
  const page = render(<FamilyMarkdown content={source} />);
  fireEvent.click(screen.getByRole("button", { name: "下载代码" }));
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][0]).toBeInstanceOf(Blob);
  expect((create.mock.calls[0][0] as Blob).type).toBe(
    "text/plain;charset=utf-8",
  );
  expect(click).toHaveBeenCalledTimes(1);
  expect(document.querySelector("a[download]")).toBeNull();
  page.unmount();
  expect(revoke).toHaveBeenCalledWith("blob:synthetic-code");
  expect(jest.getTimerCount()).toBe(0);
});

test("late clipboard completion after scope unmount produces no timer or stale UI", async () => {
  jest.useFakeTimers();
  let resolve!: () => void;
  writeText.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const view = render(<FamilyMarkdown content={source} />);
  fireEvent.click(screen.getByRole("button", { name: "复制代码" }));
  view.unmount();
  await act(async () => resolve());
  // React's async act queues a zero-delay task; a stale copy announcement
  // would instead leave our 2400ms timer outstanding after this flush.
  act(() => jest.advanceTimersByTime(0));
  expect(jest.getTimerCount()).toBe(0);
});

test("clipboard failure is visible and content/lock changes suppress stale copy feedback", async () => {
  writeText.mockRejectedValueOnce(new Error("permission denied"));
  const view = render(<FamilyMarkdown content={source} />);
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "复制代码" })),
  );
  expect(screen.getByRole("status")).toHaveTextContent("复制失败");
  view.rerender(<FamilyMarkdown content={source} actionsDisabled />);
  expect(screen.queryByRole("status")).toBeNull();
});
