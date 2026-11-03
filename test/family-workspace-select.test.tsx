/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import { useState, type CSSProperties } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  WorkspaceSelect,
  type WorkspaceSelectOption,
  type WorkspaceSelectProps,
} from "../app/family/workspace-select";
import { FAMILY_THEMES } from "../app/family/themes";

const options: readonly WorkspaceSelectOption[] = [
  { value: "a", label: "Alpha", description: "日常聊天", group: "文字聊天" },
  {
    value: "b",
    label: "Beta",
    description: "暂不可用",
    group: "文字聊天",
    disabled: true,
  },
  { value: "c", label: "Cedar", description: "复杂分析", group: "文字聊天" },
  { value: "d", label: "Draw", description: "生成图片", group: "图片生成" },
  { value: "e", label: "Alpine", description: "轻量问答", group: "文字聊天" },
];
const changed = jest.fn<(value: string) => void>();
const outsideClick = jest.fn();
const rectangle = (
  left = 120,
  top = 200,
  width = 180,
  height = 44,
): DOMRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON: () => ({}),
});
function Fixture({
  palette,
  ...props
}: Partial<WorkspaceSelectProps> & { palette?: CSSProperties } = {}) {
  const [value, setValue] = useState(props.value ?? "a");
  return (
    <div
      role="dialog"
      aria-label="设置"
      style={palette ?? (FAMILY_THEMES[0].variables as CSSProperties)}
    >
      <textarea aria-label="草稿" defaultValue="未发送的文字" />
      <input type="file" aria-label="附件" />
      <WorkspaceSelect
        label="选择模型"
        value={value}
        options={options}
        width={360}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
        {...props}
      />
      <button onClick={outsideClick}>外部按钮</button>
    </div>
  );
}
const descriptors = [
  [window, "innerWidth"],
  [window, "innerHeight"],
  [window, "visualViewport"],
].map(([target, key]) => ({
  target: target as object,
  key: key as string,
  descriptor: Object.getOwnPropertyDescriptor(target, key as string),
}));
function property(key: string, value: unknown) {
  Object.defineProperty(window, key, { configurable: true, value });
}
beforeEach(() => {
  changed.mockClear();
  outsideClick.mockClear();
  property("innerWidth", 1000);
  property("innerHeight", 800);
  property("visualViewport", undefined);
  jest
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue(rectangle());
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  descriptors.forEach(({ target, key, descriptor }) =>
    descriptor
      ? Object.defineProperty(target, key, descriptor)
      : Reflect.deleteProperty(target, key),
  );
});
function trigger() {
  return screen.getByRole("combobox", { name: "选择模型" });
}
function open() {
  const button = trigger();
  act(() => button.focus());
  fireEvent.click(button);
  return button;
}
function active() {
  return document.getElementById(
    trigger().getAttribute("aria-activedescendant")!,
  );
}

test("compact trigger is name-only; grouped popup descriptions are accessible and stay inside the themed dialog", () => {
  render(<Fixture />);
  const button = trigger();
  expect(button).toHaveTextContent("Alpha");
  expect(button).not.toHaveTextContent("日常聊天");
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(button).toHaveAttribute("value", "a");
  open();
  const listbox = screen.getByRole("listbox", { name: "选择模型" });
  expect(button.getAttribute("aria-controls")).toBe(listbox.id);
  expect(listbox.closest('[role="dialog"]')).toBe(screen.getByRole("dialog"));
  expect(screen.getAllByRole("group", { name: "文字聊天" })).toHaveLength(2);
  expect(screen.getByRole("group", { name: "图片生成" })).toBeInTheDocument();
  const selected = screen.getByRole("option", { name: "Alpha", exact: true });
  expect(selected).toHaveAttribute("aria-selected", "true");
  expect(selected).toHaveAccessibleDescription("日常聊天");
  expect(active()).toBe(selected);
  expect(
    listbox.querySelectorAll('button,a,input,select,[tabindex="0"]'),
  ).toHaveLength(0);
  expect(button).toHaveFocus();
  expect(changed).not.toHaveBeenCalled();
});

