import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  SessionChangeFile,
  SessionChangeReview,
  SessionChangeReviewAvailability,
  SessionChangeReviewMergeSource,
  SessionChangeReviewUnavailableReason,
} from "@pfsaa/contracts";
import { copy, type Language } from "@pfsaa/i18n";
import { copyText, Icon, useDialogFocus } from "@pfsaa/ui-system";
import {
  allDirectoryPaths,
  buildChangeFileTree,
  compactDirectory,
  directoryAncestors,
  parseUnifiedPatch,
  reviewTreeKeyboardAction,
  sideBySideRows,
  tokenizeCodeLine,
  type ChangeFileTreeNode,
  type DiffLine,
} from "../change-review-model";
import type { ChangeReviewDiffMode, ChangeReviewScrollPosition } from "../use-change-review";
import { PaneResizeHandle } from "./pane-resize-handle";

const INITIAL_DIFF_ROWS = 800;
const DIFF_ROW_STEP = 800;
const ChangeReviewMergeEditor = lazy(() => import("./change-review-merge.js").then((module) => ({ default: module.ChangeReviewMergeEditor })));

function statusLabel(file: SessionChangeFile, language: Language): string {
  const t = copy[language];
  if (file.status === "added") return t.changeReviewAdded;
  if (file.status === "deleted") return t.changeReviewDeleted;
  if (file.status === "renamed") return t.changeReviewRenamed;
  return t.changeReviewModified;
}

function statusMark(file: SessionChangeFile): string {
  if (file.status === "added") return "A";
  if (file.status === "deleted") return "D";
  if (file.status === "renamed") return "R";
  return "M";
}

function fileCountLabel(review: SessionChangeReview, language: Language): string {
  const t = copy[language];
  return review.fileCountTruncated ? t.changeReviewFilesAtLeast(review.files.length) : t.changeReviewFiles(review.files.length);
}

function reviewStatusMessage(reason: SessionChangeReviewUnavailableReason | undefined, language: Language): string {
  const t = copy[language];
  if (reason === "git-not-found") return t.changeReviewGitMissing;
  if (reason === "git-timeout") return t.changeReviewGitTimeout;
  if (reason === "diff-api-unavailable") return t.changeReviewDiffUnavailable;
  if (reason === "review-data-invalid") return t.changeReviewDataInvalid;
  if (reason === "review-storage-failed") return t.changeReviewStorageFailed;
  return t.changeReviewInspectionFailed;
}

function CodeLine({ text }: { text: string }) {
  return <>{tokenizeCodeLine(text || " ").map((token, index) => token.kind
    ? <span className={`change-review-token ${token.kind}`} key={`${index}-${token.text}`}>{token.text}</span>
    : token.text)}</>;
}

