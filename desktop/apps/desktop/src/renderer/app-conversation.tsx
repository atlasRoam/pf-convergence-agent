import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PermissionStatus, SessionChangeReview, SessionChangeReviewAvailability, SessionChangeReviewMergeSource, SessionChangeReviewUnavailableReason } from "@pfsaa/contracts";
import type { ProjectSummary, TaskSummary } from "@pfsaa/domain";
import { copy, type Language } from "@pfsaa/i18n";
import { Icon } from "@pfsaa/ui-system";
import type { MessageLoad, TaskUiState, WorkingPhase } from "./types";
import type { ComposerProps } from "./ui";
import type { ConversationScrollHandle, ConversationScrollSnapshot } from "./use-conversation-scroll";
import type { ChangeReviewDiffMode, ChangeReviewScrollPosition } from "./use-change-review";
import { ApprovalCard, ChangeReviewLauncher, ChangeReviewPanel, ConversationSkeleton, MemoComposer, MemoMessageTimeline, PaneResizeHandle, PermissionLevelControl } from "./ui";

type AppCopy = (typeof copy)[Language];

interface ConversationPaneData {
  task: TaskSummary;
  messageLoad: MessageLoad;
  messages: any[];
  isWorking: boolean;
  streamText: string;
  workingPhase: WorkingPhase;
  taskUi: TaskUiState | undefined;
  steeringMessageKeys: string[];
}

interface ConversationPaneSlotProps {
  data?: ConversationPaneData;
  active: boolean;
  language: Language;
  t: AppCopy;
  loadError: string | null;
  scrollPositionsRef: { current: Record<string, ConversationScrollSnapshot> };
  scrollHandleRef: { current: ConversationScrollHandle | null };
  onTimelineAtEnd: (atEnd: boolean) => void;
  onRetryInitialLoad: () => void | Promise<unknown>;
  onRetryMessages: () => void;
  onResolveApproval: (decision: "allow-once" | "deny") => Promise<void>;
  onPreviewImage: ComposerProps["onPreviewImage"];
  onContextMenuImage: ComposerProps["onContextMenuImage"];
  transcriptSearchQuery: string;
  transcriptSearchRequest: { serial: number; direction: "forward" | "backward"; reset: boolean };
  onTranscriptSearchResult: (result: { current: number; total: number }) => void;
}

function conversationPaneKey(projectCwd: string, taskId: string): string {
  return `${projectCwd}\u0000${taskId}`;
}