test("pointer selection commits once, keeps trigger focus and never remounts editor/file inputs", () => {
  render(<Fixture />);
  const editor = screen.getByRole("textbox", { name: "草稿" });
  const file = screen.getByLabelText("附件");
  const button = open();
  const option = screen.getByRole("option", { name: "Cedar" });
  fireEvent.pointerMove(option, { pointerType: "mouse" });
  expect(active()).toBe(option);
  const mouse = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
  });
  fireEvent(option, mouse);
  expect(mouse.defaultPrevented).toBe(true);
  fireEvent.click(within(option).getByText("复杂分析"));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledWith("c");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(trigger()).toBe(button);
  expect(button).toHaveFocus();
  expect(button).toHaveTextContent("Cedar");
  expect(screen.getByRole("textbox", { name: "草稿" })).toBe(editor);
  expect(editor).toHaveValue("未发送的文字");
  expect(screen.getByLabelText("附件")).toBe(file);
  open();
  fireEvent.click(screen.getByRole("option", { name: "Cedar" }));
  expect(changed).toHaveBeenCalledTimes(1);
});

test("keyboard previews skip disabled options, wrap, support Home/End and commit only on Enter/Space", () => {
  render(<Fixture />);
  const button = trigger();
  act(() => button.focus());
  fireEvent.keyDown(button, { key: "ArrowDown" });
  expect(active()).toHaveAccessibleName("Alpha");
  fireEvent.keyDown(button, { key: "ArrowDown" });
  expect(active()).toHaveAccessibleName("Cedar");
  fireEvent.keyDown(button, { key: "End" });
  expect(active()).toHaveAccessibleName("Alpine");
  fireEvent.keyDown(button, { key: "ArrowDown" });
  expect(active()).toHaveAccessibleName("Alpha");
  fireEvent.keyDown(button, { key: "ArrowUp" });
  expect(active()).toHaveAccessibleName("Alpine");
  fireEvent.keyDown(button, { key: "Home" });
  expect(active()).toHaveAccessibleName("Alpha");
  expect(changed).not.toHaveBeenCalled();
  fireEvent.keyDown(button, { key: "End" });
  fireEvent.keyDown(button, { key: "Enter" });
  expect(changed).toHaveBeenCalledWith("e");
  expect(button).toHaveTextContent("Alpine");
  fireEvent.keyDown(button, { key: " " });
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  fireEvent.keyDown(button, { key: "Home" });
  fireEvent.keyDown(button, { key: " " });
  expect(changed).toHaveBeenLastCalledWith("a");
  expect(button).toHaveFocus();
});

test("Escape dismisses the popup before a dialog; Tab closes without trapping focus or selecting", () => {
  render(<Fixture />);
  const button = open();
  const observer = jest.fn();
  window.addEventListener("keydown", observer);
  try {
    fireEvent.keyDown(button, { key: "ArrowDown" });
    fireEvent.keyDown(button, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(observer).toHaveBeenCalledTimes(1); // ArrowDown only.
    expect(button).toHaveFocus();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(observer).toHaveBeenCalledTimes(2);
    open();
    const tab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(button, tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("keydown", observer);
  }
});

test("typeahead finds labels without committing, cycles repeated letters and ignores composition/shortcuts", () => {
  render(<Fixture />);
  const button = trigger();
  act(() => button.focus());
  fireEvent.keyDown(button, { key: "c", isComposing: true });
  fireEvent.keyDown(button, { key: "c", ctrlKey: true });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  fireEvent.keyDown(button, { key: "a" });
  expect(active()).toHaveAccessibleName("Alpine");
  fireEvent.keyDown(button, { key: "a" });
  expect(active()).toHaveAccessibleName("Alpha");
  fireEvent.keyDown(button, { key: "Escape" });
  fireEvent.keyDown(button, { key: "c" });
  fireEvent.keyDown(button, { key: "e" });
  expect(active()).toHaveAccessibleName("Cedar");
  expect(changed).not.toHaveBeenCalled();
  fireEvent.keyDown(button, { key: "Enter" });
  expect(changed).toHaveBeenCalledWith("c");
});

test.each(["mouse", "touch"])(
  "outside %s pointer dismisses without blocking the outside action or reclaiming focus",
  (pointerType) => {
    render(<Fixture />);
    open();
    const outside = screen.getByRole("button", { name: "外部按钮" });
    const event = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    fireEvent(outside, event);
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    act(() => outside.focus());
    fireEvent.click(outside);
    expect(outsideClick).toHaveBeenCalledTimes(1);
    expect(outside).toHaveFocus();
    expect(changed).not.toHaveBeenCalled();
  },
);

test("moving focus outside dismisses, internal touch scrolling stays open, external scroll and resize dismiss", () => {
  render(<Fixture />);
  open();
  const list = screen.getByRole("listbox");
  const touch = new Event("pointerdown", { bubbles: true, cancelable: true });
  Object.defineProperty(touch, "pointerType", { value: "touch" });
  fireEvent(list, touch);
  expect(touch.defaultPrevented).toBe(false);
  fireEvent.scroll(list);
  expect(screen.getByRole("listbox")).toBe(list);
  act(() => screen.getByRole("textbox", { name: "草稿" }).focus());
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "草稿" })).toHaveFocus();
  open();
  fireEvent.scroll(document);
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  open();
  fireEvent(window, new Event("resize"));
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(changed).not.toHaveBeenCalled();
});