function ChangeReviewFileTree({
  files,
  selectedPath,
  expandedPaths,
  query,
  language,
  onExpandedPaths,
  onSelect,
}: {
  files: SessionChangeFile[];
  selectedPath: string | null;
  expandedPaths: string[];
  query: string;
  language: Language;
  onExpandedPaths: (paths: string[]) => void;
  onSelect: (path: string) => void;
}) {
  const t = copy[language];
  const tree = useMemo(() => buildChangeFileTree(files, query), [files, query]);
  const allDirectories = useMemo(() => allDirectoryPaths(tree), [tree]);
  const filtering = Boolean(query.trim());
  const expanded = useMemo(() => new Set(filtering ? allDirectories : expandedPaths), [allDirectories, expandedPaths, filtering]);
  const allExpanded = allDirectories.length > 0 && allDirectories.every((path) => expanded.has(path));
  const toggleAllLabel = allExpanded ? t.changeReviewCollapseAll : t.changeReviewExpandAll;
  const [focusedKey, setFocusedKey] = useState<string | null>(selectedPath ? `file:${selectedPath}` : null);
  const treeRef = useRef<HTMLDivElement>(null);
  const expandedPathsRef = useRef(expandedPaths);
  const typeaheadRef = useRef({ value: "", timer: undefined as ReturnType<typeof setTimeout> | undefined });
  expandedPathsRef.current = expandedPaths;

  useEffect(() => {
    if (!selectedPath) return;
    const currentExpandedPaths = expandedPathsRef.current;
    const ancestors = directoryAncestors(selectedPath);
    if (ancestors.some((path) => !currentExpandedPaths.includes(path))) onExpandedPaths([...new Set([...currentExpandedPaths, ...ancestors])]);
    setFocusedKey(`file:${selectedPath}`);
  }, [onExpandedPaths, selectedPath]);

  const setDirectoryExpanded = (directoryPath: string, nextExpanded: boolean) => {
    const next = new Set(expandedPaths);
    if (nextExpanded) next.add(directoryPath);
    else next.delete(directoryPath);
    onExpandedPaths([...next]);
  };

  const toggleAllDirectories = () => {
    if (!allExpanded) {
      onExpandedPaths(allDirectories);
      return;
    }
    onExpandedPaths([]);
    const firstNode = tree[0];
    setFocusedKey(firstNode
      ? firstNode.kind === "directory"
        ? `directory:${compactDirectory(firstNode).directory.path}`
        : `file:${firstNode.path}`
      : null);
  };

  const focusTreeKey = (key: string | undefined) => {
    if (!key) return;
    setFocusedKey(key);
    window.requestAnimationFrame(() => {
      const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(key) : key.replace(/["\\]/g, "\\$&");
      treeRef.current?.querySelector<HTMLButtonElement>(`[data-tree-key="${escaped}"]`)?.focus();
    });
  };

  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    const key = button.dataset.treeKey;
    const kind = button.dataset.treeKind as "directory" | "file" | undefined;
    if (!key || !kind) return;
    const buttons = Array.from(treeRef.current?.querySelectorAll<HTMLButtonElement>("button[role='treeitem']") ?? []);
    if (event.key.length === 1 && event.key.trim() && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (typeaheadRef.current.timer) clearTimeout(typeaheadRef.current.timer);
      typeaheadRef.current.value = `${typeaheadRef.current.value}${event.key}`.toLocaleLowerCase();
      typeaheadRef.current.timer = setTimeout(() => { typeaheadRef.current.value = ""; typeaheadRef.current.timer = undefined; }, 650);
      const currentIndex = Math.max(0, buttons.indexOf(button));
      const ordered = [...buttons.slice(currentIndex + 1), ...buttons.slice(0, currentIndex + 1)];
      const match = ordered.find((item) => item.querySelector(".change-review-tree-label")?.textContent?.trim().toLocaleLowerCase().startsWith(typeaheadRef.current.value));
      if (match?.dataset.treeKey) { event.preventDefault(); focusTreeKey(match.dataset.treeKey); }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const visibleKeys = buttons.map((item) => item.dataset.treeKey).filter((item): item is string => Boolean(item));
    const firstChildKey = kind === "directory"
      ? buttons.find((item) => item.dataset.parentKey === key)?.dataset.treeKey
      : undefined;
    const action = reviewTreeKeyboardAction(
      visibleKeys,
      key,
      event.key,
      kind,
      button.getAttribute("aria-expanded") === "true",
      button.dataset.parentKey,
      firstChildKey,
    );
    event.preventDefault();
    if (action.expandKey) setDirectoryExpanded(action.expandKey.slice("directory:".length), true);
    if (action.collapseKey) setDirectoryExpanded(action.collapseKey.slice("directory:".length), false);
    focusTreeKey(action.focusKey);
  };

  const renderNodes = (nodes: ChangeFileTreeNode[], depth: number, parentKey?: string): ReactNode => nodes.map((node, nodeIndex) => {
    if (node.kind === "file") {
      const file = node.file;
      const treeKey = `file:${file.path}`;
      return <button
        type="button"
        role="treeitem"
        aria-level={depth + 1}
        aria-posinset={nodeIndex + 1}
        aria-setsize={nodes.length}
        aria-selected={file.path === selectedPath}
        className={`change-review-tree-row change-review-tree-file ${file.path === selectedPath ? "active" : ""}`}
        style={{ "--change-review-tree-depth": depth } as CSSProperties}
        key={treeKey}
        data-tree-key={treeKey}
        data-tree-kind="file"
        data-parent-key={parentKey}
        tabIndex={focusedKey === treeKey || (!focusedKey && nodeIndex === 0 && depth === 0) ? 0 : -1}
        title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
        onFocus={() => setFocusedKey(treeKey)}
        onKeyDown={handleTreeKeyDown}
        onClick={() => onSelect(file.path)}
      >
        <span className={`change-review-status ${file.status}`} title={statusLabel(file, language)}>{statusMark(file)}</span>
        <span className="change-review-tree-label">{node.name}</span>
        <small><b className="diff-addition">+{file.additions}</b><b className="diff-deletion">−{file.deletions}</b></small>
      </button>;
    }
    const compacted = compactDirectory(node);
    const directory = compacted.directory;
    const treeKey = `directory:${directory.path}`;
    const isExpanded = expanded.has(directory.path);
    return <div className="change-review-tree-branch" role="none" key={treeKey}>
      <button
        type="button"
        role="treeitem"
        aria-level={depth + 1}
        aria-posinset={nodeIndex + 1}
        aria-setsize={nodes.length}
        aria-expanded={isExpanded}
        className={`change-review-tree-row change-review-tree-directory ${isExpanded ? "expanded" : ""}`}
        style={{ "--change-review-tree-depth": depth } as CSSProperties}
        title={directory.path}
        data-tree-key={treeKey}
        data-tree-kind="directory"
        data-parent-key={parentKey}
        tabIndex={focusedKey === treeKey || (!focusedKey && nodeIndex === 0 && depth === 0) ? 0 : -1}
        onFocus={() => setFocusedKey(treeKey)}
        onKeyDown={handleTreeKeyDown}
        onClick={() => setDirectoryExpanded(directory.path, !isExpanded)}
      >
        <span className="change-review-tree-chevron"><Icon name="chevron" size={12} /></span>
        <Icon name={isExpanded ? "folderOpen" : "folder"} size={14} />
        <span className="change-review-tree-label">{compacted.label}</span>
        <small title={`${t.changeReviewFiles(directory.fileCount)} · +${directory.additions} −${directory.deletions}`}>
          <span>{directory.fileCount}</span><b className="diff-addition">+{directory.additions}</b><b className="diff-deletion">−{directory.deletions}</b>
        </small>
      </button>
      {isExpanded && <div className="change-review-tree-children" role="group">{renderNodes(directory.children, depth + 1, treeKey)}</div>}
    </div>;
  });

  useEffect(() => () => { if (typeaheadRef.current.timer) clearTimeout(typeaheadRef.current.timer); }, []);

  if (!tree.length) return <div className="change-review-tree-empty">{t.changeReviewNoMatches}</div>;
  return <>
    {allDirectories.length > 0 && <div className="change-review-tree-actions">
      <button
        type="button"
        className="change-review-tree-toggle"
        title={toggleAllLabel}
        aria-label={toggleAllLabel}
        aria-pressed={allExpanded}
        disabled={filtering}
        onClick={toggleAllDirectories}
      ><Icon name={allExpanded ? "folder" : "folderOpen"} size={13} /></button>
    </div>}
    <div className="change-review-file-tree" role="tree" aria-label={t.changeReviewFileList} ref={treeRef}>{renderNodes(tree, 0)}</div>
  </>;
}

function reviewRunLabel(review: SessionChangeReview, index: number, total: number, language: Language): string {
  const t = copy[language];
  const suffix = review.state === "running"
    ? t.changeReviewCurrent
    : new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", { dateStyle: "short", timeStyle: "short" }).format(review.startedAt);
  const outcome = review.outcome === "failed"
    ? t.changeReviewFailed
    : review.outcome === "aborted"
      ? t.changeReviewAborted
      : review.outcome === "succeeded" ? t.changeReviewSucceeded : "";
  const duration = review.state === "completed" ? ` · ${t.changeReviewDuration(Math.max(0, Math.round((review.endedAt - review.startedAt) / 1000)))}` : "";
  return `${t.changeReviewRun(index + 1, total)} · ${suffix}${outcome ? ` · ${outcome}` : ""}${duration}`;
}

function HunkControls({
  hunkIndex,
  resolution,
  language,
  disabled,
  confirmingRevert,
  onAccept,
  onRequestRevert,
  onCancelRevert,
  onConfirmRevert,
}: {
  hunkIndex: number;
  resolution?: "accepted" | "reverted" | "merged";
  language: Language;
  disabled: boolean;
  confirmingRevert: boolean;
  onAccept: (hunkIndex: number) => void;
  onRequestRevert: (hunkIndex: number) => void;
  onCancelRevert: () => void;
  onConfirmRevert: (hunkIndex: number) => void;
}) {
  const t = copy[language];
  if (resolution) {
    const label = resolution === "accepted" ? t.changeReviewHunkAccepted : resolution === "reverted" ? t.changeReviewHunkReverted : t.changeReviewHunkMerged;
    const icon = resolution === "accepted" ? "check" : resolution === "reverted" ? "x" : "diff";
    return <span className={`change-review-hunk-resolution ${resolution}`} data-resolution={resolution} role="status" aria-live="polite">
      <Icon name={icon} size={12} />
      <span>{label}</span>
    </span>;
  }
  return <span className="change-review-hunk-resolution-actions">
    <button type="button" disabled={disabled} onClick={() => onAccept(hunkIndex)}><Icon name="check" size={11} /><span>{t.changeReviewAcceptHunk}</span></button>
    <button type="button" className="revert" disabled={disabled} aria-expanded={confirmingRevert} onClick={() => onRequestRevert(hunkIndex)}><Icon name="x" size={11} /><span>{t.changeReviewRevertHunk}</span></button>
    {confirmingRevert && <span className="change-review-revert-popover" role="alertdialog" aria-label={t.changeReviewConfirmRevert} onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); onCancelRevert(); }
    }}>
      <span><strong>{t.changeReviewConfirmRevert}</strong><small>{t.changeReviewConfirmRevertBody}</small></span>
      <span>
        <button type="button" className="button ghost" autoFocus disabled={disabled} onClick={onCancelRevert}>{t.changeReviewCancel}</button>
        <button type="button" className="button danger-subtle" disabled={disabled} onClick={() => onConfirmRevert(hunkIndex)}>{t.changeReviewConfirmRevert}</button>
      </span>
    </span>}
  </span>;
}

