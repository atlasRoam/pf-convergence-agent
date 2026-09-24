import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session as electronSession, shell, Tray } from "electron";
import { fork as forkNode, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { AppLanguage, PfsaaHostRequest, PfsaaHostResponse, AgentCorePackageResourceType, ProviderCreateInput, ProviderDiscoveryInput, ProviderUpdateInput, ScopedModelSelection, WindowTheme } from "@pfsaa/contracts";
import { applicationTitle, appMenuCopy, copy } from "@pfsaa/i18n";
import { assertKnownProjectCwd, assertTrustedIpcSender } from "./ipc-security";
import { transparentTitleBarOverlay, windowThemeColors } from "./window-theme";
import { buildApplicationMenuTemplate, popupApplicationMenu } from "./application-menu";
import { externalEditorCommandForPath } from "./external-editor";
import { pfsaaHostEnvironment, pfsaaPaths } from "./pfsaa-runtime";

app.setName(applicationTitle);

type RuntimeStatus = "connected" | "starting" | "disconnected";
/**
 * Maps packaged paths out of the asar archive for consumers that cannot read
 * asar, such as the forked system-Node PfsaaHost process and native file APIs.
 * No-op in development where no app.asar segment exists.
 */
function toUnpackedPath(filePath: string): string {
  return filePath.replace(
    `${path.sep}app.asar${path.sep}`,
    `${path.sep}app.asar.unpacked${path.sep}`,
  );
}

let host: ChildProcess | undefined;
// When true (default), closing the last window asks for confirmation before
// quitting. The renderer can opt out via `app:set-confirm-close` (e.g. the
// user ticks "don't ask again" in the native confirm dialog).
let confirmCloseBeforeQuit = true;
let hostAlive = false;
let hostStatus: RuntimeStatus = "starting";
let hostWindow: BrowserWindow | undefined;
let currentLanguage: AppLanguage = app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en";
let currentWindowTheme: WindowTheme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
const applicationIconPath = toUnpackedPath(path.join(__dirname, "../../assets/pfsaa-icon.png"));
const dockIconPath = applicationIconPath;
const nativeRequire = createRequire(__filename);
type MiniwindowAddon = { installMiniwindowCustomization(handle: Buffer, iconPath: string): boolean };
let miniwindowAddon: MiniwindowAddon | undefined;
let tray: Tray | undefined;
const pending = new Map<string, {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}>();

function buildApplicationMenu(language: AppLanguage) {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate(language, app.isPackaged, () => { void showAboutDialog(); })));
}

async function showAboutDialog() {
  const t = appMenuCopy[currentLanguage];
  let agentCoreSdk: string | null = null;
  try {
    const info = await requestHost("app.info") as { version?: string } | string | null;
    agentCoreSdk = typeof info === "string" ? info : (info?.version ?? null);
  } catch {
    // PfsaaHost may be unavailable; the dialog still shows the app versions.
  }
  const detail = t.aboutBody(
    app.getVersion(),
    agentCoreSdk,
  );
  const options: Electron.MessageBoxOptions = {
    type: "info",
    title: t.aboutTitle,
    message: t.aboutTitle,
    detail,
    buttons: [t.close],
    noLink: true,
  };
  void (hostWindow && !hostWindow.isDestroyed()
    ? dialog.showMessageBox(hostWindow, options)
    : dialog.showMessageBox(options));
}

function publishRuntimeStatus(status: RuntimeStatus) {
  hostStatus = status;
  if (hostWindow && !hostWindow.isDestroyed()) {
    void hostWindow.webContents.send("pfsaa:event", { type: "runtime.status", payload: status });
  }
}