test("disabled controls/options and dynamically disabled menus never commit", () => {
  const view = render(<Fixture />);
  open();
  fireEvent.click(screen.getByRole("option", { name: "Beta" }));
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByRole("listbox")).toBeInTheDocument();
  view.rerender(<Fixture disabled />);
  expect(trigger()).toBeDisabled();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  fireEvent.click(trigger());
  fireEvent.keyDown(trigger(), { key: "Enter" });
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  view.rerender(<Fixture options={[]} />);
  expect(trigger()).toBeDisabled();
  expect(changed).not.toHaveBeenCalled();
});

test("popup clamps narrow viewports and uses the space above when the trigger is near the bottom", () => {
  property("innerWidth", 300);
  property("innerHeight", 700);
  jest
    .mocked(HTMLElement.prototype.getBoundingClientRect)
    .mockReturnValue(rectangle(250, 620, 120));
  render(<Fixture />);
  open();
  const list = screen.getByRole("listbox");
  expect(list).toHaveStyle({
    left: "12px",
    top: "614px",
    width: "276px",
    maxHeight: "360px",
  });
  expect(changed).not.toHaveBeenCalled();
});

test("visual viewport offsets constrain placement and its resize/scroll events dismiss", () => {
  const viewport = Object.assign(new EventTarget(), {
    width: 320,
    height: 300,
    offsetLeft: 40,
    offsetTop: 100,
  });
  property("visualViewport", viewport);
  jest
    .mocked(HTMLElement.prototype.getBoundingClientRect)
    .mockReturnValue(rectangle(300, 330, 120));
  render(<Fixture />);
  open();
  expect(screen.getByRole("listbox")).toHaveStyle({
    left: "52px",
    top: "324px",
    width: "296px",
    maxHeight: "212px",
  });
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  open();
  act(() => viewport.dispatchEvent(new Event("scroll")));
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

test("field variant keeps a placeholder for unknown values and sizes its popup to the trigger", () => {
  render(
    <Fixture
      variant="field"
      width={undefined}
      value="unknown"
      placeholder="选择一个模型"
    />,
  );
  expect(trigger()).toHaveTextContent("选择一个模型");
  open();
  expect(screen.getByRole("listbox")).toHaveStyle({ width: "180px" });
  expect(active()).toHaveAccessibleName("Alpha");
  expect(changed).not.toHaveBeenCalled();
});

test("all twelve palettes remain on an ancestor of the inline popup without adding body portals", () => {
  const theme = FAMILY_THEMES[0];
  const view = render(<Fixture palette={theme.variables as CSSProperties} />);
  open();
  const list = screen.getByRole("listbox");
  for (const palette of FAMILY_THEMES) {
    view.rerender(<Fixture palette={palette.variables as CSSProperties} />);
    expect(screen.getByRole("listbox")).toBe(list);
    expect(list.closest('[role="dialog"]')).toBeInTheDocument();
    expect(view.container.contains(list)).toBe(true);
    expect(view.container.firstElementChild).toHaveStyle({
      "--paper": palette.variables["--paper"],
    });
  }
  expect(FAMILY_THEMES).toHaveLength(12);
  expect(changed).not.toHaveBeenCalled();
});

test("unmount cleans global listeners and options render hostile text as text without fetching", () => {
  const add = jest.spyOn(document, "addEventListener");
  const remove = jest.spyOn(document, "removeEventListener");
  const view = render(
    <Fixture
      options={[
        {
          value: "a",
          label: "Alpha",
          description:
            '<img src="https://untrusted.invalid/" onerror="leak()">',
        },
      ]}
    />,
  );
  open();
  expect(screen.getByText(/<img src=/)).toBeInTheDocument();
  expect(view.container.querySelector("img,iframe,script")).toBeNull();
  const installed = add.mock.calls.filter(([name]) =>
    ["pointerdown", "focusin", "scroll"].includes(name),
  );
  expect(installed).toHaveLength(3);
  view.unmount();
  for (const [name, listener, options] of installed)
    expect(remove).toHaveBeenCalledWith(name, listener, options);
  fireEvent.pointerDown(document.body);
  fireEvent.scroll(document);
  expect(changed).not.toHaveBeenCalled();
});
