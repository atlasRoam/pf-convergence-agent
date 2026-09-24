import { useEffect, useRef } from "react";
import type { SessionCapabilities } from "@pfsaa/contracts";
import { matchesAgentCoreKeybinding } from "./agentcore-keybindings";

/** Mirror presentation state only; AgentCore keeps all extension handlers and contexts. */
export function useExtensionEditor({ taskId, cwd, text, shortcuts, enabled, syncEnabled = true, onError }: {
  taskId?: string; cwd: string; text: string; shortcuts: SessionCapabilities["extensionShortcuts"];
  enabled: boolean; syncEnabled?: boolean; onError: (message: string) => void;
}) {
  const running = useRef(false);
  useEffect(() => {
    if (!taskId || !enabled || !syncEnabled || !window.pfsaa.extensions.syncEditor) return;
    void window.pfsaa.extensions.syncEditor(taskId, text, cwd).catch((error) => onError(String(error)));
  }, [taskId, cwd, text, enabled, syncEnabled, onError]);

  useEffect(() => {
    if (!taskId || !enabled || !shortcuts?.length) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.matches('input, textarea, [contenteditable="true"]') && !target.matches(".composer-editor-input")) return;
      const shortcut = shortcuts.find(({ key }) => matchesAgentCoreKeybinding(event, { shortcut: [key] }, "shortcut"));
      if (!shortcut) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.repeat || running.current) return;
      running.current = true;
      void window.pfsaa.extensions.invokeShortcut(taskId, shortcut.key, text, cwd)
        .catch((error) => onError(String(error)))
        .finally(() => { running.current = false; });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [taskId, cwd, text, shortcuts, enabled, onError]);
}
