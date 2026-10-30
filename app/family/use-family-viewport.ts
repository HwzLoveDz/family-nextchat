"use client";

import { useEffect } from "react";

const HEIGHT = "--family-viewport-height";
const TOP = "--family-viewport-top";
const KEYBOARD = "data-family-keyboard";

/** Keep only the family surface inside the keyboard's visible viewport. */
export function useFamilyViewport(): void {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const previous = {
      height: root.style.getPropertyValue(HEIGHT),
      heightPriority: root.style.getPropertyPriority(HEIGHT),
      top: root.style.getPropertyValue(TOP),
      topPriority: root.style.getPropertyPriority(TOP),
      keyboard: root.getAttribute(KEYBOARD),
    };
    let frame: number | null = null;
    let fullHeight = window.innerHeight;
    const update = () => {
      frame = null;
      const zoomed = viewport && Math.abs(viewport.scale - 1) > 0.01;
      const height = !zoomed && viewport ? viewport.height : window.innerHeight;
      const top =
        !zoomed && viewport && Number.isFinite(viewport.offsetTop)
          ? Math.max(0, viewport.offsetTop)
          : 0;
      if (!Number.isFinite(height) || height <= 0) return;
      const active = document.activeElement;
      const editing =
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLInputElement &&
          ![
            "checkbox",
            "radio",
            "button",
            "submit",
            "reset",
            "file",
            "color",
            "range",
            "hidden",
          ].includes(active.type)) ||
        (active instanceof HTMLElement && active.isContentEditable);
      if (!editing) fullHeight = Math.max(height, window.innerHeight);
      else fullHeight = Math.max(fullHeight, window.innerHeight);
      root.style.setProperty(HEIGHT, `${Math.round(height)}px`);
      root.style.setProperty(TOP, `${Math.round(top)}px`);
      if (!zoomed && editing && fullHeight - height > 120)
        root.setAttribute(KEYBOARD, "open");
      else root.removeAttribute(KEYBOARD);
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    const orientation = () => {
      fullHeight = window.innerHeight;
      schedule();
    };
    update();
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", orientation);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", orientation);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      if (previous.height)
        root.style.setProperty(
          HEIGHT,
          previous.height,
          previous.heightPriority,
        );
      else root.style.removeProperty(HEIGHT);
      if (previous.top)
        root.style.setProperty(TOP, previous.top, previous.topPriority);
      else root.style.removeProperty(TOP);
      if (previous.keyboard === null) root.removeAttribute(KEYBOARD);
      else root.setAttribute(KEYBOARD, previous.keyboard);
    };
  }, []);
}
