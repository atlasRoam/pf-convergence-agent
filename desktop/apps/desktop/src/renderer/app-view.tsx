import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DialogFocusReturnContext, Icon } from "@pfsaa/ui-system";
import { ApplicationMenu } from "./ui/application-menu";
import { AppConversation } from "./app-conversation";
import { AppOverlays } from "./app-overlays";
import { AppSidebar } from "./app-sidebar";
import { PaneResizeHandle } from "./ui";
import { languageSwitchTarget } from "./use-preferences";
import type { AppController } from "./use-app-controller";
import { extensionThemeStyle } from "./extension-theme";
import { applicationTitle } from "@pfsaa/i18n";
import { readPfsaaStorage, writePfsaaStorage } from "./pfsaa-storage";

const MINIMUM_SIDEBAR_WIDTH = 190;
const MAXIMUM_SIDEBAR_WIDTH = 420;
const COLLAPSED_SIDEBAR_WIDTH = 64;

export function AppView({ controller }: { controller: AppController }) {
  const overlayReturnFocusRef = useRef<HTMLElement>(null);
  const [sidebarMaximumWidth, setSidebarMaximumWidth] = useState(() => Math.max(MINIMUM_SIDEBAR_WIDTH, Math.min(MAXIMUM_SIDEBAR_WIDTH, window.innerWidth - 360)));
  const [reviewDrawer, setReviewDrawer] = useState(() => window.matchMedia("(max-width: 1280px)").matches);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(readPfsaaStorage("sidebar-width"));
    return Number.isFinite(stored) ? Math.min(MAXIMUM_SIDEBAR_WIDTH, Math.max(MINIMUM_SIDEBAR_WIDTH, stored)) : 270;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readPfsaaStorage("sidebar-collapsed") === "true");
  useEffect(() => {
    const updateMaximum = () => setSidebarMaximumWidth(Math.max(MINIMUM_SIDEBAR_WIDTH, Math.min(MAXIMUM_SIDEBAR_WIDTH, window.innerWidth - 360)));
    const drawerMedia = window.matchMedia("(max-width: 1280px)");
    const updateDrawer = () => setReviewDrawer(window.innerWidth <= 1280);
    const updateWindowLayout = () => { updateMaximum(); updateDrawer(); };
    window.addEventListener("resize", updateWindowLayout);
    window.visualViewport?.addEventListener("resize", updateDrawer);
    drawerMedia.addEventListener("change", updateDrawer);
    const rootObserver = new ResizeObserver(updateDrawer);
    rootObserver.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", updateWindowLayout);
      window.visualViewport?.removeEventListener("resize", updateDrawer);
      drawerMedia.removeEventListener("change", updateDrawer);
      rootObserver.disconnect();
    };
  }, []);
  const effectiveSidebarWidth = Math.min(sidebarMaximumWidth, Math.max(MINIMUM_SIDEBAR_WIDTH, sidebarWidth));
  const renderedSidebarWidth = sidebarCollapsed ? COLLAPSED_SIDEBAR_WIDTH : effectiveSidebarWidth;
  const languageTarget = languageSwitchTarget(controller.language);
  useEffect(() => { document.title = applicationTitle; }, []);
  const toggleSidebar = () => setSidebarCollapsed((current) => {
    const next = !current;
    writePfsaaStorage("sidebar-collapsed", String(next));
    return next;
  });
  const {
    language, setLanguage, theme, themePreference, cycleTheme, projectCwd, projects, expandedProjectCwds, tasks,
    projectTasksByCwd, projectTaskLoads, activeTask, initialLoading, projectSwitching, runtimeStatus, shortcut, t, isMac,
    sidebarRef, searchInputRef, mobileSidebarOpen, setMobileSidebarOpen, createTask, chooseProjectDirectory,
    selectProject, selectTask, openContextMenu, loadProjectSessions, createTaskForProject,
    searchQuery, setSearchQuery,
    loadInitialData, scrollPositionsRef, scrollHandleRef, handleTimelineAtEnd, activeProject, loadError, messageLoad, messages, isWorking, streamText,
    workingPhase, activeTaskUi, steeringMessageKeysByTask, showJumpToLatest, permissionStatus, changeReview,
    transcriptSearchOpen, transcriptSearchQuery, transcriptSearchRequest, transcriptSearchResult,
    setTranscriptSearchOpen, updateTranscriptQuery, stepTranscriptSearch, closeTranscriptSearch, setTranscriptSearchResult,
    composerProps, jumpToLatest,
    setMessageReload, showNotice, handlePermissionStatus, openQuickSettings, quickSettingsOpen,
    patchTaskUi, updateTaskLists, restartHost,
    pendingDelete, pendingProjectRemove, extensionUiRequest, settingsOpen, agentCoreSettingsOpen,
    commandDialog, renameOpen, resumeOpen, sessionBranchMode, trustOpen, scopedModelsOpen, previewImage,
  } = controller;
  const reviewDrawerOpen = changeReview.enabled && changeReview.reviewOpen && reviewDrawer;
  const modalOverlayOpen = Boolean(
    quickSettingsOpen || pendingDelete || pendingProjectRemove || extensionUiRequest || settingsOpen || agentCoreSettingsOpen
    || commandDialog || renameOpen || resumeOpen || sessionBranchMode || trustOpen || scopedModelsOpen || previewImage,
  );
  return <>
  <div
    style={extensionThemeStyle(activeTaskUi?.extensionTheme)}
    className={`app-shell ${activeTaskUi?.extensionTheme?.appearance ?? theme}${isMac ? " platform-macos" : " platform-overlay"}`}
    inert={modalOverlayOpen}
    aria-hidden={modalOverlayOpen || undefined}
    onFocusCapture={(event) => { overlayReturnFocusRef.current = event.target; }}
  >
    <a className="skip-link" href="#main-content" tabIndex={reviewDrawerOpen ? -1 : undefined} aria-hidden={reviewDrawerOpen || undefined}>{t.skipToContent}</a>
    <header className="titlebar" inert={mobileSidebarOpen || reviewDrawerOpen} aria-hidden={mobileSidebarOpen || reviewDrawerOpen || undefined}>
      <div className="brand-lockup"><img className="brand-mark" src="./pfsaa-icon.png" alt="" aria-hidden="true" draggable={false} /><span className="brand-name brand-name-full">{t.brandName}</span><span className="brand-name brand-name-short" title={t.brandName} aria-label={t.brandName}>{t.brandShortName}</span><span className="brand-divider" /><span className="eyebrow">{t.workspace}</span></div>
      {navigator.platform.startsWith("Win") && <ApplicationMenu language={language} onError={(message) => showNotice(message, "error")} />}
      <div className="window-drag" />
      <div className="titlebar-actions">
        <button className="icon-button mobile-nav-trigger" type="button" title={mobileSidebarOpen ? t.closeNavigation : t.openNavigation} aria-label={mobileSidebarOpen ? t.closeNavigation : t.openNavigation} aria-expanded={mobileSidebarOpen} aria-controls="workspace-sidebar" onClick={() => setMobileSidebarOpen((current) => !current)}><Icon name="folder" /></button>
        <button className="lang-button" aria-label={languageTarget.language === "en" ? t.switchToEnglish : t.switchToChinese} title={languageTarget.language === "en" ? t.switchToEnglish : t.switchToChinese} onClick={() => setLanguage(languageTarget.language)}>{languageTarget.label}</button>
        <button className="icon-button" title={themePreference === "system" ? t.themeToLight : theme === "light" ? t.themeToDark : t.themeToSystem} aria-label={themePreference === "system" ? t.themeToLight : theme === "light" ? t.themeToDark : t.themeToSystem} onClick={cycleTheme}><Icon name={themePreference === "system" ? "auto" : theme === "light" ? "moon" : "sun"} /></button>
        <button className="icon-button" title={`${t.quickSettings} (${shortcut(",")})`} aria-label={t.quickSettings} aria-haspopup="dialog" aria-expanded={quickSettingsOpen} aria-controls={quickSettingsOpen ? "quick-settings-panel" : undefined} onClick={() => openQuickSettings()}><Icon name="settings" /></button>
      </div>
    </header>

    <div className={`workspace-grid ${reviewDrawerOpen ? "review-drawer-open" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`} style={{ "--sidebar-width": `${renderedSidebarWidth}px` } as CSSProperties}>
      {reviewDrawerOpen && <button type="button" className="change-review-backdrop" tabIndex={-1} aria-hidden="true" onClick={() => changeReview.setReviewOpen(false)} />}
      <AppSidebar
        language={language}
        t={t}
        sidebarRef={sidebarRef}
        searchInputRef={searchInputRef}
        mobileSidebarOpen={mobileSidebarOpen}
        sidebarCollapsed={sidebarCollapsed}
        backgroundInert={reviewDrawerOpen}
        projectCwd={projectCwd}
        projects={projects}
        projectTasksByCwd={projectTasksByCwd}
        projectTaskLoads={projectTaskLoads}
        expandedProjectCwds={expandedProjectCwds}
        searchQuery={searchQuery}
        activeTask={activeTask}
        initialLoading={initialLoading}
        runtimeStatus={runtimeStatus}
        shortcut={shortcut}
        onCloseMobile={() => setMobileSidebarOpen(false)}
        onToggleSidebar={toggleSidebar}
        onCreateTask={createTask}
        onCreateTaskForProject={createTaskForProject}
        onSearchQuery={setSearchQuery}
        onSelectProject={selectProject}
        onSelectTask={selectTask}
        onOpenTaskContext={openContextMenu}
        onTaskMenu={(task, rect) => openContextMenu(task, rect.right - 160, rect.bottom + 4)}
        onLoadProjectSessions={loadProjectSessions}
        onRetry={runtimeStatus === "disconnected" ? restartHost : loadInitialData}
      />
      <PaneResizeHandle
        className="sidebar-resize-handle"
        label={t.resizeSidebar}
        value={effectiveSidebarWidth}
        minimum={MINIMUM_SIDEBAR_WIDTH}
        maximum={sidebarMaximumWidth}
        disabled={reviewDrawerOpen || sidebarCollapsed}
        onChange={(width) => {
          setSidebarWidth(width);
          writePfsaaStorage("sidebar-width", String(Math.round(width)));
        }}
      />

      <AppConversation
        language={language}
        t={t}
        scrollPositionsRef={scrollPositionsRef}
        scrollHandleRef={scrollHandleRef}
        activeTask={activeTask}
        activeProject={activeProject}
        projectCwd={projectCwd}
        tasks={tasks}
        initialLoading={initialLoading}
        projectSwitching={projectSwitching}
        loadError={loadError}
        messageLoad={messageLoad}
        messages={messages}
        isWorking={isWorking}
        streamText={streamText}
        workingPhase={workingPhase}
        activeTaskUi={activeTaskUi}
        steeringMessageKeys={activeTask ? steeringMessageKeysByTask[activeTask.id] ?? [] : []}
        showJumpToLatest={showJumpToLatest}
        permissionStatus={permissionStatus}
        changeReviewEnabled={changeReview.enabled}
        changeReviews={changeReview.reviews}
        latestChangeReview={changeReview.launcherReview}
        selectedChangeReview={changeReview.selectedReview}
        changeReviewOpen={changeReview.enabled && changeReview.reviewOpen}
        changeReviewDrawer={reviewDrawer}
        changeReviewLoading={changeReview.reviewLoading}
        changeReviewAvailability={changeReview.reviewAvailability}
        changeReviewUnavailableReason={changeReview.reviewUnavailableReason}
        changeReviewError={changeReview.reviewError}
        selectedChangeReviewLoading={changeReview.selectedReviewLoading}
        selectedChangeReviewError={changeReview.selectedReviewError}
        changeReviewWidth={changeReview.reviewWidth}
        changeReviewFileListWidth={changeReview.fileListWidth}
        changeReviewSelectedPath={changeReview.selectedFilePath}
        changeReviewExpandedPaths={changeReview.expandedDirectories}
        changeReviewFileFilter={changeReview.fileFilter}
        changeReviewDiffMode={changeReview.diffMode}
        changeReviewWrapLines={changeReview.wrapLines}
        changeReviewIgnoreWhitespace={changeReview.ignoreWhitespace}
        changeReviewScrollPosition={changeReview.diffScrollPosition}
        composerProps={composerProps}
        transcriptSearchOpen={transcriptSearchOpen}
        transcriptSearchQuery={transcriptSearchQuery}
        transcriptSearchRequest={transcriptSearchRequest}
        transcriptSearchResult={transcriptSearchResult}
        onOpenTranscriptSearch={() => setTranscriptSearchOpen(true)}
        onTranscriptSearchQuery={updateTranscriptQuery}
        onStepTranscriptSearch={stepTranscriptSearch}
        onCloseTranscriptSearch={closeTranscriptSearch}
        onTranscriptSearchResult={setTranscriptSearchResult}
        onTimelineAtEnd={handleTimelineAtEnd}
        onRetryInitialLoad={runtimeStatus === "disconnected" ? restartHost : loadInitialData}
        onChooseProject={chooseProjectDirectory}
        onCreateTask={createTask}
        onRetryMessages={() => setMessageReload((current) => current + 1)}
        onJumpToLatest={jumpToLatest}
        onResolveApproval={async (decision) => {
          if (!activeTaskUi?.approval) return;
          try { await window.pfsaa.approvals.resolve(activeTaskUi.approval.requestId, decision); if (activeTask) { patchTaskUi(activeTask.id, { approval: undefined, workingPhase: decision === "allow-once" ? "thinking" : null }); updateTaskLists((current) => current.map((task) => task.id === activeTask.id ? { ...task, state: decision === "allow-once" ? "running" : task.state } : task)); } }
          catch (error) { showNotice(error instanceof Error ? error.message : String(error)); throw error; }
        }}
        onPermissionStatus={handlePermissionStatus}
        onOpenChangeReview={changeReview.openLatestReview}
        onCloseChangeReview={() => changeReview.setReviewOpen(false)}
        onSelectChangeReview={changeReview.setSelectedReviewId}
        onSelectChangeReviewPath={changeReview.setSelectedFilePath}
        onChangeReviewExpandedPaths={changeReview.setExpandedDirectories}
        onChangeReviewFileFilter={changeReview.setFileFilter}
        onChangeReviewDiffMode={changeReview.setDiffMode}
        onChangeReviewWrapLines={changeReview.setWrapLines}
        onChangeReviewIgnoreWhitespace={changeReview.setIgnoreWhitespace}
        onChangeReviewScrollPosition={changeReview.setDiffScrollPosition}
        onRetryChangeReviews={changeReview.reloadReviews}
        onRetrySelectedChangeReview={changeReview.retrySelectedReview}
        onResolveChangeReviewHunk={changeReview.resolveHunk}
        onLoadChangeReviewMergeSource={changeReview.loadMergeSource}
        onApplyChangeReviewMerge={changeReview.applyMerge}
        onChangeReviewWidth={changeReview.setReviewWidth}
        onChangeReviewFileListWidth={changeReview.setFileListWidth}
        backgroundInert={mobileSidebarOpen}
      />

    </div>
  </div>
  <DialogFocusReturnContext.Provider value={overlayReturnFocusRef}><AppOverlays controller={controller} /></DialogFocusReturnContext.Provider>
  </>;
}
