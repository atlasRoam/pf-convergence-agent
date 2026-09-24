export type TaskState =
  | "idle"
  | "running"
  | "waiting-approval"
  | "compacting"
  | "retrying"
  | "completed"
  | "failed";

export interface ProjectSummary {
  id: string;
  cwd: string;
  name: string;
  taskCount: number;
}

export interface TaskSummary {
  id: string;
  title: string;
  projectId: string;
  state: TaskState;
  model: string;
  updatedAt: string;
  unread?: boolean;
}

export interface SkillInvocation {
  name: string;
  userMessage?: string;
  expanded: boolean;
}

const DEFAULT_SESSION_TITLES = new Set(["", "新建任务", "未命名任务", "new task", "untitled task"]);

/**
 * Parse both AgentCore's persisted expanded skill block and the original `/skill:name` input.
 * The expanded form intentionally mirrors AgentCore SDK's `parseSkillBlock()` contract.
 */
export function parseSkillInvocation(value: string): SkillInvocation | null {
  const text = value.trim();
  const expanded = /^<skill name="([^"]+)" location="[^"]+">\r?\n[\s\S]*?\r?\n<\/skill>(?:\r?\n\r?\n([\s\S]+))?$/.exec(text);
  if (expanded) {
    return {
      name: expanded[1],
      userMessage: expanded[2]?.trim() || undefined,
      expanded: true,
    };
  }

  const command = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!command) return null;
  return {
    name: command[1],
    userMessage: command[2]?.trim() || undefined,
    expanded: false,
  };
}

export function isDefaultSessionTitle(value: string | undefined): boolean {
  return DEFAULT_SESSION_TITLES.has((value ?? "").trim().toLowerCase());
}

export function isCommandDerivedSessionTitle(value: string | undefined): boolean {
  const title = (value ?? "").trim();
  return /^(?:\/|<skill\s|skill:\s*\S+)/i.test(title);
}

/**
 * Build a stable local session title from user-authored intent only. Runtime commands,
 * skill payloads, and leading resource references are context rather than title text.
 */
export function deriveSessionTitle(value: string): string {
  const skill = parseSkillInvocation(value);
  let text = (skill ? skill.userMessage ?? "" : value).trim();

  // Strip a leading AgentCore command or resource reference while preserving its arguments.
  text = text.replace(/^\/[A-Za-z][\w:-]*(?:\s+|$)/, "");
  text = text.replace(/^(?:@[\w./\\-]+\s+)+/, "");
  text = text.replace(/^(?:[#>*-]|\d+[.)])\s+/, "");
  text = text
    .replace(/^(?:(?:请|麻烦|劳烦)(?:你)?(?:帮我|帮忙)?|(?:帮我|帮忙))\s*/u, "")
    .replace(/^(?:please\s+|could you\s+|can you\s+)/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";

  const sentence = text.split(/[。！？!?；;\n]/u)[0]?.trim() ?? text;
  const hasHan = /\p{Script=Han}/u.test(sentence);
  let title = sentence;

  if (hasHan) {
    const commaIndex = title.search(/[，,]/u);
    if (commaIndex >= 8) title = title.slice(0, commaIndex);
    const characters = Array.from(title);
    if (characters.length > 28) title = `${characters.slice(0, 28).join("")}…`;
  } else {
    const words = title.split(/\s+/).filter(Boolean);
    if (words.length > 8) title = `${words.slice(0, 8).join(" ")}…`;
    if (Array.from(title).length > 60) title = `${Array.from(title).slice(0, 60).join("")}…`;
  }

  return title.replace(/[\s,，。.!！？;；:："'“”‘’]+$/u, "").trim();
}