function ConversationPaneSlot({
  data, active, language, t, loadError, scrollPositionsRef, scrollHandleRef,
  onTimelineAtEnd, onRetryInitialLoad, onRetryMessages, onResolveApproval,
  onPreviewImage, onContextMenuImage, transcriptSearchQuery, transcriptSearchRequest, onTranscriptSearchResult,
}: ConversationPaneSlotProps) {
  // Inactive panes keep their last data and DOM mounted and are hidden with
  // `visibility`, never `display: none`. That is what lets the browser preserve
  // each pane's own scrollTop across task switches with no restore logic.
  const retainedDataRef = useRef<ConversationPaneData | undefined>(data);
  if (data) retainedDataRef.current = data;
  const retained = retainedDataRef.current;
  const paneRef = useRef<HTMLDivElement>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);

  // Thin scroll position indicator. The native scrollbar is hidden, so this
  // thumb is the only position cue in long conversations. It writes styles
  // directly to the DOM inside a rAF to avoid re-rendering per scroll event.
  useLayoutEffect(() => {
    // Cached panes retain their DOM and scrollTop, but only the visible pane
    // needs scroll, resize, and mutation observers doing work.
    if (!active) return;
    const pane = paneRef.current;
    const indicator = indicatorRef.current;
    if (!pane || !indicator) return;
    const thumb = indicator.firstElementChild as HTMLElement | null;
    if (!thumb) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const { scrollTop, scrollHeight, clientHeight } = pane;
      const overflow = scrollHeight - clientHeight;
      if (overflow <= 1) { indicator.classList.remove("has-overflow"); return; }
      indicator.classList.add("has-overflow");
      const track = clientHeight - 16;
      const height = Math.max(28, track * (clientHeight / scrollHeight));
      const top = 8 + (track - height) * (scrollTop / overflow);
      thumb.style.height = `${height}px`;
      thumb.style.transform = `translateY(${top}px)`;
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };
    schedule();
    pane.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(pane);
    // A scroll container's own box never resizes when its content grows, so the
    // thumb has to track the transcript element itself. It mounts after this
    // effect (messages load asynchronously), hence the childList watch.
    let observedContent: Element | null = null;
    const attachContent = () => {
      const content = pane.querySelector(".timeline-list");
      if (!content || content === observedContent) return;
      if (observedContent) observer.unobserve(observedContent);
      observedContent = content;
      observer.observe(content);
    };
    attachContent();
    const mutations = new MutationObserver(attachContent);
    mutations.observe(pane, { childList: true });
    return () => {
      pane.removeEventListener("scroll", schedule);
      mutations.disconnect();
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [active]);

  if (!retained) return null;

  const { task, messageLoad, messages, isWorking, streamText, workingPhase, taskUi, steeringMessageKeys } = retained;
  const scrollKey = conversationPaneKey(task.projectId, task.id);
  return <div
    ref={paneRef}
    className={`conversation-scroll conversation-pane ${active ? "is-active" : "is-inactive"}`}
    aria-hidden={!active}
  >
    <div className="scroll-indicator" ref={indicatorRef} aria-hidden="true"><span className="scroll-indicator-thumb" /></div>
    {active && loadError && <div className="runtime-error" role="alert"><strong>{loadError}</strong><button onClick={() => void onRetryInitialLoad()}>{t.retry}</button></div>}
    {messageLoad.status === "loading" && messages.length === 0 && <ConversationSkeleton label={t.loadingConversation} />}
    {messageLoad.status === "error" && <div className="conversation-error" role="alert"><span><Icon name="alert" /> <strong>{t.conversationLoadFailed}</strong><small>{messageLoad.error}</small></span><button className="button ghost" onClick={onRetryMessages}>{t.retry}</button></div>}
    {messageLoad.status === "ready" && messages.length === 0 && !isWorking && <div className="empty-conversation"><span className="empty-glyph"><Icon name="spark" size={22} /></span><h2>{t.noMessages}</h2><p>{t.typeToStart}</p></div>}
    {(messageLoad.status === "ready" || messages.length > 0 || isWorking) && <MemoMessageTimeline
      messages={messages}
      language={language}
      running={isWorking}
      activeActivity={taskUi?.activity ?? []}
      streamText={streamText}
      workingPhase={workingPhase}
      toolName={taskUi?.toolName}
      workingMessage={taskUi?.extensionWorkingMessage ?? (workingPhase === "thinking" ? taskUi?.extensionHiddenThinkingLabel : undefined)}
      workingVisible={taskUi?.extensionWorkingVisible}
      workingFrames={taskUi?.extensionWorkingFrames}
      workingInterval={taskUi?.extensionWorkingInterval}
      toolsExpanded={taskUi?.extensionToolsExpanded}
      retryStatus={taskUi?.retryStatus}
      completedActivity={taskUi?.completedActivity ?? []}
      steeringMessageKeys={steeringMessageKeys}
      taskId={task.id}
      scrollKey={scrollKey}
      active={active}
      messageReady={messageLoad.status === "ready"}
      conversationRef={paneRef}
      scrollPositionsRef={scrollPositionsRef}
      scrollHandleRef={scrollHandleRef}
      onAtEndChange={onTimelineAtEnd}
      footer={taskUi?.approval ? <ApprovalCard approval={taskUi.approval} language={language} onResolve={onResolveApproval} /> : null}
      onPreviewImage={onPreviewImage}
      onContextMenuImage={onContextMenuImage}
      searchQuery={active ? transcriptSearchQuery : ""}
      searchRequest={active ? transcriptSearchRequest : undefined}
      onSearchResult={onTranscriptSearchResult}
    />}
  </div>;
}

const MemoConversationPaneSlot = memo(ConversationPaneSlot, (previous, next) =>
  previous.active === next.active
  && previous.data === next.data
  && previous.language === next.language
  && previous.t === next.t
  && (!previous.active || previous.loadError === next.loadError)
  && (!previous.active || previous.transcriptSearchQuery === next.transcriptSearchQuery)
  && (!previous.active || previous.transcriptSearchRequest === next.transcriptSearchRequest)
);

interface ConversationPaneDeckProps extends Omit<ConversationPaneSlotProps, "data" | "active"> {
  activeData: ConversationPaneData | null;
  tasks: TaskSummary[];
  initialLoading: boolean;
  projectSwitching: boolean;
  projectCwd: string;
  onChooseProject: () => void | Promise<unknown>;
  onCreateTask: () => void | Promise<unknown>;
}