function resolveNodeExecutable(): string {
  // Run PfsaaHost on Electron's bundled Node: it satisfies the AgentCore SDK engine
  // requirement (the historical WebIDL/undici conflict no longer applies) and
  // reads the asar archive transparently, so node_modules can stay packed.
  // A system Node cannot read asar, so it is only used when explicitly
  // requested via PFSAA_NODE_EXECUTABLE. PIDECK_NODE_EXECUTABLE remains a
  // compatibility alias for existing development setups.
  const configuredNode = process.env.PFSAA_NODE_EXECUTABLE || process.env.PIDECK_NODE_EXECUTABLE;
  if (configuredNode) return configuredNode;
  return process.execPath;
}

function createPfsaaHostEnvironment(): NodeJS.ProcessEnv {
  const environment = pfsaaHostEnvironment(__dirname);
  return {
    ...environment,
    PFSAA_USE_SYSTEM_PROXY: "1",
    PFSAA_HOST_PROCESS: "1",
    ELECTRON_RUN_AS_NODE: "1",
  };
}

async function resolveProxyForHost(sourceHost: ChildProcess, requestId: string, url: string): Promise<void> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Unsupported proxy target protocol");
    const rules = await electronSession.defaultSession.resolveProxy(parsed.toString());
    if (host === sourceHost && sourceHost.connected) {
      sourceHost.send?.({ type: "proxy.resolve-result", requestId, rules });
    }
  } catch {
    if (host === sourceHost && sourceHost.connected) {
      sourceHost.send?.({ type: "proxy.resolve-result", requestId, error: "System proxy resolution failed" });
    }
  }
}

function startHost(window: BrowserWindow) {
  hostWindow = window;
  if (host && hostAlive) {
    publishRuntimeStatus(hostStatus);
    return;
  }

  publishRuntimeStatus("starting");
  const hostPath = path.join(__dirname, "../../../../packages/pfsaa-host/dist/index.js");
  let environment: NodeJS.ProcessEnv;
  try {
    environment = createPfsaaHostEnvironment();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    publishRuntimeStatus("disconnected");
    void dialog.showMessageBox(window, { type: "error", title: app.getName(), message });
    return;
  }
  const startedHost = forkNode(hostPath, [], {
    execPath: resolveNodeExecutable(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    cwd: pfsaaPaths(__dirname).runtime,
    env: environment,
  });
  host = startedHost;
  hostAlive = true;
  startedHost.stderr?.on("data", (chunk) => {
    if (process.env.PFSAA_DEBUG || process.env.PIDECK_DEBUG) console.error(`[PFSAA Runtime] ${String(chunk).trimEnd()}`);
  });
  startedHost.on("message", (message: PfsaaHostResponse | { type?: string; payload?: unknown; requestId?: string; url?: string }) => {
    // A replaced Host can still flush buffered IPC while it exits. Ignore it:
    // only the current instance may resolve requests or publish runtime state.
    if (host !== startedHost) return;
    if ("type" in message && message.type === "proxy.resolve" && typeof message.requestId === "string" && typeof message.url === "string") {
      void resolveProxyForHost(startedHost, message.requestId, message.url);
      return;
    }
    if (!message || typeof message !== "object" || !("id" in message)) {
      if (message?.type === "runtime.status" && message.payload === "connected") {
        publishRuntimeStatus("connected");
      } else if (message?.type && hostWindow && !hostWindow.isDestroyed()) {
        void hostWindow.webContents.send("pfsaa:event", message);
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(message.error ?? "PfsaaHost request failed"));
  });
  startedHost.on("error", (error) => {
    console.error("PfsaaHost process error", error);
    teardownHost("PfsaaHost process error", startedHost);
  });
  startedHost.on("exit", () => {
    teardownHost("PfsaaHost exited", startedHost);
  });
}

// Reject every pending request and reset the Host so a later restart can
// fork a fresh PfsaaHost. `reason` is only logged here; the runtime status event
// already tells the Renderer the Host is gone.
function teardownHost(reason: string, sourceHost: ChildProcess | undefined = host) {
  if (!sourceHost || host !== sourceHost) return;
  console.warn(`[PfsaaHost] ${reason}`);
  hostAlive = false;
  host = undefined;
  sourceHost.kill();
  publishRuntimeStatus("disconnected");
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error("PfsaaHost disconnected"));
  }
  pending.clear();
}

