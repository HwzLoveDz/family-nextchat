/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { jest } from "@jest/globals";
import { useFamilyViewport } from "@/app/family/use-family-viewport";

class FixtureViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  scale = 1;
}

describe("family viewport lifecycle", () => {
  const viewportDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "visualViewport",
  );
  const heightDescriptor = Object.getOwnPropertyDescriptor(
    window,
    "innerHeight",
  );
  let viewport: FixtureViewport;
  let frames: Map<number, FrameRequestCallback>;
  let frameId: number;
  let cancelFrame: unknown;
  const root = document.documentElement;
  const flush = () =>
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    });
  beforeEach(() => {
    viewport = new FixtureViewport();
    frames = new Map();
    frameId = 0;
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });
    jest
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.set(++frameId, callback);
        return frameId;
      });
    cancelFrame = jest
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => {
        frames.delete(id);
      });
    root.style.removeProperty("--family-viewport-height");
    root.style.removeProperty("--family-viewport-top");
    root.removeAttribute("data-family-keyboard");
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (viewportDescriptor)
      Object.defineProperty(window, "visualViewport", viewportDescriptor);
    else Reflect.deleteProperty(window, "visualViewport");
    if (heightDescriptor)
      Object.defineProperty(window, "innerHeight", heightDescriptor);
    root.style.removeProperty("--family-viewport-height");
    root.style.removeProperty("--family-viewport-top");
    root.removeAttribute("data-family-keyboard");
    document
      .querySelectorAll("[data-viewport-fixture]")
      .forEach((element) => element.remove());
  });

  test("a focused text field follows keyboard height and viewport panning, batching events", () => {
    const { unmount } = renderHook(() => useFamilyViewport());
    expect(root.style.getPropertyValue("--family-viewport-height")).toBe(
      "800px",
    );
    const textarea = document.createElement("textarea");
    textarea.dataset.viewportFixture = "1";
    document.body.append(textarea);
    textarea.focus();
    viewport.height = 380;
    viewport.offsetTop = 80;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    expect(frames.size).toBe(1);
    flush();
    expect(root.style.getPropertyValue("--family-viewport-height")).toBe(
      "380px",
    );
    expect(root.style.getPropertyValue("--family-viewport-top")).toBe("80px");
    expect(root.getAttribute("data-family-keyboard")).toBe("open");
    textarea.blur();
    viewport.height = 800;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(root.hasAttribute("data-family-keyboard")).toBe(false);
    unmount();
  });

  test("pinch zoom keeps layout height and never masquerades as a software keyboard", () => {
    const input = document.createElement("input");
    input.dataset.viewportFixture = "1";
    document.body.append(input);
    const { unmount } = renderHook(() => useFamilyViewport());
    input.focus();
    viewport.scale = 2;
    viewport.height = 400;
    viewport.offsetTop = 120;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(root.style.getPropertyValue("--family-viewport-height")).toBe(
      "800px",
    );
    expect(root.style.getPropertyValue("--family-viewport-top")).toBe("0px");
    expect(root.hasAttribute("data-family-keyboard")).toBe(false);
    unmount();
  });

  test("browsers without VisualViewport follow finite window resizes", () => {
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: undefined,
    });
    const { unmount } = renderHook(() => useFamilyViewport());
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 420,
    });
    window.dispatchEvent(new Event("resize"));
    flush();
    expect(root.style.getPropertyValue("--family-viewport-height")).toBe(
      "420px",
    );
    unmount();
  });

  test("unmount cancels pending frames, removes listeners, and restores previous root attributes", () => {
    root.style.setProperty("--family-viewport-height", "42vh", "important");
    root.style.setProperty("--family-viewport-top", "3px");
    root.setAttribute("data-family-keyboard", "previous");
    const { unmount } = renderHook(() => useFamilyViewport());
    viewport.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    unmount();
    expect(cancelFrame).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
    expect(root.style.getPropertyValue("--family-viewport-height")).toBe(
      "42vh",
    );
    expect(root.style.getPropertyPriority("--family-viewport-height")).toBe(
      "important",
    );
    expect(root.style.getPropertyValue("--family-viewport-top")).toBe("3px");
    expect(root.getAttribute("data-family-keyboard")).toBe("previous");
    viewport.height = 300;
    viewport.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(0);
    expect(root.style.getPropertyValue("--family-viewport-height")).toBe(
      "42vh",
    );
  });
});