function ConversationPaneDeck({
  activeData, tasks, initialLoading, projectSwitching, projectCwd, t, loadError,
  onChooseProject, onCreateTask, ...paneProps
}: ConversationPaneDeckProps) {
  const activePaneKey = activeData ? conversationPaneKey(activeData.task.projectId, activeData.task.id) : null;
  const [cachedPaneKeys, setCachedPaneKeys] = useState<string[]>(() => activePaneKey ? [activePaneKey] : []);

  useLayoutEffect(() => {
    if (!activePaneKey) return;
    setCachedPaneKeys((current) => current.includes(activePaneKey) ? current : [...current, activePaneKey]);
  }, [activePaneKey]);

  // Keep visited panes mounted across project changes. The pane's own DOM
  // scrollTop is left untouched, so switching projects is a visibility change
  // instead of a remount/restore race.
  const paneKeys = activePaneKey && !cachedPaneKeys.includes(activePaneKey)
    ? [...cachedPaneKeys, activePaneKey]
    : cachedPaneKeys;

  return <div className="conversation-pane-stack">
    {paneKeys.map((paneKey) => <MemoConversationPaneSlot
      key={paneKey}
      {...paneProps}
      t={t}
      loadError={loadError}
      data={paneKey === activePaneKey ? activeData ?? undefined : undefined}
      active={paneKey === activePaneKey}
    />)}
    {!activeData && <div className="conversation-scroll conversation-pane is-active">
      {loadError && <div className="runtime-error" role="alert"><strong>{loadError}</strong><button onClick={() => void paneProps.onRetryInitialLoad()}>{t.retry}</button></div>}
      {initialLoading && <ConversationSkeleton label={t.loading} />}
      {!initialLoading && !loadError && projectSwitching && <div className="conversation-loading" role="status"><span className="conversation-spinner" aria-hidden="true" /><span>{t.loadingConversation}</span></div>}
      {!initialLoading && !loadError && !projectSwitching && !projectCwd && <div className="empty-conversation"><span className="empty-glyph"><Icon name="folder" size={22} /></span><h2>{t.noProjects}</h2><button className="button primary" onClick={() => void onChooseProject()}><Icon name="plus" size={14} />{t.openProject}</button></div>}
      {!initialLoading && !loadError && !projectSwitching && projectCwd && tasks.length > 0 && <div className="empty-conversation"><span className="empty-glyph"><Icon name="queue" size={22} /></span><h2>{t.selectSessionTitle}</h2><p>{t.selectSessionBody}</p><button className="button primary" onClick={() => void onCreateTask()}><Icon name="plus" size={14} />{t.newTask}</button></div>}
      {!initialLoading && !loadError && !projectSwitching && projectCwd && tasks.length === 0 && <div className="empty-conversation"><span className="empty-glyph"><Icon name="spark" size={22} /></span><h2>{t.noSessions}</h2><p>{t.createFirst}</p><button className="button primary" onClick={() => void onCreateTask()}><Icon name="plus" size={14} />{t.newTask}</button></div>}
    </div>}
  </div>;
}

