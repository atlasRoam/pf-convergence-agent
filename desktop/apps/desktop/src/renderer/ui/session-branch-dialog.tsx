import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionTreeEntrySummary, SessionTreeSnapshot } from "@pfsaa/contracts";
import { copy, type Language } from "@pfsaa/i18n";
import { Icon, useDialogFocus } from "@pfsaa/ui-system";

export type SessionBranchMode = "fork" | "clone" | "tree";

interface SessionBranchDialogProps {
  language: Language;
  mode: SessionBranchMode;
  snapshot: SessionTreeSnapshot | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
  onAbort: () => void;
  onFork: (entryId: string) => void;
  onClone: () => void;
  onNavigate: (entryId: string, options: { summarize: boolean; customInstructions?: string }) => void;
  /** Mirrors AgentCore's branchSummary.skipPrompt setting. */
  skipSummaryPrompt?: boolean;
}

function entryKind(entry: SessionTreeEntrySummary, t: (typeof copy)[Language]): string {
  if (entry.role === "user") return t.sessionTreeYou;
  if (entry.role === "assistant") return t.sessionTreeAssistant;
  if (entry.role === "tool") return t.sessionTreeTool;
  if (entry.type === "compaction") return t.sessionTreeCompaction;
  if (entry.type === "branch_summary") return t.sessionTreeBranchSummary;
  if (entry.type === "model_change" || entry.type === "thinking_level_change") return t.sessionTreeSetting;
  if (entry.type === "custom" || entry.type === "custom_message") return t.sessionTreeExtension;
  return t.sessionTreeOther;
}

function searchable(entry: SessionTreeEntrySummary): string {
  return `${entry.preview} ${entry.label ?? ""} ${entry.type} ${entry.role}`.toLowerCase();
}

const SESSION_TREE_PAGE_SIZE = 160;
const SESSION_TREE_MAX_LANE = 3;

function branchLayout(entries: SessionTreeEntrySummary[]) {
  const children = new Map<string | null, SessionTreeEntrySummary[]>();
  for (const entry of entries) {
    const siblings = children.get(entry.parentId);
    if (siblings) siblings.push(entry);
    else children.set(entry.parentId, [entry]);
  }
  const branchOffsets = new Map<string, number>();
  for (const siblings of children.values()) {
    const primary = siblings.find((sibling) => sibling.active) ?? siblings[0];
    let alternativeOffset = 0;
    for (const sibling of siblings) branchOffsets.set(sibling.id, sibling.id === primary.id ? 0 : ++alternativeOffset);
  }
  const layout = new Map<string, { lane: number; parentLane: number; branchStart: boolean; overflow: number }>();
  const actualLanes = new Map<string, number>();
  for (const entry of entries) {
    const parentLane = entry.parentId ? actualLanes.get(entry.parentId) ?? 0 : 0;
    const actualLane = parentLane + (branchOffsets.get(entry.id) ?? 0);
    actualLanes.set(entry.id, actualLane);
    layout.set(entry.id, {
      lane: Math.min(actualLane, SESSION_TREE_MAX_LANE),
      parentLane: Math.min(parentLane, SESSION_TREE_MAX_LANE),
      branchStart: actualLane !== parentLane,
      overflow: Math.max(0, actualLane - SESSION_TREE_MAX_LANE),
    });
  }
  return layout;
}

