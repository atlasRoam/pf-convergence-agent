import type { ProjectSummary, TaskSummary } from "@pfsaa/domain";
import { z } from "zod";

export type AuthMethod = "api-key" | "oauth";
export type ProviderAuthSource = "stored" | "environment" | "models-json" | "runtime" | "external" | "none";
export type PermissionMode = "ask" | "allow" | "deny" | "yolo";
export type AppLanguage = "zh" | "en";
export type WindowTheme = "light" | "dark";

// Main-only native application menu; coordinates are Renderer CSS pixels.
export const applicationMenuRequestSchema = z.object({
  menu: z.enum(["all", "edit", "view", "help"]),
  x: z.number().finite().min(0).max(100_000),
  y: z.number().finite().min(0).max(100_000),
}).strict();
export type ApplicationMenuRequest = z.infer<typeof applicationMenuRequestSchema>;

export interface PermissionStatus {
  mode: PermissionMode;
  source: "pi-permission-system" | "pfsaa-fallback";
  configPath?: string;
}

export interface PromptImage {
  data: string;
  mimeType: string;
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface ProviderSummary {
  id: string;
  name: string;
  authState: "configured" | "available" | "expired" | "missing";
  authMethod?: AuthMethod | null;
  /** Effective source only; this deliberately never contains a credential or environment variable name. */
  authSource: ProviderAuthSource;
  /** Whether AgentCore has a locally stored credential that this desktop may remove. */
  hasStoredCredential: boolean;
  authMethods: AuthMethod[];
  modelCount: number;
  /** Only Providers created from this desktop own a removable models.json entry. */
  isCustom: boolean;
  /** Locally configured, OpenAI-compatible models.json entry; independent of deletion ownership. */
  isEditable: boolean;
  /** Present only for editable Providers; never includes credentials or model secrets. */
  baseUrl?: string;
  models?: ProviderModelDefinition[];
}

export interface ProviderModelDefinition {
  id: string;
  name: string;
}

export interface ProviderDiscoveryInput {
  baseUrl: string;
  providerId?: string;
  apiKey?: string;
}

export interface ProviderCreateInput {
  name: string;
  baseUrl: string;
  models: ProviderModelDefinition[];
  /** Sent directly to PfsaaHost and stored only by AgentCore's credential store. */
  apiKey: string;
}

export interface ProviderUpdateInput {
  providerId: string;
  name: string;
  baseUrl: string;
  models: ProviderModelDefinition[];
}

export interface ProviderRemovalResult {
  providerId: string;
  action: "removed" | "hidden";
}

export interface ModelSummary {
  id: string;
  providerId: string;
  providerName: string;
  name: string;
  reasoning: boolean;
  thinkingLevels: string[];
  authConfigured: boolean;
}

export interface ScopedModelSelection {
  providerId: string;
  modelId: string;
  thinkingLevel?: string;
}

export interface ModelCycleState {
  model?: ModelSummary;
  thinkingLevel: string;
  thinkingLevels: string[];
  contextUsage?: ContextUsage;
}

export interface SessionCapabilities {
  /** Whether the current Host exposes the per-run Git review surface. */
  changeReviewEnabled: boolean;
  extensionShortcuts?: Array<{ key: string; description?: string }>;
  model?: ModelSummary;
  thinkingLevel: string;
  thinkingLevels: string[];
  slashCommands: Array<{ name: string; description?: string; argumentHint?: string; source?: "extension" }>;
  prompts: Array<{ name: string; description?: string }>;
  skills: Array<{ name: string; description?: string }>;
  contextUsage?: ContextUsage;
  scopedModels?: ScopedModelSelection[];
}

export interface AgentCoreSessionStats {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: ContextUsage;
}

export type SessionTreeEntryRole = "user" | "assistant" | "tool" | "system" | "other";

export interface SessionTreeEntrySummary {
  id: string;
  parentId: string | null;
  type: string;
  role: SessionTreeEntryRole;
  preview: string;
  label?: string;
  timestamp?: string;
  depth: number;
  childCount: number;
  active: boolean;
  current: boolean;
  forkable: boolean;
}

export interface SessionTreeSnapshot {
  entries: SessionTreeEntrySummary[];
  leafId: string | null;
  truncated: boolean;
}

export interface SessionBranchResult {
  cancelled: boolean;
  task?: TaskSummary;
  editorText?: string;
}

export interface SessionRunRecord {
  id: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export type SessionChangeFileStatus = "added" | "modified" | "deleted" | "renamed";
export type SessionChangeHunkResolutionAction = "accepted" | "reverted" | "merged";

export interface SessionChangeHunkResolution {
  hunkIndex: number;
  action: SessionChangeHunkResolutionAction;
  resolvedAt: number;
}

export interface SessionChangeFile {
  path: string;
  previousPath?: string;
  status: SessionChangeFileStatus;
  additions: number;
  deletions: number;
  patch?: string;
  patchAvailable: boolean;
  binary: boolean;
  truncated: boolean;
  oldMode?: string;
  newMode?: string;
  hunkResolutions?: SessionChangeHunkResolution[];
}

export interface SessionChangeReviewMergeSource {
  reviewId: string;
  filePath: string;
  originalContent: string;
  currentContent: string;
  currentRevision: string;
  unresolvedHunks: number[];
  originalExists: boolean;
  currentExists: boolean;
  lineEnding: "lf" | "crlf";
}

export interface SessionChangeReview {
  schemaVersion: 2;
  id: string;
  state: "running" | "completed";
  outcome?: "succeeded" | "failed" | "aborted";
  startedAt: number;
  endedAt: number;
  files: SessionChangeFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
  fileCountTruncated: boolean;
  omittedFiles?: number;
}

export type SessionChangeReviewAvailability = "available" | "not-git" | "error";
export type SessionChangeReviewUnavailableReason =
  | "git-not-found"
  | "git-timeout"
  | "git-inspection-failed"
  | "diff-api-unavailable"
  | "review-data-invalid"
  | "review-storage-failed";

export interface SessionChangeReviewCollection {
  availability: SessionChangeReviewAvailability;
  reason?: SessionChangeReviewUnavailableReason;
  reviews: SessionChangeReview[];
}

export interface ImportedSessionSummary {
  id: string;
  title: string;
  projectId: string;
  state: TaskSummary["state"];
  model: string;
  updatedAt: string;
}

export type QueueDelivery = "steer" | "followUp";

export interface AgentPromptResult {
  disposition: "completed" | "queued" | "extension-command";
}
export type QueueMode = "all" | "one-at-a-time";

export interface AgentQueuedMessage {
  id: string;
  text: string;
  images: PromptImage[];
}

export interface AgentQueueState {
  steering: AgentQueuedMessage[];
  followUp: AgentQueuedMessage[];
  steeringMode: QueueMode;
  followUpMode: QueueMode;
}

export type ExternalEditorSource = "project" | "user" | "visual" | "editor" | "default";

export type AgentCoreDefaultProjectTrust = "ask" | "always" | "never";

export interface AgentCoreThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

export type AgentCoreThinkingBudgetsPatch = AgentCoreThinkingBudgets;

export interface AgentCoreSettingsSummary {
  retryEnabled?: boolean;
  retryMaxRetries?: number;
  retryBaseDelayMs?: number;
  providerRetryTimeoutMs?: number;
  providerRetryMaxRetries?: number;
  providerRetryMaxRetryDelayMs?: number;
  compactionReserveTokens?: number;
  compactionKeepRecentTokens?: number;
  branchSummaryReserveTokens?: number;
  /** Skip AgentCore's interactive "Summarize branch?" confirmation prompt. */
  branchSummarySkipPrompt?: boolean;
  httpProxy?: string;
  httpProxyHasCredentials?: boolean;
  httpIdleTimeoutMs?: number;
  websocketConnectTimeoutMs?: number;
  defaultTools?: string[] | null;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel: string;
  /** Per-model startup thinking overrides owned by AgentCore SettingsManager. */
  modelThinkingLevels?: Record<string, string>;
  thinkingBudgets?: AgentCoreThinkingBudgets | null;
  imageAutoResize?: boolean;
  blockImages?: boolean;
  defaultProjectTrust?: AgentCoreDefaultProjectTrust;
  shellPath?: string;
  shellCommandPrefix?: string;
  npmCommand?: string[] | null;
  sessionDir?: string;
  enableSkillCommands?: boolean;
  enableInstallTelemetry?: boolean;
  transport: "auto" | "sse" | "websocket" | "websocket-cached";
  compactionEnabled: boolean;
  steeringMode: QueueMode;
  followUpMode: QueueMode;
  externalEditor?: string;
  effectiveExternalEditor: string;
  externalEditorSource: ExternalEditorSource;
}

export type AgentCoreSettingsUpdate = Partial<Pick<AgentCoreSettingsSummary,
  | "retryEnabled" | "retryMaxRetries" | "retryBaseDelayMs"
  | "providerRetryTimeoutMs" | "providerRetryMaxRetries" | "providerRetryMaxRetryDelayMs"
  | "compactionReserveTokens" | "compactionKeepRecentTokens"
  | "branchSummaryReserveTokens"
  | "branchSummarySkipPrompt"
  | "httpProxy" | "httpIdleTimeoutMs" | "websocketConnectTimeoutMs" | "defaultTools"
  | "defaultProvider"
  | "defaultModel"
  | "defaultThinkingLevel"
  | "imageAutoResize" | "blockImages" | "defaultProjectTrust"
  | "shellPath" | "shellCommandPrefix" | "npmCommand" | "sessionDir"
  | "enableSkillCommands" | "enableInstallTelemetry"
  | "transport"
  | "compactionEnabled"
  | "steeringMode"
  | "followUpMode"
  | "externalEditor"
>> & {
  /** Incremental per-model overrides; null removes the AgentCore setting. */
  modelThinkingLevels?: Record<string, string | null>;
  thinkingBudgets?: AgentCoreThinkingBudgetsPatch | null;
};

export type ExtensionUiRequestKind = "select" | "confirm" | "input" | "editor" | "custom";

export interface ExtensionThemeSnapshot {
  name?: string;
  appearance: "light" | "dark";
  colors: Partial<Record<"accent" | "text" | "muted" | "line" | "green" | "red" | "amber" | "selection-bg", string>>;
}

export interface ExtensionUiRequest {
  requestId: string;
  taskId: string;
  kind: ExtensionUiRequestKind;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeoutMs?: number;
  /** Rendered terminal-style lines for a custom AgentCore extension UI. */
  lines?: string[];
}

export interface ExtensionInputDispatchResult {
  consume: boolean;
  data?: string;
}

export interface ExtensionAutocompleteItem {
  value: string;
  label: string;
  description?: string;
  /** Complete editor state produced by AgentCore's registered provider. */
  text: string;
  cursor: number;
}

export interface ExtensionAutocompleteResult {
  prefix: string;
  items: ExtensionAutocompleteItem[];
}

export interface AgentCorePackageSummary {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  disabled: boolean;
  installedPath?: string;
  updateAvailable?: boolean;
  resources: AgentCorePackageResourceSummary[];
}

export type AgentCorePackageResourceType = "extension" | "skill" | "prompt" | "theme";

export interface AgentCorePackageResourceSummary {
  type: AgentCorePackageResourceType;
  path: string;
  enabled: boolean;
}

export interface WorkspaceFile {
  path: string;
  kind: "file" | "directory";
  size?: number;
}

export interface WorkspaceChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface WorkspaceSnapshot {
  cwd: string;
  files: WorkspaceFile[];
  changes: WorkspaceChange[];
  refreshedAt: string;
}

export type AgentCoreKeybindings = Record<string, string[]>;

export type ProjectTrustSource = "not-required" | "saved" | "inherited" | "default";

export interface ProjectTrustStatus {
  cwd: string;
  hasTrustRequiringResources: boolean;
  trusted: boolean;
  source: ProjectTrustSource;
  sourcePath?: string;
  defaultPolicy: "ask" | "always" | "never";
}

export interface PfsaaBridge {
  app: {
    popupMenu(request: ApplicationMenuRequest): Promise<void>;
    setLanguage(language: AppLanguage): Promise<void>;
    setWindowTheme(theme: WindowTheme): Promise<void>;
    quit(): Promise<void>;
    setConfirmClose(enabled: boolean): Promise<void>;
    restartHost(): Promise<void>;
    onConfirmCloseChanged(listener: (enabled: boolean) => void): void;
    offConfirmCloseChanged(listener: (enabled: boolean) => void): void;
  };
  runtime: {
    status(): Promise<"connected" | "starting" | "disconnected">;
  };
  projects: {
    list(preferredCwd?: string): Promise<ProjectSummary[]>;
    chooseDirectory(): Promise<ProjectSummary | null>;
    remove(cwd: string): Promise<void>;
    trustStatus(cwd: string): Promise<ProjectTrustStatus>;
    setTrust(cwd: string, trusted: boolean): Promise<ProjectTrustStatus>;
  };
  sessions: {
    list(projectId?: string): Promise<TaskSummary[]>;
    create(input?: { cwd?: string; name?: string }): Promise<TaskSummary>;
    delete(taskId: string, cwd?: string): Promise<void>;
    messages(taskId: string, cwd?: string): Promise<unknown[]>;
    runMetadata(taskId: string, cwd?: string): Promise<SessionRunRecord[]>;
    changeReviews(taskId: string, cwd?: string): Promise<SessionChangeReviewCollection>;
    changeReview(taskId: string, reviewId: string, cwd?: string): Promise<SessionChangeReview | null>;
    resolveChangeReviewHunk(taskId: string, reviewId: string, filePath: string, hunkIndex: number, action: "accept" | "revert", cwd?: string): Promise<SessionChangeReview>;
    changeReviewMergeSource(taskId: string, reviewId: string, filePath: string, cwd?: string): Promise<SessionChangeReviewMergeSource>;
    applyChangeReviewMerge(taskId: string, reviewId: string, filePath: string, content: string, currentRevision: string, cwd?: string): Promise<SessionChangeReview>;
    capabilities(taskId?: string, cwd?: string): Promise<SessionCapabilities>;
    compact(taskId: string, instructions?: string, cwd?: string): Promise<unknown>;
    reload(taskId: string, cwd?: string): Promise<SessionCapabilities>;
    export(taskId: string, format: "jsonl" | "html", cwd?: string, outputPath?: string): Promise<{ path: string; reviewPath?: string } | null>;
    import(taskId: string | undefined, cwd?: string): Promise<ImportedSessionSummary | null>;
    rename(taskId: string, name: string, cwd?: string): Promise<string>;
    generateTitle(taskId: string, message: string, cwd?: string, model?: { providerId: string; modelId: string }): Promise<string | null>;
    stats(taskId: string, cwd?: string): Promise<AgentCoreSessionStats>;
    share(taskId: string, cwd?: string): Promise<{ url: string; gistUrl: string }>;
    tree(taskId: string, cwd?: string): Promise<SessionTreeSnapshot>;
    fork(taskId: string, entryId: string, cwd?: string): Promise<SessionBranchResult>;
    clone(taskId: string, cwd?: string): Promise<SessionBranchResult>;
    navigateTree(taskId: string, entryId: string, options?: { summarize?: boolean; customInstructions?: string }, cwd?: string): Promise<SessionBranchResult>;
    changelog(): Promise<string>;
  };
  models: {
    list(): Promise<ModelSummary[]>;
    refresh(): Promise<ModelSummary[]>;
  };
  workspace: {
    snapshot(cwd: string): Promise<WorkspaceSnapshot>;
  };
  input: {
    keybindings(cwd?: string): Promise<AgentCoreKeybindings>;
    externalEdit(content: string, cwd?: string): Promise<string>;
  };
  providers: {
    list(): Promise<ProviderSummary[]>;
    listHidden(): Promise<ProviderSummary[]>;
    discoverModels(input: ProviderDiscoveryInput): Promise<ProviderModelDefinition[]>;
    create(input: ProviderCreateInput): Promise<ProviderSummary>;
    update(input: ProviderUpdateInput): Promise<ProviderSummary>;
    remove(providerId: string): Promise<ProviderRemovalResult>;
    restore(providerId: string): Promise<void>;
    login(providerId: string, method: AuthMethod, secret?: string, authOperationId?: string): Promise<void>;
    cancelLogin(authOperationId: string): Promise<void>;
    logout(providerId: string): Promise<void>;
    setApiKey(providerId: string, apiKey: string): Promise<void>;
    resolveAuth(requestId: string, value: string, cancelled?: boolean): Promise<void>;
    openAuthUrl(url: string): Promise<void>;
  };
  agent: {
    prompt(taskId: string, text: string, cwd?: string, images?: PromptImage[], delivery?: QueueDelivery): Promise<AgentPromptResult>;
    executeBash(taskId: string, command: string, excludeFromContext?: boolean, cwd?: string): Promise<{ output: string; exitCode: number | null; cancelled: boolean }>;
    abort(taskId: string, cwd?: string): Promise<void>;
    setThinkingLevel(taskId: string, level: string, cwd?: string): Promise<void>;
    setModel(taskId: string, providerId: string, modelId: string, cwd?: string): Promise<void>;
    cycleModel(taskId: string, direction: "forward" | "backward", cwd?: string): Promise<ModelCycleState>;
    setScopedModels(taskId: string, models: ScopedModelSelection[] | null, persist?: boolean, cwd?: string): Promise<ScopedModelSelection[]>;
    queue(taskId: string, cwd?: string): Promise<AgentQueueState>;
    setQueueModes(taskId: string, modes: { steeringMode?: QueueMode; followUpMode?: QueueMode }, cwd?: string): Promise<AgentQueueState>;
    clearQueue(taskId: string, cwd?: string): Promise<AgentQueueState>;
    promoteQueue(taskId: string, followUpIndex: number, cwd?: string): Promise<AgentQueueState>;
    editQueue(taskId: string, messageId: string, text: string, images?: PromptImage[], cwd?: string): Promise<AgentQueueState>;
    deleteQueue(taskId: string, messageId: string, cwd?: string): Promise<AgentQueueState>;
  };
  settings: {
    get(cwd?: string): Promise<AgentCoreSettingsSummary>;
    update(settings: AgentCoreSettingsUpdate, cwd?: string): Promise<AgentCoreSettingsSummary>;
    chooseExternalEditor(): Promise<string | null>;
  };
  extensions: {
    syncEditor(taskId: string, text: string, cwd?: string): Promise<void>;
    invokeShortcut(taskId: string, key: string, text: string, cwd?: string): Promise<void>;
    resolveUi(requestId: string, value: string | boolean | undefined): Promise<void>;
    sendUiInput(requestId: string, data: string): Promise<void>;
    dispatchInput(taskId: string, data: string, cwd?: string): Promise<ExtensionInputDispatchResult>;
    autocomplete(taskId: string, text: string, cursor: number, force?: boolean, cwd?: string): Promise<ExtensionAutocompleteResult | null>;
  };
  packages: {
    list(cwd?: string): Promise<AgentCorePackageSummary[]>;
    install(source: string, local?: boolean, cwd?: string): Promise<void>;
    remove(source: string, local?: boolean, cwd?: string): Promise<void>;
    update(source?: string, cwd?: string): Promise<void>;
    configure(source: string, enabled: boolean, local?: boolean, cwd?: string): Promise<void>;
    configureResource(source: string, type: AgentCorePackageResourceType, path: string, enabled: boolean, local?: boolean, cwd?: string): Promise<void>;
    checkUpdates(cwd?: string): Promise<string[]>;
  };
  events: {
    subscribe(listener: (event: PfsaaRuntimeEvent) => void): () => void;
  };
  approvals: {
    resolve(requestId: string, decision: "allow-once" | "deny"): Promise<void>;
  };
  permissions: {
    status(): Promise<PermissionStatus>;
    setMode(mode: PermissionMode): Promise<PermissionStatus>;
  };
}

export interface PfsaaRuntimeEvent {
  type: "agent.event" | "runtime.status" | "runtime.error" | "auth.event" | "approval.requested" | "approval.resolved" | "extension.ui.request" | "extension.ui.notify";
  taskId?: string;
  requestId?: string;
  event?: unknown;
  payload?: unknown;
}

export type PfsaaHostCommand =
  | "runtime.status"
  | "runtime.shutdown"
  | "app.changelog"
  | "app.info"
  | "projects.list"
  | "projects.trustStatus"
  | "projects.setTrust"
  | "sessions.list"
  | "sessions.create"
  | "sessions.delete"
  | "sessions.messages"
  | "sessions.runMetadata"
  | "sessions.changeReviews"
  | "sessions.changeReview"
  | "sessions.resolveChangeReviewHunk"
  | "sessions.changeReviewMergeSource"
  | "sessions.applyChangeReviewMerge"
  | "sessions.capabilities"
  | "sessions.compact"
  | "sessions.reload"
  | "sessions.export"
  | "sessions.import"
  | "sessions.rename"
  | "sessions.generateTitle"
  | "sessions.stats"
  | "sessions.share"
  | "sessions.tree"
  | "sessions.fork"
  | "sessions.clone"
  | "sessions.navigateTree"
  | "models.list"
  | "models.refresh"
  | "workspace.snapshot"
  | "input.keybindings"
  | "input.externalEdit"
  | "providers.list"
  | "providers.listHidden"
  | "providers.discoverModels"
  | "providers.create"
  | "providers.update"
  | "providers.remove"
  | "providers.restore"
  | "providers.login"
  | "providers.cancelLogin"
  | "providers.setApiKey"
  | "providers.logout"
  | "providers.auth-response"
  | "agent.prompt"
  | "agent.executeBash"
  | "agent.abort"
  | "agent.setThinkingLevel"
  | "agent.setModel"
  | "agent.cycleModel"
  | "agent.setScopedModels"
  | "agent.queue"
  | "agent.setQueueModes"
  | "agent.clearQueue"
  | "agent.promoteQueue"
  | "agent.editQueue"
  | "agent.deleteQueue"
  | "settings.get"
  | "settings.update"
  | "extension.editor.sync"
  | "extension.shortcut.invoke"
  | "extension.ui.resolve"
  | "extension.ui.input"
  | "extension.input.dispatch"
  | "extension.autocomplete"
  | "packages.list"
  | "packages.install"
  | "packages.remove"
  | "packages.update"
  | "packages.configure"
  | "packages.configureResource"
  | "packages.checkUpdates"
  | "approval.resolve"
  | "permissions.status"
  | "permissions.setMode";

export interface PfsaaHostRequest {
  id: string;
  command: PfsaaHostCommand;
  payload?: unknown;
}

export interface PfsaaHostResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const stringList = z.array(z.string());
const promptImages = z.array(z.object({ data: z.string(), mimeType: z.string() }).passthrough());
const modelReference = z.object({ providerId: z.string(), modelId: z.string() }).passthrough();
const scopedModelSelection = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
}).strict();
const thinkingLevel = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const modelThinkingLevelsPatch = z.record(
  z.string().min(1).max(512),
  thinkingLevel.nullable(),
).optional();
const emptyPayload = z.object({}).strict().optional();
const payload = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const pfsaaHostPayloadSchemas = {
  "runtime.status": emptyPayload,
  "runtime.shutdown": emptyPayload,
  "app.changelog": emptyPayload,
  "app.info": emptyPayload,
  "projects.list": payload({ knownCwds: stringList.optional() }),
  "projects.trustStatus": payload({ cwd: z.string() }),
  "projects.setTrust": payload({ cwd: z.string(), trusted: z.boolean() }),
  "sessions.list": payload({ cwd: z.string().optional() }),
  "sessions.create": payload({ cwd: z.string().optional(), name: z.string().optional() }),
  "sessions.delete": payload({ taskId: z.string(), cwd: z.string().optional() }),
  "sessions.messages": payload({ taskId: z.string(), cwd: z.string().optional() }),
  "sessions.runMetadata": payload({ taskId: z.string(), cwd: z.string().optional() }),
  "sessions.changeReviews": payload({ taskId: z.string(), cwd: z.string().optional() }),
  "sessions.changeReview": payload({ taskId: z.string(), reviewId: z.string(), cwd: z.string().optional() }),
  "sessions.resolveChangeReviewHunk": payload({
    taskId: z.string(),
    reviewId: z.string().min(1).max(512),
    filePath: z.string().min(1).max(4096),
    hunkIndex: z.number().int().min(0).max(10_000),
    action: z.enum(["accept", "revert"]),
    cwd: z.string().optional(),
  }),
  "sessions.changeReviewMergeSource": payload({
    taskId: z.string(),
    reviewId: z.string().min(1).max(512),
    filePath: z.string().min(1).max(4096),
    cwd: z.string().optional(),
  }),
  "sessions.applyChangeReviewMerge": payload({
    taskId: z.string(),
    reviewId: z.string().min(1).max(512),
    filePath: z.string().min(1).max(4096),
    content: z.string().max(1_000_000),
    currentRevision: z.string().regex(/^(?:missing|sha256:[a-f\d]{64})$/),
    cwd: z.string().optional(),
  }),
  "sessions.capabilities": payload({ taskId: z.string().optional(), cwd: z.string().optional() }),
  "sessions.compact": payload({ taskId: z.string(), instructions: z.string().optional(), cwd: z.string().optional() }),
  "sessions.reload": payload({ taskId: z.string(), cwd: z.string().optional() }),
  "sessions.export": payload({ taskId: z.string(), format: z.enum(["jsonl", "html"]), cwd: z.string().optional(), outputPath: z.string().min(1).max(4096).optional() }),
  "sessions.import": payload({ taskId: z.string().optional(), inputPath: z.string(), cwd: z.string().optional() }),
  "sessions.rename": payload({ taskId: z.string(), name: z.string(), cwd: z.string().optional() }),
  "sessions.generateTitle": payload({ taskId: z.string(), message: z.string(), cwd: z.string().optional(), model: modelReference.optional() }),
  "sessions.stats": payload({ taskId: z.string(), cwd: z.string().optional() }),
  "sessions.share": payload({ taskId: z.string(), cwd: z.string().optional() }),
  "sessions.tree": payload({ taskId: z.string(), cwd: z.string().optional() }),
  "sessions.fork": payload({ taskId: z.string(), entryId: z.string().min(1).max(512), cwd: z.string().optional() }),
  "sessions.clone": payload({ taskId: z.string(), cwd: z.string().optional() }),
  "sessions.navigateTree": payload({
    taskId: z.string(),
    entryId: z.string().min(1).max(512),
    summarize: z.boolean().optional(),
    customInstructions: z.string().max(20_000).optional(),
    cwd: z.string().optional(),
  }),
  "models.list": emptyPayload,
  "models.refresh": emptyPayload,
  "workspace.snapshot": payload({ cwd: z.string() }),
  "input.keybindings": payload({ cwd: z.string().optional() }),
  "input.externalEdit": payload({ content: z.string().max(1_000_000), cwd: z.string().optional() }),
  "providers.list": emptyPayload,
  "providers.listHidden": emptyPayload,
  "providers.discoverModels": payload({ baseUrl: z.string().min(1).max(2048), providerId: z.string().min(1).max(96).optional(), apiKey: z.string().max(16_384).optional() }),
  "providers.create": payload({ name: z.string().min(1).max(80), baseUrl: z.string().min(1).max(2048), models: z.array(z.object({ id: z.string().min(1).max(200), name: z.string().max(200) }).strict()).min(1).max(200), apiKey: z.string().min(1).max(16_384) }),
  "providers.update": payload({ providerId: z.string().min(1).max(96), name: z.string().min(1).max(80), baseUrl: z.string().min(1).max(2048), models: z.array(z.object({ id: z.string().min(1).max(200), name: z.string().max(200) }).strict()).min(1).max(200) }),
  "providers.remove": payload({ providerId: z.string().min(1).max(96) }),
  "providers.restore": payload({ providerId: z.string().min(1).max(96) }),
  "providers.login": payload({ providerId: z.string(), method: z.enum(["api-key", "oauth"]), secret: z.string().optional(), authOperationId: z.string().optional() }),
  "providers.cancelLogin": payload({ authOperationId: z.string() }),
  "providers.setApiKey": payload({ providerId: z.string(), apiKey: z.string() }),
  "providers.logout": payload({ providerId: z.string() }),
  "providers.auth-response": payload({ requestId: z.string(), value: z.string(), cancelled: z.boolean().optional() }),
  "agent.prompt": payload({ taskId: z.string(), text: z.string().optional(), cwd: z.string().optional(), images: promptImages.optional(), delivery: z.enum(["steer", "followUp"]).optional() }),
  "agent.executeBash": payload({ taskId: z.string(), command: z.string(), excludeFromContext: z.boolean().optional(), cwd: z.string().optional() }),
  "agent.abort": payload({ taskId: z.string(), cwd: z.string().optional() }),
  "agent.setThinkingLevel": payload({ taskId: z.string(), level: z.string(), cwd: z.string().optional() }),
  "agent.setModel": payload({ taskId: z.string(), providerId: z.string(), modelId: z.string(), cwd: z.string().optional() }),
  "agent.cycleModel": payload({ taskId: z.string(), direction: z.enum(["forward", "backward"]), cwd: z.string().optional() }),
  "agent.setScopedModels": payload({ taskId: z.string(), models: z.array(scopedModelSelection).nullable(), persist: z.boolean().optional(), cwd: z.string().optional() }),
  "agent.queue": payload({ taskId: z.string(), cwd: z.string().optional() }),
  "agent.setQueueModes": payload({ taskId: z.string(), steeringMode: z.enum(["all", "one-at-a-time"]).optional(), followUpMode: z.enum(["all", "one-at-a-time"]).optional(), cwd: z.string().optional() }),
  "agent.clearQueue": payload({ taskId: z.string(), cwd: z.string().optional() }),
  "agent.promoteQueue": payload({ taskId: z.string(), followUpIndex: z.number().finite(), cwd: z.string().optional() }),
  "agent.editQueue": payload({ taskId: z.string(), messageId: z.string(), text: z.string(), images: promptImages.optional(), cwd: z.string().optional() }),
  "agent.deleteQueue": payload({ taskId: z.string(), messageId: z.string(), cwd: z.string().optional() }),
  "settings.get": payload({ cwd: z.string().optional() }),
  "settings.update": payload({ cwd: z.string().optional(), defaultProvider: z.string().optional(), defaultModel: z.string().optional(), defaultThinkingLevel: z.string().optional(), modelThinkingLevels: modelThinkingLevelsPatch, transport: z.enum(["auto", "sse", "websocket", "websocket-cached"]).optional(), compactionEnabled: z.boolean().optional(), steeringMode: z.enum(["all", "one-at-a-time"]).optional(), followUpMode: z.enum(["all", "one-at-a-time"]).optional(), externalEditor: z.string().max(1000).optional(),
    retryEnabled: z.boolean().optional(), retryMaxRetries: z.number().int().min(0).max(100).optional(), retryBaseDelayMs: z.number().int().min(0).max(2147483647).optional(),
    providerRetryTimeoutMs: z.number().int().min(0).max(2147483647).optional(), providerRetryMaxRetries: z.number().int().min(0).max(100).optional(), providerRetryMaxRetryDelayMs: z.number().int().min(0).max(2147483647).optional(),
    compactionReserveTokens: z.number().int().positive().max(100000000).optional(), compactionKeepRecentTokens: z.number().int().min(0).max(100000000).optional(),
    branchSummaryReserveTokens: z.number().int().positive().max(100000000).optional(),
    branchSummarySkipPrompt: z.boolean().optional(),
    httpProxy: z.string().max(4096).optional(), httpIdleTimeoutMs: z.number().int().min(0).max(2147483647).optional(), websocketConnectTimeoutMs: z.number().int().min(0).max(2147483647).optional(), defaultTools: z.array(z.string().min(1).max(100)).max(100).nullable().optional(),
    thinkingBudgets: z.object({ minimal: z.number().int().positive().max(100000000).optional(), low: z.number().int().positive().max(100000000).optional(), medium: z.number().int().positive().max(100000000).optional(), high: z.number().int().positive().max(100000000).optional() }).strict().nullable().optional(),
    imageAutoResize: z.boolean().optional(), blockImages: z.boolean().optional(),
    defaultProjectTrust: z.enum(["ask", "always", "never"]).optional(), shellPath: z.string().max(4096).optional(), shellCommandPrefix: z.string().max(4096).optional(), npmCommand: z.array(z.string().min(1).max(4096)).max(100).nullable().optional(), sessionDir: z.string().max(4096).optional(),
    enableSkillCommands: z.boolean().optional(), enableInstallTelemetry: z.boolean().optional(),
  }),
  "extension.editor.sync": payload({ taskId: z.string(), text: z.string().max(1000000), cwd: z.string().optional() }),
  "extension.shortcut.invoke": payload({ taskId: z.string(), key: z.string().min(1).max(100), text: z.string().max(1000000), cwd: z.string().optional() }),
  "extension.ui.resolve": payload({ requestId: z.string(), value: z.union([z.string(), z.boolean()]).optional() }),
  "extension.ui.input": payload({ requestId: z.string(), data: z.string().max(1000) }),
  "extension.input.dispatch": payload({ taskId: z.string(), data: z.string().max(1000000), cwd: z.string().optional() }),
  "extension.autocomplete": payload({ taskId: z.string(), text: z.string().max(1000000), cursor: z.number().int().min(0).max(1000000), force: z.boolean().optional(), cwd: z.string().optional() }),
  "packages.list": payload({ cwd: z.string().optional() }),
  "packages.install": payload({ source: z.string(), local: z.boolean().optional(), cwd: z.string().optional() }),
  "packages.remove": payload({ source: z.string(), local: z.boolean().optional(), cwd: z.string().optional() }),
  "packages.update": payload({ source: z.string().optional(), cwd: z.string().optional() }),
  "packages.configure": payload({ source: z.string(), enabled: z.boolean(), local: z.boolean().optional(), cwd: z.string().optional() }),
  "packages.configureResource": payload({ source: z.string(), type: z.enum(["extension", "skill", "prompt", "theme"]), path: z.string(), enabled: z.boolean(), local: z.boolean().optional(), cwd: z.string().optional() }),
  "packages.checkUpdates": payload({ cwd: z.string().optional() }),
  "permissions.status": emptyPayload,
  "permissions.setMode": payload({ mode: z.enum(["ask", "allow", "deny", "yolo"]) }),
  "approval.resolve": payload({ requestId: z.string(), decision: z.enum(["allow-once", "deny"]) }),
} satisfies Record<PfsaaHostCommand, z.ZodType>;

