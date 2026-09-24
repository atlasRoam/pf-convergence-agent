import { useEffect } from "react";
import type { ContextUsage, ModelSummary, SessionCapabilities } from "@pfsaa/contracts";
import { copy, type Language } from "@pfsaa/i18n";
import { createDefaultTaskUiState } from "./message-utils";
import type { MessageLoad, TaskUiState } from "./types";
import { restoreCompletedActivity } from "./timeline-utils";

export interface SessionDataOptions {
  projectCwd: string;
  taskId?: string;
  language: Language;
  models: ModelSummary[];
  messageReload: number;
  setMessageLoads: React.Dispatch<React.SetStateAction<Record<string, MessageLoad>>>;
  setMessagesByTask: React.Dispatch<React.SetStateAction<Record<string, any[]>>>;
  setTaskUi: React.Dispatch<React.SetStateAction<Record<string, TaskUiState>>>;
  setCapabilities: React.Dispatch<React.SetStateAction<SessionCapabilities | null>>;
  setActiveModel: React.Dispatch<React.SetStateAction<ModelSummary | null>>;
  setThinkingLevel: (level: string) => void;
  setThinkingLevels: (levels: string[]) => void;
  setContextUsage: (usage: ContextUsage | undefined) => void;
  showNotice: (message: string) => void;
}

export function useSessionData({
  projectCwd, taskId, language, models, messageReload, setMessageLoads, setMessagesByTask, setTaskUi,
  setCapabilities, setActiveModel, setThinkingLevel, setThinkingLevels, setContextUsage, showNotice,
}: SessionDataOptions) {
  useEffect(() => {
    let cancelled = false;
    if (!projectCwd) return () => { cancelled = true; };
    if (!taskId) {
      void window.pfsaa.sessions.capabilities(undefined, projectCwd).then((next) => {
        if (cancelled) return;
        setCapabilities(next);
        setActiveModel(next.model?.authConfigured ? next.model : models.find((model) => model.authConfigured) ?? null);
        setThinkingLevel(next.thinkingLevel);
        setThinkingLevels(next.thinkingLevels);
        setContextUsage(next.contextUsage);
      }).catch((error) => !cancelled && showNotice(error instanceof Error ? error.message : String(error)));
      return () => { cancelled = true; };
    }
    setMessageLoads((current) => ({ ...current, [taskId]: { status: "loading" } }));
    setActiveModel(null);
    void Promise.allSettled([
      window.pfsaa.sessions.messages(taskId, projectCwd),
      window.pfsaa.sessions.capabilities(taskId, projectCwd),
      window.pfsaa.sessions.runMetadata(taskId, projectCwd),
    ]).then(([messagesResult, capabilitiesResult, runMetadataResult]) => {
      if (cancelled) return;
      if (messagesResult.status === "fulfilled") {
        setMessagesByTask((current) => ({ ...current, [taskId]: messagesResult.value as any[] }));
        setMessageLoads((current) => ({ ...current, [taskId]: { status: "ready" } }));
      } else {
        setMessageLoads((current) => ({ ...current, [taskId]: { status: "error", error: messagesResult.reason instanceof Error ? messagesResult.reason.message : String(messagesResult.reason) } }));
      }
      if (capabilitiesResult.status === "fulfilled") {
        const next = capabilitiesResult.value;
        setCapabilities(next);
        setActiveModel(next.model?.authConfigured ? next.model : models.find((model) => model.authConfigured) ?? null);
        setThinkingLevel(next.thinkingLevel);
        setThinkingLevels(next.thinkingLevels);
        setContextUsage(next.contextUsage);
      } else {
        const fallback = models.find((model) => model.authConfigured) ?? null;
        setActiveModel(fallback);
        setThinkingLevels(fallback?.thinkingLevels ?? ["off"]);
        setThinkingLevel(fallback?.thinkingLevels[0] ?? "off");
        showNotice(`${copy[language].capabilitiesLoadFailed}: ${capabilitiesResult.reason instanceof Error ? capabilitiesResult.reason.message : String(capabilitiesResult.reason)}`);
      }
      if (runMetadataResult.status === "fulfilled") {
        const completedActivity = messagesResult.status === "fulfilled"
          ? restoreCompletedActivity(messagesResult.value as any[], language, runMetadataResult.value)
          : restoreCompletedActivity([], language, runMetadataResult.value);
        setTaskUi((current) => {
          const previous = current[taskId] ?? createDefaultTaskUiState();
          if (previous.isSending) return current;
          return { ...current, [taskId]: { ...previous, activity: [], completedActivity } };
        });
      }
    });
    return () => { cancelled = true; };
  }, [
    language, messageReload, models, projectCwd, setActiveModel, setCapabilities,
    setContextUsage, setMessageLoads, setMessagesByTask, setTaskUi,
    setThinkingLevel, setThinkingLevels, showNotice, taskId,
  ]);
}