function rowsByHunk<T extends { hunkIndex: number }>(rows: T[]): T[][] {
  const groups: T[][] = [];
  for (const row of rows) {
    const current = groups.at(-1);
    if (!current || current[0]?.hunkIndex !== row.hunkIndex) groups.push([row]);
    else current.push(row);
  }
  return groups;
}

function UnifiedDiffRows({ lines, file, language, disabled, pendingRevertHunk, onAccept, onRequestRevert, onCancelRevert, onConfirmRevert }: {
  lines: DiffLine[];
  file: SessionChangeFile;
  language: Language;
  disabled: boolean;
  pendingRevertHunk: number | null;
  onAccept: (hunkIndex: number) => void;
  onRequestRevert: (hunkIndex: number) => void;
  onCancelRevert: () => void;
  onConfirmRevert: (hunkIndex: number) => void;
}) {
  const resolutions = new Map(file.hunkResolutions?.map((resolution) => [resolution.hunkIndex, resolution.action]));
  return <>{rowsByHunk(lines).map((group) => {
    const hunkIndex = group[0]?.hunkIndex ?? -1;
    const resolution = resolutions.get(hunkIndex);
    return <div className={`change-review-hunk-group ${resolution ? `resolved-${resolution}` : ""} ${pendingRevertHunk === hunkIndex ? "confirming-revert" : ""}`} role="rowgroup" key={`hunk-group-${hunkIndex}`}>
      {hunkIndex >= 0 && <div className="change-review-hunk-controls-sticky" role="row"><div role="cell"><HunkControls hunkIndex={hunkIndex} resolution={resolution} language={language} disabled={disabled} confirmingRevert={pendingRevertHunk === hunkIndex} onAccept={onAccept} onRequestRevert={onRequestRevert} onCancelRevert={onCancelRevert} onConfirmRevert={onConfirmRevert} /></div></div>}
      {group.map((line) => <div
        id={line.kind === "hunk" ? `change-review-hunk-${line.hunkIndex}` : undefined}
        className={`change-review-line ${line.kind} ${line.whitespaceOnly ? "whitespace-only" : ""}`}
        role="row"
        tabIndex={line.kind === "hunk" ? -1 : undefined}
        key={line.key}
      >
        <span className="change-review-line-number" role="cell">{line.oldLine ?? ""}</span>
        <span className="change-review-line-number" role="cell">{line.newLine ?? ""}</span>
        <span className="change-review-line-marker" role="cell">{line.marker}</span>
        {line.kind === "hunk"
          ? <span className="change-review-hunk-content" role="cell"><code><CodeLine text={line.text} /></code></span>
          : <code role="cell"><CodeLine text={line.text} /></code>}
      </div>)}
    </div>;
  })}</>;
}

