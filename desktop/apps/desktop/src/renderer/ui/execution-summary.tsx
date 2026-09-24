import { useEffect, useState } from "react";
import { copy, type Language } from "@pfsaa/i18n";
import { Icon } from "@pfsaa/ui-system";
import type { ActivityStep } from "../types";

function activityValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function formatActivityDuration(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  if (rounded < 60) return `${rounded}s`;
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function ExecutionSummary({ steps, language, running, toolsExpanded = false }: { steps: ActivityStep[]; language: Language; running: boolean; toolsExpanded?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || !steps.length) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running, steps.length]);
  if (!steps.length) return null;
  const t = copy[language];
  const startedAt = Math.min(...steps.map((step) => step.startedAt));
  const endedAt = running ? now : Math.max(...steps.map((step) => step.endedAt ?? step.startedAt));
  const persistedDurationMs = running ? undefined : steps.find((step) => Number.isFinite(step.durationMs))?.durationMs;
  const seconds = Math.max(0, (persistedDurationMs ?? endedAt - startedAt) / 1000);
  const duration = formatActivityDuration(seconds);
  if (running) {
    return <div className="execution-summary execution-summary-running" role="timer">
      <span>{t.executionProcessing(duration)}</span>
    </div>;
  }
  // A restored group can have unknown per-step timing while its total run
  // duration is authoritative in the persisted metadata.
  const timingKnown = persistedDurationMs !== undefined || steps.every((step) => step.timing !== "unknown");
  const toolContent = (step: ActivityStep) => (<>
    {step.args !== undefined && <div className="execution-value"><span>{t.executionArguments}</span><pre>{activityValue(step.args)}</pre></div>}
    {step.result !== undefined && <div className="execution-value"><span>{t.executionResult}</span><pre>{activityValue(step.result)}</pre></div>}
  </>);
  return <details className="execution-summary" open={toolsExpanded || undefined}>
    <summary><span>{timingKnown ? t.executionProcessed(duration) : t.executionProcessedUnknown}</span><Icon name="chevron" size={13} /></summary>
    <div className="execution-details" data-conversation-scroll-island="true">
      {steps.map((step) => {
        const heading = <>
          <span className="execution-step-icon"><Icon name={step.kind === "thinking" ? "spark" : step.isError ? "alert" : "terminal"} size={13} /></span>
          <strong>{step.kind === "thinking" ? t.executionThinking : step.label}</strong>
          <small>{step.timing === "unknown" ? "—" : step.endedAt ? `${((step.endedAt - step.startedAt) / 1000).toFixed(1)}s` : t.working}</small>
        </>;
        if (step.kind === "thinking") {
          return <div className={`execution-step ${step.isError ? "failed" : ""}`} key={step.id}>
            <div className="execution-step-heading">{heading}</div>
            {step.detail && <pre>{step.detail}</pre>}
          </div>;
        }
        return <details className={`execution-step ${step.isError ? "failed" : ""}`} key={step.id} open={toolsExpanded || undefined}>
          <summary className="execution-step-heading">{heading}<span className="execution-step-chevron"><Icon name="chevron" size={12} /></span></summary>
          {toolContent(step)}
        </details>;
      })}
    </div>
  </details>;
}

export { ExecutionSummary };
