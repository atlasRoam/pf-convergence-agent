import { CommandResultDialog, ConfirmDialog, ExtensionUiDialog, handleRovingMenuKeyDown, ImageContextMenu, ImagePreview, AgentCoreSettings, ProjectRemoveDialog, ProviderSettings, QuickSettings, QuickSettingsBoundary, RenameSessionDialog, ResumeSessionDialog, ScopedModelsDialog, SessionBranchDialog, TrustDialog, copyImageToClipboard } from "./ui";
import { Icon } from "@pfsaa/ui-system";
import { ExtensionCustomUiDialog } from "./ui/dialogs";
import type { AppController } from "./use-app-controller";
import { extensionThemeStyle } from "./extension-theme";

// All floating layers (dialogs, settings, toast, context menus) render
// here so app-view.tsx only owns the shell layout. Add new overlays in this
// file; the controller contract stays the single source of state.
export function AppOverlays({ controller }: { controller: AppController }) {
  const {
    language, theme, t, shortcut, projectCwd, tasks, activeTask, activeProject, isMac,
    paletteCommands, selectPaletteCommand, createTask, openProviderSettings, compactSession, exportSession,
    quickSettingsOpen, quickSettingsPage, setQuickSettingsOpen,
    notices, contextMenu, setContextMenu, projectContextMenu, setProjectContextMenu,
    pendingDelete, setPendingDelete, deletingTaskId, deleteTask,
    pendingProjectRemove, setPendingProjectRemove, removingProjectCwd, removeProject,
    extensionUiRequest, setExtensionUiRequest, showNotice, dismissNotice, sendExtensionUiInput,
    settingsOpen, setSettingsOpen, agentCoreSettingsOpen, setAgentCoreSettingsOpen, providerFocus, setProviderFocus, refreshModels,
    commandDialog, setCommandDialog, renameOpen, setRenameOpen, renameSession,
    resumeOpen, setResumeOpen, selectTask, sessionBranchMode, sessionTreeSnapshot, sessionBranchSkipPrompt, sessionTreeLoading, sessionTreeBusy, sessionTreeError, closeSessionBranch, loadSessionTree, forkSession, cloneSession, navigateSessionTree, abortSessionTreeOperation, trustOpen, setTrustOpen, trustProject, trustStatus, trustBusy, resolveTrust,
    scopedModelsOpen, setScopedModelsOpen, modelOptions, capabilities, saveScopedModels,
    previewImage, setPreviewImage, imageContextMenu, setImageContextMenu, openImageContextMenu,
  } = controller;
  return <div style={extensionThemeStyle(controller.activeTaskUi?.extensionTheme)} className={`overlay-root ${controller.activeTaskUi?.extensionTheme?.appearance ?? theme}${isMac ? " platform-macos" : " platform-overlay"}`}>
    {quickSettingsOpen && <QuickSettingsBoundary language={language} onClose={() => setQuickSettingsOpen(false)}><QuickSettings
      language={language}
      commands={paletteCommands}
      initialPage={quickSettingsPage}
      shortcut={shortcut}
      hasProject={Boolean(projectCwd)}
      hasSession={Boolean(activeTask)}
      onCommand={(command) => void selectPaletteCommand(command)}
      onProviders={() => openProviderSettings()}
      onNewTask={() => { setQuickSettingsOpen(false); void createTask(); }}
      onCompact={() => { setQuickSettingsOpen(false); void compactSession(); }}
      onExport={(format) => { setQuickSettingsOpen(false); void exportSession(format); }}
      onClose={() => setQuickSettingsOpen(false)}
    /></QuickSettingsBoundary>}
    {notices.length > 0 && <div className="toast-stack">
      {notices.map((item) => {
        const kindLabel = item.kind === "error" ? t.noticeError : item.kind === "warning" ? t.noticeWarning : t.noticeInfo;
        return <div key={item.id} className={`toast toast-${item.kind} ${item.closing ? "closing" : ""}`} role={item.kind === "error" ? "alert" : "status"} aria-live={item.kind === "error" ? "assertive" : "polite"}>
          <span className="toast-kind" title={kindLabel} aria-hidden="true"><Icon name={item.kind === "info" ? "info" : "alert"} size={14} /></span>
          <span className="sr-only">{kindLabel}: </span>
          <span className="toast-message">{item.message}</span>
          <button className="toast-close" type="button" title={t.closeNotice} aria-label={t.closeNotice} onClick={() => dismissNotice(item.id)}><Icon name="x" size={12} /></button>
        </div>;
      })}
    </div>}
    {contextMenu && <div className="task-context-menu" role="menu" aria-label={t.moreActions} style={{ left: contextMenu.x, top: contextMenu.y }} onKeyDown={handleRovingMenuKeyDown} onClick={(event) => event.stopPropagation()}><button role="menuitem" autoFocus onClick={() => { setPendingDelete(contextMenu.task); setContextMenu(null); }}>{t.deleteSession}</button></div>}
    {projectContextMenu && <div className="task-context-menu" role="menu" aria-label={t.moreActions} style={{ left: projectContextMenu.x, top: projectContextMenu.y }} onKeyDown={handleRovingMenuKeyDown} onClick={(event) => event.stopPropagation()}><button type="button" role="menuitem" autoFocus disabled={removingProjectCwd !== null} onClick={() => { setPendingProjectRemove(projectContextMenu.project); setProjectContextMenu(null); }}>{t.removeProject}</button></div>}
    {pendingDelete && <ConfirmDialog language={language} task={pendingDelete} busy={deletingTaskId === pendingDelete.id} onCancel={() => setPendingDelete(null)} onConfirm={() => void deleteTask(pendingDelete)} />}
    {pendingProjectRemove && <ProjectRemoveDialog language={language} project={pendingProjectRemove} busy={removingProjectCwd === pendingProjectRemove.cwd} onCancel={() => setPendingProjectRemove(null)} onConfirm={() => void removeProject(pendingProjectRemove)} />}
    {extensionUiRequest?.kind === "custom" && <ExtensionCustomUiDialog request={extensionUiRequest} language={language} onInput={(data) => void sendExtensionUiInput(data)} />}
    {extensionUiRequest && extensionUiRequest.kind !== "custom" && <ExtensionUiDialog request={extensionUiRequest} language={language} onResolve={(value) => { void window.pfsaa.extensions.resolveUi(extensionUiRequest.requestId, value).then(() => setExtensionUiRequest(null)).catch((error) => showNotice(error instanceof Error ? error.message : String(error))); }} />}
    {settingsOpen && <ProviderSettings language={language} focusProviderId={providerFocus} onClose={() => { setSettingsOpen(false); setProviderFocus(null); }} onModelsRefresh={refreshModels} />}
    {agentCoreSettingsOpen && <AgentCoreSettings language={language} cwd={activeProject?.cwd ?? projectCwd} models={modelOptions} onClose={() => setAgentCoreSettingsOpen(false)} onNotice={showNotice} />}
    {commandDialog && <CommandResultDialog language={language} title={commandDialog.title} body={commandDialog.body} onClose={() => setCommandDialog(null)} />}
    {renameOpen && activeTask && <RenameSessionDialog language={language} currentName={activeTask.title} onSave={(name) => void renameSession(name)} onClose={() => setRenameOpen(false)} />}
    {resumeOpen && <ResumeSessionDialog language={language} project={activeProject} tasks={tasks} activeTaskId={activeTask?.id} onSelect={(task) => { if (activeProject) void selectTask(activeProject, task); setResumeOpen(false); }} onClose={() => setResumeOpen(false)} />}
    {sessionBranchMode && <SessionBranchDialog language={language} mode={sessionBranchMode} snapshot={sessionTreeSnapshot} skipSummaryPrompt={sessionBranchSkipPrompt} loading={sessionTreeLoading} busy={sessionTreeBusy} error={sessionTreeError} onRetry={() => void loadSessionTree()} onClose={() => closeSessionBranch()} onAbort={() => void abortSessionTreeOperation()} onFork={(entryId) => void forkSession(entryId)} onClone={() => void cloneSession()} onNavigate={(entryId, options) => void navigateSessionTree(entryId, options)} />}
    {trustOpen && trustProject && trustStatus && <TrustDialog language={language} project={trustProject} status={trustStatus} busy={trustBusy} onResolve={(trusted) => void resolveTrust(trusted)} onClose={() => { if (!trustBusy) setTrustOpen(false); }} />}
    {scopedModelsOpen && <ScopedModelsDialog language={language} models={modelOptions} selectedModels={capabilities?.scopedModels ?? []} onSave={(models, persist) => void saveScopedModels(models, persist)} onClose={() => setScopedModelsOpen(false)} />}
    {previewImage && <ImagePreview image={previewImage} language={language} onClose={() => setPreviewImage(null)} onContextMenuImage={openImageContextMenu} />}
    {imageContextMenu && <ImageContextMenu language={language} x={imageContextMenu.x} y={imageContextMenu.y} onCopy={async () => { const copied = await copyImageToClipboard(imageContextMenu.image.src); setImageContextMenu(null); showNotice(copied ? t.copiedImage : t.copyImageFailed); }} />}
  </div>;
}
