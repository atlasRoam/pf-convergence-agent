import { useRef } from "react";
import type { TaskUiState } from "./types";
import { createDefaultTaskUiState } from "./message-utils";

const STREAM_RENDER_INTERVAL_MS = 32;

// Token deltas are batched into animation-frame-ish flushes so a fast provider
// cannot force the desktop shell to re-render the whole timeline per token.
export function useStreamDeltas(setTaskUi: React.Dispatch<React.SetStateAction<Record<string, TaskUiState>>>) {
  const streamDeltasRef = useRef<Record<string, string>>({});
  const streamFrameRef = useRef<number | null>(null);

  function flushStreamDeltas() {
    streamFrameRef.current = null;
    const pending = streamDeltasRef.current;
    streamDeltasRef.current = {};
    if (!Object.keys(pending).length) return;
    setTaskUi((current) => {
      const next = { ...current };
      for (const [pendingTaskId, text] of Object.entries(pending)) {
        const previous = next[pendingTaskId] ?? { ...createDefaultTaskUiState(), isSending: true, workingPhase: "responding" as const };
        next[pendingTaskId] = { ...previous, isSending: true, isCompacting: false, workingPhase: "responding", streamText: previous.streamText + text, toolName: undefined };
      }
      return next;
    });
  }

  function discardStreamDeltas(taskId: string) {
    delete streamDeltasRef.current[taskId];
    if (Object.keys(streamDeltasRef.current).length || streamFrameRef.current === null) return;
    window.clearTimeout(streamFrameRef.current);
    streamFrameRef.current = null;
  }

  function queueStreamDelta(taskId: string, delta: string) {
    streamDeltasRef.current[taskId] = `${streamDeltasRef.current[taskId] ?? ""}${delta}`;
    if (streamFrameRef.current !== null) return;
    streamFrameRef.current = window.setTimeout(flushStreamDeltas, STREAM_RENDER_INTERVAL_MS);
  }

  return { discardStreamDeltas, queueStreamDelta };
}
