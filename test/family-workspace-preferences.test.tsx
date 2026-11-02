/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  WORKSPACE_PREFERENCES_KEY,
  parseWorkspacePreferences,
  useWorkspacePreferences,
} from "../app/family/use-workspace-preferences";

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  localStorage.clear();
});
test("storage accepts only presentation enums and cannot retain private fields", () => {
  localStorage.setItem(
    WORKSPACE_PREFERENCES_KEY,
    JSON.stringify({
      font: "large",
      density: "compact",
      sendKey: "mod-enter",
      draft: "private",
      token: "secret",
    }),
  );
  const hook = renderHook(useWorkspacePreferences);
  expect(hook.result.current.preferences).toEqual({
    font: "large",
    density: "compact",
    sendKey: "mod-enter",
  });
  act(() =>
    hook.result.current.setPreferences({
      ...hook.result.current.preferences,
      draft: "private",
    } as any),
  );
  expect(JSON.parse(localStorage.getItem(WORKSPACE_PREFERENCES_KEY)!)).toEqual({
    font: "large",
    density: "compact",
    sendKey: "mod-enter",
  });
  hook.unmount();
  expect(
    renderHook(useWorkspacePreferences).result.current.preferences.font,
  ).toBe("large");
});
test("malformed and unknown preferences fall back and blocked storage still permits changes", () => {
  expect(parseWorkspacePreferences("not JSON")).toEqual(
    DEFAULT_WORKSPACE_PREFERENCES,
  );
  expect(
    parseWorkspacePreferences({
      font: "untrusted",
      density: "compact",
      sendKey: "script",
    }),
  ).toEqual({ font: "standard", density: "compact", sendKey: "enter" });
  jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const hook = renderHook(useWorkspacePreferences);
  expect(() =>
    act(() =>
      hook.result.current.setPreferences({
        font: "small",
        density: "compact",
        sendKey: "enter",
      }),
    ),
  ).not.toThrow();
  expect(hook.result.current.preferences.font).toBe("small");
});
test("cross-tab events update enums while ignoring unrelated and session storage events", () => {
  const hook = renderHook(useWorkspacePreferences);
  const change = { font: "large", density: "compact", sendKey: "mod-enter" };
  fireEvent(
    window,
    new StorageEvent("storage", {
      key: "unrelated",
      newValue: JSON.stringify(change),
      storageArea: localStorage,
    }),
  );
  expect(hook.result.current.preferences).toEqual(
    DEFAULT_WORKSPACE_PREFERENCES,
  );
  fireEvent(
    window,
    new StorageEvent("storage", {
      key: WORKSPACE_PREFERENCES_KEY,
      newValue: JSON.stringify(change),
      storageArea: sessionStorage,
    }),
  );
  expect(hook.result.current.preferences).toEqual(
    DEFAULT_WORKSPACE_PREFERENCES,
  );
  fireEvent(
    window,
    new StorageEvent("storage", {
      key: WORKSPACE_PREFERENCES_KEY,
      newValue: JSON.stringify(change),
      storageArea: localStorage,
    }),
  );
  expect(hook.result.current.preferences).toEqual(change);
  fireEvent(
    window,
    new StorageEvent("storage", {
      key: null,
      newValue: null,
      storageArea: localStorage,
    }),
  );
  expect(hook.result.current.preferences).toEqual(
    DEFAULT_WORKSPACE_PREFERENCES,
  );
});
