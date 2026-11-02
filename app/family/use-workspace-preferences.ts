"use client";
import { useCallback, useEffect, useState } from "react";
import type { WorkspacePreferences } from "./workspace-types";

export const WORKSPACE_PREFERENCES_KEY = "family-workspace-preferences";
export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  font: "standard",
  density: "comfortable",
  sendKey: "enter",
};
/** Only known presentation enums cross the storage boundary. */
export function parseWorkspacePreferences(raw: unknown): WorkspacePreferences {
  let value: any;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    value = null;
  }
  return {
    font: ["small", "standard", "large"].includes(value?.font)
      ? value.font
      : "standard",
    density: ["comfortable", "compact"].includes(value?.density)
      ? value.density
      : "comfortable",
    sendKey: ["enter", "mod-enter"].includes(value?.sendKey)
      ? value.sendKey
      : "enter",
  };
}
export function useWorkspacePreferences() {
  const [preferences, update] = useState(DEFAULT_WORKSPACE_PREFERENCES);
  useEffect(() => {
    try {
      update(
        parseWorkspacePreferences(
          localStorage.getItem(WORKSPACE_PREFERENCES_KEY),
        ),
      );
    } catch {
      /* Optional store. */
    }
    const sync = (event: StorageEvent) => {
      if (event.key !== WORKSPACE_PREFERENCES_KEY && event.key !== null) return;
      if (event.storageArea) {
        try {
          if (event.storageArea !== localStorage) return;
        } catch {
          return;
        }
      }
      update(parseWorkspacePreferences(event.newValue));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const setPreferences = useCallback((next: WorkspacePreferences) => {
    const safe = parseWorkspacePreferences(next);
    update(safe);
    try {
      localStorage.setItem(WORKSPACE_PREFERENCES_KEY, JSON.stringify(safe));
    } catch {
      /* In-memory preference still works. */
    }
  }, []);
  return { preferences, setPreferences };
}