function SplitDiffCell({ line, side }: { line?: DiffLine; side: "old" | "new" }) {
  const lineNumber = side === "old" ? line?.oldLine : line?.newLine;
  return <div
    role="cell"
    className={`change-review-split-cell ${line?.kind ?? "empty"} ${line?.whitespaceOnly ? "whitespace-only" : ""}`}
  >
    <span className="change-review-split-line-number">{lineNumber ?? ""}</span>
    <span className="change-review-split-marker">{line?.kind === "addition" ? "+" : line?.kind === "deletion" ? "−" : ""}</span>
    <code>{line ? <CodeLine text={line.text} /> : " "}</code>
  </div>;
}

function SplitDiffRows({ rows, file, language, disabled, pendingRevertHunk, onAccept, onRequestRevert, onCancelRevert, onConfirmRevert }: {
  rows: ReturnType<typeof sideBySideRows>;
  file: SessionChangeFile;
  language: Language;
  disabled: boolean;
  pendingRevertHunk: number | null;
  onAccept: (hunkIndex: number) => void;
  onRequestRevert: (hunkIndex: number) => void;
  onCancelRevert: () => void;
  onConfirmRevert: (hunkIndex: number) => void;
}) {
  const t = copy[language];
  const resolutions = new Map(file.hunkResolutions?.map((resolution) => [resolution.hunkIndex, resolution.action]));
  return <>{rowsByHunk(rows).map((group) => {
    const hunkIndex = group[0]?.hunkIndex ?? -1;
    const resolution = resolutions.get(hunkIndex);
    return <div className={`change-review-hunk-group ${resolution ? `resolved-${resolution}` : ""} ${pendingRevertHunk === hunkIndex ? "confirming-revert" : ""}`} role="rowgroup" key={`split-hunk-group-${hunkIndex}`}>
      {hunkIndex >= 0 && <div className="change-review-hunk-controls-sticky" role="row"><div role="cell"><HunkControls hunkIndex={hunkIndex} resolution={resolution} language={language} disabled={disabled} confirmingRevert={pendingRevertHunk === hunkIndex} onAccept={onAccept} onRequestRevert={onRequestRevert} onCancelRevert={onCancelRevert} onConfirmRevert={onConfirmRevert} /></div></div>}
      {group.map((row) => {
        if (row.kind === "pair") return <div className="change-review-split-row" role="row" key={row.key}>
          <SplitDiffCell line={row.oldLine} side="old" />
          <SplitDiffCell line={row.newLine} side="new" />
        </div>;
        if (row.kind === "hunk") {
          const hasGap = Boolean(row.oldOmittedLines || row.newOmittedLines);
          return <div
            id={`change-review-hunk-${row.hunkIndex}`}
            className={`change-review-split-meta hunk ${hasGap ? "has-gap" : "no-gap"}`}
            role="row"
            tabIndex={-1}
            title={row.text}
            key={row.key}
          >
            {hasGap
              ? <>
                  <div className="change-review-split-gap-cell" role="cell">{row.oldOmittedLines ? <span>{t.changeReviewUnchangedLines(row.oldOmittedLines)}</span> : null}</div>
                  <div className="change-review-split-gap-cell" role="cell">{row.newOmittedLines ? <span>{t.changeReviewUnchangedLines(row.newOmittedLines)}</span> : null}</div>
                </>
              : <code className="sr-only" role="cell">{row.text}</code>}
          </div>;
        }
        return <div className="change-review-split-meta meta" role="row" key={row.key}><code role="cell">{row.text}</code></div>;
      })}
    </div>;
  })}</>;
}

