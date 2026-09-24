import type { WindowTheme } from "@pfsaa/contracts";

// The Windows caption buttons are a native overlay painted above the web
// contents. Keeping that surface transparent lets the renderer's titlebar
// background and bottom divider continue beneath the buttons.
export const transparentTitleBarOverlay = "rgba(0, 0, 0, 0)";

export function windowThemeColors(theme: WindowTheme): { background: string; symbol: string } {
  return theme === "dark"
    ? { background: "#1f1e1b", symbol: "#f3f0e8" }
    : { background: "#f7f6f1", symbol: "#27251f" };
}
