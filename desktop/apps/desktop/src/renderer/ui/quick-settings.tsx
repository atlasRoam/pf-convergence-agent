import { Component, useRef, useState, type ComponentProps, type ErrorInfo, type ReactNode } from "react";
import { Command } from "cmdk";
import { copy, type Language } from "@pfsaa/i18n";
import { Icon, useDialogFocus } from "@pfsaa/ui-system";
import type { PaletteCommand } from "../palette-command";
import { handleRovingMenuKeyDown } from "./shared";

const MERGED_COMMAND_NAMES = new Set([
  "new",
  "compact",
  "export",
  "settings",
  "login",
  "logout",
  "scoped-models",
  "trust",
  "hotkeys",
]);

type QuickSettingsPage = "root" | "actions" | "commands";
type QuickSettingsItem = {
  id: string;
  label: string;
  description: string;
  icon: ComponentProps<typeof Icon>["name"];
  action: () => void;
  disabled?: boolean;
  drilldown?: boolean;
};

class QuickSettingsBoundary extends Component<{ children: ReactNode; language: Language; onClose: () => void }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: unknown) { return { error: error instanceof Error ? error.message : String(error) }; }
  componentDidCatch(error: unknown, info: ErrorInfo) { console.error("Quick settings render failed", error, info.componentStack); }
  render() {
    if (this.state.error) {
      const t = copy[this.props.language];
      return <div className="settings-backdrop quick-settings-backdrop"><div className="quick-settings-panel quick-settings-error" role="alert"><strong>{t.quickSettingsError}</strong><button className="button ghost" onClick={this.props.onClose}>{t.retry}</button></div></div>;
    }
    return this.props.children;
  }
}

function QuickSettings({ language, commands, initialPage = "root", shortcut, hasProject, hasSession, onCommand, onProviders, onNewTask, onCompact, onExport, onClose }: {
  language: Language;
  commands: PaletteCommand[];
  initialPage?: Extract<QuickSettingsPage, "root" | "commands">;
  shortcut: (key: string) => string;
  hasProject: boolean;
  hasSession: boolean;
  onCommand: (command: PaletteCommand) => void;
  onProviders: () => void;
  onNewTask: () => void;
  onCompact: () => void;
  onExport: (format: "jsonl" | "html") => void;
  onClose: () => void;
}) {
  const t = copy[language];
  const [page, setPage] = useState<QuickSettingsPage>(initialPage);
  const [query, setQuery] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, onClose);
  const navigate = (nextPage: QuickSettingsPage) => {
    setQuery("");
    setPage(nextPage);
  };
  const rootItems: QuickSettingsItem[] = [
    { id: "settings", label: t.agentCoreSettingsTitle, description: t.agentCoreSettingsDescription, icon: "settings", action: () => onCommand({ name: "settings" }) },
    { id: "providers", label: t.providerSettings, description: t.providerAuthTitle, icon: "brain", action: onProviders },
    { id: "scoped-models", label: t.scopedModelsTitle, description: hasSession ? t.scopedModelsDescription : t.noSessions, icon: "model", action: () => onCommand({ name: "scoped-models" }), disabled: !hasSession },
    { id: "task-actions", label: t.taskActions, description: t.taskActionsDescription, icon: "spark", action: () => navigate("actions"), drilldown: true },
    { id: "agentcore-commands", label: t.command, description: t.agentCoreCommandsDescription, icon: "command", action: () => navigate("commands"), drilldown: true },
    { id: "hotkeys", label: t.hotkeysTitle, description: t.quickSettingsHotkeysHint, icon: "command", action: () => onCommand({ name: "hotkeys" }) },
  ];
  const actionItems: QuickSettingsItem[] = [
    { id: "new-task", label: t.newTask, description: hasProject ? shortcut("N") : t.selectProjectFirst, icon: "plus", action: onNewTask, disabled: !hasProject },
    { id: "compact", label: t.compactContext, description: hasSession ? t.compactContext : t.noSessions, icon: "spark", action: onCompact, disabled: !hasSession },
    { id: "export-jsonl", label: t.exportJsonl, description: hasSession ? t.exportJsonl : t.noSessions, icon: "file", action: () => onExport("jsonl"), disabled: !hasSession },
    { id: "export-html", label: t.exportHtml, description: hasSession ? t.exportHtml : t.noSessions, icon: "file", action: () => onExport("html"), disabled: !hasSession },
  ];
  const agentCoreCommands = (Array.isArray(commands) ? commands : [])
    .filter((command) => command && typeof command.name === "string" && !MERGED_COMMAND_NAMES.has(command.name.replace(/^\//, "").toLocaleLowerCase()))
    .map((command) => ({ ...command, description: typeof command.description === "string" ? command.description : "" }));
  const title = page === "root" ? t.quickSettings : page === "actions" ? t.taskActions : t.command;
  const renderMenu = (items: QuickSettingsItem[]) => <div className="quick-settings-menu" role="menu" aria-label={title} onKeyDown={handleRovingMenuKeyDown}>
    {items.map((item, index) => <button type="button" role="menuitem" key={item.id} data-entry={item.id} autoFocus={index === 0} disabled={item.disabled} onClick={item.action} title={item.description}>
      <Icon name={item.icon} /><span><strong>{item.label}</strong><small>{item.description}</small></span>{item.drilldown && <span className="quick-settings-drilldown"><Icon name="chevron" size={12} /></span>}
    </button>)}
  </div>;
  return <div className="settings-backdrop quick-settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="quick-settings-panel" id="quick-settings-panel" role="dialog" aria-modal="true" aria-labelledby="quick-settings-title">
      <div className="quick-settings-header">
        <span>{page !== "root" && <button type="button" className="icon-button quick-settings-back" title={t.backToQuickSettings} aria-label={t.backToQuickSettings} onClick={() => navigate("root")}><Icon name="chevron" size={13} /></button>}<h2 id="quick-settings-title">{title}</h2></span>
        <button type="button" className="icon-button" title={t.closeSettings} aria-label={t.closeSettings} onClick={onClose}><Icon name="x" /></button>
      </div>
      {page === "root" && renderMenu(rootItems)}
      {page === "actions" && renderMenu(actionItems)}
      {page === "commands" && <Command className="quick-settings-command" label={t.command} loop filter={(value, search, keywords = []) => `${value} ${keywords.join(" ")}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) ? 1 : 0}>
        <div className="quick-settings-search"><Icon name="search" /><Command.Input autoFocus value={query} onValueChange={setQuery} placeholder={t.searchCommands} aria-label={t.searchCommands} /><kbd>ESC</kbd></div>
        <Command.List className="quick-settings-list">
          <Command.Empty className="quick-settings-empty">{t.noMatchingCommands}</Command.Empty>
          <Command.Group className="quick-settings-group">{agentCoreCommands.map((command) => <Command.Item key={`command:${command.name}`} value={`command:${command.name}`} keywords={[`/${command.name}`, command.description]} onSelect={() => onCommand(command)} data-entry={`command:${command.name}`}><Icon name="command" /><span>{`/${command.name}`}</span><small>{command.source === "prompt" || command.source === "skill" ? `${t.insertTemplate} · ${command.description}` : command.description || t.agentCoreCommand}</small></Command.Item>)}</Command.Group>
        </Command.List>
      </Command>}
    </section>
  </div>;
}

export { QuickSettingsBoundary, QuickSettings };
