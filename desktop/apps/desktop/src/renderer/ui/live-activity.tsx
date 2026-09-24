import { useCallback, useLayoutEffect, useRef } from "react";
import { copy, type Language } from "@pfsaa/i18n";
import { Icon } from "@pfsaa/ui-system";
import type { ActivityStep } from "../types";
import { MarkdownContent } from "./markdown";

function activityValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function stepDuration(step: ActivityStep, working: string): string {
  if (!step.endedAt) return working;
  return `${Math.max(0, (step.endedAt - step.startedAt) / 1000).toFixed(1)}s`;
}

function LiveActivity({ steps, language }: { steps: ActivityStep[]; language: Language }) {
  const listRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const touchActiveRef = useRef(false);
  const previousScrollTopRef = useRef(0);

  const pinToLatest = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    previousScrollTopRef.current = list.scrollTop;
  }, []);

  // Thinking deltas update the final step in place instead of appending a new
  // row. Keep the bounded process viewport on that refreshed content while the
  // reader is following it.
  useLayoutEffect(() => {
    if (followingRef.current) pinToLatest();
  }, [pinToLatest, steps]);

  // Markdown, Mermaid, KaTeX, and highlighting can change height after React's
  // layout pass. Observe the inner content rather than the fixed-height scroll
  // box so those late resizes also reveal the newest process output.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current) pinToLatest();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [pinToLatest, steps.length]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const list = listRef.current;
    if (event.deltaY < 0 && list && list.scrollTop > 0) followingRef.current = false;
  }, []);
  const handleTouchStart = useCallback(() => {
    touchActiveRef.current = true;
    previousScrollTopRef.current = listRef.current?.scrollTop ?? 0;
  }, []);
  const handleTouchEnd = useCallback(() => { touchActiveRef.current = false; }, []);
  const handleScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const top = list.scrollTop;
    if (touchActiveRef.current && top < previousScrollTopRef.current - 1) followingRef.current = false;
    if (Math.max(0, list.scrollHeight - list.clientHeight - top) <= 2) followingRef.current = true;
    previousScrollTopRef.current = top;
  }, []);

  if (!steps.length) return null;
  const t = copy[language];
  const tools = steps.filter((step) => step.kind === "tool");
  const failedTools = tools.filter((step) => step.isError).length;

  return <section className="live-activity" aria-label={t.executionThinking}>
    <header className="live-activity-header">
      <span><Icon name="spark" size={13} />{t.executionThinking}</span>
      {tools.length > 0 && <small><Icon name="terminal" size={12} />{t.executionTools} · {t.toolsSummary(tools.length, failedTools)}</small>}
    </header>
    <div
      className="live-activity-list"
      data-conversation-scroll-island="true"
      ref={listRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <div className="live-activity-content" ref={contentRef}>
        {steps.map((step) => {
          if (step.kind === "thinking") {
            return <div className="live-activity-step live-activity-thinking" key={step.id}>
              <span className="live-activity-step-icon"><Icon name="spark" size={12} /></span>
              <div><MarkdownContent text={step.detail ?? ""} language={language} /></div>
            </div>;
          }

          const hasDetails = step.args !== undefined || step.result !== undefined;
          const heading = <>
            <span className="live-activity-step-icon"><Icon name={step.isError ? "alert" : "terminal"} size={12} /></span>
            <strong>{step.label}</strong>
            <small>{stepDuration(step, t.working)}</small>
            {hasDetails && <span className="live-activity-tool-chevron"><Icon name="chevron" size={11} /></span>}
          </>;
          const details = <div className="live-activity-tool-details">
            {step.args !== undefined && <div className="execution-value"><span>{t.executionArguments}</span><pre>{activityValue(step.args)}</pre></div>}
            {step.result !== undefined && <div className="execution-value"><span>{t.executionResult}</span><pre>{activityValue(step.result)}</pre></div>}
          </div>;

          return hasDetails
            ? <details className={`live-activity-step live-activity-tool ${step.isError ? "failed" : ""}`} key={step.id}>
                <summary>{heading}</summary>
                {details}
              </details>
            : <div className={`live-activity-step live-activity-tool ${step.isError ? "failed" : ""}`} key={step.id}>{heading}</div>;
        })}
      </div>
    </div>
  </section>;
}

export { LiveActivity };