function ChangeReviewDiff({
  review,
  file,
  language,
  detailLoading,
  detailError,
  diffMode,
  wrapLines,
  ignoreWhitespace,
  scrollPosition,
  onDiffMode,
  onWrapLines,
  onIgnoreWhitespace,
  onScrollPosition,
  onRetryDetail,
  onResolveHunk,
  onLoadMergeSource,
  onApplyMerge,
}: {
  review: SessionChangeReview;
  file: SessionChangeFile;
  language: Language;
  detailLoading: boolean;
  detailError?: string;
  diffMode: ChangeReviewDiffMode;
  wrapLines: boolean;
  ignoreWhitespace: boolean;
  scrollPosition: ChangeReviewScrollPosition;
  onDiffMode: (mode: ChangeReviewDiffMode) => void;
  onWrapLines: (wrap: boolean) => void;
  onIgnoreWhitespace: (ignore: boolean) => void;
  onScrollPosition: (position: ChangeReviewScrollPosition) => void;
  onRetryDetail: () => void;
  onResolveHunk: (reviewId: string, filePath: string, hunkIndex: number, action: "accept" | "revert") => Promise<SessionChangeReview>;
  onLoadMergeSource: (reviewId: string, filePath: string) => Promise<SessionChangeReviewMergeSource>;
  onApplyMerge: (reviewId: string, filePath: string, content: string, currentRevision: string) => Promise<SessionChangeReview>;
}) {
  const t = copy[language];
  const codeRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingScrollRef = useRef<ChangeReviewScrollPosition | null>(null);
  const [visibleRows, setVisibleRows] = useState(INITIAL_DIFF_ROWS);
  const [copied, setCopied] = useState(false);
  const [currentHunk, setCurrentHunk] = useState(-1);
  const [busyHunk, setBusyHunk] = useState<number | null>(null);
  const [pendingRevertHunk, setPendingRevertHunk] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string>();
  const [mergeSource, setMergeSource] = useState<SessionChangeReviewMergeSource>();
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergeSaving, setMergeSaving] = useState(false);
  const [mergeError, setMergeError] = useState<string>();
  const mergeTriggerRef = useRef<HTMLButtonElement>(null);
  const parsedLines = useMemo(() => file.patch ? parseUnifiedPatch(file.patch) : [], [file.patch]);
  const lines = useMemo(() => ignoreWhitespace ? parsedLines.filter((line) => !line.whitespaceOnly) : parsedLines, [ignoreWhitespace, parsedLines]);
  const splitRows = useMemo(() => sideBySideRows(lines), [lines]);
  const totalRows = diffMode === "split" ? splitRows.length : lines.length;
  const hunkCount = lines.reduce((maximum, line) => Math.max(maximum, line.hunkIndex + 1), 0);

  useEffect(() => {
    setVisibleRows(INITIAL_DIFF_ROWS);
    setCurrentHunk(-1);
    setPendingRevertHunk(null);
    setActionError(undefined);
    setMergeSource(undefined);
    setMergeError(undefined);
  }, [diffMode, file.path, ignoreWhitespace, review.id]);
  useLayoutEffect(() => {
    const code = codeRef.current;
    if (!code) return;
    code.scrollTop = scrollPosition.top;
    code.scrollLeft = scrollPosition.left;
  }, [file.path, review.id, scrollPosition.left, scrollPosition.top]);
  useEffect(() => () => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    if (pendingScrollRef.current) onScrollPosition(pendingScrollRef.current);
  }, [onScrollPosition]);

  const moveToHunk = (direction: -1 | 1) => {
    if (!hunkCount) return;
    const next = currentHunk < 0
      ? direction > 0 ? 0 : hunkCount - 1
      : (currentHunk + direction + hunkCount) % hunkCount;
    setCurrentHunk(next);
    setVisibleRows(totalRows);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => codeRef.current?.querySelector<HTMLElement>(`#change-review-hunk-${next}`)?.scrollIntoView({ block: "start" })));
  };

  const patchPending = file.patchAvailable && !file.patch && !file.binary;
  const hunkActionsAvailable = review.state === "completed" && Boolean(file.patch) && !file.binary && !file.truncated;
  const resolvedHunkCount = new Set((file.hunkResolutions ?? [])
    .map((resolution) => resolution.hunkIndex)
    .filter((hunkIndex) => hunkIndex >= 0 && hunkIndex < hunkCount)).size;
  const unresolvedHunks = Math.max(0, hunkCount - resolvedHunkCount);
  const resolveHunk = async (hunkIndex: number, action: "accept" | "revert") => {
    setBusyHunk(hunkIndex);
    setActionError(undefined);
    try {
      await onResolveHunk(review.id, file.path, hunkIndex, action);
      setPendingRevertHunk(null);
    } catch {
      setActionError(t.changeReviewHunkActionFailed);
    } finally {
      setBusyHunk(null);
    }
  };
  const openMerge = async () => {
    setMergeLoading(true);
    setMergeError(undefined);
    try { setMergeSource(await onLoadMergeSource(review.id, file.path)); }
    catch { setMergeError(t.changeReviewMergeLoadFailed); }
    finally { setMergeLoading(false); }
  };
  const saveMerge = async (content: string, revision: string) => {
    setMergeSaving(true);
    setMergeError(undefined);
    try {
      await onApplyMerge(review.id, file.path, content, revision);
      setMergeSource(undefined);
      window.requestAnimationFrame(() => mergeTriggerRef.current?.focus());
    } catch (error) {
      setMergeError(error instanceof Error && /changed while the merge editor was open/i.test(error.message)
        ? t.changeReviewMergeConflict
        : t.changeReviewMergeSaveFailed);
    } finally {
      setMergeSaving(false);
    }
  };
  return <section className="change-review-diff" aria-label={file.path}>
    <header className="change-review-file-header">
      <div>
        <span className={`change-review-status ${file.status}`} title={statusLabel(file, language)}>{statusMark(file)}</span>
        <strong title={file.path}>{file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}</strong>
        {file.oldMode && file.newMode && <small className="change-review-mode" title={t.changeReviewModeChanged(file.oldMode, file.newMode)}>{file.oldMode} → {file.newMode}</small>}
      </div>
      <span>
        <b className="diff-addition">+{file.additions}</b><b className="diff-deletion">−{file.deletions}</b>
        <button
          type="button"
          className="change-review-copy-path"
          title={t.changeReviewCopyPath}
          aria-label={t.changeReviewCopyPath}
          onClick={() => void copyText(file.path).then((success) => { if (success) { setCopied(true); setTimeout(() => setCopied(false), 1_500); } })}
        ><Icon name={copied ? "check" : "copy"} size={12} /></button>
      </span>
      <span className="sr-only" role="status" aria-live="polite">{copied ? t.changeReviewPathCopied : ""}</span>
    </header>
    <div className="change-review-viewbar" aria-label={t.changeReview}>
      <div className="change-review-segmented">
        <button type="button" aria-pressed={diffMode === "unified"} title={t.changeReviewUnified} onClick={() => onDiffMode("unified")}>{t.changeReviewUnified}</button>
        <button type="button" aria-pressed={diffMode === "split"} title={t.changeReviewSplit} onClick={() => onDiffMode("split")}>{t.changeReviewSplit}</button>
      </div>
      <button type="button" className="change-review-toggle" aria-pressed={wrapLines} title={t.changeReviewWrap} onClick={() => onWrapLines(!wrapLines)}>{t.changeReviewWrap}</button>
      <button type="button" className="change-review-toggle" aria-pressed={ignoreWhitespace} title={t.changeReviewIgnoreWhitespace} onClick={() => onIgnoreWhitespace(!ignoreWhitespace)}>{t.changeReviewIgnoreWhitespace}</button>
      <button ref={mergeTriggerRef} type="button" className="change-review-toggle change-review-merge-trigger" disabled={!hunkActionsAvailable || unresolvedHunks === 0 || mergeLoading} title={hunkActionsAvailable ? t.changeReviewMergeDescription : t.changeReviewMergeUnavailable} onClick={() => void openMerge()}>{mergeLoading ? t.changeReviewMergeLoading : t.changeReviewMerge}</button>
      <span className="change-review-hunk-actions">
        <button type="button" disabled={!hunkCount} title={t.changeReviewPreviousHunk} aria-label={t.changeReviewPreviousHunk} onClick={() => moveToHunk(-1)}><Icon name="chevron" size={12} /></button>
        <button type="button" disabled={!hunkCount} title={t.changeReviewNextHunk} aria-label={t.changeReviewNextHunk} onClick={() => moveToHunk(1)}><Icon name="chevron" size={12} /></button>
      </span>
    </div>
    <div
      ref={codeRef}
      className={`change-review-code ${wrapLines ? "wrap-lines" : ""} ${diffMode === "split" ? "split" : "unified"}`}
      role="table"
      aria-label={file.path}
      onScroll={(event) => {
        const target = event.currentTarget;
        pendingScrollRef.current = { top: target.scrollTop, left: target.scrollLeft };
        if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
        scrollTimerRef.current = setTimeout(() => {
          scrollTimerRef.current = undefined;
          if (pendingScrollRef.current) onScrollPosition(pendingScrollRef.current);
          pendingScrollRef.current = null;
        }, 120);
      }}
    >
      {detailLoading || (patchPending && !detailError)
        ? <div className="change-review-no-patch" role="status"><span className="conversation-spinner" aria-hidden="true" /><span>{t.changeReviewDetailLoading}</span></div>
        : detailError
          ? <div className="change-review-no-patch" role="alert"><Icon name="alert" size={17} /><span>{t.changeReviewDetailFailed}</span><button type="button" className="button ghost" onClick={onRetryDetail}>{t.changeReviewRetry}</button></div>
          : diffMode === "unified"
            ? <UnifiedDiffRows
                lines={lines.slice(0, visibleRows)}
                file={file}
                language={language}
                disabled={!hunkActionsAvailable || busyHunk !== null}
                pendingRevertHunk={pendingRevertHunk}
                onAccept={(hunkIndex) => void resolveHunk(hunkIndex, "accept")}
                onRequestRevert={(hunkIndex) => setPendingRevertHunk((current) => current === hunkIndex ? null : hunkIndex)}
                onCancelRevert={() => setPendingRevertHunk(null)}
                onConfirmRevert={(hunkIndex) => void resolveHunk(hunkIndex, "revert")}
              />
            : <SplitDiffRows
                rows={splitRows.slice(0, visibleRows)}
                file={file}
                language={language}
                disabled={!hunkActionsAvailable || busyHunk !== null}
                pendingRevertHunk={pendingRevertHunk}
                onAccept={(hunkIndex) => void resolveHunk(hunkIndex, "accept")}
                onRequestRevert={(hunkIndex) => setPendingRevertHunk((current) => current === hunkIndex ? null : hunkIndex)}
                onCancelRevert={() => setPendingRevertHunk(null)}
                onConfirmRevert={(hunkIndex) => void resolveHunk(hunkIndex, "revert")}
              />}
      {!detailLoading && !detailError && totalRows === 0 && <div className="change-review-no-patch"><Icon name="file" size={17} /><span>{file.binary ? t.changeReviewBinary : t.changeReviewNoPatch}</span>{file.oldMode && file.newMode && <small>{t.changeReviewModeChanged(file.oldMode, file.newMode)}</small>}</div>}
      {!detailLoading && !detailError && visibleRows < totalRows && <button type="button" className="change-review-show-more" onClick={() => setVisibleRows((count) => Math.min(totalRows, count + DIFF_ROW_STEP))}>{t.changeReviewShowMoreLines(Math.min(DIFF_ROW_STEP, totalRows - visibleRows))}</button>}
    </div>
    {actionError && <div className="change-review-action-error" role="alert"><Icon name="alert" size={13} /><span>{actionError}</span></div>}
    {file.truncated && <div className="change-review-warning"><Icon name="alert" size={13} /><span>{t.changeReviewTruncated}</span></div>}
    {mergeError && !mergeSource && <div className="change-review-action-error" role="alert"><Icon name="alert" size={13} /><span>{mergeError}</span></div>}
    {mergeSource && <Suspense fallback={<div className="change-review-merge-backdrop"><div className="change-review-merge-loading" role="status"><span className="conversation-spinner" aria-hidden="true" />{t.changeReviewMergeLoading}</div></div>}>
      <ChangeReviewMergeEditor source={mergeSource} language={language} busy={mergeSaving} error={mergeError} returnFocusRef={mergeTriggerRef} onSave={saveMerge} onCancel={() => setMergeSource(undefined)} />
    </Suspense>}
  </section>;
}

