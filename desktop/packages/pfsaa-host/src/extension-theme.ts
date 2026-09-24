import type { ExtensionThemeSnapshot } from "@pfsaa/contracts";
import type { AgentCoreSdk } from "@pfsaa/agentcore-adapter";

type AgentCoreTheme = { name?: string; sourcePath?: string; getFgAnsi(color: string): string; getBgAnsi(color: string): string };

/** Decode only AgentCore's color sequences, never forward arbitrary CSS or ANSI. */
export function ansiColorToHex(ansi: string): string | undefined {
  const rgb = /\[(?:38|48);2;(\d+);(\d+);(\d+)m/.exec(ansi);
  if (rgb) {
    const values = rgb.slice(1).map(Number);
    return values.every((v) => v <= 255) ? `#${values.map((v) => v.toString(16).padStart(2, "0")).join("")}` : undefined;
  }
  const indexed = /\[(?:38|48);5;(\d+)m/.exec(ansi);
  if (!indexed) return undefined;
  const n = Number(indexed[1]);
  if (n > 255) return undefined;
  const basic = ["000000", "800000", "008000", "808000", "000080", "800080", "008080", "c0c0c0", "808080", "ff0000", "00ff00", "ffff00", "0000ff", "ff00ff", "00ffff", "ffffff"];
  if (n < 16) return `#${basic[n]}`;
  const level = (v: number) => v === 0 ? 0 : 55 + v * 40;
  const values = n >= 232 ? [1, 1, 1].map(() => 8 + (n - 232) * 10) : [Math.floor((n - 16) / 36), Math.floor((n - 16) / 6) % 6, (n - 16) % 6].map(level);
  return `#${values.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function themeSnapshot(theme: AgentCoreTheme): ExtensionThemeSnapshot {
  const colors: ExtensionThemeSnapshot["colors"] = {};
  const keys = { accent: "accent", text: "text", muted: "muted", line: "borderMuted", green: "success", red: "error", amber: "warning" } as const;
  for (const [key, agentCoreKey] of Object.entries(keys)) {
    const value = ansiColorToHex(theme.getFgAnsi(agentCoreKey));
    if (value) colors[key as keyof typeof keys] = value;
  }
  colors["selection-bg"] = ansiColorToHex(theme.getBgAnsi("selectedBg"));
  const bg = ansiColorToHex(theme.getBgAnsi("userMessageBg"));
  const light = theme.name === "light" || (bg && [1, 3, 5].reduce((sum, offset) => sum + Number.parseInt(bg.slice(offset, offset + 2), 16), 0) > 500);
  return { name: theme.name, appearance: light ? "light" : "dark", colors };
}

export function createExtensionTheme(api: NonNullable<AgentCoreSdk["themeApi"]>, session: any, emit: (snapshot: ExtensionThemeSnapshot) => void) {
  const resourceThemes = (): AgentCoreTheme[] => session.resourceLoader?.getThemes?.().themes ?? [];
  const getTheme = (name: string): AgentCoreTheme | undefined => resourceThemes().find((theme) => theme.name === name) ?? api.getThemeByName(name);
  const configured = session.settingsManager?.getTheme?.();
  let current: any = getTheme(configured ?? "dark") ?? getTheme("dark");
  // AgentCore copies uiContext using object spread. A stable proxy keeps ui.theme live
  // after setTheme without sharing a process-global selection across sessions.
  const theme = new Proxy({}, { get: (_target, key) => {
    const value = current?.[key];
    return typeof value === "function" ? value.bind(current) : value;
  } });
  return {
    theme,
    getAllThemes: () => [...new Map([...api.getAvailableThemesWithPaths(), ...resourceThemes().filter((item) => item.name).map((item) => ({ name: item.name!, path: item.sourcePath }))].map((item) => [item.name, item])).values()],
    getTheme,
    setTheme: (value: string | AgentCoreTheme) => {
      const next = typeof value === "string" ? getTheme(value) : value;
      if (!next || typeof next.getFgAnsi !== "function" || typeof next.getBgAnsi !== "function") return { success: false, error: `Theme is unavailable: ${typeof value === "string" ? value : "invalid theme"}` };
      try { const snapshot = themeSnapshot(next); current = next; emit(snapshot); return { success: true }; }
      catch { return { success: false, error: "Theme colors could not be mapped to the desktop" }; }
    },
  };
}
