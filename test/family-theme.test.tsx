/** @jest-environment jsdom */
import { jest } from "@jest/globals";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { FAMILY_THEMES, getFamilyTheme } from "../app/family/themes";
import {
  FAMILY_THEME_STORAGE_KEY,
  useFamilyTheme,
} from "../app/family/use-family-theme";
import { ThemeSettings } from "../app/family/theme-settings";
import { clearLegacyFamilyData } from "../app/family/client-cleanup";

function Harness() {
  const { theme, setTheme, style } = useFamilyTheme();
  return (
    <section data-testid="family-surface" style={style}>
      <ThemeSettings theme={theme} onChange={setTheme} />
      <input aria-label="外部输入" />
      <output aria-label="当前配色">{theme.id}</output>
    </section>
  );
}

describe("family-only visual preferences", () => {
  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
    window.localStorage.clear();
  });

  test("defaults to paper and persists only the selected enum across remounts", () => {
    const first = renderHook(() => useFamilyTheme());
    expect(first.result.current.theme.id).toBe("paper");
    act(() => first.result.current.setTheme("forest"));
    expect(first.result.current.theme.id).toBe("forest");
    expect(localStorage.getItem(FAMILY_THEME_STORAGE_KEY)).toBe("forest");
    expect(first.result.current.style.colorScheme).toBe("dark");
    first.unmount();
    const second = renderHook(() => useFamilyTheme());
    expect(second.result.current.theme.id).toBe("forest");
    expect(localStorage.length).toBe(1);
  });

  test("invalid values are never applied and blocked storage does not block selection", () => {
    localStorage.setItem(
      FAMILY_THEME_STORAGE_KEY,
      '{"id":"midnight","variables":{"--paper":"untrusted"}}',
    );
    const invalid = renderHook(() => useFamilyTheme());
    expect(invalid.result.current.theme.id).toBe("paper");
    expect(invalid.result.current.style).toMatchObject(
      getFamilyTheme("paper").variables,
    );
    invalid.unmount();
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const blocked = renderHook(() => useFamilyTheme());
    expect(blocked.result.current.theme.id).toBe("paper");
    expect(() =>
      act(() => blocked.result.current.setTheme("midnight")),
    ).not.toThrow();
    expect(blocked.result.current.theme.id).toBe("midnight");
    expect(blocked.result.current.style.colorScheme).toBe("dark");
  });

  test("cross-tab updates synchronize valid choices, ignore unrelated keys, and reset invalid values", () => {
    const hook = renderHook(() => useFamilyTheme());
    fireEvent(
      window,
      new StorageEvent("storage", {
        key: "unrelated-setting",
        newValue: "midnight",
        storageArea: localStorage,
      }),
    );
    expect(hook.result.current.theme.id).toBe("paper");
    localStorage.setItem(FAMILY_THEME_STORAGE_KEY, "ocean");
    fireEvent(
      window,
      new StorageEvent("storage", {
        key: FAMILY_THEME_STORAGE_KEY,
        newValue: "ocean",
        storageArea: localStorage,
      }),
    );
    expect(hook.result.current.theme.id).toBe("ocean");
    fireEvent(
      window,
      new StorageEvent("storage", {
        key: FAMILY_THEME_STORAGE_KEY,
        newValue: "invalid",
        storageArea: localStorage,
      }),
    );
    expect(hook.result.current.theme.id).toBe("paper");
  });

  test("all twelve radio choices apply immediately in the scoped portal and Escape restores button focus", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "主题" });
    fireEvent.click(trigger);
    const panel = screen.getByRole("region", { name: "主题设置" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", panel.id);
    expect(screen.getAllByRole("radio")).toHaveLength(12);
    expect(
      screen.getByRole("radio", { name: getFamilyTheme("paper").label }),
    ).toHaveFocus();
    const midnight = getFamilyTheme("midnight");
    fireEvent.click(screen.getByRole("radio", { name: midnight.label }));
    expect(screen.getByRole("radio", { name: midnight.label })).toBeChecked();
    expect(localStorage.getItem(FAMILY_THEME_STORAGE_KEY)).toBe("midnight");
    expect(panel.style.colorScheme).toBe("dark");
    expect(panel.style.getPropertyValue("--paper")).toBe(
      midnight.variables["--paper"],
    );
    expect(screen.getByTestId("family-surface").contains(panel)).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.queryByRole("region", { name: "主题设置" }),
    ).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  test("outside pointer and tabbing away close without taking focus from an outside control", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "主题" });
    const outside = screen.getByRole("textbox", { name: "外部输入" });
    fireEvent.click(trigger);
    fireEvent.pointerDown(outside);
    expect(
      screen.queryByRole("region", { name: "主题设置" }),
    ).not.toBeInTheDocument();
    act(() => outside.focus());
    expect(outside).toHaveFocus();
    fireEvent.click(trigger);
    expect(
      screen.getByRole("region", { name: "主题设置" }),
    ).toBeInTheDocument();
    act(() => outside.focus());
    expect(
      screen.queryByRole("region", { name: "主题设置" }),
    ).not.toBeInTheDocument();
    expect(outside).toHaveFocus();
  });

  test("legacy sign-in/sign-out cleanup preserves the non-private theme preference", async () => {
    localStorage.setItem(FAMILY_THEME_STORAGE_KEY, "lilac");
    localStorage.setItem("chat-next-web-store", "synthetic-old-store");
    localStorage.setItem("unfinished-input-synthetic", "synthetic-old-draft");
    await clearLegacyFamilyData();
    expect(localStorage.getItem("chat-next-web-store")).toBeNull();
    expect(localStorage.getItem("unfinished-input-synthetic")).toBeNull();
    expect(localStorage.getItem(FAMILY_THEME_STORAGE_KEY)).toBe("lilac");
    const hook = renderHook(() => useFamilyTheme());
    expect(hook.result.current.theme.id).toBe("lilac");
  });

  test("the picker constrains its portal to a short mobile visual viewport", () => {
    const viewport = new EventTarget();
    Object.assign(viewport, {
      width: 320,
      height: 390,
      offsetLeft: 0,
      offsetTop: 90,
    });
    const original = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    try {
      render(<Harness />);
      fireEvent.click(screen.getByRole("button", { name: "主题" }));
      const panel = screen.getByRole("region", { name: "主题设置" });
      expect(parseFloat(panel.style.width)).toBeLessThanOrEqual(320 - 24);
      expect(parseFloat(panel.style.maxHeight)).toBeLessThanOrEqual(390 - 24);
      expect(parseFloat(panel.style.top)).toBeGreaterThanOrEqual(90);
      expect(
        FAMILY_THEMES.map((theme) =>
          screen.getByRole("radio", { name: theme.label }),
        ),
      ).toHaveLength(12);
    } finally {
      cleanup();
      if (original) Object.defineProperty(window, "visualViewport", original);
      else Reflect.deleteProperty(window, "visualViewport");
    }
  });

  test.each(["slate", "deepsea", "plum", "espresso"])(
    "%s is a complete dark palette with readable primary, muted, and accent text",
    (id) => {
      const selected = getFamilyTheme(id);
      expect(selected.id).toBe(id);
      expect(selected.dark).toBe(true);
      expect(Object.keys(selected.variables)).toEqual(
        Object.keys(getFamilyTheme("paper").variables),
      );
      const luminance = (hex: string) => {
        const channels = [1, 3, 5].map((offset) => {
          const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : Math.pow((channel + 0.055) / 1.055, 2.4);
        });
        return (
          channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
        );
      };
      const ratio = (foreground: string, background: string) => {
        const values = [luminance(foreground), luminance(background)].sort(
          (a, b) => b - a,
        );
        return (values[0] + 0.05) / (values[1] + 0.05);
      };
      const colors = selected.variables;
      for (const surface of [
        "--paper",
        "--panel-bg",
        "--sidebar-bg",
        "--user-bg",
      ] as const) {
        expect(ratio(colors["--ink"], colors[surface])).toBeGreaterThanOrEqual(
          4.5,
        );
        expect(
          ratio(colors["--muted"], colors[surface]),
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        ratio(colors["--on-accent"], colors["--accent"]),
      ).toBeGreaterThanOrEqual(4.5);
    },
  );
});
