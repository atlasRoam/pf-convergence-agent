import { copy, type Language } from "@pfsaa/i18n";
import type { SessionRunRecord } from "@pfsaa/contracts";
import type { ActivityStep, WorkingPhase } from "./types";
import { messageErrorText, messageIdentity, textFromMessage } from "./message-utils";

export type MessageTimelineItem =
  | { type: "message"; message: any; index: number; stableKey?: string }
  | { type: "execution"; steps: ActivityStep[]; index: number; stableKey?: string; running?: boolean }
  | { type: "live"; text: string; index: number; stableKey: string; phase: WorkingPhase; toolName?: string; activitySteps: ActivityStep[] };

// Below these thresholds a running turn is too short (or has produced too
// little thinking) to be worth surfacing the live thinking panel; the compact
// WorkingIndicator already communicates "thinking". This keeps short tasks
// from flashing an expanded thinking block that immediately retracts.
const LIVE_THINKING_MIN_MS = 8_000;
const LIVE_THINKING_MIN_CHARS = 120;

function normalizeLiveThinkingText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    // Provider thinking deltas can contain long runs of blank lines. Keep one
    // paragraph break so the live feed stays compact without flattening prose.
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n")
    .trim();
}

function extractLiveActivitySteps(steps: ActivityStep[], now: number, hasReplyInTurn: boolean): ActivityStep[] {
  // When the running turn already shows a finalized assistant reply, only an
  // in-progress thinking stream below it is worth surfacing; ended thinking has
  // already been formalized into the reply above and must retract. Tool calls
  // remain visible while the run continues so the live feed preserves what the
  // agent actually did between two thinking blocks.
  const thinking = steps
    .filter((step) => step.kind === "thinking" && step.detail && (!hasReplyInTurn || !step.endedAt))
    .map((step) => ({ ...step, detail: normalizeLiveThinkingText(step.detail ?? "") }))
    .filter((step) => Boolean(step.detail));
  const thinkingById = new Map(thinking.map((step) => [step.id, step]));
  const tools = steps.filter((step) => step.kind === "tool");
  if (!thinking.length && !tools.length) return [];
  if (!tools.length) {
    const startedAt = Math.min(...thinking.map((step) => step.startedAt));
    const elapsed = now - startedAt;
    const textLength = thinking.reduce((length, step) => length + (step.detail?.length ?? 0), 0);
    if (textLength < LIVE_THINKING_MIN_CHARS && elapsed < LIVE_THINKING_MIN_MS) return [];
  }
  return steps.flatMap((step) => step.kind === "tool" ? [step] : thinkingById.get(step.id) ? [thinkingById.get(step.id)!] : []);
}

function activityFromMessages(messages: any[], language: Language): ActivityStep[] {
  const steps: ActivityStep[] = [];
  const toolSteps = new Map<string, ActivityStep>();
  let lastAssistantAt: number | undefined;
  let assistantMessageId: string | number | undefined;
  for (const message of messages) {
    const timestamp = typeof message?.timestamp === "number" ? message.timestamp : Date.parse(message?.timestamp ?? "") || Date.now();
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      lastAssistantAt = timestamp;
      assistantMessageId = message.id ?? timestamp;
      for (const part of message.content) {
        if (part?.type === "thinking" && part.thinking) steps.push({ id: `${message.id ?? timestamp}:thinking:${steps.length}`, kind: "thinking", label: copy[language].executionThinking, detail: part.thinking, startedAt: timestamp, endedAt: timestamp, timing: "unknown" });
        if (part?.type === "toolCall" || part?.type === "tool_call") {
          const step = { id: part.id ?? part.toolCallId ?? `${message.id ?? timestamp}:tool:${steps.length}`, kind: "tool" as const, label: part.name ?? part.toolName ?? copy[language].toolResult, args: part.arguments ?? part.args ?? {}, startedAt: timestamp, timing: "unknown" as const };
          steps.push(step);
          toolSteps.set(step.id, step);
        }
      }
    }
    if (message?.role === "assistant" && !Array.isArray(message.content)) {
      lastAssistantAt = timestamp;
      assistantMessageId = message.id ?? timestamp;
    }
    if (message?.role === "toolResult") {
      const toolId = message.toolCallId ?? message.tool_call_id;
      const step = toolSteps.get(toolId);
      if (step) {
        step.result = textFromMessage(message);
        step.endedAt = timestamp;
        step.isError = Boolean(message.isError);
      }
    }
  }
  // AgentCore may persist the final assistant text without its transient thinking
  // and tool events. Recreate a compact historical summary from the turn
  // without inventing a duration that was never persisted.
  if (!steps.length && lastAssistantAt !== undefined) {
    steps.push({
      id: `${assistantMessageId ?? lastAssistantAt}:summary`,
      kind: "thinking",
      label: copy[language].executionThinking,
      startedAt: lastAssistantAt,
      endedAt: lastAssistantAt,
      timing: "unknown",
    });
  }
  return steps;
}

