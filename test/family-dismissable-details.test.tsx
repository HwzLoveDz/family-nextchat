/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useDismissableDetails } from "../app/family/use-dismissable-details";

const action = jest.fn();
const outsideAction = jest.fn();
function Fixture({ show = true }: { show?: boolean }) {
  const menu = useDismissableDetails();
  return (
    <div>
      <textarea aria-label="草稿" defaultValue="保留我的草稿" />
      <input type="file" aria-label="附件" />
      <button onClick={outsideAction}>外部操作</button>
      {show ? (
        <details ref={menu} aria-label="对话菜单">
          <summary aria-label="对话操作">•••</summary>
          <button onClick={action}>
            <span>导出</span>
          </button>
          <button onClick={action}>刷新</button>
          <button disabled onClick={action}>
            暂不可用
          </button>
          <button aria-disabled="true">稍后可用</button>
          <input aria-label="菜单内输入" />
        </details>
      ) : null}
    </div>
  );
}
beforeEach(() => {
  action.mockClear();
  outsideAction.mockClear();
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});
function menu() {
  return screen.getByLabelText("对话菜单") as HTMLDetailsElement;
}
function open() {
  const summary = screen.getByLabelText("对话操作");
  fireEvent.click(summary);
  expect(menu().open).toBe(true);
  return summary;
}

test("native summary toggles exactly once and internal pointer input does not dismiss", () => {
  render(<Fixture />);
  const summary = open();
  fireEvent.pointerDown(screen.getByText("导出"));
  expect(menu().open).toBe(true);
  fireEvent.click(summary);
  expect(menu().open).toBe(false);
  expect(action).not.toHaveBeenCalled();
});

test.each(["mouse", "touch"])(
  "outside %s pointer closes without blocking the outside action or taking its focus",
  (pointerType) => {
    render(<Fixture />);
    const draft = screen.getByRole("textbox", { name: "草稿" });
    const file = screen.getByLabelText("附件");
    open();
    const outside = screen.getByRole("button", { name: "外部操作" });
    const event = new Event("pointerdown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "pointerType", { value: pointerType });
    fireEvent(outside, event);
    expect(menu().open).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    act(() => outside.focus());
    fireEvent.click(outside);
    expect(outsideAction).toHaveBeenCalledTimes(1);
    expect(outside).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "草稿" })).toBe(draft);
    expect(screen.getByLabelText("附件")).toBe(file);
    expect(draft).toHaveValue("保留我的草稿");
  },
);

test("an enabled item runs its existing action once before dismissal, including nested click targets", () => {
  render(<Fixture />);
  open();
  action.mockImplementationOnce(() => expect(menu().open).toBe(true));
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  fireEvent(screen.getByText("导出"), event);
  expect(action).toHaveBeenCalledTimes(1);
  expect(menu().open).toBe(false);
  expect(event.defaultPrevented).toBe(false);
});

test("disabled and aria-disabled items do not count as a selection", () => {
  render(<Fixture />);
  open();
  fireEvent.click(screen.getByRole("button", { name: "暂不可用" }));
  expect(menu().open).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "稍后可用" }));
  expect(menu().open).toBe(true);
  expect(action).not.toHaveBeenCalled();
});

test("Escape from a focused menu item closes and restores summary focus without stopping propagation", () => {
  render(<Fixture />);
  const summary = open();
  const button = screen.getByRole("button", { name: "导出" });
  act(() => button.focus());
  const observer = jest.fn();
  window.addEventListener("keydown", observer);
  try {
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(button, event);
    expect(menu().open).toBe(false);
    expect(summary).toHaveFocus();
    expect(event.defaultPrevented).toBe(true);
    expect(observer).toHaveBeenCalledTimes(1);
    const closed = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(summary, closed);
    expect(closed.defaultPrevented).toBe(false);
  } finally {
    window.removeEventListener("keydown", observer);
  }
});

test("focus may move among menu items; moving outside or leaving the document closes without reclaiming focus", () => {
  render(<Fixture />);
  open();
  const first = screen.getByRole("button", { name: "导出" });
  const second = screen.getByRole("button", { name: "刷新" });
  act(() => first.focus());
  act(() => second.focus());
  expect(menu().open).toBe(true);
  const draft = screen.getByRole("textbox", { name: "草稿" });
  act(() => draft.focus());
  expect(menu().open).toBe(false);
  expect(draft).toHaveFocus();
  open();
  act(() => first.focus());
  fireEvent.focusOut(first, { relatedTarget: null });
  expect(menu().open).toBe(false);
  expect(screen.getByLabelText("对话操作")).not.toHaveFocus();
});

test("Escape respects composition, editable controls and an existing default prevention", () => {
  render(<Fixture />);
  open();
  const button = screen.getByRole("button", { name: "导出" });
  act(() => button.focus());
  fireEvent.keyDown(button, { key: "Escape", isComposing: true });
  expect(menu().open).toBe(true);
  fireEvent.keyDown(button, { key: "Escape", keyCode: 229 });
  expect(menu().open).toBe(true);
  const prevented = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  prevented.preventDefault();
  fireEvent(button, prevented);
  expect(menu().open).toBe(true);
  const input = screen.getByRole("textbox", { name: "菜单内输入" });
  act(() => input.focus());
  const typing = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  fireEvent(input, typing);
  expect(menu().open).toBe(true);
  expect(input).toHaveFocus();
  expect(typing.defaultPrevented).toBe(false);
});

test("a conditionally mounted menu works after the hook's initial effect without remounting the draft or file input", () => {
  const view = render(<Fixture show={false} />);
  const draft = screen.getByRole("textbox", { name: "草稿" });
  const file = screen.getByLabelText("附件");
  view.rerender(<Fixture />);
  open();
  fireEvent.pointerDown(draft);
  expect(menu().open).toBe(false);
  expect(screen.getByRole("textbox", { name: "草稿" })).toBe(draft);
  expect(screen.getByLabelText("附件")).toBe(file);
});

test("unmount removes every installed document listener and detached menu input has no side effects", () => {
  const add = jest.spyOn(document, "addEventListener");
  const remove = jest.spyOn(document, "removeEventListener");
  const view = render(<Fixture />);
  open();
  const detached = menu();
  const installed = add.mock.calls.filter(([type]) =>
    ["pointerdown", "focusin", "focusout", "click", "keydown"].includes(type),
  );
  expect(installed).toHaveLength(5);
  view.unmount();
  for (const [type, listener, options] of installed)
    if (options === undefined)
      expect(remove).toHaveBeenCalledWith(type, listener);
    else expect(remove).toHaveBeenCalledWith(type, listener, options);
  detached.open = true;
  fireEvent.pointerDown(document.body);
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(detached.open).toBe(true);
  expect(action).not.toHaveBeenCalled();
});
