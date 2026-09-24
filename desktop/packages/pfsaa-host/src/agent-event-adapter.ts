/**
 * Convert AgentCore AgentSession events into the small serializable event shape used
 * by the desktop bridge. Keeping this adapter separate from the lifecycle
 * orchestrator makes event compatibility changes local and testable.
 */
export function normalizeAgentEvent(event: any, queueDelivery?: "steer" | "followUp"): unknown {
  if (event.type === "message_update") {
    const streamEvent = event.assistantMessageEvent ?? {};
    return {
      type: event.type,
      stream: {
        type: streamEvent.type,
        delta: streamEvent.delta,
        content: streamEvent.content,
        reason: streamEvent.reason,
      },
    };
  }
  if (event.type === "message_start" || event.type === "message_end") {
    return { type: event.type, message: jsonSafe(event.message), ...(queueDelivery ? { queueDelivery } : {}) };
  }
  if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
    return {
      type: event.type,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: jsonSafe(event.args),
      partialResult: jsonSafe(event.partialResult),
      result: jsonSafe(event.result),
      isError: event.isError,
    };
  }
  if (event.type === "compaction_start") {
    return { type: event.type, reason: event.reason };
  }
  if (event.type === "compaction_end") {
    return {
      type: event.type,
      reason: event.reason,
      result: jsonSafe(event.result),
      aborted: event.aborted,
      willRetry: event.willRetry,
      errorMessage: event.errorMessage,
    };
  }
  if (event.type === "agent_end") {
    return { type: event.type, willRetry: event.willRetry, messages: jsonSafe(event.messages) };
  }
  if (event.type === "auto_retry_start" || event.type === "summarization_retry_scheduled") {
    return {
      type: event.type,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      errorMessage: event.errorMessage,
    };
  }
  if (event.type === "auto_retry_end") {
    return { type: event.type, success: event.success, attempt: event.attempt, finalError: event.finalError };
  }
  if (event.type === "summarization_retry_attempt_start") {
    return { type: event.type, source: event.source, reason: event.reason };
  }
  if (event.type === "summarization_retry_finished") return { type: event.type };
  if (event.type === "agent_settled" || event.type === "turn_start" || event.type === "turn_end") {
    return { type: event.type, willRetry: event.willRetry };
  }
  // AgentCore 0.84.4 exposes the lifecycle of blocking Extension UI prompts. Keep
  // the event shape explicit at the bridge boundary so future consumers do
  // not depend on arbitrary SDK objects leaking through the fallback path.
  if (event.type === "ui_prompt_start" || event.type === "ui_prompt_end") {
    return {
      type: event.type,
      reason: event.reason,
      kind: event.kind,
      ...(typeof event.title === "string" ? { title: event.title } : {}),
    };
  }
  return jsonSafe(event);
}

function jsonSafe<T>(value: T): T {
  if (value === undefined || value === null) return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return undefined as T;
  }
}
