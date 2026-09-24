export interface FallbackCommand {
  name: string;
  description: string;
  source?: "extension";
}

const unavailablePfsaaCommands = new Set(["changelog", "import", "share", "trust"]);

export function isPfsaaAvailableCommand(name: string): boolean {
  return !unavailablePfsaaCommands.has(name.replace(/^\//, "").toLowerCase());
}

/**
 * Used only while AgentCore's ResourceLoader is unavailable. The authoritative
 * command list always comes from AgentCore's built-in slash command catalog.
 */
export const fallbackSlashCommands: FallbackCommand[] = [
  { name: "model", description: "Select model" },
  { name: "thinking", description: "Set thinking level" },
  { name: "scoped-models", description: "Configure model cycling" },
  { name: "export", description: "Export the current session" },
  { name: "name", description: "Rename the current session" },
  { name: "session", description: "Show session information" },
  { name: "tree", description: "Browse the session tree" },
  { name: "fork", description: "Fork from a previous user message" },
  { name: "clone", description: "Clone the active branch" },
  { name: "login", description: "Configure Provider authentication" },
  { name: "logout", description: "Remove Provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact the current context" },
  { name: "resume", description: "Resume another session" },
  { name: "reload", description: "Reload runtime resources" },
  { name: "settings", description: "Configure defaults" },
  { name: "copy", description: "Copy the last assistant message" },
  { name: "hotkeys", description: "View keyboard shortcuts" },
  { name: "quit", description: "Quit PFSAA" },
];