export interface ChangeReviewPanelProps {
  reviews: SessionChangeReview[];
  selectedReview: SessionChangeReview | null;
  language: Language;
  loading: boolean;
  availability: SessionChangeReviewAvailability;
  unavailableReason?: SessionChangeReviewUnavailableReason;
  loadError?: string;
  detailLoading: boolean;
  detailError?: string;
  fileListWidth: number;
  selectedPath: string | null;
  expandedPaths: string[];
  fileFilter: string;
  diffMode: ChangeReviewDiffMode;
  wrapLines: boolean;
  ignoreWhitespace: boolean;
  scrollPosition: ChangeReviewScrollPosition;
  drawer: boolean;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onFileListWidth: (width: number) => void;
  onSelectReview: (reviewId: string) => void;
  onSelectPath: (path: string) => void;
  onExpandedPaths: (paths: string[]) => void;
  onFileFilter: (query: string) => void;
  onDiffMode: (mode: ChangeReviewDiffMode) => void;
  onWrapLines: (wrap: boolean) => void;
  onIgnoreWhitespace: (ignore: boolean) => void;
  onScrollPosition: (position: ChangeReviewScrollPosition) => void;
  onRetry: () => void;
  onRetryDetail: () => void;
  onResolveHunk: (reviewId: string, filePath: string, hunkIndex: number, action: "accept" | "revert") => Promise<SessionChangeReview>;
  onLoadMergeSource: (reviewId: string, filePath: string) => Promise<SessionChangeReviewMergeSource>;
  onApplyMerge: (reviewId: string, filePath: string, content: string, currentRevision: string) => Promise<SessionChangeReview>;
  onClose: () => void;
}

