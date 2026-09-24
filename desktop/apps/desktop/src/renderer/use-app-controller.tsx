import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentQueuedMessage, AgentQueueState, ContextUsage, ExtensionAutocompleteItem, ExtensionUiRequest, ModelSummary, PermissionStatus, AgentCoreKeybindings, ProjectTrustStatus, QueueDelivery, QueueMode, ProviderSummary, ScopedModelSelection, SessionCapabilities, SessionTreeSnapshot, WorkspaceSnapshot } from "@pfsaa/contracts";
import { deriveSessionTitle, isDefaultSessionTitle, type ProjectSummary, type TaskSummary } from "@pfsaa/domain";
import { copy, localizeCommandDescription } from "@pfsaa/i18n";
import { fallbackSlashCommands, isPfsaaAvailableCommand } from "./agentcore-capabilities";
import { copyText, useDialogFocus } from "@pfsaa/ui-system";
import type { ActivityStep, ImageAttachment, ImageContextMenuState, MessageLoad, PreviewImage, SentImageMessage, SuggestionMode, TaskUiState } from "./types";
import { createDefaultTaskUiState, sortTasksByUpdatedAt, textFromMessage } from "./message-utils";
import { useRuntimeEvents } from "./use-runtime-events";
import { useSessionData } from "./use-session-data";
import { useChangeReview } from "./use-change-review";
import { ComposerHistory } from "./composer-history";
import { useConversationScroll } from "./use-conversation-scroll";
import { useGlobalShortcuts } from "./use-global-shortcuts";
import { useExtensionEditor } from "./use-extension-editor";
import { commandModel, exportArguments } from "./agentcore-command-arguments";
import { useSentImagesCache } from "./use-sent-images-cache";
import { useNotice } from "./use-notice";
import { usePreferences } from "./use-preferences";
import { readPfsaaStorage, removePfsaaStorage, writePfsaaStorage } from "./pfsaa-storage";
import { useStreamDeltas } from "./use-stream-deltas";
import { loadQueueForCurrentTask } from "./queue-load";
import { activatePaletteCommand, type PaletteCommand } from "./palette-command";
import { domKeyToTerminalInput, firstAgentCoreKeybinding, matchesAgentCoreKeybinding } from "./agentcore-keybindings";
import type { SessionBranchMode } from "./ui";