export interface AppConversationProps {
  language: Language;
  t: AppCopy;
  scrollPositionsRef: { current: Record<string, ConversationScrollSnapshot> };
  scrollHandleRef: { current: ConversationScrollHandle | null };
  activeTask: TaskSummary | null;
  activeProject: ProjectSummary | null;
  projectCwd: string;
  tasks: TaskSummary[];
  initialLoading: boolean;
  projectSwitching: boolean;
  loadError: string | null;
  messageLoad: MessageLoad;
  messages: any[];
  isWorking: boolean;
  streamText: string;
  workingPhase: WorkingPhase;
  activeTaskUi: TaskUiState | undefined;
  steeringMessageKeys: string[];
  showJumpToLatest: boolean;
  permissionStatus: PermissionStatus | null;
  changeReviewEnabled: boolean;
  changeReviews: SessionChangeReview[];
  latestChangeReview: SessionChangeReview | null;
  selectedChangeReview: SessionChangeReview | null;
  changeReviewOpen: boolean;
  changeReviewDrawer: boolean;
  changeReviewLoading: boolean;
  changeReviewAvailability: SessionChangeReviewAvailability;
  changeReviewUnavailableReason?: SessionChangeReviewUnavailableReason;
  changeReviewError?: string;
  selectedChangeReviewLoading: boolean;
  selectedChangeReviewError?: string;
  changeReviewWidth: number;
  changeReviewFileListWidth: number;
  changeReviewSelectedPath: string | null;
  changeReviewExpandedPaths: string[];
  changeReviewFileFilter: string;
  changeReviewDiffMode: ChangeReviewDiffMode;
  changeReviewWrapLines: boolean;
  changeReviewIgnoreWhitespace: boolean;
  changeReviewScrollPosition: ChangeReviewScrollPosition;
  composerProps: ComposerProps;
  transcriptSearchOpen: boolean;
  transcriptSearchQuery: string;
  transcriptSearchRequest: { serial: number; direction: "forward" | "backward"; reset: boolean };
  transcriptSearchResult: { current: number; total: number };
  onOpenTranscriptSearch: () => void;
  onTranscriptSearchQuery: (query: string) => void;
  onStepTranscriptSearch: (direction: "forward" | "backward") => void;
  onCloseTranscriptSearch: () => void;
  onTranscriptSearchResult: (result: { current: number; total: number }) => void;
  onTimelineAtEnd: (atEnd: boolean) => void;
  onRetryInitialLoad: () => void | Promise<unknown>;
  onChooseProject: () => void | Promise<unknown>;
  onCreateTask: () => void | Promise<unknown>;
  onRetryMessages: () => void;
  onJumpToLatest: () => void;
  onResolveApproval: (decision: "allow-once" | "deny") => Promise<void>;
  onPermissionStatus: (status: PermissionStatus) => void;
  onOpenChangeReview: () => void;
  onCloseChangeReview: () => void;
  onSelectChangeReview: (reviewId: string) => void;
  onSelectChangeReviewPath: (path: string) => void;
  onChangeReviewExpandedPaths: (paths: string[]) => void;
  onChangeReviewFileFilter: (query: string) => void;
  onChangeReviewDiffMode: (mode: ChangeReviewDiffMode) => void;
  onChangeReviewWrapLines: (wrap: boolean) => void;
  onChangeReviewIgnoreWhitespace: (ignore: boolean) => void;
  onChangeReviewScrollPosition: (position: ChangeReviewScrollPosition) => void;
  onRetryChangeReviews: () => void;
  onRetrySelectedChangeReview: () => void;
  onResolveChangeReviewHunk: (reviewId: string, filePath: string, hunkIndex: number, action: "accept" | "revert") => Promise<SessionChangeReview>;
  onLoadChangeReviewMergeSource: (reviewId: string, filePath: string) => Promise<SessionChangeReviewMergeSource>;
  onApplyChangeReviewMerge: (reviewId: string, filePath: string, content: string, currentRevision: string) => Promise<SessionChangeReview>;
  onChangeReviewWidth: (width: number) => void;
  onChangeReviewFileListWidth: (width: number) => void;
  backgroundInert?: boolean;
}