function requestHost(command: PfsaaHostRequest["command"], payload?: unknown) {
  return new Promise<unknown>((resolve, reject) => {
    if (!host || !hostAlive) {
      reject(new Error("PfsaaHost is not connected"));
      return;
    }
    const id = randomUUID();
    const timeoutMs = command === "providers.login" || command === "sessions.share"
      ? 15 * 60_000
      : command === "runtime.shutdown"
        ? 5_000
      // agent.prompt is event-driven: an interactive turn can run for many
      // minutes and streams progress via agent events. Its completion is
      // signaled by agent_settled, not by the RPC response, so a fixed timeout
      // would only ever misreport a long-but-healthy run as failed. Leave it
      // unbounded; a crashed PfsaaHost still rejects via the exit handler.
      : command === "agent.prompt" || command === "input.externalEdit" || command === "sessions.compact" || command === "sessions.navigateTree" || command === "extension.shortcut.invoke"
        ? 0
        : command.startsWith("packages.")
          ? 10 * 60_000
        : 60_000;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      pending.delete(id);
      reject(new Error(`PfsaaHost request timed out: ${command}`));
    }, timeoutMs) : undefined;
    pending.set(id, { resolve, reject, timer });
    host.send?.({ id, command, payload } satisfies PfsaaHostRequest);
  });
}

function focusHostWindow(): void {
  const window = hostWindow;
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function applyWindowTheme(theme: WindowTheme): void {
  currentWindowTheme = theme;
  const colors = windowThemeColors(theme);
  if (!hostWindow || hostWindow.isDestroyed()) return;
  hostWindow.setBackgroundColor(colors.background);
  if (process.platform !== "darwin") {
    hostWindow.setTitleBarOverlay({ color: transparentTitleBarOverlay, symbolColor: colors.symbol, height: 48 });
  }
}

function optionalKnownProjectCwd(cwd: string | undefined): string | undefined {
  return assertKnownProjectCwd(cwd, [pfsaaPaths(__dirname).runtime]);
}

function requireKnownProjectCwd(cwd: string | undefined): string {
  const known = optionalKnownProjectCwd(cwd);
  if (!known) throw new Error("A project directory is required");
  return known;
}

function registerTrustedIpcHandler(channel: string, listener: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event, hostWindow);
    return listener(event, ...args);
  });
}

