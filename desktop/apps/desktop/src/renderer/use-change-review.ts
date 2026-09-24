import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SessionChangeReview,
  SessionChangeReviewAvailability,
  SessionChangeReviewMergeSource,
  SessionChangeReviewUnavailableReason,
} from "@pfsaa/contracts";
import { readPfsaaStorage, removePfsaaStorage, writePfsaaStorage } from "./pfsaa-storage";

const MAX_CACHED_REVIEW_VIEWS = 40;
const MAX_VIEW_PATHS = 200;
const MAX_SCROLL_POSITIONS = 50;
const DEFAULT_REVIEW_WIDTH = 700;
const DEFAULT_FILE_LIST_WIDTH = 220;
const REVIEW_VIEW_STORAGE_NAME = "change-review-views.v2";

export type ChangeReviewDiffMode = "unified" | "split";
export type ChangeReviewScrollPosition = { top: number; left: number };

type ReviewViewState = {
  open: boolean;
  selectedReviewId: string | null;
  reviewWidth: number;
  fileListWidth: number;
  selectedFiles: Record<string, string>;
  expandedDirectories: Record<string, string[]>;
  scrollPositions: Record<string, ChangeReviewScrollPosition>;
  fileFilter: string;
  diffMode: ChangeReviewDiffMode;
  wrapLines: boolean;
  ignoreWhitespace: boolean;
};

type LoadedReviews = {
  scopeKey: string;
  records: SessionChangeReview[];
  loading: boolean;
  availability: SessionChangeReviewAvailability;
  reason?: SessionChangeReviewUnavailableReason;
  error?: string;
};

const DEFAULT_VIEW_STATE: ReviewViewState = {
  open: false,
  selectedReviewId: null,
  reviewWidth: DEFAULT_REVIEW_WIDTH,
  fileListWidth: DEFAULT_FILE_LIST_WIDTH,
  selectedFiles: {},
  expandedDirectories: {},
  scrollPositions: {},
  fileFilter: "",
  diffMode: "unified",
  wrapLines: false,
  ignoreWhitespace: false,
};

function reviewScopeKey(taskId: string | undefined, projectCwd: string): string {
  return taskId && projectCwd ? `${projectCwd}\u0000${taskId}` : "";
}

function boundedStringRecord(value: unknown, maximum: number): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => key.length <= 512 && typeof item === "string" && item.length <= 4096)
    .slice(-maximum));
}

function sanitizeViewState(value: unknown): ReviewViewState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_VIEW_STATE };
  const record = value as Record<string, unknown>;
  const selectedFiles = boundedStringRecord(record.selectedFiles, 20);
  const expandedDirectories = Object.fromEntries(Object.entries(
    record.expandedDirectories && typeof record.expandedDirectories === "object" && !Array.isArray(record.expandedDirectories)
      ? record.expandedDirectories as Record<string, unknown>
      : {},
  ).filter(([key, paths]) => key.length <= 512 && Array.isArray(paths))
    .slice(-20)
    .map(([key, paths]) => [key, (paths as unknown[]).filter((item): item is string => typeof item === "string" && item.length <= 4096).slice(0, MAX_VIEW_PATHS)]));
  const scrollPositions = Object.fromEntries(Object.entries(
    record.scrollPositions && typeof record.scrollPositions === "object" && !Array.isArray(record.scrollPositions)
      ? record.scrollPositions as Record<string, unknown>
      : {},
  ).filter(([key, position]) => {
    if (key.length > 4608 || !position || typeof position !== "object") return false;
    const item = position as Record<string, unknown>;
    return Number.isFinite(item.top) && Number.isFinite(item.left);
  }).slice(-MAX_SCROLL_POSITIONS).map(([key, position]) => {
    const item = position as Record<string, number>;
    return [key, { top: Math.min(100_000_000, Math.max(0, item.top)), left: Math.min(100_000_000, Math.max(0, item.left)) }];
  }));
  return {
    open: record.open === true,
    selectedReviewId: typeof record.selectedReviewId === "string" && record.selectedReviewId.length <= 512 ? record.selectedReviewId : null,
    reviewWidth: Number.isFinite(record.reviewWidth) ? Math.round(Number(record.reviewWidth)) : DEFAULT_REVIEW_WIDTH,
    fileListWidth: Number.isFinite(record.fileListWidth) ? Math.round(Number(record.fileListWidth)) : DEFAULT_FILE_LIST_WIDTH,
    selectedFiles,
    expandedDirectories,
    scrollPositions,
    fileFilter: typeof record.fileFilter === "string" ? record.fileFilter.slice(0, 160) : "",
    diffMode: record.diffMode === "split" ? "split" : "unified",
    wrapLines: record.wrapLines === true,
    ignoreWhitespace: record.ignoreWhitespace === true,
  };
}

