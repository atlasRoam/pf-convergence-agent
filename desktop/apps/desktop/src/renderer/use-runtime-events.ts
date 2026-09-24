import { useEffect, useEffectEvent, useRef } from "react";
import { parseExtensionTheme } from "./extension-theme";
import type { AgentQueueState, ContextUsage, ExtensionUiRequest, PfsaaRuntimeEvent, SessionChangeReview, SessionChangeReviewAvailability, SessionChangeReviewUnavailableReason, SessionRunRecord } from "@pfsaa/contracts";
import type { TaskSummary } from "@pfsaa/domain";
import { applicationTitle, copy, type Language } from "@pfsaa/i18n";
import type { ActivityStep, TaskUiState } from "./types";
import { createDefaultTaskUiState, mergeMessageSnapshot, messageIdentity, resetExtensionPresentation, sortTasksByUpdatedAt } from "./message-utils";

function applyPersistedRunDurations(groups: ActivityStep[][], records: SessionRunRecord[]): ActivityStep[][] {
  const groupOffset = Math.max(0, groups.length - records.length);
  const recordOffset = Math.max(0, records.length - groups.length);
  return groups.map((steps, groupIndex) => {
    const record = records[groupIndex - groupOffset + recordOffset];
    if (!record || steps.length === 0) return steps;
    return steps.map((step, stepIndex) => stepIndex === 0
      ? { ...step, durationMs: record.durationMs, timing: "measured" }
      : step);
  });
}

export interface RuntimeEventsOptions {
  projectCwd: string;
  language: Language;
  activeTaskId?: string;
  queueModes: Partial<Pick<AgentQueueState, "steeringMode" | "followUpMode">>;
  queueState: AgentQueueState | null;
  setRuntimeStatus: (status: "connected" | "starting" | "disconnected") => void;
  showNotice: (message: string, kind?: "info" | "warning" | "error") => void;
  patchTaskUi: (taskId: string, patch: Partial<TaskUiState>) => void;
  updateTaskLists: (update: (tasks: TaskSummary[]) => TaskSummary[]) => void;
  discardStreamDeltas: (taskId: string) => void;
  queueStreamDelta: (taskId: string, delta: string) => void;
  updateActivity: (taskId: string, update: (steps: ActivityStep[]) => ActivityStep[]) => void;
  setQueueState: (state: AgentQueueState | null) => void;
  setExtensionUiRequest: React.Dispatch<React.SetStateAction<ExtensionUiRequest | null>>;
  setSteeringMessageKeysByTask: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  setMessagesByTask: React.Dispatch<React.SetStateAction<Record<string, any[]>>>;
  setTaskUi: React.Dispatch<React.SetStateAction<Record<string, TaskUiState>>>;
  setMessageLoads: React.Dispatch<React.SetStateAction<Record<string, { status: "idle" | "loading" | "ready" | "error"; error?: string }>>>;
  setContextUsage: (usage: ContextUsage | undefined) => void;
  setActiveTask: React.Dispatch<React.SetStateAction<TaskSummary | null>>;
  refreshWorkspace: () => Promise<void>;
  onQueueActivity: () => void;
  onChangeReviewUpdated: (taskId: string, review: SessionChangeReview) => void;
  onChangeReviewStatus: (taskId: string, availability: SessionChangeReviewAvailability, reason?: SessionChangeReviewUnavailableReason) => void;
  onExtensionEditorText: (text: string) => void;
  onExtensionEditorSubmit: (text: string) => void;
  onSessionReplaced: (task: TaskSummary, previousTaskId: string) => void;
}