function registerIpcHandlers() {
  registerTrustedIpcHandler("app:popup-menu", (_event, request: unknown) => {
    if (process.platform !== "win32" || !hostWindow) throw new Error("The title-bar application menu is available on Windows only");
    return popupApplicationMenu(hostWindow, Menu.getApplicationMenu(), request);
  });
  registerTrustedIpcHandler("app:set-language", (_event, language: AppLanguage) => {
    currentLanguage = language === "en" ? "en" : "zh";
    buildApplicationMenu(currentLanguage);
    updateTrayMenu();
    return currentLanguage;
  });
  registerTrustedIpcHandler("app:set-window-theme", (_event, theme: WindowTheme) => {
    applyWindowTheme(theme === "dark" ? "dark" : "light");
  });
  registerTrustedIpcHandler("app:set-confirm-close", (_event, enabled: boolean) => {
    confirmCloseBeforeQuit = Boolean(enabled);
  });
  registerTrustedIpcHandler("app:restart-host", async () => {
    try { await requestHost("runtime.shutdown"); } catch { /* A crashed Host can still be replaced. */ }
    teardownHost("restart requested");
    if (!hostWindow) return;
    startHost(hostWindow);
    // Resolve only after the replacement process completes a real IPC round
    // trip; a fixed delay can report success before startup actually finishes.
    await requestHost("runtime.status");
    publishRuntimeStatus("connected");
  });
  registerTrustedIpcHandler("app:quit", () => { app.quit(); });
  registerTrustedIpcHandler("runtime:status", () => hostStatus);
  registerTrustedIpcHandler("projects:list", async () => {
    return requestHost("projects.list", { knownCwds: [pfsaaPaths(__dirname).runtime] });
  });
  registerTrustedIpcHandler("projects:choose-directory", async () => {
    throw new Error(appMenuCopy[currentLanguage].fixedWorkspaceOnly);
  });
  registerTrustedIpcHandler("projects:remove", (_event, cwd: string) => {
    requireKnownProjectCwd(cwd);
    throw new Error(appMenuCopy[currentLanguage].fixedWorkspaceCannotRemove);
  });
  registerTrustedIpcHandler("projects:trust-status", (_event, cwd: string) => requestHost("projects.trustStatus", { cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("projects:set-trust", (_event, cwd: string, trusted: boolean) => requestHost("projects.setTrust", { cwd: requireKnownProjectCwd(cwd), trusted }));
  registerTrustedIpcHandler("sessions:list", (_event, projectId?: string) => requestHost("sessions.list", { cwd: requireKnownProjectCwd(projectId) }));
  registerTrustedIpcHandler("sessions:create", (_event, input?: { cwd?: string; name?: string }) => requestHost("sessions.create", { ...input, cwd: requireKnownProjectCwd(input?.cwd) }));
  registerTrustedIpcHandler("sessions:delete", (_event, taskId: string, cwd?: string) => requestHost("sessions.delete", { taskId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:messages", (_event, taskId: string, cwd?: string) => requestHost("sessions.messages", { taskId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:run-metadata", (_event, taskId: string, cwd?: string) => requestHost("sessions.runMetadata", { taskId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:change-reviews", (_event, taskId: string, cwd?: string) => requestHost("sessions.changeReviews", { taskId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:change-review", (_event, taskId: string, reviewId: string, cwd?: string) => requestHost("sessions.changeReview", { taskId, reviewId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:resolve-change-review-hunk", (_event, taskId: string, reviewId: string, filePath: string, hunkIndex: number, action: "accept" | "revert", cwd?: string) => requestHost("sessions.resolveChangeReviewHunk", { taskId, reviewId, filePath, hunkIndex, action, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:change-review-merge-source", (_event, taskId: string, reviewId: string, filePath: string, cwd?: string) => requestHost("sessions.changeReviewMergeSource", { taskId, reviewId, filePath, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:apply-change-review-merge", (_event, taskId: string, reviewId: string, filePath: string, content: string, currentRevision: string, cwd?: string) => requestHost("sessions.applyChangeReviewMerge", { taskId, reviewId, filePath, content, currentRevision, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:capabilities", (_event, taskId?: string, cwd?: string) => requestHost("sessions.capabilities", { taskId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:compact", (_event, taskId: string, instructions?: string, cwd?: string) => requestHost("sessions.compact", { taskId, instructions, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:reload", (_event, taskId: string, cwd?: string) => requestHost("sessions.reload", { taskId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:export", async (_event, taskId: string, format: "jsonl" | "html", cwd?: string, outputPath?: string) => {
    const projectCwd = requireKnownProjectCwd(cwd);
    if (outputPath !== undefined) {
      if (typeof outputPath !== "string" || !outputPath.trim() || outputPath.length > 4096 || /[\0\r\n]/.test(outputPath)) throw new Error("Invalid export path");
      const requested = outputPath.startsWith("~/") ? path.join(app.getPath("home"), outputPath.slice(2)) : path.resolve(projectCwd, outputPath);
      const chosen = await dialog.showSaveDialog({ defaultPath: requested, filters: [{ name: format.toUpperCase(), extensions: [format] }], properties: ["showOverwriteConfirmation", "createDirectory"] });
      if (chosen.canceled || !chosen.filePath) return null;
      outputPath = chosen.filePath;
    }
    return requestHost("sessions.export", { taskId, format, cwd: projectCwd, outputPath });
  });
  registerTrustedIpcHandler("sessions:import", async (_event, taskId?: string, cwd?: string) => {
    const trustedCwd = requireKnownProjectCwd(cwd);
    if (!hostWindow) return null;
    const result = await dialog.showOpenDialog(hostWindow, {
      title: appMenuCopy[currentLanguage].importSession,
      properties: ["openFile"],
      filters: [{ name: appMenuCopy[currentLanguage].sessionJsonl, extensions: ["jsonl"] }, { name: "All files", extensions: ["*"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return requestHost("sessions.import", { taskId, inputPath: result.filePaths[0], cwd: trustedCwd });
  });
  registerTrustedIpcHandler("sessions:rename", (_event, taskId: string, name: string, cwd?: string) => requestHost("sessions.rename", { taskId, name, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:generateTitle", (_event, taskId: string, message: string, cwd?: string, model?: { providerId: string; modelId: string }) => requestHost("sessions.generateTitle", { taskId, message, cwd: requireKnownProjectCwd(cwd), model }));
  registerTrustedIpcHandler("sessions:stats", (_event, taskId: string, cwd?: string) => requestHost("sessions.stats", { taskId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:share", (_event, taskId: string, cwd?: string) => requestHost("sessions.share", { taskId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:tree", (_event, taskId: string, cwd?: string) => requestHost("sessions.tree", { taskId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:fork", (_event, taskId: string, entryId: string, cwd?: string) => requestHost("sessions.fork", { taskId, entryId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:clone", (_event, taskId: string, cwd?: string) => requestHost("sessions.clone", { taskId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:navigate-tree", (_event, taskId: string, entryId: string, options?: { summarize?: boolean; customInstructions?: string }, cwd?: string) => requestHost("sessions.navigateTree", { taskId, entryId, ...options, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("sessions:changelog", () => requestHost("app.changelog"));
  registerTrustedIpcHandler("models:list", () => requestHost("models.list"));
  registerTrustedIpcHandler("models:refresh", () => requestHost("models.refresh"));
  registerTrustedIpcHandler("workspace:snapshot", (_event, cwd: string) => requestHost("workspace.snapshot", { cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("input:keybindings", (_event, cwd?: string) => requestHost("input.keybindings", { cwd: optionalKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("extensions:sync-editor", (_event, taskId: string, text: string, cwd?: string) => requestHost("extension.editor.sync", { taskId, text, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("extensions:invoke-shortcut", (_event, taskId: string, key: string, text: string, cwd?: string) => requestHost("extension.shortcut.invoke", { taskId, key, text, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("extensions:dispatch-input", (_event, taskId: string, data: string, cwd?: string) => requestHost("extension.input.dispatch", { taskId, data, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("extensions:autocomplete", (_event, taskId: string, text: string, cursor: number, force?: boolean, cwd?: string) => requestHost("extension.autocomplete", { taskId, text, cursor, force, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("input:external-edit", (_event, content: string, cwd?: string) => requestHost("input.externalEdit", { content, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("providers:list", () => requestHost("providers.list"));
  registerTrustedIpcHandler("providers:list-hidden", () => requestHost("providers.listHidden"));
  registerTrustedIpcHandler("providers:discover-models", (_event, input: ProviderDiscoveryInput) => requestHost("providers.discoverModels", input));
  registerTrustedIpcHandler("providers:create", (_event, input: ProviderCreateInput) => requestHost("providers.create", input));
  registerTrustedIpcHandler("providers:update", (_event, input: ProviderUpdateInput) => requestHost("providers.update", input));
  registerTrustedIpcHandler("providers:remove", (_event, providerId: string) => requestHost("providers.remove", { providerId }));
  registerTrustedIpcHandler("providers:restore", (_event, providerId: string) => requestHost("providers.restore", { providerId }));
  registerTrustedIpcHandler("providers:login", async (_event, providerId: string, method: "api-key" | "oauth", secret?: string, authOperationId?: string) => {
    await requestHost("providers.login", { providerId, method, secret, authOperationId });
    if (method === "oauth") focusHostWindow();
  });
  registerTrustedIpcHandler("providers:cancel-login", (_event, authOperationId: string) => requestHost("providers.cancelLogin", { authOperationId }));
  registerTrustedIpcHandler("providers:set-api-key", (_event, providerId: string, apiKey: string) => requestHost("providers.setApiKey", { providerId, apiKey }));
  registerTrustedIpcHandler("providers:logout", (_event, providerId: string) => requestHost("providers.logout", { providerId }));
  registerTrustedIpcHandler("providers:auth-response", (_event, requestId: string, value: string, cancelled?: boolean) => requestHost("providers.auth-response", { requestId, value, cancelled }));
  registerTrustedIpcHandler("providers:open-auth-url", async (_event, url: string) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Only http(s) auth URLs can be opened");
    await shell.openExternal(parsed.toString());
  });
  registerTrustedIpcHandler("agent:prompt", (_event, taskId: string, text: string, cwd?: string, images?: Array<{ data: string; mimeType: string }>, delivery?: "steer" | "followUp") => requestHost("agent.prompt", { taskId, text, cwd: requireKnownProjectCwd(cwd), images, delivery }));
  registerTrustedIpcHandler("agent:execute-bash", (_event, taskId: string, command: string, excludeFromContext?: boolean, cwd?: string) => requestHost("agent.executeBash", { taskId, command, excludeFromContext, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("agent:abort", (_event, taskId: string, cwd?: string) => requestHost("agent.abort", { taskId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("agent:set-thinking-level", (_event, taskId: string, level: string, cwd?: string) => requestHost("agent.setThinkingLevel", { taskId, level, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("agent:set-model", (_event, taskId: string, providerId: string, modelId: string, cwd?: string) => requestHost("agent.setModel", { taskId, providerId, modelId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("agent:cycle-model", (_event, taskId: string, direction: "forward" | "backward", cwd?: string) => requestHost("agent.cycleModel", { taskId, direction, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("agent:set-scoped-models", (_event, taskId: string, models: ScopedModelSelection[] | null, persist?: boolean, cwd?: string) => requestHost("agent.setScopedModels", { taskId, models, persist, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("agent:queue", (_event, taskId: string, cwd?: string) => requestHost("agent.queue", { taskId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("agent:set-queue-modes", (_event, taskId: string, modes: { steeringMode?: "all" | "one-at-a-time"; followUpMode?: "all" | "one-at-a-time" }, cwd?: string) => requestHost("agent.setQueueModes", { taskId, cwd: requireKnownProjectCwd(cwd), ...modes }));
  registerTrustedIpcHandler("agent:clear-queue", (_event, taskId: string, cwd?: string) => requestHost("agent.clearQueue", { taskId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("agent:promote-queue", (_event, taskId: string, followUpIndex: number, cwd?: string) => requestHost("agent.promoteQueue", { taskId, followUpIndex, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("agent:edit-queue", (_event, taskId: string, messageId: string, text: string, images?: Array<{ data: string; mimeType: string }>, cwd?: string) => requestHost("agent.editQueue", { taskId, messageId, text, images, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("agent:delete-queue", (_event, taskId: string, messageId: string, cwd?: string) => requestHost("agent.deleteQueue", { taskId, messageId, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("settings:get", (_event, cwd?: string) => requestHost("settings.get", { cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("settings:update", (_event, settings: Record<string, unknown>, cwd?: string) => requestHost("settings.update", { ...settings, cwd: requireKnownProjectCwd(cwd) }));
  registerTrustedIpcHandler("settings:choose-external-editor", async () => {
    if (!hostWindow) return null;
    const result = await dialog.showOpenDialog(hostWindow, {
      title: copy[currentLanguage].agentCoreExternalEditorDialogTitle,
      properties: ["openFile"],
      filters: process.platform === "win32"
        ? [{ name: copy[currentLanguage].agentCoreExternalEditorApplications, extensions: ["exe", "com", "cmd", "bat"] }]
        : undefined,
    });
    const editorPath = result.canceled ? undefined : result.filePaths[0];
    if (!editorPath) return null;
    const isMacApplication = process.platform === "darwin" && path.extname(editorPath).toLowerCase() === ".app";
    try {
      if (!isMacApplication) accessSync(editorPath, fsConstants.X_OK);
    } catch {
      throw new Error(copy[currentLanguage].agentCoreExternalEditorNotExecutable);
    }
    try {
      return externalEditorCommandForPath(editorPath);
    } catch {
      throw new Error(copy[currentLanguage].agentCoreExternalEditorPathUnsupported);
    }
  });
  registerTrustedIpcHandler("extension-ui:resolve", (_event, requestId: string, value: string | boolean | undefined) => requestHost("extension.ui.resolve", { requestId, value }));
  registerTrustedIpcHandler("extension-ui:input", (_event, requestId: string, data: string) => requestHost("extension.ui.input", { requestId, data }));
  registerTrustedIpcHandler("packages:list", (_event, cwd?: string) => requestHost("packages.list", { cwd: optionalKnownProjectCwd(cwd) ?? process.cwd() }));
  registerTrustedIpcHandler("packages:install", (_event, source: string, local?: boolean, cwd?: string) => requestHost("packages.install", { source, local, cwd: local ? requireKnownProjectCwd(cwd) : (optionalKnownProjectCwd(cwd) ?? process.cwd()) }));
  registerTrustedIpcHandler("packages:remove", (_event, source: string, local?: boolean, cwd?: string) => requestHost("packages.remove", { source, local, cwd: local ? requireKnownProjectCwd(cwd) : (optionalKnownProjectCwd(cwd) ?? process.cwd()) }));
  registerTrustedIpcHandler("packages:update", (_event, source?: string, cwd?: string) => requestHost("packages.update", { source, cwd: optionalKnownProjectCwd(cwd) ?? process.cwd() }));
  registerTrustedIpcHandler("packages:configure", (_event, source: string, enabled: boolean, local?: boolean, cwd?: string) => requestHost("packages.configure", { source, enabled, local, cwd: local ? requireKnownProjectCwd(cwd) : (optionalKnownProjectCwd(cwd) ?? process.cwd()) }));
  registerTrustedIpcHandler("packages:configure-resource", (_event, source: string, type: AgentCorePackageResourceType, resourcePath: string, enabled: boolean, local?: boolean, cwd?: string) => requestHost("packages.configureResource", { source, type, path: resourcePath, enabled, local, cwd: local ? requireKnownProjectCwd(cwd) : (optionalKnownProjectCwd(cwd) ?? process.cwd()) }));
  registerTrustedIpcHandler("packages:check-updates", (_event, cwd?: string) => requestHost("packages.checkUpdates", { cwd: optionalKnownProjectCwd(cwd) ?? process.cwd() }));
  registerTrustedIpcHandler("approval:resolve", (_event, requestId: string, decision: "allow-once" | "deny") => requestHost("approval.resolve", { requestId, decision }));
  registerTrustedIpcHandler("permissions:status", () => requestHost("permissions.status"));
  registerTrustedIpcHandler("permissions:set-mode", (_event, mode: "ask" | "allow" | "deny" | "yolo") => requestHost("permissions.setMode", { mode }));
}

function createWindow() {
  const initialWindowColors = windowThemeColors(currentWindowTheme);
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 375,
    minHeight: 520,
    icon: applicationIconPath,
    backgroundColor: initialWindowColors.background,
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 17 } }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: { color: transparentTitleBarOverlay, symbolColor: initialWindowColors.symbol, height: 48 },
        }),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.platform !== "darwin") window.setMenuBarVisibility(false);
  hostWindow = window;
  applyWindowTheme(currentWindowTheme);

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") void shell.openExternal(parsed.toString());
    } catch {
      // Ignore malformed links emitted by model content.
    }
    return { action: "deny" };
  });

  // PFSAA has no in-window navigation surface. Model-authored Markdown and
  // extension content may contain links, so reject every page-initiated
  // navigation and leave explicitly validated HTTP(S) links to the system
  // browser handler above.
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "../../../../dist-renderer/index.html"));
  }
  startHost(window);
  if (process.platform === "darwin") {
    try {
      miniwindowAddon ??= nativeRequire(toUnpackedPath(path.join(__dirname, "../../assets/pfsaa-miniwindow.node"))) as MiniwindowAddon;
      miniwindowAddon.installMiniwindowCustomization(window.getNativeWindowHandle(), applicationIconPath);
    } catch (error) {
      console.warn("Could not customize the minimized window Dock tile", error);
    }
  }
  window.on("closed", () => {
    if (hostWindow === window) hostWindow = undefined;
  });
  createTray();
  // Intercept the close request so we can confirm before quitting. Without this
  // guard the window would destroy itself and `before-quit` would tear down the
  // host mid-task. We only act on the last window; on macOS the app stays alive
  // after close, so a confirm there would be wrong.
  window.on("close", (event) => {
    if (!confirmCloseBeforeQuit || process.platform === "darwin") return;
    event.preventDefault();
    const t = copy[currentLanguage];
    // The async variant supports the "don't ask again" checkbox; the sync
    // variant in this Electron version does not. The promise resolves only
    // after the user responds, by which point we decide whether to destroy.
    void dialog.showMessageBox(window, {
      type: "question",
      buttons: [t.confirmCloseCancel, t.confirmCloseMinimize, t.confirmCloseExit],
      defaultId: 2,
      cancelId: 0,
      message: t.confirmCloseTitle,
      detail: t.confirmCloseBody,
      checkboxLabel: t.confirmCloseDontAsk,
      checkboxChecked: false,
      noLink: true,
    }).then(({ response, checkboxChecked }) => {
      if (checkboxChecked) {
        confirmCloseBeforeQuit = false;
        window.webContents.send("app:confirm-close-changed", false);
      }
      if (response === 1) {
        window.hide();
      } else if (response === 2) {
        window.destroy();
        if (BrowserWindow.getAllWindows().length === 0) app.quit();
      }
    });
  });
}

function showMainWindow() {
  const window = hostWindow ?? BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function updateTrayMenu() {
  if (!tray) return;
  const t = copy[currentLanguage];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t.workspace, click: showMainWindow },
    { type: "separator" },
    {
      label: t.confirmCloseExit,
      click: () => {
        // Destroying first skips the close-confirm dialog, then quit tears down
        // the host via `before-quit`.
        hostWindow?.destroy();
        if (BrowserWindow.getAllWindows().length === 0) app.quit();
      },
    },
  ]));
}

function createTray() {
  if (process.platform === "darwin") return;
  if (!tray) {
    tray = new Tray(applicationIconPath);
    tray.setToolTip(app.getName());
    tray.on("click", showMainWindow);
  }
  updateTrayMenu();
}

app.whenReady().then(() => {
  if (process.platform === "darwin") app.dock?.setIcon(dockIconPath);
  registerIpcHandlers();
  buildApplicationMenu(currentLanguage);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

let hostQuitDrainInProgress = false;
let hostDrainedForQuit = false;
app.on("before-quit", (event) => {
  if (hostQuitDrainInProgress) {
    event.preventDefault();
    return;
  }
  if (!hostDrainedForQuit && host && hostAlive) {
    event.preventDefault();
    hostQuitDrainInProgress = true;
    void requestHost("runtime.shutdown")
      .catch(() => undefined)
      .finally(() => {
        hostQuitDrainInProgress = false;
        hostDrainedForQuit = true;
        app.quit();
      });
    return;
  }
  hostAlive = false;
  host?.kill();
  host = undefined;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(`${applicationTitle} 正在退出`));
  }
  pending.clear();
});
