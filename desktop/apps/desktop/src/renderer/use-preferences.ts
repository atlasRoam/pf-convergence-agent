import { useEffect, useState } from "react";
import type { Language } from "@pfsaa/i18n";
import type { Theme, ThemePreference } from "./types";
import { readPfsaaStorage, writePfsaaStorage } from "./pfsaa-storage";

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function languageSwitchTarget(language: Language): { language: Language; label: "EN" | "中" } {
  return language === "zh" ? { language: "en", label: "EN" } : { language: "zh", label: "中" };
}

export function usePreferences() {
  const [language, setLanguage] = useState<Language>(() => readPfsaaStorage("language") === "en" ? "en" : "zh");
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    const stored = readPfsaaStorage("theme");
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });
  const [confirmClose, setConfirmClose] = useState<boolean>(() => {
    const stored = readPfsaaStorage("confirmClose");
    return stored === "false" ? false : true;
  });
  const [resolvedSystemTheme, setResolvedSystemTheme] = useState<Theme>(systemTheme);
  const theme: Theme = themePreference === "system" ? resolvedSystemTheme : themePreference;
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const onChange = (event: MediaQueryListEvent) => setResolvedSystemTheme(event.matches ? "dark" : "light");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  useEffect(() => { writePfsaaStorage("language", language); document.documentElement.lang = language === "zh" ? "zh-CN" : "en"; }, [language]);
  useEffect(() => { writePfsaaStorage("theme", themePreference); document.documentElement.style.colorScheme = theme; }, [theme, themePreference]);
  useEffect(() => { writePfsaaStorage("confirmClose", confirmClose ? "true" : "false"); }, [confirmClose]);
  useEffect(() => { void window.pfsaa.app.setLanguage(language).catch(() => undefined); }, [language]);
  useEffect(() => { void window.pfsaa.app.setWindowTheme(theme).catch(() => undefined); }, [theme]);
  useEffect(() => { void window.pfsaa.app.setConfirmClose(confirmClose).catch(() => undefined); }, [confirmClose]);
  // Main may ask us to persist "don't ask again" after the user ticks the
  // checkbox in the native close-confirm dialog.
  useEffect(() => {
    const handler = (enabled: boolean) => {
      writePfsaaStorage("confirmClose", enabled ? "true" : "false");
      setConfirmClose(enabled);
    };
    window.pfsaa.app.onConfirmCloseChanged?.(handler);
    return () => window.pfsaa.app.offConfirmCloseChanged?.(handler);
  }, []);
  function cycleTheme() {
    setThemePreference((current) => current === "system" ? "light" : current === "light" ? "dark" : "system");
  }
  return { language, setLanguage, theme, themePreference, cycleTheme, confirmClose, setConfirmClose };
}