export function useAppController() {

  const { language, setLanguage, theme, themePreference, cycleTheme } = usePreferences();
  const [projectCwd, setProjectCwd] = useState(() => readPfsaaStorage("project-cwd") ?? "");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [expandedProjectCwds, setExpandedProjectCwds] = useState<string[]>(() => {
    try {
      const stored = JSON.parse(readPfsaaStorage("expanded-project-cwds") ?? "[]");
      if (Array.isArray(stored)) return stored.filter((cwd): cwd is string => typeof cwd === "string" && cwd.length > 0);
    } catch { /* Fall through to the legacy single-project preference. */ }
    const legacy = readPfsaaStorage("expanded-project-cwd");
    return legacy ? [legacy] : [];
  });
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [projectTasksByCwd, setProjectTasksByCwd] = useState<Record<string, TaskSummary[]>>({});
  const [projectTaskLoads, setProjectTaskLoads] = useState<Record<string, MessageLoad>>({});
  const [activeTask, setActiveTask] = useState<TaskSummary | null>(null);
  const activeTaskId = activeTask?.id;
  const [messagesByTask, setMessagesByTask] = useState<Record<string, any[]>>({});
  const [steeringMessageKeysByTask, setSteeringMessageKeysByTask] = useState<Record<string, string[]>>({});
  const [sentImagesByTask, setSentImagesByTask] = useState<Record<string, SentImageMessage[]>>(() => {
    try {
      const stored = JSON.parse(readPfsaaStorage("sent-images.v1") ?? "null");
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
      return Object.fromEntries(Object.entries(stored).filter(([, value]) => Array.isArray(value))) as Record<string, SentImageMessage[]>;
    } catch { return {}; }
  });
  const [messageLoads, setMessageLoads] = useState<Record<string, MessageLoad>>({});
  const [messageReload, setMessageReload] = useState(0);
  const [taskUi, setTaskUi] = useState<Record<string, TaskUiState>>({});
  const [composer, setComposer] = useState("");
  const [composerImages, setComposerImages] = useState<ImageAttachment[]>([]);
  const [previewImage, setPreviewImage] = useState<PreviewImage | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [agentCoreKeybindings, setAgentCoreKeybindings] = useState<AgentCoreKeybindings>({});
  const [externalEditing, setExternalEditing] = useState(false);
  const [transcriptSearchOpen, setTranscriptSearchOpen] = useState(false);
  const [transcriptSearchQuery, setTranscriptSearchQuery] = useState("");
  const [transcriptSearchRequest, setTranscriptSearchRequest] = useState<{ serial: number; direction: "forward" | "backward"; reset: boolean }>({ serial: 0, direction: "forward", reset: true });
  const [transcriptSearchResult, setTranscriptSearchResult] = useState({ current: 0, total: 0 });
  const [quickSettingsOpen, setQuickSettingsOpen] = useState(false);
  const [quickSettingsPage, setQuickSettingsPage] = useState<"root" | "commands">("root");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agentCoreSettingsOpen, setAgentCoreSettingsOpen] = useState(false);
  const [providerFocus, setProviderFocus] = useState<string | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [capabilities, setCapabilities] = useState<SessionCapabilities | null>(null);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [activeModel, setActiveModel] = useState<ModelSummary | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | undefined>(undefined);
  const [permissionStatus, setPermissionStatus] = useState<PermissionStatus | null>(null);
  const [queueState, setQueueState] = useState<AgentQueueState | null>(null);
  const [queueMutationBusy, setQueueMutationBusy] = useState(false);
  const [queueDelivery, setQueueDelivery] = useState<QueueDelivery>("followUp");
  const [queueEdit, setQueueEdit] = useState<{ taskId: string; message: AgentQueuedMessage; delivery: QueueDelivery } | null>(null);
  const [extensionUiRequest, setExtensionUiRequest] = useState<ExtensionUiRequest | null>(null);
  const [commandDialog, setCommandDialog] = useState<{ title: string; body: string } | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [sessionBranchMode, setSessionBranchMode] = useState<SessionBranchMode | null>(null);
  const [sessionTreeSnapshot, setSessionTreeSnapshot] = useState<SessionTreeSnapshot | null>(null);
  const [sessionBranchSkipPrompt, setSessionBranchSkipPrompt] = useState(false);
  const [sessionTreeLoading, setSessionTreeLoading] = useState(false);
  const [sessionTreeBusy, setSessionTreeBusy] = useState(false);
  const [sessionTreeError, setSessionTreeError] = useState<string | null>(null);
  const [trustOpen, setTrustOpen] = useState(false);
  const [trustProject, setTrustProject] = useState<ProjectSummary | null>(null);
  const [trustStatus, setTrustStatus] = useState<ProjectTrustStatus | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);
  const [scopedModelsOpen, setScopedModelsOpen] = useState(false);
  const [thinkingLevel, setThinkingLevel] = useState("off");
  const [thinkingLevels, setThinkingLevels] = useState<string[]>(["off"]);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [suggestionMode, setSuggestionMode] = useState<SuggestionMode>(null);
  const [suggestionQuery, setSuggestionQuery] = useState("");
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [extensionSuggestions, setExtensionSuggestions] = useState<ExtensionAutocompleteItem[]>([]);
  const extensionAutocompleteRequestRef = useRef(0);
  const extensionAutocompleteTimerRef = useRef<number | undefined>(undefined);
  const extensionInputQueueRef = useRef<Promise<void>>(Promise.resolve());
  const dispatchExtensionInputRef = useRef<(data: string, element?: HTMLTextAreaElement) => void>(() => undefined);
  const [runtimeStatus, setRuntimeStatus] = useState<"connected" | "starting" | "disconnected">("starting");
  const [contextMenu, setContextMenu] = useState<{ task: TaskSummary; x: number; y: number } | null>(null);
  const [projectContextMenu, setProjectContextMenu] = useState<{ project: ProjectSummary; x: number; y: number } | null>(null);
  const [imageContextMenu, setImageContextMenu] = useState<ImageContextMenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TaskSummary | null>(null);
  const [pendingProjectRemove, setPendingProjectRemove] = useState<ProjectSummary | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [removingProjectCwd, setRemovingProjectCwd] = useState<string | null>(null);
  const { notices, showNotice, dismissNotice } = useNotice();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [projectSwitching, setProjectSwitching] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { scrollPositionsRef, scrollHandleRef, handleTimelineAtEnd, jumpToLatest, followLatest } = useConversationScroll({ setShowJumpToLatest });
  const { discardStreamDeltas, queueStreamDelta } = useStreamDeltas(setTaskUi);
  const optimisticTaskIdsRef = useRef<Record<string, Set<string>>>({});
  const projectLoadRequestRef = useRef(0);
  const modelSelectionRequestRef = useRef(0);
  const sessionTreeRequestRef = useRef(0);
  const initialLoadStartedRef = useRef(false);
  const queueEditDraftRef = useRef<{ text: string; images: ImageAttachment[]; delivery: QueueDelivery } | null>(null);
  const composerHistoryRef = useRef(new ComposerHistory());
  const handlePreviewImage = useCallback((image: PreviewImage) => setPreviewImage(image), []);
  const handleCustomEditorPaste = useCallback((text: string) => dispatchExtensionInputRef.current(`\x1b[200~${text.slice(0, 999_988)}\x1b[201~`), []);
  const openImageContextMenu = useCallback((event: React.MouseEvent, image: PreviewImage) => {
    event.preventDefault();
    setContextMenu(null);
    setProjectContextMenu(null);
    setImageContextMenu({ image, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 174)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 58)) });
  }, []);
  const t = copy[language];
  useDialogFocus(sidebarRef, () => setMobileSidebarOpen(false), mobileSidebarOpen && window.matchMedia("(max-width: 560px)").matches);
  useEffect(() => {
    // Invalidate an in-flight model capability refresh when its session scope
    // changes, so a late response cannot update another conversation.
    modelSelectionRequestRef.current += 1;
  }, [activeTask?.id, projectCwd]);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const shortcut = (key: string) => `${isMac ? "⌘" : "Ctrl+"}${key}`;
  const activeTaskUi = activeTask ? taskUi[activeTask.id] : undefined;
  useEffect(() => {
    extensionAutocompleteRequestRef.current += 1;
    if (extensionAutocompleteTimerRef.current !== undefined) window.clearTimeout(extensionAutocompleteTimerRef.current);
    setExtensionSuggestions([]);
    setSuggestionMode((current) => current === "extension" ? null : current);
  }, [activeTask?.id, activeTaskUi?.extensionAutocomplete?.active]);
  useSentImagesCache(sentImagesByTask, setSentImagesByTask);
  const isSending = Boolean(activeTaskUi?.isSending);
  const isCompacting = Boolean(activeTaskUi?.isCompacting);
  const isWorking = isSending || isCompacting;
  const streamText = activeTaskUi?.streamText ?? "";
  const workingPhase = activeTaskUi?.workingPhase ?? null;
  const rawMessages = useMemo(() => activeTaskId ? messagesByTask[activeTaskId] ?? [] : [], [activeTaskId, messagesByTask]);
  const messages = useMemo(() => {
    if (!activeTaskId) return rawMessages;
    const pendingImages = [...(sentImagesByTask[activeTaskId] ?? [])];
    if (!pendingImages.length) return rawMessages;
    return rawMessages.map((message) => {
      if (message?.role !== "user" || (Array.isArray(message.content) && message.content.some((part: any) => part?.type === "image"))) return message;
      const matchIndex = pendingImages.findIndex((sent) => textFromMessage(message).trim() === sent.text);
      if (matchIndex < 0) return message;
      const sent = pendingImages.splice(matchIndex, 1)[0];
      return { ...message, content: [{ type: "text", text: sent.text }, ...sent.images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }))] };
    });
  }, [activeTaskId, rawMessages, sentImagesByTask]);
  const promptHistory = useMemo(() => {
    const history: string[] = [];
    for (const message of messages) {
      if (message?.role !== "user") continue;
      const text = textFromMessage(message).trim();
      if (text && history[history.length - 1] !== text) history.push(text);
    }
    return history;
  }, [messages]);
  const messageLoad = activeTask ? messageLoads[activeTask.id] ?? { status: "idle" as const } : { status: "idle" as const };
  const activeProject = projects.find((project) => project.cwd === projectCwd) ?? null;
  const handleChangeReviewError = useCallback((error: unknown) => showNotice(`${t.changeReviewLoadFailed}: ${error instanceof Error ? error.message : String(error)}`), [showNotice, t.changeReviewLoadFailed]);
  const changeReview = useChangeReview({ enabled: capabilities?.changeReviewEnabled === true, taskId: activeTaskId, projectCwd, onError: handleChangeReviewError });

  useEffect(() => {
    if (!queueEdit) return;
    const queueMessages = [...(queueState?.steering ?? []), ...(queueState?.followUp ?? [])];
    const sameTask = queueEdit.taskId === activeTaskId;
    if (sameTask && queueMessages.some((message) => message.id === queueEdit.message.id)) return;
    const draft = queueEditDraftRef.current;
    setComposer(draft?.text ?? "");
    setComposerImages(draft?.images ?? []);
    if (draft) setQueueDelivery(draft.delivery);
    queueEditDraftRef.current = null;
    setQueueEdit(null);
    if (sameTask) showNotice(t.queueEditUnavailable);
  }, [activeTaskId, queueEdit, queueState, showNotice, t.queueEditUnavailable]);

  function mergeLiveTaskState(task: TaskSummary): TaskSummary {
    const ui = taskUi[task.id];
    if (ui?.approval) return { ...task, state: "waiting-approval" };
    if (ui?.isSending || ui?.isCompacting) return { ...task, state: "running" };
    return task;
  }

  function updateTaskLists(update: (tasks: TaskSummary[]) => TaskSummary[]) {
    setTasks(update);
    setProjectTasksByCwd((current) => Object.fromEntries(Object.entries(current).map(([cwd, projectTasks]) => [cwd, update(projectTasks)])));
  }

  function patchTaskUi(taskId: string, patch: Partial<TaskUiState>) {
    setTaskUi((current) => {
      const previous = current[taskId] ?? createDefaultTaskUiState();
      return { ...current, [taskId]: { ...previous, ...patch } };
    });
  }

  function updateActivity(taskId: string, update: (steps: ActivityStep[]) => ActivityStep[]) {
    setTaskUi((current) => {
      const previous = current[taskId] ?? { ...createDefaultTaskUiState(), isSending: true, workingPhase: "thinking" as const };
      return { ...current, [taskId]: { ...previous, activity: update(previous.activity) } };
    });
  }

  function openProviderSettings(providerId?: string) {
    setQuickSettingsOpen(false);
    setPreviewImage(null);
    setProviderFocus(providerId ?? null);
    setSettingsOpen(true);
  }

  function openQuickSettings(page: "root" | "commands" = "root") {
    setSettingsOpen(false);
    setProviderFocus(null);
    setPreviewImage(null);
    setQuickSettingsPage(page);
    setQuickSettingsOpen(true);
  }

  function handlePermissionStatus(status: PermissionStatus) {
    setPermissionStatus(status);
    if (status.mode === "ask") return;
    setTaskUi((current) => Object.fromEntries(Object.entries(current).map(([taskId, state]) => [taskId, state.approval ? { ...state, approval: undefined, workingPhase: state.isSending ? "thinking" as const : state.workingPhase } : state])));
    updateTaskLists((current) => current.map((task) => task.state === "waiting-approval" ? { ...task, state: "running" } : task));
  }

  function clearProjectState() {
    setActiveTask(null);
    setTasks([]);
    setWorkspace(null);
    setCapabilities(null);
    setContextUsage(undefined);
    setComposer("");
    setComposerImages([]);
    queueEditDraftRef.current = null;
    setQueueEdit(null);
    setActiveModel(null);
    setThinkingLevel("off");
    setThinkingLevels(["off"]);
    setMessageLoads({});
  }

  async function refreshWorkspace() {
    if (!projectCwd) return;
    try { setWorkspace(await window.pfsaa.workspace.snapshot(projectCwd)); }
    catch (error) { showNotice(`${t.workspaceRefreshFailed}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async function refreshModels(providerId?: string) {
    try {
      const maxAttempts = providerId ? 8 : 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const [providersResult, modelsResult] = await Promise.allSettled([
          providerId ? window.pfsaa.providers.list() : Promise.resolve([] as ProviderSummary[]),
          window.pfsaa.models.list(),
        ]);
        if (modelsResult.status === "fulfilled") setModels(modelsResult.value);
        else throw modelsResult.reason;
        if (!providerId) return;
        if (providersResult.status === "fulfilled" && providersResult.value.some((provider) => provider.id === providerId && provider.authState === "configured")) return;
        await new Promise((resolve) => window.setTimeout(resolve, attempt < 2 ? 150 : 300));
      }
    } catch (error) { showNotice(`${t.modelLoadFailed}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async function loadProjectData(cwd: string, preferredTaskId?: string, selectDefaultTask = true, fallbackTask?: TaskSummary, preserveView = false) {
    // A newer project load supersedes this one: its results are discarded so a
    // slow response cannot clobber the project the user has since switched to.
    const requestId = ++projectLoadRequestRef.current;
    if (!preserveView) setInitialLoading(true);
    setLoadError(null);
    try {
      setProjectCwd(cwd);
      writePfsaaStorage("project-cwd", cwd);
      const [tasksResult, modelsResult, snapshotResult, capabilitiesResult] = await Promise.allSettled([
        window.pfsaa.sessions.list(cwd),
        window.pfsaa.models.list(),
        window.pfsaa.workspace.snapshot(cwd),
        window.pfsaa.sessions.capabilities(undefined, cwd),
      ]);
      if (requestId !== projectLoadRequestRef.current) return;
      const listedTasks = tasksResult.status === "fulfilled" ? tasksResult.value.map(mergeLiveTaskState) : [];
      // A newly-created empty session can briefly be missing from AgentCore's
      // persisted SessionManager list while its session file is flushed. Keep
      // the task supplied by the sidebar visible/selectable during that gap.
      const previousTasks = [...(projectTasksByCwd[cwd] ?? []), ...(fallbackTask ? [fallbackTask] : [])];
      const remoteTasks = mergeProjectTasks(cwd, listedTasks, previousTasks);
      if (tasksResult.status === "fulfilled") {
        setTasks(remoteTasks);
        setProjectTasksByCwd((current) => ({ ...current, [cwd]: remoteTasks }));
        setProjectTaskLoads((current) => ({ ...current, [cwd]: { status: "ready" } }));
      } else setLoadError(`${t.initialLoadFailed}: ${tasksResult.reason instanceof Error ? tasksResult.reason.message : String(tasksResult.reason)}`);
      if (modelsResult.status === "fulfilled") setModels(modelsResult.value);
      else showNotice(`${t.modelLoadFailed}: ${modelsResult.reason instanceof Error ? modelsResult.reason.message : String(modelsResult.reason)}`);
      if (snapshotResult.status === "fulfilled") setWorkspace(snapshotResult.value);
      else showNotice(`${t.workspaceRefreshFailed}: ${snapshotResult.reason instanceof Error ? snapshotResult.reason.message : String(snapshotResult.reason)}`);
      if (capabilitiesResult.status === "fulfilled") {
        setCapabilities(capabilitiesResult.value);
        setThinkingLevel(capabilitiesResult.value.thinkingLevel);
        setThinkingLevels(capabilitiesResult.value.thinkingLevels);
        setContextUsage(capabilitiesResult.value.contextUsage);
        setActiveModel(capabilitiesResult.value.model?.authConfigured ? capabilitiesResult.value.model : modelsResult.status === "fulfilled" ? modelsResult.value.find((model) => model.authConfigured) ?? null : null);
      } else showNotice(`${t.capabilitiesLoadFailed}: ${capabilitiesResult.reason instanceof Error ? capabilitiesResult.reason.message : String(capabilitiesResult.reason)}`);
      const preferredTask = preferredTaskId ? remoteTasks.find((task) => task.id === preferredTaskId) ?? fallbackTask ?? null : null;
      setActiveTask(selectDefaultTask ? preferredTask ?? remoteTasks[0] ?? null : preferredTask);
    } catch (error) {
      if (requestId !== projectLoadRequestRef.current) return;
      setLoadError(`${t.initialLoadFailed}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!preserveView && requestId === projectLoadRequestRef.current) setInitialLoading(false);
    }
  }

  async function loadInitialData() {
    setInitialLoading(true);
    setLoadError(null);
    try {
      const discoveredProjects = await window.pfsaa.projects.list(projectCwd || undefined);      setProjects(discoveredProjects);
      const selectedProject = discoveredProjects.find((project) => project.cwd === projectCwd) ?? discoveredProjects[0];
      if (!selectedProject) {
        clearProjectState();
        setProjectCwd("");
        removePfsaaStorage("project-cwd");
        setExpandedProjectCwds([]);
        setInitialLoading(false);
        return;
      }
      // The expanded project preference is restored before the project list is
      // available. Load every restored project in the background as well as
      // the active project; otherwise an expanded, non-active project renders
      // with an idle task load until the user collapses and re-expands it.
      const restoredExpandedCwds = new Set(expandedProjectCwds);
      restoredExpandedCwds.add(selectedProject.cwd);
      setExpandedProjectCwds([...restoredExpandedCwds]);
      await loadProjectData(selectedProject.cwd, activeTask?.projectId === selectedProject.id ? activeTask.id : undefined);
      const restoredExpandedProjects = discoveredProjects.filter((project) => project.cwd !== selectedProject.cwd && restoredExpandedCwds.has(project.cwd));
      await Promise.all(restoredExpandedProjects.map((project) => loadProjectSessions(project)));
    } catch (error) {
      setLoadError(`${t.initialLoadFailed}: ${error instanceof Error ? error.message : String(error)}`);
      setInitialLoading(false);
    }
  }

  const loadInitialDataRef = useRef(loadInitialData);
  loadInitialDataRef.current = loadInitialData;

  async function restartHost() {
    // PfsaaHost crashed or was killed; ask Main to fork a fresh one, then reload
    // the workspace once it is back. Without this the retry button can never
    // recover from a disconnected host.
    setRuntimeStatus("starting");
    setLoadError(null);
    try {
      await window.pfsaa.app.restartHost();
      await loadInitialData();
    } catch (error) {
      setLoadError(`${t.initialLoadFailed}: ${error instanceof Error ? error.message : String(error)}`);
      setRuntimeStatus("disconnected");
    }
  }

  async function loadProjectSessions(project: ProjectSummary) {
    setProjectTaskLoads((current) => ({ ...current, [project.cwd]: { status: "loading" } }));
    try {
      const listedTasks = (await window.pfsaa.sessions.list(project.cwd)).map(mergeLiveTaskState);
      setProjectTasksByCwd((current) => ({
        ...current,
        [project.cwd]: mergeProjectTasks(project.cwd, listedTasks, current[project.cwd] ?? []),
      }));
      setProjectTaskLoads((current) => ({ ...current, [project.cwd]: { status: "ready" } }));
    } catch (error) {
      setProjectTaskLoads((current) => ({ ...current, [project.cwd]: { status: "error", error: error instanceof Error ? error.message : String(error) } }));
    }
  }

  async function selectProject(project: ProjectSummary) {
    if (expandedProjectCwds.includes(project.cwd)) {
      setExpandedProjectCwds((current) => current.filter((cwd) => cwd !== project.cwd));
      return;
    }
    setExpandedProjectCwds((current) => [...current, project.cwd]);
    if (project.cwd !== projectCwd) await loadProjectSessions(project);
  }

  async function selectTask(project: ProjectSummary, task: TaskSummary) {
    setMobileSidebarOpen(false);
    setExpandedProjectCwds((current) => current.includes(project.cwd) ? current : [...current, project.cwd]);
    if (project.cwd === projectCwd) {
      // A cached task can still have messages from the previous render while
      // useSessionData fetches the authoritative snapshot. Mark it as loading
      // before activating the timeline so the first scroll restoration waits
      // for stable message geometry instead of restoring against stale heights.
      if (activeTask?.id !== task.id) {
        setMessageLoads((current) => ({ ...current, [task.id]: { status: "loading" } }));
      }
      setActiveTask(task);
      updateTaskLists((current) => current.map((item) => item.id === task.id ? { ...item, unread: false } : item));
      return;
    }
    // Cross-project switch: clear only session-scoped state so the previous
    // conversation/messages caches and the composer draft survive, and skip
    // the full-screen skeleton (preserveView) — the switch reads as a fast
    // content swap instead of a loading flash. Session effects stay idle
    // while activeTask is null, so no stale task is refetched under the new
    // project cwd.
    setActiveTask(null);
    setCapabilities(null);
    setActiveModel(null);
    setContextUsage(undefined);
    setThinkingLevel("off");
    setThinkingLevels(["off"]);
    setQueueState(null);
    setWorkspace(null);
    setProjectSwitching(true);
    try {
      await loadProjectData(project.cwd, task.id, false, task, true);
    } finally {
      setProjectSwitching(false);
    }
  }

  async function createTaskForProject(project: ProjectSummary) {
    if (initialLoading) return null;
    try {
      const task = await window.pfsaa.sessions.create({ cwd: project.cwd, name: t.newTaskName });
      rememberOptimisticTask(task);
      setProjectTasksByCwd((current) => ({ ...current, [project.cwd]: sortTasksByUpdatedAt([task, ...(current[project.cwd] ?? []).filter((item) => item.id !== task.id)]) }));
      setProjects((current) => current.map((item) => item.cwd === project.cwd ? { ...item, taskCount: item.taskCount + 1 } : item));
      setExpandedProjectCwds((current) => current.includes(project.cwd) ? current : [...current, project.cwd]);
      setMobileSidebarOpen(false);
      clearProjectState();
      setProjectCwd(project.cwd);
      writePfsaaStorage("project-cwd", project.cwd);
      setTasks([task]);
      setMessagesByTask((current) => ({ ...current, [task.id]: [] }));
      setMessageLoads((current) => ({ ...current, [task.id]: { status: "ready" } }));
      setActiveTask(task);
      await loadProjectData(project.cwd, task.id, false, task);
      // SessionManager.list may not expose a just-created session until its
      // session file is flushed. Keep the optimistic task selected instead of
      // letting the reload return to the empty-project state.
      setTasks((current) => sortTasksByUpdatedAt([task, ...current.filter((item) => item.id !== task.id)]));
      setProjectTasksByCwd((current) => ({ ...current, [project.cwd]: sortTasksByUpdatedAt([task, ...(current[project.cwd] ?? []).filter((item) => item.id !== task.id)]) }));
      setActiveTask((current) => current?.id === task.id ? current : task);
      showNotice(t.sessionCreated);
      return task;
    } catch (error) {
      showNotice(`${t.sessionCreateFailed}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function chooseProjectDirectory() {
    try {
      const chooseDirectory = window.pfsaa.projects.chooseDirectory;
      if (typeof chooseDirectory !== "function") throw new Error(t.projectBridgeError);
      const project = await chooseDirectory();
      if (!project) return;
      setProjects((current) => [project, ...current.filter((item) => item.cwd !== project.cwd)]);
      await selectProject(project);
      try {
        const status = await window.pfsaa.projects.trustStatus(project.cwd);
        if ((status.source === "default" || status.source === "not-required") && status.defaultPolicy === "ask") {
          setTrustProject(project);
          setTrustStatus(status);
          setTrustOpen(true);
        }
      } catch (error) {
        showNotice(`${t.trustStatusFailed}: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    } catch (error) {
      showNotice(`${t.projectOpenFailed}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function removeProject(project: ProjectSummary) {
    if (removingProjectCwd) return;
    try {
      const removeProjectBridge = window.pfsaa.projects.remove;
      if (typeof removeProjectBridge !== "function") throw new Error(t.projectRemoveBridgeError);
      setRemovingProjectCwd(project.cwd);
      await removeProjectBridge(project.cwd);
      setProjects((current) => current.filter((item) => item.cwd !== project.cwd));
      setProjectTasksByCwd((current) => { const next = { ...current }; delete next[project.cwd]; return next; });
      setProjectTaskLoads((current) => { const next = { ...current }; delete next[project.cwd]; return next; });
      setExpandedProjectCwds((current) => current.filter((cwd) => cwd !== project.cwd));
      if (projectCwd === project.cwd) {
        clearProjectState();
        setProjectCwd("");
        removePfsaaStorage("project-cwd");
      }
      setPendingProjectRemove(null);
    } catch (error) {
      showNotice(`${t.projectRemoveFailed}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRemovingProjectCwd(null);
    }
  }

  useEffect(() => {
    writePfsaaStorage("expanded-project-cwds", JSON.stringify(expandedProjectCwds));
    removePfsaaStorage("expanded-project-cwd");
  }, [expandedProjectCwds]);
  useEffect(() => {
    if (initialLoadStartedRef.current) return;
    initialLoadStartedRef.current = true;
    void loadInitialDataRef.current();
  }, []);
  useEffect(() => {
    let current = true;
    setQueueState(null);
    if (activeTaskId && projectCwd) {
      void loadQueueForCurrentTask({
        load: () => window.pfsaa.agent.queue(activeTaskId, projectCwd),
        isCurrent: () => current,
        onLoaded: (next) => {
          setQueueState(next);
          setQueueDelivery((delivery) => next.steering.length > 0 ? "steer" : delivery);
        },
        onError: (error) => showNotice(error instanceof Error ? error.message : String(error)),
      });
    }
    return () => { current = false; };
  }, [activeTaskId, projectCwd, showNotice]);

  const modelOptions = useMemo(() => [...models].filter((model) => model.authConfigured).sort((a, b) => a.providerName.localeCompare(b.providerName) || a.name.localeCompare(b.name)), [models]);
  const suggestions = useMemo(() => {
    if (suggestionMode === "extension") return extensionSuggestions;
    if (suggestionMode === "mention") return (workspace?.files ?? []).filter((file) => file.kind === "file" && file.path.toLowerCase().includes(suggestionQuery.toLowerCase())).slice(0, 12);
    const slashCommands = Array.isArray(capabilities?.slashCommands) && capabilities.slashCommands.length ? capabilities.slashCommands : fallbackSlashCommands;
    const prompts = Array.isArray(capabilities?.prompts) ? capabilities.prompts : [];
    const skills = Array.isArray(capabilities?.skills) ? capabilities.skills : [];
    const slashItems = [
      ...slashCommands.filter((item) => isPfsaaAvailableCommand(item.name)).map((item) => ({ ...item, description: item.source === "extension" ? item.description : localizeCommandDescription(item.name, item.description, language) })),
      ...prompts.map((item) => ({ name: item.name, description: item.description ?? "" })),
      ...skills.map((item) => ({ name: item.name, description: item.description ?? "" })),
    ];
    return slashItems.filter((item) => item.name.toLowerCase().includes(suggestionQuery.toLowerCase())).slice(0, 12);
  }, [capabilities, extensionSuggestions, language, suggestionMode, suggestionQuery, workspace]);
  const paletteCommands = useMemo(() => {
    const slashCommands = Array.isArray(capabilities?.slashCommands) && capabilities.slashCommands.length ? capabilities.slashCommands : fallbackSlashCommands;
    const prompts = Array.isArray(capabilities?.prompts) ? capabilities.prompts : [];
    const skills = Array.isArray(capabilities?.skills) ? capabilities.skills : [];
    const commands = [
      ...slashCommands.filter((item) => isPfsaaAvailableCommand(item.name)).map((item) => ({ ...item, description: item.source === "extension" ? item.description : localizeCommandDescription(item.name, item.description, language) })),
      ...prompts.map((item) => ({ name: item.name, description: item.description ?? "", source: "prompt" })),
      ...skills.map((item) => ({ name: item.name, description: item.description ?? "", source: "skill" })),
    ];
    return Array.from(new Map(commands.map((command) => [command.name, command])).values());
  }, [capabilities, language]);
  const commandNames = useMemo(() => paletteCommands.map((command) => command.name), [paletteCommands]);

  useSessionData({
    projectCwd,
    taskId: activeTask?.id,
    language,
    models,
    messageReload,
    setMessageLoads,
    setMessagesByTask,
    setTaskUi,
    setCapabilities,
    setActiveModel,
    setThinkingLevel,
    setThinkingLevels,
    setContextUsage,
    showNotice,
  });

  function handleSessionReplaced(task: TaskSummary) {
    rememberOptimisticTask(task);
    setProjectTasksByCwd((current) => ({
      ...current,
      [task.projectId]: sortTasksByUpdatedAt([task, ...(current[task.projectId] ?? []).filter((item) => item.id !== task.id)]),
    }));
    setExpandedProjectCwds((current) => current.includes(task.projectId) ? current : [...current, task.projectId]);
    if (task.projectId === projectCwd) {
      setTasks((current) => sortTasksByUpdatedAt([task, ...current.filter((item) => item.id !== task.id)]));
      setActiveTask(task);
      return;
    }
    setActiveTask(null);
    setCapabilities(null);
    setActiveModel(null);
    setContextUsage(undefined);
    setQueueState(null);
    setWorkspace(null);
    setProjectSwitching(true);
    void loadProjectData(task.projectId, task.id, true, task, true)
      .finally(() => setProjectSwitching(false));
    void window.pfsaa.projects.list(task.projectId).then(setProjects).catch(() => undefined);
  }

  useRuntimeEvents({
    projectCwd,
    language,
    activeTaskId: activeTask?.id,
    queueModes: { steeringMode: queueState?.steeringMode, followUpMode: queueState?.followUpMode },
    queueState,
    setRuntimeStatus,
    showNotice,
    patchTaskUi,
    updateTaskLists,
    discardStreamDeltas,
    queueStreamDelta,
    updateActivity,
    setQueueState,
    setExtensionUiRequest,
    setSteeringMessageKeysByTask,
    setMessagesByTask,
    setTaskUi,
    setMessageLoads,
    setContextUsage,
    setActiveTask,
    refreshWorkspace,
    onQueueActivity: followLatest,
    onExtensionEditorText: (text: string) => { setComposer(text); setSuggestionMode(null); },
    onExtensionEditorSubmit: (text: string) => { setComposer(text); setSuggestionMode(null); void sendPrompt(text); },
    onSessionReplaced: handleSessionReplaced,
    onChangeReviewUpdated: changeReview.applyUpdatedReview,
    onChangeReviewStatus: changeReview.applyReviewStatus,
  });

  useEffect(() => { void window.pfsaa.runtime.status().then(setRuntimeStatus).catch(() => setRuntimeStatus("disconnected")); void window.pfsaa.permissions.status().then(setPermissionStatus).catch(() => undefined); }, []);

  useEffect(() => {
    if (runtimeStatus !== "connected") return;
    void window.pfsaa.input.keybindings(projectCwd || undefined).then(setAgentCoreKeybindings).catch((error) => {
      showNotice(`${t.keybindingsLoadFailed}: ${error instanceof Error ? error.message : String(error)}`, "error");
    });
  }, [projectCwd, runtimeStatus, showNotice, t.keybindingsLoadFailed]);

  useEffect(() => {
    if (activeTaskId) composerHistoryRef.current.resetNavigation(activeTaskId);
    setTranscriptSearchOpen(false);
    setTranscriptSearchQuery("");
    setTranscriptSearchResult({ current: 0, total: 0 });
  }, [activeTaskId]);

  useEffect(() => {
    sessionTreeRequestRef.current += 1;
    setSessionBranchMode(null);
    setSessionTreeSnapshot(null);
    setSessionTreeError(null);
    setSessionTreeLoading(false);
    setSessionTreeBusy(false);
  }, [activeTaskId]);

  // The timeline owns the real scroll state. Reset only the transient affordance
  // when the active task changes; the new timeline will publish its restored
  // at-end state during initialization.
  useEffect(() => { setShowJumpToLatest(false); }, [activeTask?.id]);

  useGlobalShortcuts({
    searchInputRef,
    settingsOpen,
    agentCoreSettingsOpen,
    quickSettingsOpen,
    packagesOpen: false,
    extensionUiOpen: Boolean(extensionUiRequest),
    commandDialogOpen: Boolean(commandDialog),
    renameOpen,
    resumeOpen,
    sessionBranchOpen: Boolean(sessionBranchMode),
    trustOpen,
    scopedModelsOpen,
    pendingDelete: Boolean(pendingDelete),
    pendingProjectRemove: Boolean(pendingProjectRemove),
    previewImage: Boolean(previewImage),
    thinkingMenuOpen,
    modelMenuOpen,
    suggestionMode,
    contextMenu: Boolean(contextMenu),
    projectContextMenu: Boolean(projectContextMenu),
    imageContextMenu: Boolean(imageContextMenu),
    agentCoreKeybindings,
    onAgentCoreCommands: () => openQuickSettings("commands"),
    onTranscriptSearch: () => setTranscriptSearchOpen(true),
    onQuickSettings: () => openQuickSettings(),
    onCreateTask: createTask,
    onCloseMenus: () => { setThinkingMenuOpen(false); setModelMenuOpen(false); setSuggestionMode(null); setContextMenu(null); setProjectContextMenu(null); setImageContextMenu(null); },
  });

  useExtensionEditor({ taskId: activeTaskId ?? undefined, cwd: projectCwd, text: composer,
    shortcuts: capabilities?.extensionShortcuts, enabled: runtimeStatus === "connected" && !queueEdit,
    syncEnabled: activeTaskUi?.extensionEditor?.active !== true, onError: showNotice });

  useEffect(() => {
    if (!activeTaskId || !activeTaskUi?.extensionTerminalInputActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.matches("input, textarea, button, [contenteditable='true'], .composer-extension-editor")) return;
      const data = domKeyToTerminalInput(event);
      if (!data) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dispatchExtensionInputRef.current(data);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeTaskId, activeTaskUi?.extensionTerminalInputActive]);

  useEffect(() => {
    const close = () => { setContextMenu(null); setProjectContextMenu(null); setImageContextMenu(null); };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("blur", close); };
  }, []);

  useEffect(() => {
    if (!thinkingMenuOpen && !modelMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".menu-anchor")) return;
      setThinkingMenuOpen(false); setModelMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [thinkingMenuOpen, modelMenuOpen]);

  async function createTask() {
    if (!projectCwd) {
      showNotice(t.selectProjectFirst);
      return null;
    }
    try {
      // Invalidate any in-flight project load so its late results cannot
      // replace the task list/active task established here.
      projectLoadRequestRef.current += 1;
      const task = await window.pfsaa.sessions.create({ cwd: projectCwd, name: t.newTaskName });
      rememberOptimisticTask(task);
      setTasks((current) => sortTasksByUpdatedAt([task, ...current.filter((item) => item.id !== task.id)]));
      setProjectTasksByCwd((current) => ({ ...current, [projectCwd]: sortTasksByUpdatedAt([task, ...(current[projectCwd] ?? []).filter((item) => item.id !== task.id)]) }));
      setProjects((current) => current.map((project) => project.cwd === projectCwd ? { ...project, taskCount: project.taskCount + 1 } : project));
      setMessagesByTask((current) => ({ ...current, [task.id]: [] }));
      setMessageLoads((current) => ({ ...current, [task.id]: { status: "ready" } }));
      setExpandedProjectCwds((current) => current.includes(projectCwd) ? current : [...current, projectCwd]);
      setActiveTask(task);
      showNotice(t.sessionCreated);
      return task;
    } catch (error) {
      showNotice(`${t.sessionCreateFailed}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function deleteTask(task: TaskSummary) {
    const taskCwd = task.projectId || projectCwd;
    setDeletingTaskId(task.id);
    try {
      await window.pfsaa.sessions.delete(task.id, taskCwd);
      const optimisticIds = optimisticTaskIdsRef.current[taskCwd];
      optimisticIds?.delete(task.id);
      if (optimisticIds && optimisticIds.size === 0) delete optimisticTaskIdsRef.current[taskCwd];
      if (taskCwd === projectCwd) setTasks((current) => current.filter((item) => item.id !== task.id));
      setProjectTasksByCwd((current) => ({ ...current, [taskCwd]: (current[taskCwd] ?? []).filter((item) => item.id !== task.id) }));
      setProjects((current) => current.map((project) => project.cwd === taskCwd ? { ...project, taskCount: Math.max(0, project.taskCount - 1) } : project));
      setMessagesByTask((current) => { const next = { ...current }; delete next[task.id]; return next; });
      setSentImagesByTask((current) => { const next = { ...current }; delete next[task.id]; return next; });
      setSteeringMessageKeysByTask((current) => { const next = { ...current }; delete next[task.id]; return next; });
      setTaskUi((current) => { const next = { ...current }; delete next[task.id]; return next; });
      discardStreamDeltas(task.id);
      setPendingDelete(null);
      if (activeTask?.id === task.id) {
        setActiveTask(null);
      }
      showNotice(t.sessionDeleted);
    } catch (error) {
      showNotice(`${t.sessionDeleteFailed}: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally { setDeletingTaskId(null); }
  }

  function showCommandResult(title: string, body: string) {
    setCommandDialog({ title, body });
  }

  function formatSessionStats(stats: any): string {
    const tokens = stats.tokens ?? {};
    const context = stats.contextUsage?.tokens == null ? "—" : `${stats.contextUsage.tokens.toLocaleString()} / ${stats.contextUsage.contextWindow.toLocaleString()}`;
    return [
      `${t.sessionIdLabel}: ${stats.sessionId}`,
      stats.sessionFile ? `${t.sessionFileLabel}: ${stats.sessionFile}` : `${t.sessionFileLabel}: ${t.sessionInMemory}`,
      "",
      `${t.you}: ${stats.userMessages} · ${t.assistant}: ${stats.assistantMessages}`,
      `${t.toolCall}: ${stats.toolCalls} · ${t.toolResult}: ${stats.toolResults}`,
      `${t.tokenUnit}: ${tokens.total?.toLocaleString?.() ?? 0}`,
      `${t.sessionCostLabel}: $${Number(stats.cost ?? 0).toFixed(3)}`,
      `${t.contextUsed}: ${context}`,
    ].join("\n");
  }

  function showHotkeys() {
    const agentCoreBinding = (action: string) => (agentCoreKeybindings[action] ?? []).join(" / ") || "—";
    showCommandResult(t.hotkeysTitle, [
      `${shortcut("K")} — ${t.command}`,
      `${shortcut(",")} — ${t.quickSettings}`,
      `${shortcut("N")} — ${t.newTask}`,
      `Esc — ${t.cancel}`,
      `Enter — ${t.send}`,
      t.shiftEnter,
      "",
      `${agentCoreBinding("tui.altScreen.search")} — ${t.transcriptSearch}`,
      `${agentCoreBinding("app.editor.external")} — ${t.externalEditor}`,
      `${agentCoreBinding("app.model.select")} — ${t.chooseModel}`,
      `${agentCoreBinding("app.thinking.cycle")} — ${t.chooseThinking}`,
    ].join("\n"));
  }

  async function importSession() {
    if (!projectCwd) return showNotice(t.selectProjectFirst);
    try {
      const imported = await window.pfsaa.sessions.import(activeTask?.id, projectCwd || undefined);
      if (!imported) return;
      rememberOptimisticTask(imported);
      setTasks((current) => sortTasksByUpdatedAt([imported, ...current.filter((task) => task.id !== imported.id)]));
      setProjectTasksByCwd((current) => ({ ...current, [projectCwd]: sortTasksByUpdatedAt([imported, ...(current[projectCwd] ?? []).filter((task) => task.id !== imported.id)]) }));
      await loadProjectData(projectCwd, imported.id, true, imported);
      showNotice(t.sessionImported);
    } catch (error) { showNotice(`${t.sessionImportFailed}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async function renameSession(name: string) {
    if (!activeTask) return showNotice(t.noSessions);
    if (!name.trim()) return showNotice(t.sessionNameRequired);
    try {
      const title = await window.pfsaa.sessions.rename(activeTask.id, name.trim(), projectCwd);
      updateTaskLists((current) => current.map((task) => task.id === activeTask.id ? { ...task, title } : task));
      setActiveTask((current) => current?.id === activeTask.id ? { ...current, title } : current);
      setRenameOpen(false);
      showNotice(title);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function showSessionInfo() {
    if (!activeTask) return showNotice(t.noSessions);
    try { showCommandResult(t.sessionInfoTitle, formatSessionStats(await window.pfsaa.sessions.stats(activeTask.id, projectCwd))); }
    catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function loadSessionTree(task: TaskSummary = activeTask as TaskSummary) {
    if (!task || !projectCwd) return;
    const requestId = ++sessionTreeRequestRef.current;
    setSessionTreeLoading(true);
    setSessionTreeError(null);
    try {
      const [tree, settings] = await Promise.all([
        window.pfsaa.sessions.tree(task.id, projectCwd),
        window.pfsaa.settings.get(projectCwd).catch(() => null),
      ]);
      if (requestId !== sessionTreeRequestRef.current) return;
      setSessionTreeSnapshot(tree);
      setSessionBranchSkipPrompt(settings?.branchSummarySkipPrompt === true);
    } catch (error) {
      if (requestId !== sessionTreeRequestRef.current) return;
      setSessionTreeError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === sessionTreeRequestRef.current) setSessionTreeLoading(false);
    }
  }

  function openSessionBranch(mode: SessionBranchMode) {
    if (!activeTask) { showNotice(t.noSessions); return; }
    if (isWorking) { showNotice(t.sessionTreeWaitUntilIdle, "warning"); return; }
    setSessionBranchMode(mode);
    setSessionTreeSnapshot(null);
    setSessionBranchSkipPrompt(false);
    setSessionTreeError(null);
    void loadSessionTree(activeTask);
  }

  function closeSessionBranch(force = false) {
    if (sessionTreeBusy && !force) return;
    sessionTreeRequestRef.current += 1;
    setSessionBranchMode(null);
    setSessionTreeSnapshot(null);
    setSessionBranchSkipPrompt(false);
    setSessionTreeError(null);
    setSessionTreeLoading(false);
  }

  async function forkSession(entryId: string) {
    if (!activeTask || sessionTreeBusy) return;
    const sourceTask = activeTask;
    setSessionTreeBusy(true);
    setSessionTreeError(null);
    try {
      const result = await window.pfsaa.sessions.fork(sourceTask.id, entryId, projectCwd);
      if (result.cancelled) { showNotice(t.sessionTreeOperationCancelled); return; }
      if (result.task) handleSessionReplaced(result.task);
      setComposer(result.editorText ?? "");
      setSuggestionMode(null);
      closeSessionBranch(true);
      showNotice(t.forkSessionDone);
    } catch (error) {
      setSessionTreeError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionTreeBusy(false);
    }
  }

  async function cloneSession() {
    if (!activeTask || sessionTreeBusy) return;
    const sourceTask = activeTask;
    setSessionTreeBusy(true);
    setSessionTreeError(null);
    try {
      const result = await window.pfsaa.sessions.clone(sourceTask.id, projectCwd);
      if (result.cancelled) { showNotice(t.sessionTreeOperationCancelled); return; }
      if (result.task) handleSessionReplaced(result.task);
      setComposer("");
      setSuggestionMode(null);
      closeSessionBranch(true);
      showNotice(t.cloneSessionDone);
    } catch (error) {
      setSessionTreeError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionTreeBusy(false);
    }
  }

  async function navigateSessionTree(entryId: string, options: { summarize: boolean; customInstructions?: string }) {
    if (!activeTask || sessionTreeBusy) return;
    const taskId = activeTask.id;
    setSessionTreeBusy(true);
    setSessionTreeError(null);
    try {
      const result = await window.pfsaa.sessions.navigateTree(taskId, entryId, options, projectCwd);
      if (result.cancelled) { showNotice(t.sessionTreeOperationCancelled); return; }
      if (result.editorText && !composer.trim()) setComposer(result.editorText);
      setSuggestionMode(null);
      setMessageReload((current) => current + 1);
      closeSessionBranch(true);
      showNotice(t.sessionTreeNavigated);
    } catch (error) {
      setSessionTreeError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionTreeBusy(false);
    }
  }

  async function abortSessionTreeOperation() {
    if (!activeTask) return;
    try { await window.pfsaa.agent.abort(activeTask.id, projectCwd); }
    catch (error) { showNotice(error instanceof Error ? error.message : String(error), "error"); }
  }

  async function shareSession() {
    if (!activeTask) return showNotice(t.noSessions);
    try {
      const result = await window.pfsaa.sessions.share(activeTask.id, projectCwd);
      showCommandResult(t.sessionShared, `${result.url}\n\n${result.gistUrl}`);
    } catch (error) { showNotice(`${t.sessionShareFailed}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async function copyLastAssistant() {
    const lastAssistant = [...messages].reverse().find((message: any) => message?.role === "assistant");
    const text = lastAssistant ? textFromMessage(lastAssistant).trim() : "";
    if (!text) return showNotice(t.noAssistantToCopy);
    if (await copyText(text)) showNotice(t.copyLastAssistant);
    else showNotice(t.copyLastAssistantFailed);
  }

  async function openProjectTrust(project: ProjectSummary | null = activeProject) {
    if (!project) return showNotice(t.selectProjectFirst);
    try {
      const status = await window.pfsaa.projects.trustStatus(project.cwd);
      setTrustProject(project);
      setTrustStatus(status);
      setTrustOpen(true);
    } catch (error) {
      showNotice(`${t.trustStatusFailed}: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async function resolveTrust(trusted: boolean, project: ProjectSummary | null = trustProject ?? activeProject) {
    if (!project || trustBusy) return showNotice(t.selectProjectFirst);
    setTrustBusy(true);
    let appliedNow = false;
    let reloadError: unknown;
    try {
      const status = await window.pfsaa.projects.setTrust(project.cwd, trusted);
      setTrustStatus(status);
      if (activeTask && project.cwd === projectCwd && !isWorking) {
        try {
          const next = await window.pfsaa.sessions.reload(activeTask.id, project.cwd);
          setCapabilities(next);
          setMessageReload((current) => current + 1);
          appliedNow = true;
        } catch (error) {
          reloadError = error;
        }
      }
      setTrustOpen(false);
      setTrustProject(null);
      const action = trusted ? t.trustProject : t.untrustProject;
      const timing = appliedNow ? t.trustAppliedNow : t.trustAppliesNextSession;
      showNotice(`${action} · ${timing}${reloadError ? ` (${reloadError instanceof Error ? reloadError.message : String(reloadError)})` : ""}`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setTrustBusy(false);
    }
  }

  async function saveScopedModels(models: ScopedModelSelection[] | null, persist: boolean) {
    if (!activeTask) return showNotice(t.noSessions);
    try {
      await window.pfsaa.agent.setScopedModels(activeTask.id, models, persist, projectCwd);
      setScopedModelsOpen(false);
      const next = await window.pfsaa.sessions.capabilities(activeTask.id, projectCwd);
      setCapabilities(next);
      showNotice(t.scopedModelsSave);
    } catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function handleBuiltinCommand(text: string, onAccepted?: () => void): Promise<boolean> {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) return false;
    const command = match[1].toLowerCase();
    const argument = match[2]?.trim() ?? "";
    if (!isPfsaaAvailableCommand(command)) {
      showNotice(t.commandUnavailable(`/${command}`), "warning");
      onAccepted?.();
      return true;
    }
    let action: (() => unknown | Promise<unknown>) | null = null;
    if (command === "login" || command === "logout") action = () => openProviderSettings(argument || undefined);
    else if (command === "model") action = async () => {
      if (!argument) { setModelMenuOpen(true); setThinkingMenuOpen(false); return; }
      let model = commandModel(models, argument);
      if (!model) {
        // Extensions may register providers after the startup catalog request.
        try {
          const latestModels = await window.pfsaa.models.list();
          setModels(latestModels);
          model = commandModel(latestModels, argument);
        } catch (error) { showNotice(error instanceof Error ? error.message : String(error), "error"); return; }
      }
      if (!model) { showNotice(t.modelArgumentNotFound(argument), "error"); return; }
      await chooseModel(model);
    };
    else if (command === "thinking") action = async () => {
      if (!argument) { setThinkingMenuOpen(true); setModelMenuOpen(false); return; }
      const requestedLevel = thinkingLevels.find((level) => level.toLowerCase() === argument.toLowerCase());
      if (!requestedLevel) { showNotice(`${t.chooseThinking}: ${thinkingLevels.join(", ")}`); setThinkingMenuOpen(true); setModelMenuOpen(false); return; }
      await chooseThinking(requestedLevel);
    };
    else if (command === "compact") action = () => compactSession(argument || undefined);
    else if (command === "export") action = () => { const options = exportArguments(argument); return exportSession(options.format, options.outputPath); };
    else if (command === "new") action = () => createTask();
    else if (command === "reload") action = async () => {
      if (!activeTask) { showNotice(t.noSessions); return; }
      try {
        const next = await window.pfsaa.sessions.reload(activeTask.id, projectCwd);
        setCapabilities(next);
        await loadInitialData();
        showNotice(t.sessionReloaded);
      } catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
    };
    else if (command === "import") action = () => importSession();
    else if (command === "share") action = () => shareSession();
    else if (command === "copy") action = () => copyLastAssistant();
    else if (command === "name") action = async () => { if (argument) await renameSession(argument); else if (activeTask) setRenameOpen(true); else showNotice(t.noSessions); };
    else if (command === "session") action = () => showSessionInfo();
    else if (command === "changelog") action = async () => { try { showCommandResult(t.changelogTitle, await window.pfsaa.sessions.changelog()); } catch (error) { showNotice(error instanceof Error ? error.message : String(error)); } };
    else if (command === "hotkeys") action = () => showHotkeys();
    else if (command === "trust") action = async () => { if (/^(?:yes|true|trust|on)$/i.test(argument)) await resolveTrust(true); else if (/^(?:no|false|untrust|off)$/i.test(argument)) await resolveTrust(false); else await openProjectTrust(); };
    else if (command === "resume") action = () => setResumeOpen(true);
    else if (command === "fork") action = () => openSessionBranch("fork");
    else if (command === "clone") action = () => openSessionBranch("clone");
    else if (command === "tree") action = () => openSessionBranch("tree");
    else if (command === "quit") action = () => window.pfsaa.app.quit();
    else if (command === "scoped-models") action = () => { if (!activeTask) showNotice(t.noSessions); else setScopedModelsOpen(true); };
    else if (command === "settings") action = () => setAgentCoreSettingsOpen(true);
    if (!action) return false;
    onAccepted?.();
    await action();
    return true;
  }

  function isRegisteredExtensionCommand(text: string): boolean {
    const match = /^\/(\S+)(?:\s|$)/.exec(text);
    if (!match) return false;
    const name = match[1].toLowerCase();
    return (capabilities?.slashCommands ?? []).some((command) => command.source === "extension" && command.name.toLowerCase() === name);
  }

  async function selectPaletteCommand(command: PaletteCommand) {
    setQuickSettingsOpen(false);
    try {
      await activatePaletteCommand(command, {
        insertTemplate: (text) => {
          if (queueEdit) { showNotice(t.finishQueueEditFirst); return; }
          updateComposer(`${text}${composer}`);
          requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer-editor-input")?.focus());
        },
        executeBuiltin: handleBuiltinCommand,
        executeExtension: async (text) => {
          if (!activeTask) { showNotice(t.noSessions); return; }
          await window.pfsaa.agent.prompt(activeTask.id, text, projectCwd, [], queueDelivery);
          setMessageReload((current) => current + 1);
        },
        unsupported: () => showNotice(t.unsupportedDesktopCommand, "error"),
      });
    } catch (error) { showNotice(error instanceof Error ? error.message : String(error), "error"); }
  }

  function beginQueueEdit(message: AgentQueuedMessage, delivery: QueueDelivery) {
    if (!activeTask || queueMutationBusy || queueEdit) return;
    queueEditDraftRef.current = { text: composer, images: [...composerImages], delivery: queueDelivery };
    setQueueEdit({ taskId: activeTask.id, message, delivery });
    setComposer(message.text);
    setComposerImages(message.images.map((image, index) => ({ id: `queue-${message.id}-${index}`, data: image.data, mimeType: image.mimeType, name: t.imageAttached })));
    setQueueDelivery(delivery);
    setSuggestionMode(null);
  }

  function finishQueueEdit() {
    const draft = queueEditDraftRef.current;
    setComposer(draft?.text ?? "");
    setComposerImages(draft?.images ?? []);
    if (draft) setQueueDelivery(draft.delivery);
    queueEditDraftRef.current = null;
    setQueueEdit(null);
    setSuggestionMode(null);
  }

  function cancelQueueEdit() {
    if (queueMutationBusy) return;
    finishQueueEdit();
  }

  function replaceQueuedSentImages(taskId: string, original: AgentQueuedMessage, text: string, images: ImageAttachment[]) {
    setSentImagesByTask((current) => {
      const messages = [...(current[taskId] ?? [])];
      if (original.images.length > 0) {
        let originalIndex = -1;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const sent = messages[index];
          if (sent && sent.text === original.text && sent.images.length === original.images.length && sent.images.every((image, imageIndex) => image.data === original.images[imageIndex]?.data && image.mimeType === original.images[imageIndex]?.mimeType)) {
            originalIndex = index;
            break;
          }
        }
        if (originalIndex >= 0) messages.splice(originalIndex, 1);
      }
      if (images.length > 0) messages.push({ text, images: [...images] });
      return { ...current, [taskId]: messages };
    });
  }

  async function sendPrompt(textOverride?: string) {
    const text = (textOverride ?? composer).trim();
    if (!text && !composerImages.length) return;
    if (suggestionMode && suggestions.length > 0) { applySuggestion(suggestions[suggestionIndex] as any); return; }
    if (queueEdit) {
      if (!activeTask || activeTask.id !== queueEdit.taskId || queueMutationBusy) return;
      const images = [...composerImages];
      setQueueMutationBusy(true);
      try {
        const next = await window.pfsaa.agent.editQueue(activeTask.id, queueEdit.message.id, text, images.map(({ data, mimeType }) => ({ data, mimeType })), projectCwd);
        setQueueState(next);
        replaceQueuedSentImages(activeTask.id, queueEdit.message, text, images);
        finishQueueEdit();
      } catch (error) {
        showNotice(error instanceof Error ? error.message : String(error));
      } finally {
        setQueueMutationBusy(false);
      }
      return;
    }
    if (await handleBuiltinCommand(text, () => {
      if (activeTask) composerHistoryRef.current.add(activeTask.id, text, promptHistory);
      setComposer(""); setSuggestionMode(null);
    })) return;
    const bashMatch = /^(!!|!)([\s\S]*)$/.exec(text);
    if (bashMatch) {
      const command = bashMatch[2].trim();
      if (!command) return;
      const task = activeTask ?? await createTask();
      if (!task) return;
      composerHistoryRef.current.add(task.id, text, activeTask?.id === task.id ? promptHistory : []);
      setComposer(""); setComposerImages([]); setSuggestionMode(null);
      patchTaskUi(task.id, { isSending: true, isCompacting: false, workingPhase: "tool", toolName: "shell", streamText: "" });
      try {
        await window.pfsaa.agent.executeBash(task.id, command, bashMatch[1] === "!!", projectCwd);
        const next = await window.pfsaa.sessions.messages(task.id, projectCwd);
        setMessagesByTask((current) => ({ ...current, [task.id]: next as any[] }));
        setMessageLoads((current) => ({ ...current, [task.id]: { status: "ready" } }));
      } catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
      finally { patchTaskUi(task.id, { isSending: false, workingPhase: null, toolName: undefined }); }
      return;
    }
    const extensionCommandCandidate = isRegisteredExtensionCommand(text);
    if (!extensionCommandCandidate && !activeModel?.authConfigured && !modelOptions.some((model) => model.authConfigured)) { showNotice(t.noModelAvailable); return; }
    const creating = !activeTask;
    const desiredModel = activeModel;
    const desiredThinking = thinkingLevel;
    const images = composerImages;
    // Sending a new prompt is an explicit request to follow the new turn.
    followLatest();
    const task = activeTask ?? await createTask();
    if (!task) return;
    composerHistoryRef.current.add(task.id, text, activeTask?.id === task.id ? promptHistory : []);
    const optimisticId = `local-${Date.now()}`;
    const continuingExecution = Boolean(activeTaskUi?.isSending || activeTaskUi?.isCompacting);
    setComposer(""); setComposerImages([]); setSuggestionMode(null);
    if (images.length && !extensionCommandCandidate) setSentImagesByTask((current) => ({ ...current, [task.id]: [...(current[task.id] ?? []), { text, images }] }));
    // AgentCore extension commands are control messages, not conversation turns.
    // Do not render an optimistic user message that AgentCore will never persist.
    if (!continuingExecution && !extensionCommandCandidate) setMessagesByTask((current) => ({ ...current, [task.id]: [...(current[task.id] ?? []), { id: optimisticId, role: "user", content: images.length ? [{ type: "text", text }, ...images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }))] : text, timestamp: new Date().toISOString() }] }));
    setMessageLoads((current) => ({ ...current, [task.id]: { status: "ready" } }));
    patchTaskUi(task.id, { isSending: true, isCompacting: continuingExecution ? Boolean(activeTaskUi?.isCompacting) : false, workingPhase: "thinking", streamText: "", activity: continuingExecution ? activeTaskUi?.activity ?? [] : [], completedActivity: activeTaskUi?.completedActivity ?? [] });
    const taskTitle = extensionCommandCandidate ? "" : deriveSessionTitle(text);
    const shouldNameTask = !extensionCommandCandidate && isDefaultSessionTitle(task.title);
    const updatedAt = new Date().toISOString();
    updateTaskLists((current) => sortTasksByUpdatedAt(current.map((item) => item.id === task.id ? { ...item, title: shouldNameTask ? taskTitle || item.title : item.title, state: "running", updatedAt } : item)));
    setActiveTask((current) => current?.id === task.id ? { ...current, title: shouldNameTask ? taskTitle || current.title : current.title, state: "running", updatedAt } : current);
    // Persist the auto-derived (truncated) title immediately so a reload before
    // the LLM title returns still shows a sensible name. The backend otherwise
    // keeps the placeholder from sessions.create and a restart reverts to "新建任务".
    if (shouldNameTask && taskTitle) {
      void window.pfsaa.sessions.rename(task.id, taskTitle, projectCwd).catch(() => {});
      // Fire-and-forget LLM title generation: after the first message, ask the
      // model for a short summary title (e.g. "你好" -> "打招呼"/"Greeting") and
      // upgrade the name when it returns. Falls back to the truncated title above
      // if the model is unavailable or returns nothing.
      const titleModel = desiredModel ?? modelOptions.find((model) => model.authConfigured) ?? null;
      if (titleModel) {
        const fallbackTitle = taskTitle;
        void window.pfsaa.sessions.generateTitle(task.id, text, projectCwd, { providerId: titleModel.providerId, modelId: titleModel.id })
          .then((llmTitle) => {
            const clean = (llmTitle ?? "").trim();
            if (!clean) return;
            // Only upgrade if the user has not manually renamed in the meantime.
            updateTaskLists((current) => current.map((item) => item.id === task.id && (item.title === fallbackTitle || isDefaultSessionTitle(item.title)) ? { ...item, title: clean } : item));
            setActiveTask((current) => current?.id === task.id && (current.title === fallbackTitle || isDefaultSessionTitle(current.title)) ? { ...current, title: clean } : current);
            void window.pfsaa.sessions.rename(task.id, clean, projectCwd).catch(() => {});
          })
          .catch(() => {});
      }
    }
    try {
      if (creating && desiredModel) await window.pfsaa.agent.setModel(task.id, desiredModel.providerId, desiredModel.id, projectCwd);
      if (creating && desiredThinking !== "off") await window.pfsaa.agent.setThinkingLevel(task.id, desiredThinking, projectCwd);
      const promptResult = await window.pfsaa.agent.prompt(task.id, text, projectCwd, images.map(({ data, mimeType }) => ({ data, mimeType })), queueDelivery);
      // Extension commands run outside AgentCore's model loop, so AgentSession does
      // not emit agent_settled. Clear only this command's optimistic running
      // state; an extension command invoked during an existing run must leave
      // that run visible.
      if (promptResult?.disposition === "extension-command" && !continuingExecution) {
        patchTaskUi(task.id, { isSending: false, isCompacting: false, workingPhase: null, streamText: "", activity: [] });
        updateTaskLists((current) => current.map((item) => item.id === task.id ? { ...item, state: "idle", updatedAt: new Date().toISOString() } : item));
        setActiveTask((current) => current?.id === task.id ? { ...current, state: "idle", updatedAt: new Date().toISOString() } : current);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A timed-out agent.prompt is not a real failure: removal of the RPC
      // timeout above means this should no longer fire, but if it ever does
      // (e.g. a revert), keep the run alive — PfsaaHost keeps streaming and a
      // later agent_settled clears state when the run truly ends.
      if (message.includes("timed out: agent.prompt")) return;
      patchTaskUi(task.id, { isSending: false, isCompacting: false, workingPhase: null, activity: [] });
      setMessagesByTask((current) => ({ ...current, [task.id]: (current[task.id] ?? []).filter((message) => message.id !== optimisticId) }));
        if (images.length && !extensionCommandCandidate) setSentImagesByTask((current) => ({ ...current, [task.id]: (current[task.id] ?? []).filter((sent) => sent.images[0]?.id !== images[0]?.id) }));
      updateTaskLists((current) => current.map((item) => item.id === task.id ? { ...item, state: "failed" } : item));
      showNotice(message, "error");
    }
  }

  async function abortActive() {
    if (!activeTask) return;
    try {
      await window.pfsaa.agent.abort(activeTask.id, activeProject?.cwd);
      discardStreamDeltas(activeTask.id);
      patchTaskUi(activeTask.id, { isSending: false, isCompacting: false, workingPhase: null, streamText: "", retryStatus: undefined });
      updateTaskLists((current) => current.map((task) => task.id === activeTask.id ? { ...task, state: "idle" } : task));
    }
    catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
  }

  function appendComposerImages(files: File[], fallbackName: string) {
    for (const file of files.filter((candidate) => candidate.type.startsWith("image/"))) {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const match = /^data:([^;]+);base64,(.+)$/.exec(result);
        if (!match) return;
        setComposerImages((current) => [...current, { id: `${Date.now()}-${Math.random()}`, data: match[2], mimeType: match[1], name: file.name || fallbackName }]);
      };
      reader.readAsDataURL(file);
    }
  }

  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (!files.length) return;
    event.preventDefault();
    appendComposerImages(files, "pasted-image");
  }

  async function editComposerExternally() {
    if (!projectCwd || externalEditing) return;
    setExternalEditing(true);
    try {
      const value = await window.pfsaa.input.externalEdit(composer, projectCwd);
      updateComposer(value);
      if (activeTask && activeTaskUi?.extensionEditor?.active) await window.pfsaa.extensions.syncEditor(activeTask.id, value, projectCwd);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setExternalEditing(false);
    }
  }

  function recallComposerHistory(direction: "previous" | "next") {
    if (!activeTask || queueEdit) return false;
    const navigation = composerHistoryRef.current.navigate(activeTask.id, direction, composer, promptHistory);
    if (!navigation.handled) return false;
    updateComposer(navigation.value ?? "", true);
    return true;
  }

  function updateTranscriptQuery(value: string) {
    setTranscriptSearchQuery(value);
    setTranscriptSearchRequest((current) => ({ serial: current.serial + 1, direction: "forward", reset: true }));
  }

  function stepTranscriptSearch(direction: "forward" | "backward") {
    setTranscriptSearchRequest((current) => ({ serial: current.serial + 1, direction, reset: false }));
  }

  function closeTranscriptSearch() {
    setTranscriptSearchOpen(false);
    setTranscriptSearchQuery("");
    setTranscriptSearchResult({ current: 0, total: 0 });
  }

  function requestExtensionAutocomplete(value: string, cursor = value.length, force = false) {
    if (!activeTask || !activeTaskUi?.extensionAutocomplete?.active) return;
    const requestId = ++extensionAutocompleteRequestRef.current;
    void window.pfsaa.extensions.autocomplete(activeTask.id, value, cursor, force, projectCwd).then((result) => {
      if (requestId !== extensionAutocompleteRequestRef.current) return;
      if (!result?.items.length) {
        setExtensionSuggestions([]);
        setSuggestionMode((current) => current === "extension" ? null : current);
        return;
      }
      setExtensionSuggestions(result.items);
      setSuggestionMode("extension");
      setSuggestionIndex(0);
    }).catch((error) => {
      if (requestId === extensionAutocompleteRequestRef.current) showNotice(error instanceof Error ? error.message : String(error), "error");
    });
  }

  function updateComposer(value: string, preserveHistory = false) {
    if (!preserveHistory && activeTask) composerHistoryRef.current.resetNavigation(activeTask.id);
    setComposer(value);
    if (extensionAutocompleteTimerRef.current !== undefined) window.clearTimeout(extensionAutocompleteTimerRef.current);
    if (activeTaskUi?.extensionAutocomplete?.active) extensionAutocompleteTimerRef.current = window.setTimeout(() => requestExtensionAutocomplete(value), 80);
    const mentionMatch = /(?:^|\s)@([^\s]*)$/.exec(value);
    if (mentionMatch) {
      setSuggestionMode("mention"); setSuggestionQuery(mentionMatch[1]); setSuggestionIndex(0); return;
    }
    const slashMatch = /^\/([^\s/]*)$/.exec(value);
    const slashQuery = slashMatch?.[1].toLowerCase() ?? "";
    const knownPrefix = slashMatch && (slashQuery === "" || paletteCommands.some((command) => command.name.replace(/^\//, "").toLowerCase().startsWith(slashQuery)));
    if (!slashMatch || !knownPrefix) { setSuggestionMode(null); setSuggestionQuery(""); return; }
    setSuggestionMode("slash"); setSuggestionQuery(slashMatch[1]); setSuggestionIndex(0);
  }

  function applySuggestion(item: any) {
    if (suggestionMode === "extension") {
      if (typeof item.text === "string") {
        setComposer(item.text);
        const cursor = typeof item.cursor === "number" ? Math.max(0, Math.min(item.cursor, item.text.length)) : item.text.length;
        window.requestAnimationFrame(() => {
          const editor = document.querySelector<HTMLTextAreaElement>(".composer-editor-input");
          editor?.focus();
          editor?.setSelectionRange(cursor, cursor);
        });
      }
      setExtensionSuggestions([]);
      setSuggestionMode(null);
      return;
    }
    const prefix = suggestionMode === "mention" ? "@" : "/";
    const replacement = `${prefix}${suggestionMode === "mention" ? item.path : item.name} `;
    setComposer((current) => suggestionMode === "mention"
      ? current.replace(/(?:^|\s)@[^\s]*$/, (token) => `${/^\s/.test(token) ? token[0] : ""}${replacement}`)
      : current.replace(/^\/[^\s/]*$/, replacement));
    setSuggestionMode(null);
  }

  async function chooseThinking(level: string) {
    setThinkingMenuOpen(false);
    if (!activeTask) { setThinkingLevel(level); return; }
    try { await window.pfsaa.agent.setThinkingLevel(activeTask.id, level, projectCwd); setThinkingLevel(level); }
    catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function chooseModel(model: ModelSummary) {
    setModelMenuOpen(false);
    const requestId = ++modelSelectionRequestRef.current;
    if (!activeTask) {
      setActiveModel(model); setThinkingLevels(model.thinkingLevels); setThinkingLevel(model.thinkingLevels.includes(thinkingLevel) ? thinkingLevel : model.thinkingLevels[0] ?? "off"); return;
    }
    try {
      await window.pfsaa.agent.setModel(activeTask.id, model.providerId, model.id, projectCwd);
      if (requestId !== modelSelectionRequestRef.current) return;

      // Keep the model switch responsive while the authoritative runtime
      // capabilities are being read back from AgentCore.
      const fallbackThinkingLevels = model.thinkingLevels.length ? model.thinkingLevels : ["off"];
      setActiveModel(model);
      setThinkingLevels(fallbackThinkingLevels);
      setThinkingLevel(fallbackThinkingLevels.includes(thinkingLevel) ? thinkingLevel : fallbackThinkingLevels[0]);

      const next = await window.pfsaa.sessions.capabilities(activeTask.id, projectCwd);
      if (requestId !== modelSelectionRequestRef.current) return;
      const runtimeThinkingLevels = next.thinkingLevels.length ? next.thinkingLevels : ["off"];
      setCapabilities(next);
      setActiveModel(next.model ?? model);
      setThinkingLevels(runtimeThinkingLevels);
      setThinkingLevel(runtimeThinkingLevels.includes(next.thinkingLevel) ? next.thinkingLevel : runtimeThinkingLevels[0]);
      setContextUsage(next.contextUsage);
    } catch (error) {
      if (requestId === modelSelectionRequestRef.current) showNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function cycleModel(direction: "forward" | "backward") {
    if (!activeTask) return;
    const requestId = ++modelSelectionRequestRef.current;
    try {
      const next = await window.pfsaa.agent.cycleModel(activeTask.id, direction, projectCwd);
      if (requestId !== modelSelectionRequestRef.current) return;
      const levels = next.thinkingLevels.length ? next.thinkingLevels : ["off"];
      if (next.model) setActiveModel(next.model);
      setThinkingLevels(levels);
      setThinkingLevel(levels.includes(next.thinkingLevel) ? next.thinkingLevel : levels[0]);
      setContextUsage(next.contextUsage);
      setCapabilities((current) => current ? {
        ...current,
        model: next.model ?? current.model,
        thinkingLevel: next.thinkingLevel,
        thinkingLevels: levels,
        contextUsage: next.contextUsage,
      } : current);
    } catch (error) {
      if (requestId === modelSelectionRequestRef.current) showNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function rememberOptimisticTask(task: TaskSummary) {
    const ids = optimisticTaskIdsRef.current[task.projectId] ?? new Set<string>();
    ids.add(task.id);
    optimisticTaskIdsRef.current[task.projectId] = ids;
  }

  function mergeProjectTasks(cwd: string, listedTasks: TaskSummary[], previousTasks: TaskSummary[] = []): TaskSummary[] {
    const listedById = new Map<string, TaskSummary>();
    for (const task of listedTasks) listedById.set(task.id, task);
    const optimisticIds = optimisticTaskIdsRef.current[cwd] ?? new Set<string>();
    const optimisticById = new Map<string, TaskSummary>();
    for (const task of previousTasks) {
      if (!optimisticIds.has(task.id) || listedById.has(task.id) || optimisticById.has(task.id)) continue;
      optimisticById.set(task.id, task);
    }
    for (const task of listedTasks) optimisticIds.delete(task.id);
    if (optimisticIds.size === 0) delete optimisticTaskIdsRef.current[cwd];
    return sortTasksByUpdatedAt([...listedById.values(), ...optimisticById.values()]);
  }

  async function setQueueModes(modes: { steeringMode?: QueueMode; followUpMode?: QueueMode }): Promise<boolean> {
    if (!activeTask || queueEdit || queueMutationBusy) return false;
    setQueueMutationBusy(true);
    try {
      setQueueState(await window.pfsaa.agent.setQueueModes(activeTask.id, modes, projectCwd));
      return true;
    }
    catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
      return false;
    }
    finally { setQueueMutationBusy(false); }
  }

  async function clearQueue() {
    if (!activeTask || queueEdit || queueMutationBusy) return;
    try { setQueueState(await window.pfsaa.agent.clearQueue(activeTask.id, projectCwd)); }
    catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
  }

  async function promoteQueuedMessage(followUpIndex: number) {
    if (!activeTask || queueEdit || queueMutationBusy) return;
    setQueueMutationBusy(true);
    try {
      const next = await window.pfsaa.agent.promoteQueue(activeTask.id, followUpIndex, projectCwd);
      setQueueState(next);
      if (next.steering.length > 0) setQueueDelivery("steer");
    }
    catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
    finally { setQueueMutationBusy(false); }
  }

  async function deleteQueuedMessage(message: AgentQueuedMessage) {
    if (!activeTask || queueEdit || queueMutationBusy) return;
    setQueueMutationBusy(true);
    try {
      const next = await window.pfsaa.agent.deleteQueue(activeTask.id, message.id, projectCwd);
      setQueueState(next);
      replaceQueuedSentImages(activeTask.id, message, "", []);
    }
    catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
    finally { setQueueMutationBusy(false); }
  }

  async function compactSession(instructions?: string) {
    if (!activeTask) return showNotice(t.noSessions);
    try {
      await window.pfsaa.sessions.compact(activeTask.id, instructions, projectCwd);
      const next = await window.pfsaa.sessions.messages(activeTask.id, projectCwd);
      setMessagesByTask((current) => ({ ...current, [activeTask.id]: next as any[] }));
      showNotice(t.contextCompacted);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = /Compaction cancelled/i.test(message);
      showNotice(cancelled ? t.contextCompactionCancelled : message, cancelled ? "info" : "error");
    }
  }

  async function exportSession(format: "jsonl" | "html", outputPath?: string) {
    if (!activeTask) return showNotice(t.noSessions);
    try {
      const result = await window.pfsaa.sessions.export(activeTask.id, format, projectCwd, outputPath);
      if (!result) return;
      showNotice(`${t.exportedTo} ${result.path}${result.reviewPath ? ` · ${t.exportedReviewCompanion}: ${result.reviewPath}` : ""}`);
    } catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
  }

  function openContextMenu(task: TaskSummary, x: number, y: number) {
    setProjectContextMenu(null);
    setContextMenu({ task, x: Math.max(8, Math.min(x, window.innerWidth - 174)), y: Math.max(8, Math.min(y, window.innerHeight - 58)) });
  }

  function openProjectContextMenu(project: ProjectSummary, x: number, y: number) {
    setContextMenu(null);
    setProjectContextMenu({ project, x: Math.max(8, Math.min(x, window.innerWidth - 174)), y: Math.max(8, Math.min(y, window.innerHeight - 58)) });
  }

  function dispatchExtensionInput(data: string, element?: HTMLTextAreaElement) {
    if (!activeTask) return;
    const taskId = activeTask.id;
    const cwd = projectCwd;
    const customEditorActive = Boolean(activeTaskUi?.extensionEditor?.active);
    const run = async () => {
      try {
        const result = await window.pfsaa.extensions.dispatchInput(taskId, data, cwd);
        if (result.consume || customEditorActive) return;
        const nextData = result.data ?? data;
        if (!element?.isConnected) return;
        const start = element.selectionStart;
        const end = element.selectionEnd;
        const commit = (value: string, cursor: number) => {
          element.value = value;
          element.setSelectionRange(cursor, cursor);
          updateComposer(value);
        };
        if (nextData === "\r") { void sendPrompt(element.value); return; }
        if (nextData === "\x7f") {
          const from = start === end && start > 0 ? start - 1 : start;
          commit(`${element.value.slice(0, from)}${element.value.slice(end)}`, from);
          return;
        }
        if (nextData === "\x1b[3~") {
          const to = start === end ? Math.min(element.value.length, end + 1) : end;
          commit(`${element.value.slice(0, start)}${element.value.slice(to)}`, start);
          return;
        }
        if (nextData === "\t" || nextData === "\n" || (nextData.length === 1 && nextData >= " ")) {
          commit(`${element.value.slice(0, start)}${nextData}${element.value.slice(end)}`, start + nextData.length);
        }
      } catch (error) {
        showNotice(error instanceof Error ? error.message : String(error), "error");
      }
    };
    extensionInputQueueRef.current = extensionInputQueueRef.current.then(run, run);
  }
  dispatchExtensionInputRef.current = dispatchExtensionInput;

  const composerProps = {
    sessionKey: activeTask?.id ?? projectCwd,
    value: composer,
    onChange: updateComposer,
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
      const terminalData = domKeyToTerminalInput(event.nativeEvent);
      if (terminalData && (activeTaskUi?.extensionEditor?.active || activeTaskUi?.extensionTerminalInputActive)) {
        event.preventDefault();
        event.stopPropagation();
        dispatchExtensionInput(terminalData, event.currentTarget instanceof HTMLTextAreaElement ? event.currentTarget : undefined);
        return;
      }
      if (event.key === "Tab" && activeTaskUi?.extensionAutocomplete?.active && (!suggestionMode || suggestions.length === 0)) {
        event.preventDefault();
        requestExtensionAutocomplete(event.currentTarget.value, event.currentTarget.selectionStart, true);
        return;
      }
      if (matchesAgentCoreKeybinding(event, agentCoreKeybindings, "app.editor.external")) { event.preventDefault(); void editComposerExternally(); return; }
      if (matchesAgentCoreKeybinding(event, agentCoreKeybindings, "app.thinking.cycle")) {
        event.preventDefault();
        const current = Math.max(0, thinkingLevels.indexOf(thinkingLevel));
        void chooseThinking(thinkingLevels[(current + 1) % thinkingLevels.length] ?? "off");
        return;
      }
      if (matchesAgentCoreKeybinding(event, agentCoreKeybindings, "app.model.cycleForward") || matchesAgentCoreKeybinding(event, agentCoreKeybindings, "app.model.cycleBackward")) {
        event.preventDefault();
        void cycleModel(matchesAgentCoreKeybinding(event, agentCoreKeybindings, "app.model.cycleBackward") ? "backward" : "forward");
        return;
      }
      if (matchesAgentCoreKeybinding(event, agentCoreKeybindings, "app.model.select")) { event.preventDefault(); setModelMenuOpen(true); setThinkingMenuOpen(false); return; }
      if (suggestionMode && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setSuggestionIndex((current) => Math.max(0, Math.min(suggestions.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))); return; }
      if (suggestionMode && suggestions.length && (event.key === "Tab" || event.key === "Enter")) { event.preventDefault(); applySuggestion(suggestions[suggestionIndex] ?? suggestions[0]); return; }
      if (event.key === "Escape") { if (suggestionMode) setSuggestionMode(null); else if (queueEdit) cancelQueueEdit(); return; }
      if (!suggestionMode && event.key === "ArrowUp" && event.currentTarget.selectionStart === event.currentTarget.selectionEnd && event.currentTarget.value.lastIndexOf("\n", event.currentTarget.selectionStart - 1) < 0 && recallComposerHistory("previous")) { event.preventDefault(); return; }
      if (!suggestionMode && event.key === "ArrowDown" && event.currentTarget.selectionStart === event.currentTarget.selectionEnd && event.currentTarget.value.indexOf("\n", event.currentTarget.selectionEnd) < 0 && recallComposerHistory("next")) { event.preventDefault(); return; }
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendPrompt(); }
    },
    onPaste: handleComposerPaste,
    onDropImages: (files: File[]) => appendComposerImages(files, "dropped-image"),
    onExternalEdit: () => void editComposerExternally(),
    externalEditing,
    externalEditorShortcut: firstAgentCoreKeybinding(agentCoreKeybindings, "app.editor.external"),
    onSend: () => void sendPrompt(),
    onStop: () => void abortActive(),
    isSending: isWorking,
    language,
    activeModel,
    modelOptions,
    thinkingLevel,
    thinkingLevels,
    thinkingMenuOpen,
    modelMenuOpen,
    suggestionMode,
    suggestions,
    suggestionIndex,
    onThinkingMenu: () => { setThinkingMenuOpen((current) => !current); setModelMenuOpen(false); },
    onModelMenu: () => { setModelMenuOpen((current) => !current); setThinkingMenuOpen(false); },
    onThinking: chooseThinking,
    onModel: chooseModel,
    onSuggestion: applySuggestion,
    contextUsage,
    commandNames,
    customEditorActive: activeTaskUi?.extensionEditor?.active === true,
    customEditorLines: activeTaskUi?.extensionEditor?.lines,
    onCustomEditorPaste: handleCustomEditorPaste,
    attachments: composerImages,
    onRemoveAttachment: (id: string) => setComposerImages((current) => current.filter((image) => image.id !== id)),
    onPreviewImage: handlePreviewImage,
    onContextMenuImage: openImageContextMenu,
    queueDelivery,
    queueState,
    queueMutationBusy,
    queueEdit: queueEdit ? { messageId: queueEdit.message.id, delivery: queueEdit.delivery } : null,
    onQueueDelivery: setQueueDelivery,
    onQueueModes: setQueueModes,
    onClearQueue: clearQueue,
    onPromoteQueue: (index: number) => void promoteQueuedMessage(index),
    onEditQueue: beginQueueEdit,
    onDeleteQueue: (message: AgentQueuedMessage) => void deleteQueuedMessage(message),
    onCancelQueueEdit: cancelQueueEdit,
  };

  async function resolveExtensionUi(value: string | boolean | undefined) {
    if (!extensionUiRequest) return;
    try {
      await window.pfsaa.extensions.resolveUi(extensionUiRequest.requestId, value);
      setExtensionUiRequest(null);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function sendExtensionUiInput(data: string) {
    if (!extensionUiRequest) return;
    try {
      await window.pfsaa.extensions.sendUiInput(extensionUiRequest.requestId, data);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    language, setLanguage, theme, themePreference,
    cycleTheme: () => { if (activeTask) patchTaskUi(activeTask.id, { extensionTheme: undefined }); cycleTheme(); },
    projectCwd, projects, expandedProjectCwds, tasks,
    projectTasksByCwd, projectTaskLoads, activeTask, initialLoading, projectSwitching, runtimeStatus, shortcut, t, isMac,
    sidebarRef, searchInputRef, mobileSidebarOpen, setMobileSidebarOpen, searchQuery, setSearchQuery, createTask, createTaskForProject, chooseProjectDirectory,
    selectProject, openProjectContextMenu, selectTask, openContextMenu, loadProjectSessions,
    loadInitialData, restartHost, scrollPositionsRef, scrollHandleRef, handleTimelineAtEnd, activeProject, loadError, messageLoad, messages, isWorking, streamText,
    workingPhase, activeTaskUi, steeringMessageKeysByTask, showJumpToLatest, permissionStatus, modelOptions, capabilities, changeReview,
    transcriptSearchOpen, transcriptSearchQuery, transcriptSearchRequest, transcriptSearchResult,
    setTranscriptSearchOpen, updateTranscriptQuery, stepTranscriptSearch, closeTranscriptSearch, setTranscriptSearchResult,
    composerProps, jumpToLatest, sendPrompt, abortActive,
    paletteCommands, composer, updateComposer, compactSession, exportSession, selectPaletteCommand,
    quickSettingsOpen, quickSettingsPage, setQuickSettingsOpen, openQuickSettings,
    commandDialog, setCommandDialog, renameOpen, setRenameOpen, resumeOpen, setResumeOpen, sessionBranchMode, sessionTreeSnapshot, sessionBranchSkipPrompt, sessionTreeLoading, sessionTreeBusy, sessionTreeError, trustOpen, setTrustOpen, trustProject, trustStatus, trustBusy, scopedModelsOpen, setScopedModelsOpen,
    importSession, renameSession, openProjectTrust, resolveTrust, saveScopedModels,
    notices, dismissNotice, contextMenu, projectContextMenu, pendingDelete, pendingProjectRemove, deletingTaskId,
    removingProjectCwd, extensionUiRequest, settingsOpen, agentCoreSettingsOpen, providerFocus, previewImage,
    imageContextMenu, setPendingDelete, setPendingProjectRemove, setContextMenu, setProjectContextMenu,
    setSettingsOpen, setAgentCoreSettingsOpen, setProviderFocus, setPreviewImage, setImageContextMenu,
    setExtensionUiRequest,
    deleteTask, removeProject, refreshModels, showNotice, resolveExtensionUi, sendExtensionUiInput, handlePermissionStatus, patchTaskUi,
    updateTaskLists, setMessageReload, openImageContextMenu,
    openProviderSettings,
    openSessionBranch, closeSessionBranch, loadSessionTree, forkSession, cloneSession, navigateSessionTree, abortSessionTreeOperation,
  };
}

export type AppController = ReturnType<typeof useAppController>;