/**
 * Rebuild the detailed execution steps after a session reload. AgentCore persists
 * thinking/tool messages separately from PFSAA's execution timing metadata;
 * keep the former for the expandable detail view and overlay the latter on
 * the first step so the summary duration remains authoritative.
 */
export function restoreCompletedActivity(messages: any[], language: Language, records: SessionRunRecord[]): ActivityStep[][] {
  const groups: ActivityStep[][] = [];
  let turn: any[] = [];
  let hasAssistantInTurn = false;
  const flushTurn = () => {
    if (!turn.length) return;
    const steps = activityFromMessages(turn, language);
    if (steps.length) groups.push(steps);
    turn = [];
    hasAssistantInTurn = false;
  };

  for (const message of messages) {
    if (message?.role === "compactionSummary") continue;
    if (message?.role === "user" && turn.length && hasAssistantInTurn) flushTurn();
    turn.push(message);
    if (message?.role === "assistant") hasAssistantInTurn = true;
  }
  flushTurn();

  // A message snapshot can be unavailable temporarily (or a provider may
  // omit all detail). Keep a useful summary row for those records rather than
  // dropping the persisted run completely.
  if (groups.length === 0 && records.length > 0) {
    return records.map((record) => [{
      id: `persisted:${record.id}`,
      kind: "thinking" as const,
      label: copy[language].executionThinking,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: record.durationMs,
      timing: "measured" as const,
    }]);
  }

  // Align metadata to the newest reconstructed groups. This mirrors the
  // timeline's existing offset handling when a session contains older turns
  // that were not observed during the current app lifetime.
  const groupOffset = Math.max(0, groups.length - records.length);
  const recordOffset = Math.max(0, records.length - groups.length);
  return groups.map((steps, groupIndex) => {
    const record = records[groupIndex - groupOffset + recordOffset];
    if (!record || steps.length === 0) return steps;
    return steps.map((step, stepIndex) => stepIndex === 0
      ? { ...step, durationMs: record.durationMs, timing: "measured" as const }
      : step);
  });
}

