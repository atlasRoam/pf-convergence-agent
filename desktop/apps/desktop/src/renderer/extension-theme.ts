import type { CSSProperties } from "react";
import type { ExtensionThemeSnapshot } from "@pfsaa/contracts";

const tokens = ["accent", "text", "muted", "line", "green", "red", "amber", "selection-bg"] as const;
export function parseExtensionTheme(value: unknown): ExtensionThemeSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as ExtensionThemeSnapshot;
  if (input.appearance !== "dark" && input.appearance !== "light") return undefined;
  const colors: ExtensionThemeSnapshot["colors"] = {};
  for (const token of tokens) {
    const color = input.colors?.[token];
    if (typeof color === "string" && /^#[a-f\d]{6}$/i.test(color)) colors[token] = color;
  }
  return { appearance: input.appearance, colors, name: typeof input.name === "string" ? input.name : undefined };
}

export function extensionThemeStyle(theme?: ExtensionThemeSnapshot): CSSProperties | undefined {
  if (!theme) return undefined;
  return Object.fromEntries(tokens.flatMap((token) => theme.colors[token] ? [[`--${token}`, theme.colors[token]]] : [])) as CSSProperties;
}