function loadStoredViews(): Map<string, ReviewViewState> {
  try {
    const raw = readPfsaaStorage(REVIEW_VIEW_STORAGE_NAME) ?? "null";
    if (raw.length > 1_000_000) { removePfsaaStorage(REVIEW_VIEW_STORAGE_NAME); return new Map(); }
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown } | null;
    if (parsed?.version !== 2 || !Array.isArray(parsed.entries)) return new Map();
    return new Map(parsed.entries
      .filter((entry): entry is [string, unknown] => Array.isArray(entry) && typeof entry[0] === "string" && entry[0].length <= 8192)
      .slice(-MAX_CACHED_REVIEW_VIEWS)
      .map(([key, value]) => [key, sanitizeViewState(value)]));
  } catch { return new Map(); }
}

function summarizeReview(review: SessionChangeReview): SessionChangeReview {
  return { ...review, files: review.files.map(({ patch: _patch, ...file }) => file) };
}

function scrollKey(reviewId: string, filePath: string): string {
  return `${reviewId}\u0000${filePath}`;
}

export function useChangeReview({ enabled, taskId, projectCwd, onError }: { enabled: boolean; taskId?: string; projectCwd: string; onError: (error: unknown) => void }) {
  const scopeKey = reviewScopeKey(taskId, projectCwd);
  const [loaded, setLoaded] = useState<LoadedReviews>({ scopeKey: "", records: [], loading: false, availability: "available" });
  const [viewVersion, setViewVersion] = useState(0);
  const [detailVersion, setDetailVersion] = useState(0);
  const [reloadVersion, setReloadVersion] = useState(0);
  const requestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const latestStartedAtRef = useRef(0);
  const statusRevisionRef = useRef(0);
  const liveUpdatesRef = useRef(new Map<string, SessionChangeReview>());
  const detailReviewsRef = useRef(new Map<string, SessionChangeReview>());
  const detailErrorsRef = useRef(new Map<string, string>());
  const detailLoadingRef = useRef(new Set<string>());
  const viewStatesRef = useRef<Map<string, ReviewViewState>>(loadStoredViews());

  const updateViewState = useCallback((key: string, update: Partial<ReviewViewState> | ((current: ReviewViewState) => ReviewViewState)) => {
    if (!key) return;
    const states = viewStatesRef.current;
    const current = states.get(key) ?? { ...DEFAULT_VIEW_STATE };
    const next = typeof update === "function" ? update(current) : { ...current, ...update };
    states.delete(key);
    states.set(key, sanitizeViewState(next));
    while (states.size > MAX_CACHED_REVIEW_VIEWS) {
      const oldestKey = states.keys().next().value as string | undefined;
      if (!oldestKey) break;
      states.delete(oldestKey);
    }
    setViewVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    const persist = () => {
      try {
        writePfsaaStorage(REVIEW_VIEW_STORAGE_NAME, JSON.stringify({ version: 2, entries: [...viewStatesRef.current] }));
      } catch { /* View restoration is best effort and never blocks review. */ }
    };
    const timer = window.setTimeout(persist, 350);
    window.addEventListener("pagehide", persist);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", persist);
    };
  }, [viewVersion]);

  useEffect(() => {
    const requestId = ++requestRef.current;
    detailRequestRef.current += 1;
    latestStartedAtRef.current = 0;
    statusRevisionRef.current = 0;
    const statusRevision = statusRevisionRef.current;
    liveUpdatesRef.current.clear();
    detailReviewsRef.current.clear();
    detailErrorsRef.current.clear();
    detailLoadingRef.current.clear();
    setDetailVersion((version) => version + 1);
    if (!enabled || !scopeKey || !taskId || !projectCwd) {
      setLoaded({ scopeKey: "", records: [], loading: false, availability: "available" });
      return;
    }
    setLoaded({ scopeKey, records: [], loading: true, availability: "available" });
    void window.pfsaa.sessions.changeReviews(taskId, projectCwd).then((collection) => {
      if (requestRef.current !== requestId) return;
      const liveUpdates = [...liveUpdatesRef.current.values()];
      const liveIds = new Set(liveUpdates.map((review) => review.id));
      const merged = [...collection.reviews.filter((review) => !liveIds.has(review.id)), ...liveUpdates]
        .sort((left, right) => left.startedAt - right.startedAt);
      latestStartedAtRef.current = merged.at(-1)?.startedAt ?? 0;
      const preferredId = viewStatesRef.current.get(scopeKey)?.selectedReviewId;
      const selectedReviewId = preferredId && merged.some((review) => review.id === preferredId)
        ? preferredId
        : merged.at(-1)?.id ?? null;
      updateViewState(scopeKey, { selectedReviewId });
      setLoaded((current) => current.scopeKey === scopeKey ? {
        scopeKey,
        records: merged,
        loading: false,
        availability: statusRevisionRef.current === statusRevision ? collection.availability : current.availability,
        reason: statusRevisionRef.current === statusRevision ? collection.reason : current.reason,
        error: statusRevisionRef.current === statusRevision ? undefined : current.error,
      } : current);
    }).catch((error) => {
      if (requestRef.current === requestId) {
        const message = error instanceof Error ? error.message : String(error);
        setLoaded({ scopeKey, records: [], loading: false, availability: "error", reason: "git-inspection-failed", error: message });
        onError(error);
      }
    });
  }, [enabled, onError, projectCwd, reloadVersion, scopeKey, taskId, updateViewState]);

  const viewState = scopeKey ? viewStatesRef.current.get(scopeKey) ?? DEFAULT_VIEW_STATE : DEFAULT_VIEW_STATE;
  const reviews = loaded.scopeKey === scopeKey ? loaded.records : [];
  const loading = enabled && Boolean(scopeKey) && (loaded.scopeKey !== scopeKey || loaded.loading);
  const latestReview = reviews.at(-1) ?? null;
  const launcherReview = latestReview?.files.length
    ? latestReview
    : [...reviews].reverse().find((review) => review.files.length > 0) ?? null;
  const selectedSummary = reviews.find((review) => review.id === viewState.selectedReviewId) ?? latestReview;
  const selectedReview = selectedSummary ? detailReviewsRef.current.get(selectedSummary.id) ?? selectedSummary : null;

  useEffect(() => {
    if (!enabled || !viewState.open || !selectedSummary || !taskId || !projectCwd || !scopeKey) return;
    if (detailReviewsRef.current.has(selectedSummary.id) || detailLoadingRef.current.has(selectedSummary.id)) return;
    // Live reviews already carry their bounded patch payload.
    if (liveUpdatesRef.current.has(selectedSummary.id)) {
      detailReviewsRef.current.set(selectedSummary.id, liveUpdatesRef.current.get(selectedSummary.id)!);
      setDetailVersion((version) => version + 1);
      return;
    }
    const requestId = ++detailRequestRef.current;
    detailLoadingRef.current.add(selectedSummary.id);
    detailErrorsRef.current.delete(selectedSummary.id);
    setDetailVersion((version) => version + 1);
    void window.pfsaa.sessions.changeReview(taskId, selectedSummary.id, projectCwd).then((review) => {
      if (detailRequestRef.current !== requestId || reviewScopeKey(taskId, projectCwd) !== scopeKey) return;
      if (review) detailReviewsRef.current.set(review.id, review);
      else detailErrorsRef.current.set(selectedSummary.id, "not-found");
    }).catch((error) => {
      if (detailRequestRef.current === requestId) {
        detailErrorsRef.current.set(selectedSummary.id, error instanceof Error ? error.message : String(error));
        onError(error);
      }
    }).finally(() => {
      detailLoadingRef.current.delete(selectedSummary.id);
      setDetailVersion((version) => version + 1);
    });
  }, [detailVersion, enabled, onError, projectCwd, scopeKey, selectedSummary, taskId, viewState.open]);

  const setSelectedReviewId = useCallback((reviewId: string) => updateViewState(scopeKey, { selectedReviewId: reviewId }), [scopeKey, updateViewState]);
  const setReviewOpen = useCallback((open: boolean) => { if (enabled) updateViewState(scopeKey, { open }); }, [enabled, scopeKey, updateViewState]);
  const setReviewWidth = useCallback((reviewWidth: number) => updateViewState(scopeKey, { reviewWidth: Math.round(reviewWidth) }), [scopeKey, updateViewState]);
  const setFileListWidth = useCallback((fileListWidth: number) => updateViewState(scopeKey, { fileListWidth: Math.round(fileListWidth) }), [scopeKey, updateViewState]);
  const openLatestReview = useCallback(() => {
    if (!enabled) return;
    const review = launcherReview ?? latestReview;
    updateViewState(scopeKey, { ...(review ? { selectedReviewId: review.id } : {}), open: true });
  }, [enabled, launcherReview, latestReview, scopeKey, updateViewState]);

  const applyUpdatedReview = useCallback((updatedTaskId: string, review: SessionChangeReview) => {
    if (!enabled || updatedTaskId !== taskId || !scopeKey) return;
    liveUpdatesRef.current.set(review.id, review);
    detailReviewsRef.current.set(review.id, review);
    setDetailVersion((version) => version + 1);
    setLoaded((current) => {
      const records = current.scopeKey === scopeKey ? current.records : [];
      return {
        scopeKey,
        records: [...records.filter((item) => item.id !== review.id), summarizeReview(review)].sort((left, right) => left.startedAt - right.startedAt),
        loading: current.scopeKey === scopeKey ? current.loading : false,
        availability: "available",
      };
    });
    if (review.startedAt >= latestStartedAtRef.current) {
      latestStartedAtRef.current = review.startedAt;
      if (!(viewStatesRef.current.get(scopeKey)?.open ?? false)) updateViewState(scopeKey, { selectedReviewId: review.id });
    }
  }, [enabled, scopeKey, taskId, updateViewState]);

  const applyReviewStatus = useCallback((updatedTaskId: string, availability: SessionChangeReviewAvailability, reason?: SessionChangeReviewUnavailableReason) => {
    if (!enabled || updatedTaskId !== taskId || !scopeKey) return;
    statusRevisionRef.current += 1;
    setLoaded((current) => current.scopeKey === scopeKey ? { ...current, availability, reason, error: undefined } : current);
  }, [enabled, scopeKey, taskId]);

  const resolveHunk = useCallback(async (reviewId: string, filePath: string, hunkIndex: number, action: "accept" | "revert") => {
    if (!taskId || !projectCwd) throw new Error("No active task");
    const review = await window.pfsaa.sessions.resolveChangeReviewHunk(taskId, reviewId, filePath, hunkIndex, action, projectCwd);
    applyUpdatedReview(taskId, review);
    return review;
  }, [applyUpdatedReview, projectCwd, taskId]);

  const loadMergeSource = useCallback(async (reviewId: string, filePath: string): Promise<SessionChangeReviewMergeSource> => {
    if (!taskId || !projectCwd) throw new Error("No active task");
    return window.pfsaa.sessions.changeReviewMergeSource(taskId, reviewId, filePath, projectCwd);
  }, [projectCwd, taskId]);

  const applyMerge = useCallback(async (reviewId: string, filePath: string, content: string, currentRevision: string) => {
    if (!taskId || !projectCwd) throw new Error("No active task");
    const review = await window.pfsaa.sessions.applyChangeReviewMerge(taskId, reviewId, filePath, content, currentRevision, projectCwd);
    applyUpdatedReview(taskId, review);
    return review;
  }, [applyUpdatedReview, projectCwd, taskId]);

  const selectedReviewId = selectedReview?.id ?? viewState.selectedReviewId;
  const selectedFilePath = selectedReviewId ? viewState.selectedFiles[selectedReviewId] ?? null : null;
  const setSelectedFilePath = useCallback((filePath: string) => {
    if (!selectedReviewId) return;
    updateViewState(scopeKey, (current) => ({ ...current, selectedFiles: { ...current.selectedFiles, [selectedReviewId]: filePath } }));
  }, [scopeKey, selectedReviewId, updateViewState]);
  const expandedDirectories = selectedReviewId ? viewState.expandedDirectories[selectedReviewId] ?? [] : [];
  const setExpandedDirectories = useCallback((paths: string[]) => {
    if (!selectedReviewId) return;
    updateViewState(scopeKey, (current) => ({ ...current, expandedDirectories: { ...current.expandedDirectories, [selectedReviewId]: paths.slice(0, MAX_VIEW_PATHS) } }));
  }, [scopeKey, selectedReviewId, updateViewState]);
  const selectedScrollKey = selectedReviewId && selectedFilePath ? scrollKey(selectedReviewId, selectedFilePath) : "";
  const diffScrollPosition = selectedScrollKey ? viewState.scrollPositions[selectedScrollKey] ?? { top: 0, left: 0 } : { top: 0, left: 0 };
  const setDiffScrollPosition = useCallback((position: ChangeReviewScrollPosition) => {
    if (!selectedScrollKey) return;
    updateViewState(scopeKey, (current) => {
      const entries = [...Object.entries(current.scrollPositions).filter(([key]) => key !== selectedScrollKey), [selectedScrollKey, position] as const].slice(-MAX_SCROLL_POSITIONS);
      return { ...current, scrollPositions: Object.fromEntries(entries) };
    });
  }, [scopeKey, selectedScrollKey, updateViewState]);

  const retrySelectedReview = useCallback(() => {
    if (!selectedSummary) return;
    if (detailErrorsRef.current.get(selectedSummary.id) === "not-found") {
      setReloadVersion((version) => version + 1);
      return;
    }
    detailReviewsRef.current.delete(selectedSummary.id);
    detailErrorsRef.current.delete(selectedSummary.id);
    detailLoadingRef.current.delete(selectedSummary.id);
    setDetailVersion((version) => version + 1);
  }, [selectedSummary]);

  return {
    enabled,
    reviews,
    latestReview,
    launcherReview,
    selectedReview,
    selectedReviewId: viewState.selectedReviewId,
    setSelectedReviewId,
    reviewOpen: enabled && viewState.open,
    setReviewOpen,
    openLatestReview,
    reviewLoading: loading,
    reviewAvailability: loaded.scopeKey === scopeKey ? loaded.availability : "available" as const,
    reviewUnavailableReason: loaded.scopeKey === scopeKey ? loaded.reason : undefined,
    reviewError: loaded.scopeKey === scopeKey ? loaded.error : undefined,
    reloadReviews: () => { if (enabled) setReloadVersion((version) => version + 1); },
    selectedReviewLoading: Boolean(selectedSummary && detailLoadingRef.current.has(selectedSummary.id)),
    selectedReviewError: selectedSummary ? detailErrorsRef.current.get(selectedSummary.id) : undefined,
    retrySelectedReview,
    resolveHunk,
    loadMergeSource,
    applyMerge,
    reviewWidth: viewState.reviewWidth,
    setReviewWidth,
    fileListWidth: viewState.fileListWidth,
    setFileListWidth,
    selectedFilePath,
    setSelectedFilePath,
    expandedDirectories,
    setExpandedDirectories,
    fileFilter: viewState.fileFilter,
    setFileFilter: (fileFilter: string) => updateViewState(scopeKey, { fileFilter }),
    diffMode: viewState.diffMode,
    setDiffMode: (diffMode: ChangeReviewDiffMode) => updateViewState(scopeKey, { diffMode }),
    wrapLines: viewState.wrapLines,
    setWrapLines: (wrapLines: boolean) => updateViewState(scopeKey, { wrapLines }),
    ignoreWhitespace: viewState.ignoreWhitespace,
    setIgnoreWhitespace: (ignoreWhitespace: boolean) => updateViewState(scopeKey, { ignoreWhitespace }),
    diffScrollPosition,
    setDiffScrollPosition,
    applyUpdatedReview,
    applyReviewStatus,
  };
}
