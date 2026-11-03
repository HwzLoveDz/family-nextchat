"use client";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import styles from "./workspace-select.module.scss";

export interface WorkspaceSelectOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  disabled?: boolean;
}
export interface WorkspaceSelectProps {
  label: string;
  value: string;
  options: readonly WorkspaceSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  variant?: "compact" | "field";
  width?: number;
  placeholder?: string;
}
type Placement = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  above: boolean;
};
const normalize = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, "");

/** A select-only combobox. Navigation previews an option; only selection commits. */
export function WorkspaceSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  variant = "compact",
  width,
  placeholder = "请选择",
}: WorkspaceSelectProps) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const id = `workspace-select-${useId()}`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const search = useRef({ text: "", at: 0 });
  const selected = options.findIndex((option) => option.value === value);
  const enabled = options.flatMap((option, index) =>
    option.disabled ? [] : [index],
  );
  const unavailable = disabled || enabled.length === 0;
  const expanded = open && !unavailable;
  const optionId = (index: number) => `${id}-option-${index}`;
  const close = () => {
    setOpen(false);
    search.current = { text: "", at: 0 };
  };
  const measure = (): Placement | null => {
    const button = trigger.current;
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const viewportLeft = viewport?.offsetLeft ?? 0;
    const viewportTop = viewport?.offsetTop ?? 0;
    const inset = 12;
    const gap = 6;
    const minimumLeft = viewportLeft + inset;
    const minimumTop = viewportTop + inset;
    const maximumBottom = viewportTop + viewportHeight - inset;
    if (rect.bottom < viewportTop || rect.top > maximumBottom) return null;
    const requestedWidth =
      typeof width === "number" && Number.isFinite(width) && width > 0
        ? width
        : Math.max(rect.width, variant === "field" ? 0 : 240);
    const popupWidth = Math.min(
      requestedWidth,
      Math.max(0, viewportWidth - inset * 2),
    );
    const below = maximumBottom - rect.bottom - gap;
    const above = rect.top - minimumTop - gap;
    const opensAbove = below < 280 && above > below;
    return {
      left: Math.max(
        minimumLeft,
        Math.min(rect.left, viewportLeft + viewportWidth - inset - popupWidth),
      ),
      top: opensAbove
        ? Math.max(minimumTop, Math.min(rect.top - gap, maximumBottom))
        : Math.max(minimumTop, rect.bottom + gap),
      width: popupWidth,
      maxHeight: Math.min(360, Math.max(0, opensAbove ? above : below)),
      above: opensAbove,
    };
  };
  const show = (index?: number) => {
    if (unavailable) return;
    const next = measure();
    if (!next || next.maxHeight < 44) return;
    setPlacement(next);
    setActive(
      index ??
        (selected >= 0 && !options[selected].disabled ? selected : enabled[0]),
    );
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (unavailable || !option || option.disabled) return;
    close();
    trigger.current?.focus({ preventScroll: true });
    if (option.value !== value) onChange(option.value);
  };

  useEffect(() => {
    if (unavailable) {
      setOpen(false);
      search.current = { text: "", at: 0 };
    }
  }, [unavailable]);
  useEffect(() => {
    if (expanded && (!options[active] || options[active].disabled))
      setActive(
        selected >= 0 && !options[selected].disabled ? selected : enabled[0],
      );
  }, [expanded, active, options, selected, enabled]);
  useLayoutEffect(() => {
    if (!expanded || active < 0) return;
    const item = document.getElementById(`${id}-option-${active}`);
    item?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [expanded, active, id]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        close();
    };
    const scrolled = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target))
        return;
      close();
    };
    const dismiss = () => close();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", dismiss);
    viewport?.addEventListener("scroll", dismiss);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      document.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("blur", dismiss);
      viewport?.removeEventListener("resize", dismiss);
      viewport?.removeEventListener("scroll", dismiss);
    };
  }, [expanded]);

  const keydown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (unavailable || event.nativeEvent.isComposing || event.keyCode === 229)
      return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      search.current = { text: "", at: 0 };
      if (event.key === "Home") {
        if (expanded) setActive(enabled[0]);
        else show(enabled[0]);
      } else if (event.key === "End") {
        if (expanded) setActive(enabled.at(-1)!);
        else show(enabled.at(-1)!);
      } else if (!expanded) {
        show(
          selected >= 0 && !options[selected].disabled
            ? selected
            : event.key === "ArrowUp"
            ? enabled.at(-1)
            : enabled[0],
        );
      } else {
        const position = enabled.indexOf(active);
        const delta = event.key === "ArrowUp" ? -1 : 1;
        setActive(
          enabled[(position + delta + enabled.length) % enabled.length],
        );
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (expanded) choose(active);
      else show();
      return;
    }
    if (event.key === "Escape" && expanded) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      if (expanded) close();
      return;
    }
    if (
      event.key.length !== 1 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    const now = Date.now();
    const previous = now - search.current.at <= 700 ? search.current.text : "";
    const text = previous + normalize(event.key);
    const repeated = [...text].every((character) => character === text[0]);
    const prefix = repeated ? text[0] : text;
    search.current = { text, at: now };
    const start = expanded ? active : selected;
    const offset = previous && !repeated ? 0 : 1;
    const candidates = options.map(
      (_, index) => (Math.max(start, 0) + offset + index) % options.length,
    );
    const match = candidates.find(
      (index) =>
        !options[index].disabled &&
        normalize(options[index].label).startsWith(prefix),
    );
    if (match !== undefined) {
      event.preventDefault();
      if (expanded) setActive(match);
      else show(match);
    }
  };
  const groups: { name?: string; indices: number[] }[] = [];
  options.forEach((option, index) => {
    const previous = groups.at(-1);
    if (previous && previous.name === option.group)
      previous.indices.push(index);
    else groups.push({ name: option.group, indices: [index] });
  });

  return (
    <div ref={root} className={`${styles.root} ${styles[variant]}`}>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        className={styles.trigger}
        aria-label={label}
        aria-expanded={expanded}
        aria-haspopup="listbox"
        aria-controls={id}
        aria-activedescendant={
          expanded && active >= 0 ? optionId(active) : undefined
        }
        disabled={unavailable}
        value={value}
        data-value={value}
        onClick={() => {
          if (expanded) close();
          else show();
        }}
        onKeyDown={keydown}
      >
        <span className={styles.value}>
          {options[selected]?.label || placeholder}
        </span>
        <svg
          className={styles.chevron}
          aria-hidden="true"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
        >
          <path
            d="m4 6 4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {expanded && placement ? (
        <div
          ref={popup}
          id={id}
          role="listbox"
          aria-label={label}
          className={`${styles.popup} ${placement.above ? styles.above : ""}`}
          style={{
            left: placement.left,
            top: placement.top,
            width: placement.width,
            maxHeight: placement.maxHeight,
          }}
          onMouseDown={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            if (event.pointerType !== "touch") event.preventDefault();
          }}
        >
          {groups.map((group, groupIndex) => (
            <div
              key={groupIndex}
              className={styles.group}
              role={group.name ? "group" : "presentation"}
              aria-label={group.name}
            >
              {group.name ? (
                <div className={styles.groupTitle} aria-hidden="true">
                  {group.name}
                </div>
              ) : null}
              {group.indices.map((index) => {
                const option = options[index];
                return (
                  <div
                    key={option.value}
                    id={optionId(index)}
                    role="option"
                    aria-label={option.label}
                    aria-describedby={
                      option.description
                        ? `${optionId(index)}-description`
                        : undefined
                    }
                    aria-selected={option.value === value}
                    aria-disabled={option.disabled || undefined}
                    data-value={option.value}
                    data-active={active === index}
                    className={styles.option}
                    onPointerMove={(event) => {
                      if (!option.disabled && event.pointerType !== "touch")
                        setActive(index);
                    }}
                    onClick={() => choose(index)}
                  >
                    <span className={styles.optionText}>
                      <span className={styles.optionLabel}>{option.label}</span>
                      {option.description ? (
                        <span
                          id={`${optionId(index)}-description`}
                          className={styles.description}
                        >
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    <span className={styles.check} aria-hidden="true">
                      {option.value === value ? (
                        <svg
                          viewBox="0 0 16 16"
                          width="16"
                          height="16"
                          fill="none"
                        >
                          <path
                            d="m3 8 3 3 7-7"
                            stroke="currentColor"
                            strokeWidth="1.7"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
