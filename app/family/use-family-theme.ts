"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import {
  DEFAULT_FAMILY_THEME,
  getFamilyTheme,
  type FamilyThemeId,
} from "./themes";

// A visual enum only. Legacy account/chat cleanup deliberately leaves it alone.
export const FAMILY_THEME_STORAGE_KEY = "family-theme";

export function useFamilyTheme() {
  const [theme, updateTheme] = useState(() =>
    getFamilyTheme(DEFAULT_FAMILY_THEME),
  );
  useEffect(() => {
    try {
      updateTheme(
        getFamilyTheme(window.localStorage.getItem(FAMILY_THEME_STORAGE_KEY)),
      );
    } catch {
      /* A blocked preference store must not block the app. */
    }
    const synchronize = (event: StorageEvent) => {
      if (event.key !== FAMILY_THEME_STORAGE_KEY && event.key !== null) return;
      if (event.storageArea) {
        try {
          if (event.storageArea !== window.localStorage) return;
        } catch {
          return;
        }
      }
      updateTheme(getFamilyTheme(event.newValue));
    };
    window.addEventListener("storage", synchronize);
    return () => window.removeEventListener("storage", synchronize);
  }, []);
  const setTheme = useCallback((id: FamilyThemeId) => {
    const selected = getFamilyTheme(id);
    updateTheme(selected);
    try {
      window.localStorage.setItem(FAMILY_THEME_STORAGE_KEY, selected.id);
    } catch {
      /* Selection still applies for this visit. */
    }
  }, []);
  const style = useMemo(
    () =>
      ({
        ...theme.variables,
        colorScheme: theme.dark ? "dark" : "light",
      }) as CSSProperties,
    [theme],
  );
  return { theme, setTheme, style };
}
