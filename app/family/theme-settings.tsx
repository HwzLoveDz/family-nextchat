"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { FAMILY_THEMES, type FamilyTheme, type FamilyThemeId } from "./themes";
import styles from "./theme-settings.module.scss";

type Placement = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
};

export function ThemeSettings({
  theme,
  onChange,
}: {
  theme: FamilyTheme;
  onChange: (id: FamilyThemeId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement>({
    left: 12,
    top: 12,
    width: 296,
    maxHeight: 480,
  });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const panelId = `${id}-themes`,
    descriptionId = `${id}-current`;
  const surfaceStyle = {
    ...theme.variables,
    colorScheme: theme.dark ? "dark" : "light",
  } as CSSProperties;
  const position = useCallback(() => {
    const anchor = trigger.current;
    if (!anchor) return;
    const viewport = window.visualViewport;
    const width = viewport?.width || window.innerWidth,
      height = viewport?.height || window.innerHeight;
    const originX = viewport?.offsetLeft || 0,
      originY = viewport?.offsetTop || 0;
    const inset = 12,
      availableHeight = Math.max(80, height - 2 * inset),
      menuWidth = Math.max(1, Math.min(360, width - 2 * inset));
    const bounds = anchor.getBoundingClientRect();
    const menuHeight = Math.min(
      panel.current?.getBoundingClientRect().height || 400,
      availableHeight,
    );
    const below = originY + height - inset - bounds.bottom - 8,
      above = bounds.top - originY - inset - 8;
    const proposedTop =
      below >= menuHeight || below >= above
        ? bounds.bottom + 8
        : bounds.top - menuHeight - 8;
    const next = {
      left: Math.max(
        originX + inset,
        Math.min(bounds.right - menuWidth, originX + width - inset - menuWidth),
      ),
      top: Math.max(
        originY + inset,
        Math.min(proposedTop, originY + height - inset - menuHeight),
      ),
      width: menuWidth,
      maxHeight: availableHeight,
    };
    setPlacement((previous) =>
      Object.keys(next).every(
        (key) =>
          previous[key as keyof Placement] === next[key as keyof Placement],
      )
        ? previous
        : next,
    );
  }, []);
  const close = useCallback((restoreFocus: boolean) => {
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  }, []);
  useEffect(() => {
    if (!open) return;
    position();
    panel.current
      ?.querySelector<HTMLInputElement>('input[type="radio"]:checked')
      ?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !panel.current?.contains(target) &&
        !trigger.current?.contains(target)
      )
        close(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(position);
    if (panel.current) observer?.observe(panel.current);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
      observer?.disconnect();
    };
  }, [open, close, position]);

  return (
    <span className={styles.control} style={surfaceStyle}>
      <button
        ref={trigger}
        type="button"
        className={styles.trigger}
        aria-label="主题"
        aria-describedby={descriptionId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (open) close(true);
          else {
            position();
            setOpen(true);
          }
        }}
      >
        <span className={styles.paletteIcon} aria-hidden="true">
          ◐
        </span>
        主题
      </button>
      <span id={descriptionId} className={styles.srOnly}>
        当前主题：{theme.label}
      </span>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panel}
              id={panelId}
              className={styles.panel}
              role="region"
              aria-label="主题设置"
              style={{ ...surfaceStyle, ...placement }}
            >
              <div className={styles.heading}>
                <div>
                  <h2>选择主题</h2>
                  <p>只保存在这台设备上</p>
                </div>
                <button
                  type="button"
                  className={styles.close}
                  aria-label="关闭主题设置"
                  onClick={() => close(true)}
                >
                  ×
                </button>
              </div>
              <fieldset className={styles.choices}>
                <legend className={styles.srOnly}>主题配色</legend>
                {FAMILY_THEMES.map((option) => (
                  <label
                    key={option.id}
                    className={`${styles.choice} ${
                      theme.id === option.id ? styles.selected : ""
                    }`}
                  >
                    <span className={styles.swatches} aria-hidden="true">
                      {option.swatches.map((color, index) => (
                        <span key={index} style={{ backgroundColor: color }} />
                      ))}
                    </span>
                    <span className={styles.choiceTitle}>
                      <strong>{option.label}</strong>
                      <input
                        className={styles.radio}
                        type="radio"
                        name={`${id}-theme`}
                        value={option.id}
                        checked={theme.id === option.id}
                        aria-label={option.label}
                        aria-describedby={`${id}-${option.id}-description`}
                        onChange={() => onChange(option.id)}
                      />
                    </span>
                    <small id={`${id}-${option.id}-description`}>
                      {option.description}
                    </small>
                  </label>
                ))}
              </fieldset>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