function payloadValidationMessage(command: PfsaaHostCommand, value: unknown, error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.code === "unrecognized_keys") return `${command} payload contains unknown field: ${issue.keys[0]}`;
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : undefined;
  if (field && (!value || typeof value !== "object" || !(field in value) || (value as Record<string, unknown>)[field] === undefined)) {
    return `${command} requires ${field}`;
  }
  if (field && issue?.code === "invalid_type") {
    const expected = issue.expected === "boolean" ? "a boolean"
      : issue.expected === "string" ? "a string"
        : issue.expected === "number" ? "a finite number"
          : issue.expected;
    return `${field} must be ${expected}`;
  }
  return `${command} payload is invalid: ${z.prettifyError(error)}`;
}

/**
 * Runtime validation for the structured-clone boundary. TypeScript protects
 * PFSAA's own callers, but this boundary also receives JavaScript values from
 * Electron IPC and must reject coercible or unknown shapes explicitly.
 */
export function validatePfsaaHostPayload(command: PfsaaHostCommand, payload: unknown): unknown {
  const schema = pfsaaHostPayloadSchemas[command] as z.ZodType | undefined;
  if (!schema) throw new Error(`Unsupported PfsaaHost command: ${command}`);
  const result = schema.safeParse(payload);
  if (!result.success) throw new Error(payloadValidationMessage(command, payload, result.error));
  return payload;
}
