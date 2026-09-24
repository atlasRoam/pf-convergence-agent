import { useEffect, type RefObject } from "react";
import type { AgentCoreKeybindings } from "@pfsaa/contracts";
import { matchesAgentCoreKeybinding } from "./agentcore-keybindings";

interface GlobalShortcutsOptions {
  searchInputRef: RefObject<HTMLInputElement | null>;
  settingsOpen: boolean;
  agentCoreSettingsOpen: boolean;
  quickSettingsOpen: boolean;
  packagesOpen: boolean;
  extensionUiOpen: boolean;
  commandDialogOpen: boolean;
  renameOpen: boolean;
  resumeOpen: boolean;
  sessionBranchOpen: boolean;
  trustOpen: boolean;
  scopedModelsOpen: boolean;
  pendingDelete: boolean;
  pendingProjectRemove: boolean;
  previewImage: boolean;
  thinkingMenuOpen: boolean;
  modelMenuOpen: boolean;
  suggestionMode: string | null;
  contextMenu: boolean;
  projectContextMenu: boolean;
  imageContextMenu: boolean;
  agentCoreKeybindings?: AgentCoreKeybindings;
  onAgentCoreCommands: () => void;
  onTranscriptSearch?: () => void;
  onQuickSettings: () => void;
  onCreateTask: () => void | Promise<unknown>;
  onCloseMenus: () => void;
}

export function useGlobalShortcuts({
  searchInputRef, settingsOpen, agentCoreSettingsOpen, quickSettingsOpen, packagesOpen, extensionUiOpen, commandDialogOpen, renameOpen, resumeOpen, sessionBranchOpen, trustOpen, scopedModelsOpen, pendingDelete, pendingProjectRemove, previewImage,
  thinkingMenuOpen, modelMenuOpen, suggestionMode, contextMenu, projectContextMenu, imageContextMenu, agentCoreKeybindings,
  onAgentCoreCommands, onTranscriptSearch, onQuickSettings, onCreateTask, onCloseMenus,
}: GlobalShortcutsOptions) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const modalOpen = settingsOpen || agentCoreSettingsOpen || quickSettingsOpen || packagesOpen || extensionUiOpen || commandDialogOpen || renameOpen || resumeOpen || sessionBranchOpen || trustOpen || scopedModelsOpen || pendingDelete || pendingProjectRemove || previewImage;
      if (modalOpen) return;
      if (matchesAgentCoreKeybinding(event, agentCoreKeybindings, "tui.altScreen.search")) { event.preventDefault(); onTranscriptSearch?.(); return; }
      if (modifier && event.key.toLowerCase() === "k") { event.preventDefault(); onAgentCoreCommands(); return; }
      if (modifier && event.key.toLowerCase() === "n") { event.preventDefault(); void onCreateTask(); return; }
      if (modifier && event.key === ",") { event.preventDefault(); onQuickSettings(); return; }
      const target = event.target;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable);
      if (event.key === "/" && !typing) { event.preventDefault(); searchInputRef.current?.focus(); return; }
      if (event.key === "Escape") {
        if (thinkingMenuOpen || modelMenuOpen || suggestionMode || contextMenu || projectContextMenu || imageContextMenu) { onCloseMenus(); return; }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandDialogOpen, contextMenu, extensionUiOpen, imageContextMenu, modelMenuOpen, onCloseMenus, onCreateTask, onAgentCoreCommands, onQuickSettings, onTranscriptSearch, packagesOpen, pendingDelete, pendingProjectRemove, agentCoreKeybindings, agentCoreSettingsOpen, previewImage, projectContextMenu, quickSettingsOpen, renameOpen, resumeOpen, searchInputRef, scopedModelsOpen, sessionBranchOpen, settingsOpen, suggestionMode, thinkingMenuOpen, trustOpen]);
}