export function AppConversation({
  language, t, activeTask, activeProject, projectCwd, tasks, initialLoading, projectSwitching,
  scrollPositionsRef, scrollHandleRef,
  loadError, messageLoad, messages, isWorking, streamText, workingPhase, activeTaskUi,
  steeringMessageKeys, showJumpToLatest, permissionStatus, changeReviewEnabled, changeReviews, latestChangeReview,
  selectedChangeReview, changeReviewOpen, changeReviewDrawer, changeReviewLoading, changeReviewAvailability,
  changeReviewUnavailableReason, changeReviewError, selectedChangeReviewLoading,
  selectedChangeReviewError, changeReviewWidth, changeReviewFileListWidth,
  changeReviewSelectedPath, changeReviewExpandedPaths, changeReviewFileFilter,
  changeReviewDiffMode, changeReviewWrapLines, changeReviewIgnoreWhitespace,
  changeReviewScrollPosition, composerProps, transcriptSearchOpen, transcriptSearchQuery, transcriptSearchRequest, transcriptSearchResult,
  onOpenTranscriptSearch, onTranscriptSearchQuery, onStepTranscriptSearch, onCloseTranscriptSearch, onTranscriptSearchResult, onTimelineAtEnd,
  onRetryInitialLoad, onChooseProject, onCreateTask, onRetryMessages, onJumpToLatest,
  onResolveApproval, onPermissionStatus, onOpenChangeReview, onCloseChangeReview,
  onSelectChangeReview, onSelectChangeReviewPath, onChangeReviewExpandedPaths,
  onChangeReviewFileFilter, onChangeReviewDiffMode, onChangeReviewWrapLines,
  onChangeReviewIgnoreWhitespace, onChangeReviewScrollPosition, onRetryChangeReviews,
  onRetrySelectedChangeReview, onResolveChangeReviewHunk, onLoadChangeReviewMergeSource,
  onApplyChangeReviewMerge, onChangeReviewWidth, onChangeReviewFileListWidth,
  backgroundInert = false,
}: AppConversationProps) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const reviewLauncherRef = useRef<HTMLButtonElement>(null);
  const transcriptSearchInputRef = useRef<HTMLInputElement>(null);
  const [layoutWidth, setLayoutWidth] = useState(0);
  useLayoutEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    const update = () => setLayoutWidth(layout.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(layout);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (transcriptSearchOpen) transcriptSearchInputRef.current?.focus(); }, [transcriptSearchOpen]);
  const minimumReviewWidth = 520;
  const maximumReviewWidth = Math.max(minimumReviewWidth, layoutWidth - 400);
  const effectiveReviewWidth = Math.min(maximumReviewWidth, Math.max(minimumReviewWidth, changeReviewWidth));

  const activeData = useMemo<ConversationPaneData | null>(() => activeTask ? {
    task: activeTask,
    messageLoad,
    messages,
    isWorking,
    streamText,
    workingPhase,
    taskUi: activeTaskUi,
    steeringMessageKeys,
  } : null, [activeTask, activeTaskUi, isWorking, messageLoad, messages, steeringMessageKeys, streamText, workingPhase]);

  return <>
    <main className="main-column" id="main-content" tabIndex={-1} inert={backgroundInert} aria-hidden={backgroundInert || undefined}>
      <div ref={layoutRef} className={`conversation-layout ${changeReviewOpen ? "review-open" : ""}`} style={{ "--change-review-width": `${effectiveReviewWidth}px` } as CSSProperties}>
        <section className="conversation-primary" inert={changeReviewOpen && changeReviewDrawer} aria-hidden={changeReviewOpen && changeReviewDrawer || undefined}>
      {activeTask && <div className="conversation-header"><div className="conversation-title"><div className="breadcrumb"><span>{activeProject?.name ?? t.brandShortName}</span><span>/</span><span>{activeTask.title ?? t.conversation}</span></div><h1>{activeTask.title ?? t.conversation}</h1></div><button type="button" className="icon-button transcript-search-trigger" aria-label={t.transcriptSearch} title={t.transcriptSearch} onClick={onOpenTranscriptSearch}><Icon name="search" size={15} /></button></div>}
      {activeTaskUi?.extensionHeader && <pre className="extension-header" aria-live="polite">{activeTaskUi.extensionHeader.join("\n")}</pre>}
      {transcriptSearchOpen && <div className="transcript-search" role="search" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); onCloseTranscriptSearch(); } else if (event.key === "Enter") { event.preventDefault(); onStepTranscriptSearch(event.shiftKey ? "backward" : "forward"); } }}><Icon name="search" size={14} /><input ref={transcriptSearchInputRef} type="search" value={transcriptSearchQuery} onChange={(event) => onTranscriptSearchQuery(event.target.value)} placeholder={t.transcriptSearchPlaceholder} aria-label={t.transcriptSearch} /><span aria-live="polite">{t.transcriptSearchResult(transcriptSearchResult.current, transcriptSearchResult.total)}</span><button type="button" className="icon-button transcript-search-previous" disabled={!transcriptSearchResult.total} aria-label={t.transcriptSearchPrevious} title={t.transcriptSearchPrevious} onClick={() => onStepTranscriptSearch("backward")}><Icon name="down" size={13} /></button><button type="button" className="icon-button" disabled={!transcriptSearchResult.total} aria-label={t.transcriptSearchNext} title={t.transcriptSearchNext} onClick={() => onStepTranscriptSearch("forward")}><Icon name="down" size={13} /></button><button type="button" className="icon-button" aria-label={t.transcriptSearchClose} title={t.transcriptSearchClose} onClick={onCloseTranscriptSearch}><Icon name="x" size={13} /></button></div>}
      <ConversationPaneDeck
        activeData={activeData}
        tasks={tasks}
        initialLoading={initialLoading}
        projectSwitching={projectSwitching}
        projectCwd={projectCwd}
        language={language}
        t={t}
        loadError={loadError}
        scrollPositionsRef={scrollPositionsRef}
        scrollHandleRef={scrollHandleRef}
        onTimelineAtEnd={onTimelineAtEnd}
        onRetryInitialLoad={onRetryInitialLoad}
        onChooseProject={onChooseProject}
        onCreateTask={onCreateTask}
        onRetryMessages={onRetryMessages}
        onResolveApproval={onResolveApproval}
        onPreviewImage={composerProps.onPreviewImage}
        onContextMenuImage={composerProps.onContextMenuImage}
        transcriptSearchQuery={transcriptSearchQuery}
        transcriptSearchRequest={transcriptSearchRequest}
        onTranscriptSearchResult={onTranscriptSearchResult}
      />
      <div className="composer-dock">
        {showJumpToLatest && <button className="jump-latest" onClick={onJumpToLatest}><Icon name="down" size={13} />{t.jumpToLatest}</button>}
        {changeReviewEnabled && (latestChangeReview || changeReviewAvailability !== "available") && <ChangeReviewLauncher buttonRef={reviewLauncherRef} review={latestChangeReview} availability={changeReviewAvailability} language={language} onOpen={onOpenChangeReview} />}
        {(activeTaskUi?.extensionStatuses && Object.keys(activeTaskUi.extensionStatuses).length > 0 || activeTaskUi?.extensionWidgets?.some((widget) => widget.placement === "aboveEditor")) && <div className="extension-ui-surface">{Object.entries(activeTaskUi?.extensionStatuses ?? {}).map(([key, value]) => <span className="extension-status" key={key}>{value}</span>)}{activeTaskUi?.extensionWidgets?.filter((widget) => widget.placement === "aboveEditor").map((widget) => <pre className="extension-widget" key={widget.key}>{widget.lines.join("\n")}</pre>)}</div>}
        <MemoComposer {...composerProps} />
        {activeTaskUi?.extensionWidgets?.some((widget) => widget.placement === "belowEditor") && <div className="extension-ui-surface">{activeTaskUi.extensionWidgets.filter((widget) => widget.placement === "belowEditor").map((widget) => <pre className="extension-widget" key={widget.key}>{widget.lines.join("\n")}</pre>)}</div>}
        {activeTaskUi?.extensionFooter && <pre className="extension-footer" aria-live="polite">{activeTaskUi.extensionFooter.join("\n")}</pre>}
        <PermissionLevelControl language={language} status={permissionStatus} onStatus={onPermissionStatus} />
      </div>
        </section>
        {changeReviewEnabled && changeReviewOpen && <>
          <PaneResizeHandle
            className="change-review-panel-resize-handle"
            label={t.changeReviewResizePanel}
            value={effectiveReviewWidth}
            minimum={minimumReviewWidth}
            maximum={maximumReviewWidth}
            direction={-1}
            onChange={onChangeReviewWidth}
          />
          <ChangeReviewPanel
            key={`${projectCwd}\u0000${activeTask?.id ?? ""}`}
            reviews={changeReviews}
            selectedReview={selectedChangeReview}
            language={language}
            loading={changeReviewLoading}
            availability={changeReviewAvailability}
            unavailableReason={changeReviewUnavailableReason}
            loadError={changeReviewError}
            detailLoading={selectedChangeReviewLoading}
            detailError={selectedChangeReviewError}
            fileListWidth={changeReviewFileListWidth}
            selectedPath={changeReviewSelectedPath}
            expandedPaths={changeReviewExpandedPaths}
            fileFilter={changeReviewFileFilter}
            diffMode={changeReviewDiffMode}
            wrapLines={changeReviewWrapLines}
            ignoreWhitespace={changeReviewIgnoreWhitespace}
            scrollPosition={changeReviewScrollPosition}
            drawer={changeReviewDrawer}
            returnFocusRef={reviewLauncherRef}
            onFileListWidth={onChangeReviewFileListWidth}
            onSelectReview={onSelectChangeReview}
            onSelectPath={onSelectChangeReviewPath}
            onExpandedPaths={onChangeReviewExpandedPaths}
            onFileFilter={onChangeReviewFileFilter}
            onDiffMode={onChangeReviewDiffMode}
            onWrapLines={onChangeReviewWrapLines}
            onIgnoreWhitespace={onChangeReviewIgnoreWhitespace}
            onScrollPosition={onChangeReviewScrollPosition}
            onRetry={onRetryChangeReviews}
            onRetryDetail={onRetrySelectedChangeReview}
            onResolveHunk={onResolveChangeReviewHunk}
            onLoadMergeSource={onLoadChangeReviewMergeSource}
            onApplyMerge={onApplyChangeReviewMerge}
            onClose={onCloseChangeReview}
          />
        </>}
      </div>
    </main>
  </>;
}
