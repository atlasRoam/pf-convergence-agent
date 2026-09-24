import type { AgentCoreKeybindings } from "@pfsaa/contracts";

const browserKeyNames: Record<string, string> = {
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  Backspace: "backspace",
  Delete: "delete",
  Enter: "enter",
  Escape: "escape",
  PageDown: "pagedown",
  PageUp: "pageup",
  Tab: "tab",
  " ": "space",
};

function canonicalKey(value: string): string {
  const parts = value.toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  const key = parts.pop() ?? "";
  const modifiers = new Set(parts.map((part) => part === "control" ? "ctrl" : part === "command" ? "meta" : part));
  return ["ctrl", "alt", "shift", "meta"].filter((modifier) => modifiers.has(modifier)).concat(key).join("+");
}

export function browserEventKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): string {
  const key = browserKeyNames[event.key] ?? event.key.toLowerCase();
  return [event.ctrlKey && "ctrl", event.altKey && "alt", event.shiftKey && "shift", event.metaKey && "meta", key]
    .filter((part): part is string => Boolean(part))
    .join("+");
}

export function matchesAgentCoreKeybinding(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
  bindings: AgentCoreKeybindings | undefined,
  action: string,
): boolean {
  const pressed = canonicalKey(browserEventKey(event));
  return (bindings?.[action] ?? []).some((binding) => canonicalKey(binding) === pressed);
}

export function firstAgentCoreKeybinding(bindings: AgentCoreKeybindings | undefined, action: string): string | undefined {
  return bindings?.[action]?.[0];
}

export function domKeyToTerminalInput(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "isComposing">): string | undefined {
  if (event.isComposing || event.metaKey) return undefined;
  const specialKeys: Record<string, string> = {
    ArrowUp: "\x1b[A", ArrowDown: "\x1b[B", ArrowLeft: "\x1b[D", ArrowRight: "\x1b[C",
    Enter: "\r", Escape: "\x1b", Backspace: "\x7f", Delete: "\x1b[3~",
    Home: "\x1b[H", End: "\x1b[F", PageUp: "\x1b[5~", PageDown: "\x1b[6~", Tab: "\t",
  };
  if (specialKeys[event.key]) return event.altKey && event.key === "Enter" ? "\x1b\r" : specialKeys[event.key];
  if (event.ctrlKey && event.key.length === 1) {
    const code = event.key.toLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  }
  if (event.altKey && event.key.length === 1) return `\x1b${event.key}`;
  return event.key.length === 1 ? event.key : undefined;
}