export function SessionBranchDialog({
  language, mode, snapshot, loading, busy, error, onRetry, onClose, onAbort, onFork, onClone, onNavigate, skipSummaryPrompt = false,
}: SessionBranchDialogProps) {
  const t = copy[language];
  const dialogRef = useRef<HTMLDivElement>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [pageStart, setPageStart] = useState(0);
  const [summarize, setSummarize] = useState(false);
  const [customInstructions, setCustomInstructions] = useState("");
  useEffect(() => {
    if (!skipSummaryPrompt) return;
    setSummarize(false);
    setCustomInstructions("");
  }, [skipSummaryPrompt]);
  useDialogFocus(dialogRef, () => { if (busy && mode === "tree" && summarize && !skipSummaryPrompt) onAbort(); else if (!busy) onClose(); });

  const entries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return (snapshot?.entries ?? []).filter((entry) => {
      if (mode === "fork" && !entry.forkable) return false;
      if (mode === "clone" && !entry.active) return false;
      if (mode === "tree" && !showAll && !(entry.current || entry.role === "user" || entry.role === "assistant" || entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "custom_message")) return false;
      return !normalizedQuery || searchable(entry).includes(normalizedQuery);
    });
  }, [mode, query, showAll, snapshot]);

  const treeLayout = useMemo(() => branchLayout(snapshot?.entries ?? []), [snapshot]);

  useEffect(() => {
    const anchor = mode === "fork"
      ? [...entries].reverse().find((entry) => entry.forkable)
      : entries.find((entry) => entry.current) ?? entries.at(-1);
    const anchorIndex = anchor ? entries.findIndex((entry) => entry.id === anchor.id) : 0;
    setPageStart(Math.floor(Math.max(0, anchorIndex) / SESSION_TREE_PAGE_SIZE) * SESSION_TREE_PAGE_SIZE);
  }, [entries, mode]);

  const visibleEntries = entries.slice(pageStart, pageStart + SESSION_TREE_PAGE_SIZE);
  const pageEnd = Math.min(entries.length, pageStart + SESSION_TREE_PAGE_SIZE);

  useEffect(() => {
    if (!snapshot || selectedId && snapshot.entries.some((entry) => entry.id === selectedId)) return;
    const initial = mode === "fork"
      ? [...snapshot.entries].reverse().find((entry) => entry.forkable)
      : snapshot.entries.find((entry) => entry.current) ?? snapshot.entries.at(-1);
    setSelectedId(initial?.id ?? null);
  }, [mode, selectedId, snapshot]);

  useEffect(() => {
    if (selectedId === null) return;
    if (entries.some((entry) => entry.id === selectedId)) return;
    setSelectedId(entries[0]?.id ?? null);
  }, [entries, selectedId]);

  const selected = snapshot?.entries.find((entry) => entry.id === selectedId) ?? null;
  const title = mode === "fork" ? t.forkSessionTitle : mode === "clone" ? t.cloneSessionTitle : t.sessionTreeTitle;
  const description = mode === "fork" ? t.forkSessionDescription : mode === "clone" ? t.cloneSessionDescription : t.sessionTreeDescription;
  const actionable = mode === "fork" ? Boolean(selected?.forkable) : mode === "clone" ? Boolean(snapshot?.leafId) : Boolean(selected && !selected.current);
  const formattedTime = selected?.timestamp ? new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(selected.timestamp)) : "";

  function moveSelection(direction: -1 | 1) {
    const index = visibleEntries.findIndex((entry) => entry.id === selectedId);
    const next = visibleEntries[Math.max(0, Math.min(visibleEntries.length - 1, (index < 0 ? 0 : index) + direction))];
    if (!next) return;
    setSelectedId(next.id);
    document.querySelector<HTMLElement>(`[data-session-entry-id="${CSS.escape(next.id)}"]`)?.focus();
  }

  function changePage(nextStart: number) {
    const boundedStart = Math.max(0, Math.min(nextStart, Math.max(0, entries.length - 1)));
    setPageStart(boundedStart);
    setSelectedId(entries[boundedStart]?.id ?? null);
  }

  function submit() {
    if (!actionable || busy) return;
    if (mode === "fork" && selected) onFork(selected.id);
    else if (mode === "clone") onClone();
    else if (selected) {
      const shouldSummarize = !skipSummaryPrompt && summarize;
      onNavigate(selected.id, { summarize: shouldSummarize, ...(shouldSummarize && customInstructions.trim() ? { customInstructions: customInstructions.trim() } : {}) });
    }
  }

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div ref={dialogRef} className="session-branch-dialog" role="dialog" aria-modal="true" aria-labelledby="session-branch-title" aria-describedby="session-branch-description" aria-busy={busy}>
      <header className="session-branch-header">
        <div><span className="eyebrow">{t.brandShortName} · {mode === "fork" ? "/fork" : mode === "clone" ? "/clone" : "/tree"}</span><h2 id="session-branch-title">{title}</h2><p id="session-branch-description">{description}</p></div>
        <button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label={t.cancel} title={t.cancel}><Icon name="x" /></button>
      </header>

      {loading ? <div className="session-branch-state" role="status"><span className="session-branch-spinner" />{t.sessionTreeLoading}</div>
        : error ? <div className="session-branch-state error" role="alert"><Icon name="alert" /><span>{t.sessionTreeLoadFailed}<small>{error}</small></span><button type="button" className="button ghost" onClick={onRetry}>{t.retry}</button></div>
        : !snapshot?.entries.length ? <div className="session-branch-state"><Icon name="branch" /><span>{t.sessionTreeEmpty}</span></div>
        : <div className={`session-branch-body mode-${mode}`}>
          <section className="session-branch-browser" aria-label={t.sessionTreeNodes}>
            {mode !== "clone" && <div className="session-branch-tools">
              <label className="session-branch-search"><Icon name="search" size={14} /><input autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.sessionTreeSearch} aria-label={t.sessionTreeSearch} /></label>
              {mode === "tree" && <div className="session-branch-filter" role="group" aria-label={t.sessionTreeFilter}>
                <button type="button" className={!showAll ? "selected" : ""} aria-pressed={!showAll} onClick={() => setShowAll(false)}>{t.sessionTreeConversation}</button>
                <button type="button" className={showAll ? "selected" : ""} aria-pressed={showAll} onClick={() => setShowAll(true)}>{t.sessionTreeAllEntries}</button>
              </div>}
            </div>}
            <div className="session-branch-list" role="tree" aria-label={t.sessionTreeNodes} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveSelection(event.key === "ArrowDown" ? 1 : -1); } }}>
              {entries.length === 0 ? <p className="session-branch-no-results">{t.sessionTreeNoMatches}</p> : visibleEntries.map((entry) => {
                const layout = treeLayout.get(entry.id) ?? { lane: 0, parentLane: 0, branchStart: false, overflow: 0 };
                return <button
                type="button"
                role="treeitem"
                aria-level={layout.lane + 1}
                aria-current={entry.current ? "true" : undefined}
                aria-selected={entry.id === selectedId}
                tabIndex={entry.id === selectedId ? 0 : -1}
                data-session-entry-id={entry.id}
                data-tree-lane={layout.lane}
                className={`session-branch-row${entry.id === selectedId ? " selected" : ""}${entry.active ? " active-path" : ""}${layout.branchStart ? " branch-start" : ""}`}
                style={{ "--tree-lane": layout.lane, "--tree-parent-lane": layout.parentLane } as React.CSSProperties}
                key={entry.id}
                onClick={() => setSelectedId(entry.id)}
              >
                <span className="session-branch-rail" aria-hidden="true"><i />{layout.overflow > 0 && <b>+{layout.overflow}</b>}</span>
                <span className="session-branch-row-copy"><span><strong>{entry.label || entryKind(entry, t)}</strong>{entry.current && <em>{t.sessionTreeCurrent}</em>}{entry.childCount > 1 && <em>{t.sessionTreeBranches(entry.childCount)}</em>}</span><small>{entry.preview || entryKind(entry, t)}</small></span>
              </button>;})}
            </div>
            <div className="session-branch-list-footer">
              {snapshot.truncated && <p className="session-branch-truncated" role="status">{t.sessionTreeTruncated}</p>}
              {entries.length > SESSION_TREE_PAGE_SIZE && <nav className="session-branch-pagination" aria-label={t.sessionTreePages}>
                <button type="button" disabled={pageStart === 0} onClick={() => changePage(Math.max(0, pageStart - SESSION_TREE_PAGE_SIZE))}>{t.sessionTreePreviousPage}</button>
                <span>{t.sessionTreePageRange(pageStart + 1, pageEnd, entries.length)}</span>
                <button type="button" disabled={pageEnd >= entries.length} onClick={() => changePage(pageStart + SESSION_TREE_PAGE_SIZE)}>{t.sessionTreeNextPage}</button>
              </nav>}
            </div>
          </section>

          <aside className="session-branch-detail">
            {mode === "clone" ? <>
              <span className="session-branch-detail-icon"><Icon name="copy" size={18} /></span>
              <h3>{t.cloneSessionSummary}</h3>
              <p>{t.cloneSessionImpact}</p>
              <dl><div><dt>{t.sessionTreeActiveEntries}</dt><dd>{entries.length}</dd></div><div><dt>{t.sessionTreeDestination}</dt><dd>{t.cloneSessionNewTask}</dd></div></dl>
            </> : selected ? <>
              <div className="session-branch-detail-heading"><span>{entryKind(selected, t)}</span>{selected.current && <strong>{t.sessionTreeCurrentPoint}</strong>}</div>
              {selected.label ? <><h3>{selected.label}</h3>{selected.preview && <p className="session-branch-preview">{selected.preview}</p>}</> : <p className="session-branch-preview primary">{selected.preview || entryKind(selected, t)}</p>}
              <dl>{formattedTime && <div><dt>{t.sessionTreeTime}</dt><dd>{formattedTime}</dd></div>}<div><dt>{t.sessionTreePath}</dt><dd>{selected.active ? t.sessionTreeActivePath : t.sessionTreeOtherBranch}</dd></div></dl>
              {mode === "fork" && <p className="session-branch-impact">{t.forkSessionImpact}</p>}
              {mode === "tree" && selected.current && <p className="session-branch-impact neutral">{t.sessionTreeAlreadyHere}</p>}
              {mode === "tree" && !selected.current && (skipSummaryPrompt
                ? <p className="session-branch-summary-skipped" role="status" data-summary-prompt-skipped="true">{t.sessionTreeSummaryPromptSkipped}</p>
                : <div className="session-branch-summary-options">
                  <label><input type="checkbox" checked={summarize} onChange={(event) => setSummarize(event.target.checked)} /><span><strong>{t.sessionTreeSummarize}</strong><small>{t.sessionTreeSummarizeHint}</small></span></label>
                  {summarize && <label className="session-branch-instructions"><span>{t.sessionTreeCustomInstructions}</span><textarea rows={3} value={customInstructions} onChange={(event) => setCustomInstructions(event.target.value)} placeholder={t.sessionTreeCustomInstructionsPlaceholder} /></label>}
                </div>)}
            </> : <p>{t.sessionTreeSelectEntry}</p>}
          </aside>
        </div>}

      <footer className="session-branch-footer">
        <span aria-live="polite">{busy ? (mode === "tree" && summarize ? t.sessionTreeSummarizing : t.sessionTreeApplying) : ""}</span>
        <div>
          {busy && mode === "tree" && summarize ? <button type="button" className="button ghost" onClick={onAbort}>{t.sessionTreeStopSummary}</button> : <button type="button" className="button ghost" disabled={busy} onClick={onClose}>{t.cancel}</button>}
          <button type="button" className="button primary" disabled={!actionable || busy || loading || Boolean(error)} onClick={submit}>{busy ? t.sessionTreeApplying : mode === "fork" ? t.forkSessionAction : mode === "clone" ? t.cloneSessionAction : t.sessionTreeNavigateAction}</button>
        </div>
      </footer>
    </div>
  </div>;
}