export function useRuntimeEvents({
  projectCwd, language, activeTaskId, queueModes, queueState, setRuntimeStatus, showNotice,
  patchTaskUi, updateTaskLists, discardStreamDeltas, queueStreamDelta, updateActivity,
  setQueueState, setExtensionUiRequest, setSteeringMessageKeysByTask, setMessagesByTask,
  setTaskUi, setMessageLoads, setContextUsage, setActiveTask, refreshWorkspace,
  onQueueActivity, onChangeReviewUpdated, onChangeReviewStatus, onExtensionEditorText, onExtensionEditorSubmit,
  onSessionReplaced,
}: RuntimeEventsOptions) {
  const replacementTaskIdRef = useRef<string | undefined>(undefined);
  useEffect(() => { replacementTaskIdRef.current = undefined; }, [activeTaskId]);
  // Context usage only belongs to the conversation currently on screen; a
  // background task in another project must not overwrite it. Fetching per
  // event is also cheap to skip: refresh only on boundaries worth reflecting.
  const refreshContextUsage = (taskId: string) => {
    void window.pfsaa.sessions.capabilities(taskId, projectCwd).then((next) => setContextUsage(next.contextUsage)).catch(() => undefined);
  };
  const noticeKind = (level: unknown): "info" | "warning" | "error" => level === "error" || level === "warning" ? level : "info";
  const handleRuntimeEvent = useEffectEvent((runtimeEvent: PfsaaRuntimeEvent) => {
    if (runtimeEvent.type === "runtime.status") {
      const status = runtimeEvent.payload;
      if (status === "connected" || status === "starting" || status === "disconnected") setRuntimeStatus(status);
      return;
    }
    if (runtimeEvent.type === "runtime.error") {
      const payload = runtimeEvent.payload as { message?: string } | undefined;
      setRuntimeStatus("disconnected");
      showNotice(`${copy[language].runtimeStartFailed}: ${payload?.message ?? copy[language].runtimeDisconnected}`, "error");
      return;
    }
    if (runtimeEvent.type === "extension.ui.request" && runtimeEvent.event && typeof runtimeEvent.event === "object") {
      setExtensionUiRequest(runtimeEvent.event as ExtensionUiRequest);
      return;
    }
    if (runtimeEvent.type === "extension.ui.notify") {
      const event = runtimeEvent.event as { message?: string; level?: string } | undefined;
      if (event?.message) showNotice(event.message, noticeKind(event.level));
      return;
    }
    if (runtimeEvent.type === "agent.event" && (runtimeEvent.event as any)?.type === "extension.ui.notify") {
      const event = runtimeEvent.event as { message?: string; level?: string } | undefined;
      if (event?.message) showNotice(event.message, noticeKind(event.level));
      return;
    }
    const taskId = runtimeEvent.taskId;
    if (!taskId) return;
    if (runtimeEvent.type === "approval.requested" && runtimeEvent.requestId) {
      const event = runtimeEvent.event as { toolName?: string; args?: unknown } | undefined;
      patchTaskUi(taskId, { approval: { requestId: runtimeEvent.requestId, toolName: event?.toolName ?? copy[language].toolResult, args: event?.args }, workingPhase: null });
      updateTaskLists((current) => current.map((task) => task.id === taskId ? { ...task, state: "waiting-approval" } : task));
      return;
    }
    if (runtimeEvent.type === "approval.resolved" && runtimeEvent.requestId) {
      const event = runtimeEvent.event as { decision?: "allow-once" | "deny" } | undefined;
      patchTaskUi(taskId, { approval: undefined, workingPhase: event?.decision === "allow-once" ? "thinking" : null });
      updateTaskLists((current) => current.map((task) => task.id === taskId ? { ...task, state: event?.decision === "allow-once" ? "running" : task.state } : task));
      return;
    }
    if (runtimeEvent.type !== "agent.event") return;
    const event = runtimeEvent.event as any;
    if (event?.type === "session.replaced" && event.task && typeof event.task === "object") {
      const nextTask = event.task as TaskSummary;
      const previousTaskId = typeof event.previousTaskId === "string" ? event.previousTaskId : taskId;
      if (activeTaskId === previousTaskId) replacementTaskIdRef.current = nextTask.id;
      setMessagesByTask((current) => current[nextTask.id] ? current : { ...current, [nextTask.id]: [] });
      setMessageLoads((current) => ({ ...current, [nextTask.id]: { status: "loading" } }));
      setTaskUi((current) => ({ ...current, [nextTask.id]: current[nextTask.id] ?? createDefaultTaskUiState() }));
      setQueueState(null);
      onSessionReplaced(nextTask, previousTaskId);
      return;
    }
    if (event?.type === "extension.shutdown.requested") {
      void window.pfsaa.app.quit();
      return;
    }
    if (event?.type === "extension.error") {
      const message = typeof event.error === "string" ? event.error : copy[language].extensionErrorUnknown;
      showNotice(copy[language].extensionError(message), "error");
      return;
    }
    if (event?.type === "extension.diagnostics" && Array.isArray(event.diagnostics) && event.diagnostics.length > 0) {
      const first = event.diagnostics.find((diagnostic: any) => diagnostic?.type === "error") ?? event.diagnostics[0];
      const detail = typeof first?.message === "string" ? first.message : copy[language].extensionErrorUnknown;
      showNotice(copy[language].extensionDiagnostics(detail, event.diagnostics.length), event.diagnostics.some((diagnostic: any) => diagnostic?.type === "error") ? "error" : event.diagnostics.some((diagnostic: any) => diagnostic?.type === "warning") ? "warning" : "info");
      return;
    }
    if (event?.type === "model.fallback" && typeof event.message === "string") {
      showNotice(event.message, "warning");
      return;
    }
    if (event?.type === "extension.ui.dismiss" && typeof event.requestId === "string") {
      setExtensionUiRequest((current) => current?.requestId === event.requestId ? null : current);
      return;
    }
    if (event?.type === "extension.ui.presentation") {
      if (event.action === "reset" && taskId === activeTaskId) document.title = applicationTitle;
      if (event.action === "editor-text" && (taskId === activeTaskId || taskId === replacementTaskIdRef.current) && typeof event.text === "string") onExtensionEditorText(event.text);
      if (event.action === "editor-submit" && (taskId === activeTaskId || taskId === replacementTaskIdRef.current) && typeof event.text === "string") onExtensionEditorSubmit(event.text);
      if (event.action === "title" && taskId === activeTaskId && typeof event.title === "string" && event.title.trim()) document.title = `${event.title.trim()} | ${applicationTitle}`;
      setTaskUi((current) => {
        const previous = current[taskId] ?? createDefaultTaskUiState();
        if (event.action === "reset") return { ...current, [taskId]: resetExtensionPresentation(previous) };
        if (event.action === "status" && typeof event.key === "string") {
          const statuses = { ...(previous.extensionStatuses ?? {}) };
          if (typeof event.text === "string" && event.text) statuses[event.key] = event.text;
          else delete statuses[event.key];
          return { ...current, [taskId]: { ...previous, extensionStatuses: statuses } };
        }
        if (event.action === "widget" && typeof event.key === "string") {
          const widgets = (previous.extensionWidgets ?? []).filter((widget) => widget.key !== event.key);
          if (Array.isArray(event.lines)) widgets.push({ key: event.key, lines: event.lines.filter((line: unknown): line is string => typeof line === "string"), placement: event.placement === "belowEditor" ? "belowEditor" : "aboveEditor" });
          return { ...current, [taskId]: { ...previous, extensionWidgets: widgets } };
        }
        if (event.action === "header") return { ...current, [taskId]: { ...previous, extensionHeader: Array.isArray(event.lines) ? event.lines.filter((line: unknown): line is string => typeof line === "string") : undefined } };
        if (event.action === "footer") return { ...current, [taskId]: { ...previous, extensionFooter: Array.isArray(event.lines) ? event.lines.filter((line: unknown): line is string => typeof line === "string") : undefined } };
        if (event.action === "editor") return { ...current, [taskId]: { ...previous, extensionEditor: event.active === true ? { active: true, lines: Array.isArray(event.lines) ? event.lines.filter((line: unknown): line is string => typeof line === "string") : [] } : undefined } };
        if (event.action === "terminal-input") return { ...current, [taskId]: { ...previous, extensionTerminalInputActive: event.active === true } };
        if (event.action === "autocomplete") return { ...current, [taskId]: { ...previous, extensionAutocomplete: event.active === true ? { active: true, triggerCharacters: Array.isArray(event.triggerCharacters) ? event.triggerCharacters.filter((item: unknown): item is string => typeof item === "string") : [] } : undefined } };
        if (event.action === "working-message") return { ...current, [taskId]: { ...previous, extensionWorkingMessage: typeof event.message === "string" ? event.message : undefined } };
        if (event.action === "working-visible") return { ...current, [taskId]: { ...previous, extensionWorkingVisible: event.visible !== false } };
        if (event.action === "working-indicator") {
          const frames = Array.isArray(event.indicator?.frames) ? event.indicator.frames.filter((frame: unknown): frame is string => typeof frame === "string") : undefined;
          const interval = typeof event.indicator?.interval === "number" ? Math.max(50, event.indicator.interval) : undefined;
          return { ...current, [taskId]: { ...previous, extensionWorkingFrames: frames, extensionWorkingInterval: interval } };
        }
        if (event.action === "hidden-thinking-label") return { ...current, [taskId]: { ...previous, extensionHiddenThinkingLabel: typeof event.label === "string" ? event.label : undefined } };
        if (event.action === "tools-expanded") return { ...current, [taskId]: { ...previous, extensionToolsExpanded: event.expanded === true } };
        if (event.action === "theme") return { ...current, [taskId]: { ...previous, extensionTheme: parseExtensionTheme(event.theme) } };
        return current;
      });
      return;
    }
    if (event?.type === "extension.ui.unsupported" && typeof event.capability === "string") { showNotice(copy[language].extensionUiUnsupported(event.capability), "warning"); return; }
    if (event?.type === "prompt_error" && typeof event.message === "string") { showNotice(event.message, "error"); return; }
    if (event?.type === "change-review.updated" && event.review && typeof event.review === "object") {
      onChangeReviewUpdated(taskId, event.review as SessionChangeReview);
      return;
    }
    if (event?.type === "change-review.status" && (event.availability === "available" || event.availability === "not-git" || event.availability === "error")) {
      onChangeReviewStatus(taskId, event.availability, event.reason);
      return;
    }
    if (event?.type === "queue_update") {
      if (taskId === activeTaskId) {
        const queueMessages = (value: unknown) => Array.isArray(value) ? value.filter((message): message is AgentQueueState["steering"][number] => Boolean(message && typeof message === "object" && typeof (message as { id?: unknown }).id === "string" && typeof (message as { text?: unknown }).text === "string")).map((message) => ({ ...message, images: Array.isArray(message.images) ? [...message.images] : [] })) : [];
        const nextQueue: AgentQueueState = { steering: queueMessages(event.steering), followUp: queueMessages(event.followUp), steeringMode: event.steeringMode ?? queueState?.steeringMode ?? queueModes.steeringMode ?? "one-at-a-time", followUpMode: event.followUpMode ?? queueState?.followUpMode ?? queueModes.followUpMode ?? "one-at-a-time" };
        setQueueState(nextQueue);
        onQueueActivity();
      }
      return;
    }
    if (event?.type === "agent_start") {
      discardStreamDeltas(taskId);
      setTaskUi((current) => {
        const previous = current[taskId] ?? createDefaultTaskUiState();
        const startedAt = Date.now();
        const activity = previous.activity.length > 0 ? previous.activity : [{ id: `${taskId}:thinking:${startedAt}`, kind: "thinking" as const, label: copy[language].executionThinking, startedAt }];
        return { ...current, [taskId]: { ...previous, isSending: true, isCompacting: false, workingPhase: "thinking", streamText: "", toolName: undefined, activity } };
      });
      const updatedAt = new Date().toISOString();
      updateTaskLists((current) => sortTasksByUpdatedAt(current.map((task) => task.id === taskId ? { ...task, state: "running", updatedAt } : task)));
      if (taskId === activeTaskId) refreshContextUsage(taskId);
    } else if (event?.type === "message_start" && event.message?.role === "user") {
      const queueDelivery = event.queueDelivery === "steer" ? "steer" : "followUp";
      discardStreamDeltas(taskId);
      const steeringMessageKey = queueDelivery === "steer" ? messageIdentity(event.message) : undefined;
      if (steeringMessageKey) setSteeringMessageKeysByTask((current) => ({ ...current, [taskId]: [...new Set([...(current[taskId] ?? []), steeringMessageKey])] }));
      setMessagesByTask((current) => ({ ...current, [taskId]: mergeMessageSnapshot(current[taskId] ?? [], [event.message]) }));
      if (event.queueDelivery && taskId === activeTaskId) onQueueActivity();
      setTaskUi((current) => {
        const previous = current[taskId] ?? { ...createDefaultTaskUiState(), isSending: true };
        const hasCompletedWork = previous.activity.some((step) => step.endedAt || step.kind === "tool" || Boolean(step.detail));
        const startedAt = Date.now();
        // A steering message opens a *new* reasoning round inside the same run.
        // Reset activity to a fresh thinking step (so the live panel shows only
        // the current round's thinking, not the stale prior one) and archive the
        // previous round's steps into completedActivity so its summary renders.
        // Keeping the old activity would leak round-1 thinking into round 2+ and
        // never let the live panel retract into a collapsed summary.
        const freshActivity = [{ id: `${taskId}:thinking:${startedAt}`, kind: "thinking" as const, label: copy[language].executionThinking, startedAt }];
        return { ...current, [taskId]: { ...previous, isSending: true, isCompacting: false, workingPhase: "thinking", streamText: "", toolName: undefined, activity: freshActivity, completedActivity: hasCompletedWork ? [...previous.completedActivity, previous.activity] : previous.completedActivity } };
      });
    } else if (event?.type === "turn_start") patchTaskUi(taskId, { workingPhase: "thinking", toolName: undefined, retryStatus: undefined });
    else if (event?.type === "compaction_start") patchTaskUi(taskId, { isCompacting: true, workingPhase: "compacting", toolName: undefined, retryStatus: undefined });
    else if (event?.type === "compaction_end") { patchTaskUi(taskId, { isCompacting: false, workingPhase: "thinking", retryStatus: undefined }); if (taskId === activeTaskId) refreshContextUsage(taskId); }
    else if (event?.type === "auto_retry_start") {
      patchTaskUi(taskId, { isSending: true, workingPhase: "retrying", toolName: undefined, retryStatus: { kind: "agent", attempt: Number(event.attempt) || 1, maxAttempts: Number(event.maxAttempts) || 1, delayMs: Number(event.delayMs) || 0, errorMessage: typeof event.errorMessage === "string" ? event.errorMessage : undefined } });
    }
    else if (event?.type === "auto_retry_end") {
      patchTaskUi(taskId, { retryStatus: undefined, workingPhase: event.success ? "thinking" : null });
      if (!event.success && typeof event.finalError === "string") showNotice(copy[language].autoRetryFailed(event.finalError), "error");
    }
    else if (event?.type === "summarization_retry_scheduled") {
      patchTaskUi(taskId, { isCompacting: true, workingPhase: "summarizing", retryStatus: { kind: "summarization", attempt: Number(event.attempt) || 1, maxAttempts: Number(event.maxAttempts) || 1, delayMs: Number(event.delayMs) || 0, errorMessage: typeof event.errorMessage === "string" ? event.errorMessage : undefined } });
    }
    else if (event?.type === "summarization_retry_attempt_start") {
      setTaskUi((current) => { const previous = current[taskId] ?? createDefaultTaskUiState(); return { ...current, [taskId]: { ...previous, isCompacting: true, workingPhase: "summarizing", retryStatus: previous.retryStatus ? { ...previous.retryStatus, source: event.source === "branchSummary" ? "branchSummary" : "compaction", delayMs: 0 } : { kind: "summarization", attempt: 1, maxAttempts: 1, delayMs: 0, source: event.source === "branchSummary" ? "branchSummary" : "compaction" } } }; });
    }
    else if (event?.type === "summarization_retry_finished") {
      patchTaskUi(taskId, { retryStatus: undefined, workingPhase: "compacting" });
    }
    else if (event?.type === "message_start" || event?.type === "message_end") {
      if (taskId === activeTaskId) refreshContextUsage(taskId);
    }
    else if (event?.type === "message_update" && event.stream?.type === "thinking_delta" && event.stream.delta) {
      updateActivity(taskId, (steps) => { const last = steps[steps.length - 1]; if (last?.kind === "thinking" && !last.endedAt) return [...steps.slice(0, -1), { ...last, detail: `${last.detail ?? ""}${event.stream.delta}` }]; return [...steps, { id: `${taskId}:thinking:${Date.now()}`, kind: "thinking", label: copy[language].executionThinking, detail: event.stream.delta, startedAt: Date.now() }]; });
      patchTaskUi(taskId, { workingPhase: "thinking" });
    } else if (event?.type === "message_update" && event.stream?.type === "text_delta" && event.stream.delta) {
      updateActivity(taskId, (steps) => steps.map((step) => step.kind === "thinking" && !step.endedAt ? { ...step, endedAt: Date.now() } : step));
      queueStreamDelta(taskId, event.stream.delta);
    } else if (event?.type === "bash_execution_start") {
      const startedAt = Date.now();
      updateActivity(taskId, (steps) => [...steps, { id: event.id ?? `${taskId}:bash:${startedAt}`, kind: "tool", label: event.excludeFromContext ? "!! shell" : "! shell", args: { command: event.command }, startedAt }]);
      patchTaskUi(taskId, { isSending: true, workingPhase: "tool", toolName: "shell" });
    } else if (event?.type === "bash_execution_update") {
      updateActivity(taskId, (steps) => steps.map((step) => step.id === event.id ? { ...step, result: `${typeof step.result === "string" ? step.result : ""}${event.delta ?? ""}` } : step));
    } else if (event?.type === "bash_execution_end") {
      updateActivity(taskId, (steps) => steps.map((step) => step.id === event.id ? { ...step, endedAt: Date.now(), result: event.result?.output ?? step.result, isError: Boolean(event.error || (typeof event.result?.exitCode === "number" && event.result.exitCode !== 0)) } : step));
    } else if (event?.type === "tool_execution_start") {
      const startedAt = Date.now();
      updateActivity(taskId, (steps) => [...steps.map((step) => step.kind === "thinking" && !step.endedAt ? { ...step, endedAt: startedAt } : step), { id: event.toolCallId ?? `${taskId}:tool:${startedAt}`, kind: "tool", label: event.toolName ?? copy[language].toolResult, args: event.args, startedAt }]);
      patchTaskUi(taskId, { workingPhase: "tool", toolName: event.toolName });
    } else if (event?.type === "tool_execution_update") updateActivity(taskId, (steps) => steps.map((step) => step.id === event.toolCallId ? { ...step, result: event.partialResult } : step));
    else if (event?.type === "tool_execution_end") { updateActivity(taskId, (steps) => steps.map((step) => step.id === event.toolCallId ? { ...step, endedAt: Date.now(), result: event.result, isError: Boolean(event.isError) } : step)); patchTaskUi(taskId, { workingPhase: "thinking", toolName: undefined }); if (taskId === activeTaskId) refreshContextUsage(taskId); }
    else if (event?.type === "session_info_changed" && typeof event.name === "string" && event.name.trim()) { const title = event.name.trim(); updateTaskLists((current) => current.map((task) => task.id === taskId ? { ...task, title } : task)); setActiveTask((current) => current?.id === taskId ? { ...current, title } : current); }
    else if (event?.type === "message.snapshot") {
      discardStreamDeltas(taskId);
      const snapshot = Array.isArray(event.messages) ? event.messages : [];
      // Compaction snapshots carry `replace` because AgentCore rewrote its message
      // list in place (older turns folded into a compactionSummary). Merge
      // semantics would keep the folded-away messages after the summary and
      // break the timeline order; swapping is the only correct interpretation.
      setMessagesByTask((current) => ({ ...current, [taskId]: event.replace ? snapshot : mergeMessageSnapshot(current[taskId] ?? [], snapshot, true) }));
      setMessageLoads((current) => ({ ...current, [taskId]: { status: "ready" } }));
      patchTaskUi(taskId, { streamText: "" });
    }
    else if (event?.type === "agent_end") {
      discardStreamDeltas(taskId);
      // PfsaaHost emits authoritative message snapshots on message_end and
      // agent_settled. `agent_end.messages` is the loop's new-message batch,
      // not a second canonical transcript; merging both paths duplicates
      // replies when compaction has rebuilt message objects without ids.
      if (Array.isArray(event.messages) && event.messages.length > 0) {
        setMessageLoads((current) => ({ ...current, [taskId]: { status: "ready" } }));
      }
      updateActivity(taskId, (steps) => steps.map((step) => step.endedAt ? step : { ...step, endedAt: Date.now() }));
      patchTaskUi(taskId, { workingPhase: "thinking", streamText: "", toolName: undefined });
    }
    else if (event?.type === "agent_settled") {
      // A settle with willRetry means AgentCore is only pausing before an automatic
      // retry (e.g. after a tool error). Do not tear down the running state:
      // the next turn_start keeps streaming, and clearing isSending/activity
      // here would make the spinner and live timer vanish permanently.
      if (event.willRetry) {
        patchTaskUi(taskId, { workingPhase: "thinking", toolName: undefined });
        return;
      }
      discardStreamDeltas(taskId);
      const endedAt = Date.now();
      updateActivity(taskId, (steps) => steps.map((step) => step.endedAt ? step : { ...step, endedAt }));
      setTaskUi((current) => { const previous = current[taskId] ?? createDefaultTaskUiState(); const completedActivity = previous.activity.length > 0 ? [...previous.completedActivity, previous.activity.map((step) => step.endedAt ? step : { ...step, endedAt })] : previous.completedActivity; return { ...current, [taskId]: { ...previous, isSending: false, isCompacting: false, workingPhase: null, streamText: "", toolName: undefined, retryStatus: undefined, activity: [], completedActivity } }; });
      void window.pfsaa.sessions.messages(taskId, projectCwd).then((next) => { setMessagesByTask((current) => ({ ...current, [taskId]: mergeMessageSnapshot(current[taskId] ?? [], next as any[], true) })); setMessageLoads((current) => ({ ...current, [taskId]: { status: "ready" } })); }).catch((error) => setMessageLoads((current) => ({ ...current, [taskId]: { status: "error", error: error instanceof Error ? error.message : String(error) } })));
      // Read back the record PfsaaHost just appended so the completed view and a
      // later restart use the same authoritative duration value.
      void window.pfsaa.sessions.runMetadata(taskId, projectCwd).then((records) => setTaskUi((current) => {
        const previous = current[taskId] ?? createDefaultTaskUiState();
        return { ...current, [taskId]: { ...previous, completedActivity: applyPersistedRunDurations(previous.completedActivity, records) } };
      })).catch(() => undefined);
      if (taskId === activeTaskId) refreshContextUsage(taskId);
      void refreshWorkspace();
      updateTaskLists((current) => sortTasksByUpdatedAt(current.map((task) => task.id === taskId ? { ...task, state: "idle", updatedAt: new Date().toISOString() } : task)));
    }
  });
  useEffect(() => window.pfsaa.events.subscribe(handleRuntimeEvent), []);
}