function ChangeReviewPanel({
  reviews, selectedReview, language, loading, availability, unavailableReason, loadError,
  detailLoading, detailError, fileListWidth, selectedPath, expandedPaths, fileFilter,
  diffMode, wrapLines, ignoreWhitespace, scrollPosition, drawer, returnFocusRef, onFileListWidth,
  onSelectReview, onSelectPath, onExpandedPaths, onFileFilter, onDiffMode, onWrapLines,
  onIgnoreWhitespace, onScrollPosition, onRetry, onRetryDetail, onClose,
  onResolveHunk, onLoadMergeSource, onApplyMerge,
}: ChangeReviewPanelProps) {
  const t = copy[language];
  const [runPickerOpen, setRunPickerOpen] = useState(false);
  const [bodyWidth, setBodyWidth] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const runPickerRef = useRef<HTMLDivElement>(null);
  const runPickerTriggerRef = useRef<HTMLButtonElement>(null);
  const selectedFile = selectedReview?.files.find((file) => file.path === selectedPath) ?? selectedReview?.files[0] ?? null;
  const selectedReviewIndex = selectedReview ? reviews.findIndex((review) => review.id === selectedReview.id) : -1;
  useDialogFocus(panelRef, onClose, drawer, returnFocusRef);

  useEffect(() => {
    if (selectedFile && selectedFile.path !== selectedPath) onSelectPath(selectedFile.path);
  }, [onSelectPath, selectedFile, selectedPath]);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const update = () => setBodyWidth(body.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(body);
    return () => observer.disconnect();
  }, [selectedReview?.id]);
  useEffect(() => {
    if (!runPickerOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !runPickerRef.current?.contains(event.target)) setRunPickerOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [runPickerOpen]);
  useEffect(() => {
    if (drawer) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (runPickerOpen) {
        setRunPickerOpen(false);
        window.requestAnimationFrame(() => runPickerTriggerRef.current?.focus());
      } else {
        onClose();
        window.requestAnimationFrame(() => returnFocusRef.current?.focus());
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [drawer, onClose, returnFocusRef, runPickerOpen]);

  const minimumFileListWidth = 190;
  const maximumFileListWidth = Math.max(minimumFileListWidth, bodyWidth - 340);
  const effectiveFileListWidth = Math.min(maximumFileListWidth, Math.max(minimumFileListWidth, fileListWidth));
  const runPickerDisabled = loading || reviews.length === 0 || !selectedReview;
  const unavailable = availability !== "available";

  return <aside
    ref={panelRef}
    className="change-review-panel"
    aria-labelledby="change-review-title"
    role={drawer ? "dialog" : undefined}
    aria-modal={drawer || undefined}
  >
    <header className="change-review-header">
      <div><Icon name="diff" size={15} /><strong id="change-review-title">{t.changeReview}</strong></div>
      <button type="button" className="icon-button" title={t.changeReviewClose} aria-label={t.changeReviewClose} onClick={() => { onClose(); if (!drawer) window.requestAnimationFrame(() => returnFocusRef.current?.focus()); }}><Icon name="x" size={13} /></button>
    </header>
    <div className="change-review-toolbar">
      <div className="change-review-run-picker" ref={runPickerRef}>
        <button
          ref={runPickerTriggerRef}
          type="button"
          className="change-review-run-trigger"
          aria-label={t.changeReviewSelectRun}
          aria-haspopup="listbox"
          aria-expanded={runPickerOpen}
          disabled={runPickerDisabled}
          onClick={() => setRunPickerOpen((current) => !current)}
        >
          <span>{selectedReview && selectedReviewIndex >= 0 ? reviewRunLabel(selectedReview, selectedReviewIndex, reviews.length, language) : t.changeReviewSelectRun}</span>
          <Icon name="chevron" size={13} />
        </button>
        {runPickerOpen && <div
          className="change-review-run-menu"
          role="listbox"
          data-dialog-escape-boundary=""
          aria-label={t.changeReviewSelectRun}
          onKeyDown={(event) => {
            const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button[role='option']"));
            const current = options.indexOf(document.activeElement as HTMLButtonElement);
            let next = -1;
            if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % options.length;
            else if (event.key === "ArrowUp") next = current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = options.length - 1;
            else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setRunPickerOpen(false);
              runPickerTriggerRef.current?.focus();
              return;
            }
            if (next >= 0) { event.preventDefault(); options[next]?.focus(); }
          }}
        >
          {reviews.map((review, index) => {
            const selected = review.id === selectedReview?.id;
            return <button
              type="button"
              role="option"
              aria-selected={selected}
              className={selected ? "selected" : ""}
              autoFocus={selected}
              key={review.id}
              onClick={() => { onSelectReview(review.id); setRunPickerOpen(false); runPickerTriggerRef.current?.focus(); }}
            ><span>{reviewRunLabel(review, index, reviews.length, language)}</span>{selected && <Icon name="check" size={13} />}</button>;
          })}
        </div>}
      </div>
      {selectedReview && <div className="change-review-totals"><span>{fileCountLabel(selectedReview, language)}</span><strong className="diff-addition">{selectedReview.fileCountTruncated ? "≥ " : ""}+{selectedReview.additions}</strong><strong className="diff-deletion">{selectedReview.fileCountTruncated ? "≥ " : ""}−{selectedReview.deletions}</strong></div>}
    </div>
    <div className={`change-review-scope-notice ${unavailable ? "warning" : ""}`} role={unavailable ? "status" : "note"}>
      <Icon name={unavailable ? "alert" : "diff"} size={13} />
      <span>{availability === "not-git" ? t.changeReviewNotGitBody : availability === "error" ? `${reviewStatusMessage(unavailableReason, language)}${loadError ? ` ${loadError}` : ""}` : t.changeReviewWorkspaceNotice}</span>
      {unavailable && <button type="button" className="button ghost" onClick={onRetry}>{t.changeReviewRetry}</button>}
    </div>
    {loading
      ? <div className="change-review-empty" role="status"><span className="conversation-spinner" aria-hidden="true" /><span>{t.loading}</span></div>
      : unavailable && !selectedReview
        ? <div className="change-review-empty" role="status"><Icon name="alert" size={18} /><strong>{availability === "not-git" ? t.changeReviewNotGit : t.changeReviewUnavailable}</strong><span>{availability === "not-git" ? t.changeReviewNotGitBody : reviewStatusMessage(unavailableReason, language)}</span><button type="button" className="button ghost" onClick={onRetry}>{t.changeReviewRetry}</button></div>
        : !selectedReview?.files.length
          ? <div className="change-review-empty"><Icon name="check" size={18} /><span>{t.changeReviewNoChanges}</span></div>
          : <div ref={bodyRef} className="change-review-body" style={{ "--change-review-files-width": `${effectiveFileListWidth}px` } as CSSProperties}>
              {selectedFile && <ChangeReviewDiff
                review={selectedReview}
                file={selectedFile}
                language={language}
                detailLoading={detailLoading}
                detailError={detailError}
                diffMode={diffMode}
                wrapLines={wrapLines}
                ignoreWhitespace={ignoreWhitespace}
                scrollPosition={scrollPosition}
                onDiffMode={onDiffMode}
                onWrapLines={onWrapLines}
                onIgnoreWhitespace={onIgnoreWhitespace}
                onScrollPosition={onScrollPosition}
                onRetryDetail={onRetryDetail}
                onResolveHunk={onResolveHunk}
                onLoadMergeSource={onLoadMergeSource}
                onApplyMerge={onApplyMerge}
              />}
              <PaneResizeHandle
                className="change-review-files-resize-handle"
                label={t.changeReviewResizeFiles}
                value={effectiveFileListWidth}
                minimum={minimumFileListWidth}
                maximum={maximumFileListWidth}
                direction={-1}
                onChange={onFileListWidth}
              />
              <nav className="change-review-files" aria-label={t.changeReviewFileList}>
                <div className="change-review-files-title"><span>{t.changeReviewFileList}</span><small>{selectedReview.fileCountTruncated ? `${selectedReview.files.length}+` : selectedReview.files.length}</small></div>
                <label className="change-review-file-filter"><Icon name="search" size={12} /><input type="search" value={fileFilter} onChange={(event) => onFileFilter(event.target.value)} placeholder={t.changeReviewFilterFiles} aria-label={t.changeReviewFilterFiles} /></label>
                <ChangeReviewFileTree files={selectedReview.files} selectedPath={selectedFile?.path ?? null} expandedPaths={expandedPaths} query={fileFilter} language={language} onExpandedPaths={onExpandedPaths} onSelect={onSelectPath} />
                {selectedReview.fileCountTruncated && <div className="change-review-list-warning"><Icon name="alert" size={12} /><span>{selectedReview.omittedFiles ? t.changeReviewOmittedFiles(selectedReview.omittedFiles) : t.changeReviewCollectionTruncated}</span></div>}
              </nav>
            </div>}
  </aside>;
}

function ChangeReviewLauncher({
  review,
  language,
  availability = "available",
  buttonRef,
  onOpen,
}: {
  review?: SessionChangeReview | null;
  language: Language;
  availability?: SessionChangeReviewAvailability;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
}) {
  const t = copy[language];
  const unavailable = availability !== "available" && !review;
  return <div className="change-review-launcher-wrap"><button
    ref={buttonRef}
    type="button"
    className={`change-review-launcher ${review?.state === "running" ? "running" : ""} ${unavailable ? "unavailable" : ""}`}
    title={unavailable ? t.changeReviewUnavailable : t.changeReviewOpen}
    aria-label={unavailable ? t.changeReviewUnavailable : t.changeReviewOpen}
    onClick={onOpen}
  >
    <Icon name={unavailable ? "alert" : "diff"} size={13} />
    <span>{review ? `${review.state === "running" ? t.changeReviewCurrent : t.changeReviewLatest} · ${fileCountLabel(review, language)}` : t.changeReviewUnavailable}</span>
    {review && <><strong className="diff-addition">{review.fileCountTruncated ? "≥ " : ""}+{review.additions}</strong><strong className="diff-deletion">{review.fileCountTruncated ? "≥ " : ""}−{review.deletions}</strong></>}
    <Icon name="chevron" size={11} />
  </button></div>;
}

export { ChangeReviewLauncher, ChangeReviewPanel };