export function buildMessageTimelineItems({
  messages,
  language,
  running,
  completedActivity,
  steeringMessageKeys,
  taskId = "timeline",
  liveText = "",
  activeActivity = [],
  workingPhase = "thinking",
  toolName,
}: {
  messages: any[];
  language: Language;
  running: boolean;
  completedActivity: ActivityStep[][];
  steeringMessageKeys: string[];
  taskId?: string;
  liveText?: string;
  activeActivity?: ActivityStep[];
  workingPhase?: WorkingPhase;
  toolName?: string;
}): MessageTimelineItem[] {
  const items: MessageTimelineItem[] = [];
  const shellRun = running && toolName === "shell";
  let turn: any[] = [];
  let turnIndex = 0;
  let hasAssistantInTurn = false;
  const steeringKeys = new Set(steeringMessageKeys);

  // A steering message is delivered inside the current agent run, so it does
  // not create another logical turn or another completed activity summary.
  let userTurnCount = 0;
  let hasAssistantInLogicalTurn = false;
  let hasMessageInLogicalTurn = false;
  for (const message of messages) {
    // Compaction summary messages are AgentCore's context-fold bookkeeping, not a
    // user turn. Excluding them keeps turn grouping and activity alignment
    // correct after an auto/manual compaction rewrites the message list.
    if (message?.role === "compactionSummary") continue;
    const isSteeringMessage = message?.role === "user" && steeringKeys.has(messageIdentity(message) ?? "");
    if (message?.role === "user") {
      if (!hasMessageInLogicalTurn) {
        userTurnCount += 1;
        hasMessageInLogicalTurn = true;
      } else if (hasAssistantInLogicalTurn && !isSteeringMessage) {
        userTurnCount += 1;
        hasAssistantInLogicalTurn = false;
      }
    } else if (message?.role === "assistant") {
      hasAssistantInLogicalTurn = true;
    }
  }

  // completedActivity only covers turns observed during the current app
  // lifetime. Align it to the newest persisted turns when the session already
  // contains older history.
  const observedTurnCount = completedActivity.length + (running && !shellRun ? 1 : 0);
  const activityOffset = Math.max(0, userTurnCount - observedTurnCount);
  const flushTurn = (isFinal = false) => {
    if (!turn.length) return;
    const activeTurn = isFinal && running && !shellRun;
    // Runtime activity has the real start/end times. Persisted messages only
    // retain a result timestamp, which would make every historical summary
    // appear as 0s and can associate a queued turn with the previous one.
    const recordedActivity = completedActivity[turnIndex - activityOffset];
    const steps = activeTurn && activeActivity.length
      ? activeActivity
      : recordedActivity?.length
      ? recordedActivity
      : activityFromMessages(turn, language);
    const responseKey = `response-${taskId}-${turnIndex}`;
    let hasAssistantText = false;
    if (!steps.length && !activeTurn) {
      for (const [index, message] of turn.entries()) if (message?.role !== "toolResult") items.push({ type: "message", message, index: items.length + index });
      turn = [];
      hasAssistantInTurn = false;
      turnIndex += 1;
      return;
    }
    // Keep every user message in a shared steering turn. The summary is
    // inserted once immediately before the first assistant reply, so all
    // inputs are visible above it and the response follows below it.
    let summaryInserted = false;
    const finalAssistantMessage = [...turn].reverse().find((message) => message?.role === "assistant" && (textFromMessage(message) || messageErrorText(message)));
    for (const message of turn) {
      if (message?.role === "user") {
        items.push({ type: "message", message, index: items.length });
      } else if (message?.role === "assistant" && (textFromMessage(message) || messageErrorText(message))) {
        hasAssistantText = true;
        // While a queued turn is running, keep earlier turns (which are no
        // longer the final turn) visible with their completed execution summary.
        if (!summaryInserted && (activeTurn || !running || !isFinal) && steps.length) {
          items.push({ type: "execution", steps, index: items.length, stableKey: `execution-${steps[0]?.id ?? `${taskId}-${turnIndex}`}`, running: activeTurn });
          summaryInserted = true;
        }
        // Only the settled turn's final Assistant record replaces the live row.
        // Earlier progress/commentary messages keep their own identities; using
        // one response key for every record creates duplicate React keys.
        items.push({ type: "message", message, index: items.length, stableKey: isFinal && !activeTurn && message === finalAssistantMessage ? responseKey : undefined });
      }
    }
    // A completed turn can contain user messages without a textual assistant
    // reply (for example an interrupted/empty response). Keep its summary
    // visible after the inputs instead of dropping it.
    if (!summaryInserted && (activeTurn || !running || !isFinal) && steps.length) {
      items.push({ type: "execution", steps, index: items.length, stableKey: `execution-${steps[0]?.id ?? `${taskId}-${turnIndex}`}`, running: activeTurn });
    }
    // A running turn may already contain an earlier assistant reply (for
    // example when the user steers mid-run, or AgentCore auto-retries after a tool
    // error). The live thinking panel must still appear for the *current*
    // round: it renders below the prior reply and shows the fresh thinking
    // stream. Gating on `!hasAssistantText` would suppress it for every round
    // after the first, leaving the user with only the bare working indicator.
    if (activeTurn) {
      items.push({ type: "live", text: liveText, index: items.length, stableKey: responseKey, phase: workingPhase, toolName, activitySteps: extractLiveActivitySteps(activeActivity, Date.now(), hasAssistantText) });
    }
    turn = [];
    hasAssistantInTurn = false;
    turnIndex += 1;
  };

  for (const message of messages) {
    // Compaction summary entries carry no user/assistant content and must not
    // open or extend a turn; the summary itself is rendered by PFSAA as part
    // of the execution activity, not as a timeline message.
    if (message?.role === "compactionSummary") continue;
    // AgentCore persists user `!` / `!!` commands as standalone bashExecution
    // messages. They are not part of the surrounding model turn.
    if (message?.role === "bashExecution") {
      flushTurn();
      items.push({ type: "message", message, index: items.length });
      continue;
    }
    // Steering messages are delivered inside the current agent run. Keep
    // them in the same timeline turn so the run has one shared summary.
    const isSteeringMessage = message?.role === "user" && steeringKeys.has(messageIdentity(message) ?? "");
    if (message?.role === "user" && turn.length && !isSteeringMessage && hasAssistantInTurn) flushTurn();
    turn.push(message);
    if (message?.role === "assistant") hasAssistantInTurn = true;
  }
  flushTurn(true);
  // Shell commands have no optimistic user message, so their AgentCore streaming
  // events need an independent live row instead of borrowing the preceding
  // conversation turn. The persisted bashExecution message replaces it when
  // the command completes.
  if (shellRun) {
    items.push({
      type: "live",
      text: "",
      index: items.length,
      stableKey: `bash-live-${taskId}-${activeActivity.at(-1)?.id ?? "shell"}`,
      phase: "tool",
      toolName: "shell",
      activitySteps: extractLiveActivitySteps(activeActivity, Date.now(), false),
    });
  }
  return items;
}
