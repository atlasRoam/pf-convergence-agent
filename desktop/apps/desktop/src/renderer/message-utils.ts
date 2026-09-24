import { parseSkillInvocation, type TaskSummary } from "@pfsaa/domain";
import type { Language } from "@pfsaa/i18n";
import type { TaskUiState } from "./types";

export function createDefaultTaskUiState(): TaskUiState {
  return { isSending: false, isCompacting: false, streamText: "", workingPhase: null, activity: [], completedActivity: [], extensionStatuses: {}, extensionWidgets: [], extensionWorkingVisible: true };
}

export function resetExtensionPresentation(state: TaskUiState): TaskUiState {
  return {
    ...state,
    extensionStatuses: {},
    extensionWidgets: [],
    extensionHeader: undefined,
    extensionFooter: undefined,
    extensionEditor: undefined,
    extensionTerminalInputActive: false,
    extensionAutocomplete: undefined,
    extensionWorkingMessage: undefined,
    extensionWorkingVisible: true,
    extensionWorkingFrames: undefined,
    extensionWorkingInterval: undefined,
    extensionHiddenThinkingLabel: undefined,
    extensionToolsExpanded: false,
    extensionTheme: undefined,
    retryStatus: undefined,
  };
}

export function sortTasksByUpdatedAt(tasks: TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt);
    const bTime = Date.parse(b.updatedAt);
    return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
  });
}

export function textFromMessage(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((part: any) => part?.type === "text" ? part.text : "").filter(Boolean).join("\n");
}

export function bashExecutionDetails(message: any): {
  command: string;
  output: string;
  excludeFromContext: boolean;
  exitCode: number | null;
  cancelled: boolean;
  failed: boolean;
} | null {
  if (message?.role !== "bashExecution" || typeof message.command !== "string") return null;
  return {
    command: message.command,
    output: typeof message.output === "string" ? message.output : "",
    excludeFromContext: Boolean(message.excludeFromContext),
    exitCode: typeof message.exitCode === "number" ? message.exitCode : null,
    cancelled: Boolean(message.cancelled),
    failed: Boolean(message.cancelled || (typeof message.exitCode === "number" && message.exitCode !== 0)),
  };
}

/** Returns the text a user can actually see in one persisted message row. */
export function messageSearchText(message: any): string {
  const bash = bashExecutionDetails(message);
  if (bash) return `${bash.excludeFromContext ? "!!" : "!"}${bash.command}\n${bash.output}`;
  return [textFromMessage(message), messageErrorText(message)].filter(Boolean).join("\n");
}

// A failed model call (usage limits, provider/auth errors) surfaces as an
// assistant message with an empty text body plus stopReason "error" and
// errorMessage. The timeline must treat it as a real reply instead of
// dropping it. User-initiated aborts (stopReason "aborted") are deliberate
// and stay silent, matching the TUI.
export function messageErrorText(message: any): string {
  if (message?.role !== "assistant") return "";
  if (message?.stopReason !== "error") return "";
  const errorMessage = message?.errorMessage;
  return typeof errorMessage === "string" ? errorMessage.trim() : "";
}

export function messageIdentity(message: any): string | undefined {
  const id = typeof message?.id === "string" && message.id ? message.id : undefined;
  if (id) return `id:${id}`;
  // AgentCore messages are not guaranteed to expose an id. Their timestamp is
  // stable across message_start and the later full message.snapshot, so use
  // it with the role/content as a fallback identity. Without this, every
  // deferred snapshot appends the same message again.
  const timestamp = message?.timestamp;
  if ((typeof timestamp !== "string" && typeof timestamp !== "number") || !String(timestamp)) return undefined;
  const role = typeof message?.role === "string" ? message.role : "";
  const text = textFromMessage(message);
  const images = Array.isArray(message?.content)
    ? message.content.filter((part: any) => part?.type === "image").map((part: any) => part?.mimeType ?? "image").join(",")
    : "";
  return `message:${role}|${String(timestamp)}|${text}|${images}`;
}

function sameUserPrompt(left: any, right: any): boolean {
  if (left?.role !== "user" || right?.role !== "user") return false;
  if (textFromMessage(left) === textFromMessage(right)) return true;
  const leftSkill = parseSkillInvocation(textFromMessage(left));
  const rightSkill = parseSkillInvocation(textFromMessage(right));
  if (!leftSkill || !rightSkill || leftSkill.name !== rightSkill.name) return false;
  return (leftSkill.userMessage ?? "") === (rightSkill.userMessage ?? "");
}

function findLocalUserPrompt(messages: any[], target: any): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (typeof candidate?.id === "string" && candidate.id.startsWith("local-") && sameUserPrompt(candidate, target)) return index;
  }
  return -1;
}

export function mergeMessageSnapshot(previous: any[], snapshot: any[], authoritativeOrder = false): any[] {
  if (!snapshot.length) return previous;
  // Full session snapshots are already in AgentCore's canonical turn order. Sorting
  // them by timestamps is incorrect for queued turns because user messages
  // can be persisted before the assistant responses are finalized, which
  // groups all summaries before the actual replies. Rebuild from the
  // snapshot's order and only retain local/live messages that are not present.
  if (authoritativeOrder) {
    const usedPrevious = new Set<number>();
    const ordered = snapshot.map((message) => {
      const identity = messageIdentity(message);
      let index = identity
        ? previous.findIndex((item, itemIndex) => !usedPrevious.has(itemIndex) && messageIdentity(item) === identity)
        : -1;
      // Replace the optimistic local user message with AgentCore's persisted message.
      if (index < 0 && message?.role === "user") {
        index = findLocalUserPrompt(previous, message);
        while (index >= 0 && usedPrevious.has(index)) index = findLocalUserPrompt(previous.slice(0, index), message);
      }
      if (index >= 0) usedPrevious.add(index);
      return message;
    });
    for (const [index, message] of previous.entries()) if (!usedPrevious.has(index)) ordered.push(message);
    return ordered;
  }

  // Event-level snapshots (for example message_start) are incremental. Keep
  // the existing timeline order and replace matching messages in place.
  const merged = [...previous];
  for (const message of snapshot) {
    const identity = messageIdentity(message);
    let index = identity ? merged.findIndex((item) => messageIdentity(item) === identity) : -1;
    if (index < 0 && message?.role === "user") index = findLocalUserPrompt(merged, message);
    if (index >= 0) merged[index] = message;
    else merged.push(message);
  }
  return merged;
}

export function formatMessageTime(value: string | number | undefined, language: Language) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
