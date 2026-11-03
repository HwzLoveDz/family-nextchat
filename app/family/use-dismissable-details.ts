"use client";
import { useEffect, useRef, type RefObject } from "react";

/** Adds dismissal to a native details menu without taking over its toggle. */
export function useDismissableDetails(): RefObject<HTMLDetailsElement | null> {
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    // The menu may first mount after authentication. Read the ref for every
    // event so that conditional rendering never leaves a stale DOM listener.
    const outsidePointer = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (
        details?.open &&
        event.target instanceof Node &&
        !details.contains(event.target)
      )
        details.open = false;
    };
    const focusEntered = (event: FocusEvent) => {
      const details = detailsRef.current;
      if (
        details?.open &&
        event.target instanceof Node &&
        !details.contains(event.target)
      )
        details.open = false;
    };
    const focusLeft = (event: FocusEvent) => {
      const details = detailsRef.current;
      if (
        details?.open &&
        event.target instanceof Node &&
        details.contains(event.target) &&
        (!(event.relatedTarget instanceof Node) ||
          !details.contains(event.relatedTarget))
      )
        details.open = false;
    };
    const selected = (event: MouseEvent) => {
      const details = detailsRef.current;
      if (!details?.open || !(event.target instanceof Element)) return;
      const button = event.target.closest("button");
      if (
        button &&
        details.contains(button) &&
        !button.closest("summary") &&
        !button.matches(":disabled") &&
        button.getAttribute("aria-disabled") !== "true"
      )
        details.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      const details = detailsRef.current;
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        !details?.open ||
        (event.target instanceof Element &&
          event.target.closest(
            'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
          ))
      )
        return;
      const restoreFocus =
        document.activeElement !== null &&
        details.contains(document.activeElement);
      details.open = false;
      if (restoreFocus) {
        const summary = [...details.children].find(
          (element) => element.tagName === "SUMMARY",
        );
        if (summary instanceof HTMLElement) {
          event.preventDefault();
          summary.focus();
        }
      }
    };

    document.addEventListener("pointerdown", outsidePointer, true);
    document.addEventListener("focusin", focusEntered);
    document.addEventListener("focusout", focusLeft);
    // Bubble after the item's React/native action; never prevent its default.
    document.addEventListener("click", selected);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outsidePointer, true);
      document.removeEventListener("focusin", focusEntered);
      document.removeEventListener("focusout", focusLeft);
      document.removeEventListener("click", selected);
      document.removeEventListener("keydown", escape);
    };
  }, []);
  return detailsRef;
}
