import type { ExtensionAutocompleteResult, ExtensionInputDispatchResult, PermissionMode, PermissionStatus } from "@pfsaa/contracts";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

export interface PermissionEngineCallbacks {
  emitApproval(requestId: string, taskId: string, toolName: string, args: unknown): void;
  emitEvent(taskId: string, event: unknown): void;
  emitUiRequest?(requestId: string, taskId: string, request: Record<string, unknown>): void;
}

type BeforeToolCall = (context: any, signal?: AbortSignal) => Promise<unknown> | unknown;
type ExtensionKeybindings = { matches(data: string, keybinding: string): boolean };
type CustomUiComponent = {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
  dispose?(): void;
};
type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;
type ComponentFactory = (tui: any, theme: any, data?: any) => CustomUiComponent;
type AutocompleteItem = { value: string; label: string; description?: string };
type AutocompleteProvider = {
  triggerCharacters?: string[];
  getSuggestions(lines: string[], cursorLine: number, cursorCol: number, options: { signal: AbortSignal; force?: boolean }): Promise<{ items: AutocompleteItem[]; prefix: string } | null>;
  applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number };
};
type EditorComponent = CustomUiComponent & {
  getText(): string;
  setText(text: string): void;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  setAutocompleteProvider?: (provider: AutocompleteProvider) => void;
};
type ExtensionUiScope = {
  taskId: string;
  statuses: Map<string, string>;
  terminalHandlers: Set<TerminalInputHandler>;
  autocompleteProvider?: AutocompleteProvider;
  editorFactory?: (tui: any, theme: any, keybindings: ExtensionKeybindings) => EditorComponent;
  editor?: EditorComponent;
  components: Map<string, CustomUiComponent>;
  renderTimers: Map<string, ReturnType<typeof setTimeout>>;
  footerSubscriptions: Set<() => void>;
  disposed: boolean;
};

const COMPONENT_WIDTH = 96;
const CURSOR_MARKER = "\x1b_pi:c\x07";

function sanitizeLines(lines: unknown, maxLines: number, cursor = ""): string[] {
  if (!Array.isArray(lines)) return [];
  return lines.slice(0, maxLines).filter((line): line is string => typeof line === "string").map((line) => stripVTControlCharacters(line.replaceAll(CURSOR_MARKER, cursor)).slice(0, 4096));
}

function textOffset(lines: string[], line: number, column: number): number {
  let offset = 0;
  for (let index = 0; index < line; index += 1) offset += (lines[index]?.length ?? 0) + 1;
  return offset + column;
}

const plainText = (text: string) => text;

// Extension UI contexts are copied with object spread when AgentCore binds them. Keep
// theme access side-effect free and provide the same structural API as AgentCore's
// Theme without leaking terminal ANSI styling into the desktop renderer.
const desktopPlainTextTheme = Object.freeze({
  name: "pfsaa",
  sourcePath: undefined,
  sourceInfo: undefined,
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: plainText,
  italic: plainText,
  underline: plainText,
  inverse: plainText,
  strikethrough: plainText,
  getFgAnsi: (_color: string) => "",
  getBgAnsi: (_color: string) => "",
  getColorMode: () => "truecolor" as const,
  getThinkingBorderColor: (_level: string) => plainText,
  getBashModeBorderColor: () => plainText,
});

function permissionConfigPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent");
  return path.join(agentDir, "extensions", "pi-permission-system", "config.json");
}

function resolvePermissionExtensionPath(): string | undefined {
  if (process.env.PFSAA_PROJECT_ROOT || process.env.PFCA_PROJECT_ROOT) return undefined;
  const candidates = [
    process.env.PFSAA_PERMISSION_EXTENSION || process.env.PIDECK_PERMISSION_EXTENSION,
    path.resolve(process.cwd(), "node_modules/@gotgenes/pi-permission-system/src/index.ts"),
    path.resolve(process.cwd(), "apps/desktop/node_modules/@gotgenes/pi-permission-system/src/index.ts"),
    path.resolve(__dirname, "../../../node_modules/@gotgenes/pi-permission-system/src/index.ts"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate));
}

function readPermissionConfig(): Record<string, unknown> {
  const configPath = permissionConfigPath();
  const raw = readFileSync(configPath, "utf8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if (!raw.endsWith("\\n")) throw error;
    const repaired = JSON.parse(raw.slice(0, -2)) as Record<string, unknown>;
    writeFileSync(configPath, `${JSON.stringify(repaired, null, 2)}\n`, "utf8");
    return repaired;
  }
}

function loadPermissionMode(): PermissionMode {
  try {
    const config = readPermissionConfig() as { yoloMode?: boolean; permission?: Record<string, unknown> };
    if (config.yoloMode) return "yolo";
    const fallback = config.permission?.["*"];
    if (fallback === "allow" || fallback === "ask" || fallback === "deny") {
      const bash = config.permission?.bash;
      if (fallback === "allow" && typeof bash !== "string" && (!bash || typeof bash !== "object" || !Object.hasOwn(bash, "*"))) persistPermissionMode(fallback);
      return fallback;
    }
  } catch {
    // Use PFSAA's safe ask default when no plugin config is available.
  }
  return "ask";
}

function persistPermissionMode(mode: PermissionMode): void {
  const configPath = permissionConfigPath();
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) config = readPermissionConfig();
  const policy = mode === "yolo" ? "ask" : mode;
  const permission = typeof config.permission === "object" && config.permission ? config.permission as Record<string, unknown> : {};
  const bash = typeof permission.bash === "object" && permission.bash ? permission.bash as Record<string, unknown> : {};
  const hasBashFallback = typeof permission.bash === "string" || Object.hasOwn(bash, "*");
  config.permission = { ...permission, "*": policy, ...(!hasBashFallback ? { bash: { "*": policy, ...bash } } : {}) };
  config.yoloMode = mode === "yolo";
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function permissionSource(): PermissionStatus["source"] {
  return resolvePermissionExtensionPath() ? "pi-permission-system" : "pfsaa-fallback";
}

/** AgentCore permission-system adapter; it owns policy persistence and approval waiters, not tool execution. */
export class PermissionEngine {
  private editorTexts = new Map<string, string>();
  private mode: PermissionMode = loadPermissionMode();
  private revisionValue = 0;
  private readonly approvalWaiters = new Map<string, (allow: boolean) => void>();
  private readonly approvalTaskIds = new Map<string, string>();
  private readonly uiWaiters = new Map<string, {
    taskId: string;
    resolve(value: string | boolean | undefined): void;
    timer?: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    onAbort?: () => void;
  }>();
  private readonly customUiWaiters = new Map<string, {
    taskId: string;
    component?: CustomUiComponent;
    pendingInputs: string[];
    handleInput(data: string): void;
    dispose(): void;
    resolve(value: unknown): void;
  }>();
  private readonly extensionUiScopes = new Map<string, ExtensionUiScope>();

  constructor(private readonly callbacks: PermissionEngineCallbacks) {}

  get revision(): number { return this.revisionValue; }

  status(): PermissionStatus {
    return { mode: this.mode, source: permissionSource(), configPath: permissionConfigPath() };
  }

  async setMode(mode: PermissionMode): Promise<PermissionStatus> {
    persistPermissionMode(mode);
    this.mode = mode;
    this.revisionValue += 1;
    if (mode === "allow" || mode === "yolo" || mode === "deny") {
      const decision = mode === "deny" ? "deny" : "allow-once";
      for (const [requestId, resolve] of this.approvalWaiters.entries()) {
        const taskId = this.approvalTaskIds.get(requestId) ?? requestId;
        resolve(decision === "allow-once");
        this.callbacks.emitEvent(taskId, { type: "approval.resolved", requestId, decision, source: "permission-mode" });
      }
      this.approvalWaiters.clear();
      this.approvalTaskIds.clear();
    }
    return this.status();
  }

  async beforeToolCall(taskId: string, context: any, previous: BeforeToolCall | undefined, signal?: AbortSignal, scopeId = taskId): Promise<unknown> {
    const toolName = context.toolCall?.name ?? "unknown";
    if (this.mode === "deny") return { block: true, reason: "Permission mode blocks this tool call." };
    if (this.mode === "allow" || this.mode === "yolo") return undefined;
    const requestId = `${encodeURIComponent(scopeId)}:${context.toolCall?.id ?? Date.now()}`;
    this.callbacks.emitApproval(requestId, taskId, toolName, context.args);
    this.approvalTaskIds.set(requestId, taskId);
    const allowed = await new Promise<boolean>((resolve) => {
      const settled = (allow: boolean) => {
        if (this.approvalWaiters.get(requestId) === settle) this.approvalWaiters.delete(requestId);
        this.approvalTaskIds.delete(requestId);
        resolve(allow);
      };
      const settle = (allow: boolean) => settled(allow);
      this.approvalWaiters.set(requestId, settle);
      if (signal) {
        if (signal.aborted) settle(false);
        else signal.addEventListener("abort", () => settle(false), { once: true });
      }
    });
    if (!allowed) return { block: true, reason: "Permission denied for this tool call." };
    return previous?.(context, signal);
  }

  resolve(requestId: string, decision: "allow-once" | "deny"): void {
    const resolve = this.approvalWaiters.get(requestId);
    if (!resolve) throw new Error(`Unknown approval request: ${requestId}`);
    this.approvalWaiters.delete(requestId);
    this.approvalTaskIds.delete(requestId);
    resolve(decision === "allow-once");
  }

  /** Deny any pending approval/UI waits belonging to a session being torn down so its Promise never hangs. */
  dispose(scopeId: string): void {
    this.editorTexts.delete(scopeId);
    this.disposeExtensionScope(scopeId);
    const prefix = `${encodeURIComponent(scopeId)}:`;
    for (const [requestId, resolve] of this.approvalWaiters.entries()) {
      if (requestId.startsWith(prefix)) {
        this.approvalWaiters.delete(requestId);
        this.approvalTaskIds.delete(requestId);
        resolve(false);
      }
    }
    for (const [requestId, waiter] of this.uiWaiters.entries()) {
      if (requestId.startsWith(prefix)) {
        this.uiWaiters.delete(requestId);
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(undefined);
      }
    }
    for (const [requestId, waiter] of this.customUiWaiters.entries()) {
      if (!requestId.startsWith(prefix)) continue;
      this.customUiWaiters.delete(requestId);
      waiter.dispose();
      waiter.resolve(undefined);
      this.callbacks.emitEvent(waiter.taskId, { type: "extension.ui.dismiss", requestId, reason: "aborted" });
    }
  }

  resolveUi(requestId: string, value: string | boolean | undefined): void {
    const waiter = this.uiWaiters.get(requestId);
    if (!waiter) throw new Error(`Unknown extension UI request: ${requestId}`);
    this.uiWaiters.delete(requestId);
    if (waiter.timer) clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(value);
  }

  /** Forward a terminal-style key sequence to a custom extension component. */
  inputUi(requestId: string, data: string): void {
    const waiter = this.customUiWaiters.get(requestId);
    // The renderer can race the final dismiss event. Treat late input as a
    // harmless no-op instead of surfacing an actionable error for a stale key.
    if (!waiter) return;
    waiter.handleInput(data);
  }

  resetUi(taskId: string): void {
    for (const [requestId, waiter] of this.uiWaiters.entries()) {
      if (waiter.taskId !== taskId) continue;
      this.uiWaiters.delete(requestId);
      if (waiter.timer) clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(undefined);
    }
    for (const [requestId, waiter] of this.customUiWaiters.entries()) {
      if (waiter.taskId !== taskId) continue;
      this.customUiWaiters.delete(requestId);
      waiter.dispose();
      waiter.resolve(undefined);
      this.callbacks.emitEvent(taskId, { type: "extension.ui.dismiss", requestId, reason: "aborted" });
    }
    for (const [scopeId, scope] of this.extensionUiScopes.entries()) {
      if (scope.taskId === taskId) this.disposeExtensionScope(scopeId);
    }
    this.callbacks.emitEvent(taskId, { type: "extension.ui.presentation", action: "reset" });
  }

  private disposeExtensionScope(scopeId: string): void {
    const scope = this.extensionUiScopes.get(scopeId);
    if (!scope) return;
    scope.disposed = true;
    for (const timer of scope.renderTimers.values()) clearTimeout(timer);
    scope.renderTimers.clear();
    for (const component of scope.components.values()) component.dispose?.();
    scope.components.clear();
    for (const unsubscribe of scope.footerSubscriptions) unsubscribe();
    scope.footerSubscriptions.clear();
    scope.editor?.dispose?.();
    scope.editor = undefined;
    scope.terminalHandlers.clear();
    this.extensionUiScopes.delete(scopeId);
  }

  createUi(taskId: string, scopeId = taskId, themes?: { theme: any; getAllThemes(): any[]; getTheme(name: string): any; setTheme(value: any): { success: boolean; error?: string } }, extensionKeybindings?: ExtensionKeybindings, footerData?: { getGitBranch(): string | null; getProviderCount(): number; onBranchChange(callback: () => void): () => void }) {
    const request = <T extends string | boolean | undefined>(kind: "select" | "confirm" | "input" | "editor", payload: Record<string, unknown>, opts?: { signal?: AbortSignal; timeout?: number }) => new Promise<T | undefined>((resolve) => {
      const requestId = `${encodeURIComponent(scopeId)}:extension:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const settle = (value: string | boolean | undefined, reason?: "timeout" | "aborted") => {
        const waiter = this.uiWaiters.get(requestId);
        if (!waiter) return;
        this.uiWaiters.delete(requestId);
        if (waiter.timer) clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.resolve(value);
        if (reason) this.callbacks.emitEvent(taskId, { type: "extension.ui.dismiss", requestId, reason });
      };
      const timeoutMs = typeof opts?.timeout === "number" && Number.isFinite(opts.timeout) && opts.timeout > 0
        ? Math.min(opts.timeout, 2_147_483_647)
        : undefined;
      const fallback = kind === "confirm" ? false : undefined;
      const waiter: (typeof this.uiWaiters extends Map<string, infer V> ? V : never) = {
        taskId,
        resolve: (value) => resolve(value as T),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      };
      if (opts?.signal?.aborted) {
        resolve(fallback as T);
        return;
      }
      if (timeoutMs) waiter.timer = setTimeout(() => settle(fallback, "timeout"), timeoutMs);
      if (opts?.signal) {
        waiter.onAbort = () => settle(fallback, "aborted");
        opts.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.uiWaiters.set(requestId, waiter);
      if (this.callbacks.emitUiRequest) this.callbacks.emitUiRequest(requestId, taskId, { kind, ...payload, ...(timeoutMs ? { timeoutMs } : {}) });
      else {
        settle(fallback);
      }
    });
    let editorText = this.editorTexts.get(scopeId) ?? "";
    let toolsExpanded = false;
    const unsupported = new Set<string>();
    const present = (action: string, payload: Record<string, unknown> = {}) => this.callbacks.emitEvent(taskId, { type: "extension.ui.presentation", action, ...payload });
    const warnUnsupported = (capability: string) => {
      if (unsupported.has(capability)) return;
      unsupported.add(capability);
      this.callbacks.emitEvent(taskId, { type: "extension.ui.unsupported", capability });
    };
    this.disposeExtensionScope(scopeId);
    const scope: ExtensionUiScope = {
      taskId,
      statuses: new Map(),
      terminalHandlers: new Set(),
      components: new Map(),
      renderTimers: new Map(),
      footerSubscriptions: new Set(),
      disposed: false,
    };
    this.extensionUiScopes.set(scopeId, scope);
    const keybindings = extensionKeybindings ?? {
      matches(data: string, keybinding: string): boolean {
        const keys: Record<string, string[]> = {
          "tui.select.up": ["\x1b[A", "\x1bOA"],
          "tui.select.down": ["\x1b[B", "\x1bOB"],
          "tui.select.confirm": ["\r", "\n"],
          "tui.select.cancel": ["\x1b"],
        };
        return keys[keybinding]?.includes(data) ?? false;
      },
    };
    const renderComponent = (key: string, action: "widget" | "header" | "footer" | "editor", maxLines: number, payload: Record<string, unknown> = {}) => {
      if (scope.disposed) return;
      const component = action === "editor" ? scope.editor : scope.components.get(key);
      if (!component) return;
      try {
        present(action, { ...payload, lines: sanitizeLines(component.render(COMPONENT_WIDTH), maxLines, action === "editor" ? "▌" : "") });
      } catch (error) {
        present(action, { ...payload, lines: undefined });
        this.callbacks.emitEvent(taskId, { type: "extension.error", error: error instanceof Error ? error.message : String(error) });
      }
    };
    const scheduleRender = (key: string, action: "widget" | "header" | "footer" | "editor", maxLines: number, payload: Record<string, unknown> = {}) => {
      if (scope.disposed || scope.renderTimers.has(key)) return;
      scope.renderTimers.set(key, setTimeout(() => {
        scope.renderTimers.delete(key);
        renderComponent(key, action, maxLines, payload);
      }, 50));
    };
    const createTui = (key: string, action: "widget" | "header" | "footer" | "editor", maxLines: number, payload: Record<string, unknown> = {}) => ({
      mode: "regular",
      children: [] as unknown[],
      terminal: { rows: 40, columns: COMPONENT_WIDTH, hideCursor() {}, showCursor() {}, setTitle: (title: string) => present("title", { title }) },
      requestRender: () => scheduleRender(key, action, maxLines, payload),
      setFocus: () => undefined,
      addInputListener: (handler: TerminalInputHandler) => { scope.terminalHandlers.add(handler); present("terminal-input", { active: true }); },
      removeInputListener: (handler: TerminalInputHandler) => { scope.terminalHandlers.delete(handler); present("terminal-input", { active: scope.terminalHandlers.size > 0 }); },
      addChild: () => undefined,
      removeChild: () => undefined,
      clear: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      showOverlay: () => ({ hide() {}, show() {}, dispose() {}, isVisible: true }),
    });
    const replaceComponent = (key: string, action: "widget" | "header" | "footer", factory: ComponentFactory | undefined, maxLines: number, payload: Record<string, unknown> = {}) => {
      const old = scope.components.get(key);
      old?.dispose?.();
      scope.components.delete(key);
      const timer = scope.renderTimers.get(key);
      if (timer) clearTimeout(timer);
      scope.renderTimers.delete(key);
      if (!factory) { present(action, { ...payload, lines: undefined }); return; }
      try {
        const component = factory(createTui(key, action, maxLines, payload), themes?.theme ?? desktopPlainTextTheme, action === "footer" ? {
          getGitBranch: () => footerData?.getGitBranch() ?? null,
          getExtensionStatuses: () => new Map(scope.statuses),
          getAvailableProviderCount: () => footerData?.getProviderCount() ?? 0,
          onBranchChange: (callback: () => void) => {
            if (!footerData) return () => undefined;
            const unsubscribe = footerData.onBranchChange(callback);
            scope.footerSubscriptions.add(unsubscribe);
            return () => { scope.footerSubscriptions.delete(unsubscribe); unsubscribe(); };
          },
        } : undefined);
        scope.components.set(key, component);
        renderComponent(key, action, maxLines, payload);
      } catch (error) {
        present(action, { ...payload, lines: undefined });
        this.callbacks.emitEvent(taskId, { type: "extension.error", error: error instanceof Error ? error.message : String(error) });
      }
    };
    const editorTheme = {
      borderColor: plainText,
      selectList: {
        selectedPrefix: plainText,
        selectedText: plainText,
        description: plainText,
        scrollInfo: plainText,
        noMatch: plainText,
      },
    };
    return {
      select: (title: string, options: string[], opts?: { signal?: AbortSignal; timeout?: number }) => request<string>("select", { title, options }, opts),
      confirm: (title: string, message: string, opts?: { signal?: AbortSignal; timeout?: number }) => request<boolean>("confirm", { title, message }, opts),
      input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal; timeout?: number }) => request<string>("input", { title, placeholder }, opts),
      notify: (message: string, type?: string) => this.callbacks.emitEvent(taskId, { type: "extension.ui.notify", message: stripVTControlCharacters(message), level: type ?? "info" }),
      onTerminalInput: (handler: TerminalInputHandler) => { scope.terminalHandlers.add(handler); present("terminal-input", { active: true }); return () => { scope.terminalHandlers.delete(handler); present("terminal-input", { active: scope.terminalHandlers.size > 0 }); }; },
      setStatus: (key: string, text?: string) => {
        const sanitized = text === undefined ? undefined : stripVTControlCharacters(text);
        if (sanitized) scope.statuses.set(key, sanitized); else scope.statuses.delete(key);
        present("status", { key, text: sanitized });
        if (scope.components.has("footer")) scheduleRender("footer", "footer", 12);
      },
      setWorkingMessage: (message?: string) => present("working-message", { message }),
      setWorkingVisible: (visible: boolean) => present("working-visible", { visible }),
      setWorkingIndicator: (indicator?: { frames?: string[]; intervalMs?: number }) => present("working-indicator", { indicator: indicator ? { frames: indicator.frames, interval: indicator.intervalMs } : undefined }),
      setHiddenThinkingLabel: (label?: string) => present("hidden-thinking-label", { label }),
      setWidget: (key: string, content?: string[] | (() => unknown), options?: Record<string, unknown>) => {
        const placement = options?.placement === "belowEditor" ? "belowEditor" : "aboveEditor";
        if (content === undefined || Array.isArray(content)) {
          replaceComponent(`widget:${key}`, "widget", undefined, 10, { key, placement });
          present("widget", { key, lines: content === undefined ? undefined : sanitizeLines(content, 10), placement });
          return;
        }
        replaceComponent(`widget:${key}`, "widget", content as ComponentFactory, 10, { key, placement });
      },
      setFooter: (factory?: ComponentFactory) => replaceComponent("footer", "footer", factory, 12),
      setHeader: (factory?: ComponentFactory) => replaceComponent("header", "header", factory, 12),
      setTitle: (title: string) => present("title", { title }),
      custom: <T>(factory: (tui: any, theme: any, keybindings: ExtensionKeybindings, done: (result: T) => void) => CustomUiComponent | Promise<CustomUiComponent>, _options?: Record<string, unknown>) => new Promise<T | undefined>((resolve) => {
        const requestId = `${encodeURIComponent(scopeId)}:extension-custom:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
        let component: CustomUiComponent | undefined;
        let settled = false;
        let dirty = false;
        let renderTimer: ReturnType<typeof setTimeout> | undefined;
        const keybindings = extensionKeybindings ?? {
          matches(data: string, keybinding: string): boolean {
            const keys: Record<string, string[]> = {
              "tui.select.up": ["\x1b[A", "\x1bOA"],
              "tui.select.down": ["\x1b[B", "\x1bOB"],
              "tui.select.confirm": ["\r", "\n"],
              "tui.select.cancel": ["\x1b"],
            };
            return keys[keybinding]?.includes(data) ?? false;
          },
        };
        const render = () => {
          if (settled || !component) { dirty = true; return; }
          try {
            const marker = "\x1b_pi:c\x07";
            const lines = component.render(96).map((line) => stripVTControlCharacters(line.replaceAll(marker, "")));
            this.callbacks.emitUiRequest?.(requestId, taskId, { kind: "custom", title: "AgentCore Extension", lines });
            dirty = false;
          } catch (error) {
            this.callbacks.emitEvent(taskId, { type: "extension.error", error: error instanceof Error ? error.message : String(error) });
            settle(undefined);
          }
        };
        const scheduleRender = () => {
          dirty = true;
          if (settled || renderTimer) return;
          renderTimer = setTimeout(() => {
            renderTimer = undefined;
            render();
          }, 50);
        };
        const settle = (value: T | undefined, reason?: "aborted") => {
          if (settled) return;
          settled = true;
          if (renderTimer) clearTimeout(renderTimer);
          renderTimer = undefined;
          const waiter = this.customUiWaiters.get(requestId);
          if (waiter) {
            this.customUiWaiters.delete(requestId);
            waiter.dispose();
          } else {
            component?.dispose?.();
          }
          resolve(value);
          this.callbacks.emitEvent(taskId, { type: "extension.ui.dismiss", requestId, ...(reason ? { reason } : {}) });
        };
        const waiter = {
          taskId,
          pendingInputs: [] as string[],
          handleInput: (data: string) => {
            if (settled) return;
            if (!component) { waiter.pendingInputs.push(data); return; }
            try {
              component.handleInput?.(data);
              render();
            } catch (error) {
              this.callbacks.emitEvent(taskId, { type: "extension.error", error: error instanceof Error ? error.message : String(error) });
            }
          },
          dispose: () => { settled = true; component?.dispose?.(); },
          resolve: (value: unknown) => resolve(value as T | undefined),
        };
        this.customUiWaiters.set(requestId, waiter);
        const tui = {
          requestRender: scheduleRender,
          setFocus: () => undefined,
        };
        const done = (value: T) => settle(value);
        let created: CustomUiComponent | Promise<CustomUiComponent>;
        try {
          created = factory(tui, themes?.theme ?? desktopPlainTextTheme, keybindings, done);
        } catch (error) {
          this.customUiWaiters.delete(requestId);
          resolve(undefined);
          this.callbacks.emitEvent(taskId, { type: "extension.error", error: error instanceof Error ? error.message : String(error) });
          return;
        }
        Promise.resolve(created).then((next) => {
          if (settled) { next.dispose?.(); return; }
          component = next;
          for (const input of waiter.pendingInputs.splice(0)) waiter.handleInput(input);
          render();
          if (dirty) scheduleRender();
        }).catch((error: unknown) => {
          this.customUiWaiters.delete(requestId);
          component?.dispose?.();
          resolve(undefined);
          this.callbacks.emitEvent(taskId, { type: "extension.error", error: error instanceof Error ? error.message : String(error) });
        });
      }),
      pasteToEditor: (text: string) => {
        editorText = (this.editorTexts.get(scopeId) ?? editorText) + text;
        this.editorTexts.set(scopeId, editorText);
        scope.editor?.setText(editorText);
        if (scope.editor) scheduleRender("editor", "editor", 80, { active: true });
        present("editor-text", { text: editorText });
      },
      setEditorText: (text: string) => {
        editorText = text;
        this.editorTexts.set(scopeId, text);
        scope.editor?.setText(text);
        if (scope.editor) scheduleRender("editor", "editor", 80, { active: true });
        present("editor-text", { text });
      },
      getEditorText: () => this.editorTexts.get(scopeId) ?? editorText,
      setEditorComponent: (factory?: ExtensionUiScope["editorFactory"]) => {
        scope.editor?.dispose?.();
        scope.editor = undefined;
        scope.editorFactory = factory;
        const timer = scope.renderTimers.get("editor");
        if (timer) clearTimeout(timer);
        scope.renderTimers.delete("editor");
        if (!factory) { present("editor", { active: false, lines: undefined }); return; }
        try {
          const component = factory(createTui("editor", "editor", 80, { active: true }), editorTheme, keybindings);
          scope.editor = component;
          component.onChange = (text: string) => {
            editorText = text;
            this.editorTexts.set(scopeId, text);
            present("editor-text", { text });
            scheduleRender("editor", "editor", 80, { active: true });
          };
          component.onSubmit = (text: string) => {
            editorText = text;
            this.editorTexts.set(scopeId, text);
            present("editor-submit", { text });
          };
          if (scope.autocompleteProvider) component.setAutocompleteProvider?.(scope.autocompleteProvider);
          component.setText(editorText);
          renderComponent("editor", "editor", 80, { active: true });
        } catch (error) {
          scope.editor = undefined;
          scope.editorFactory = undefined;
          present("editor", { active: false, lines: undefined });
          this.callbacks.emitEvent(taskId, { type: "extension.error", error: error instanceof Error ? error.message : String(error) });
        }
      },
      getEditorComponent: () => scope.editorFactory,
      editor: async (title: string, prefill?: string) => {
        const value = await request<string>("editor", { title, prefill });
        if (typeof value === "string") { editorText = value; this.editorTexts.set(scopeId, value); }
        return value;
      },
      addAutocompleteProvider: (factory: (current: AutocompleteProvider) => AutocompleteProvider) => {
        const fallback: AutocompleteProvider = scope.autocompleteProvider ?? {
          async getSuggestions() { return null; },
          applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            const line = lines[cursorLine] ?? "";
            const start = Math.max(0, cursorCol - prefix.length);
            const next = [...lines];
            next[cursorLine] = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`;
            return { lines: next, cursorLine, cursorCol: start + item.value.length };
          },
        };
        try {
          scope.autocompleteProvider = factory(fallback);
          scope.editor?.setAutocompleteProvider?.(scope.autocompleteProvider);
          present("autocomplete", { active: true, triggerCharacters: sanitizeLines(scope.autocompleteProvider.triggerCharacters, 32) });
        } catch (error) {
          this.callbacks.emitEvent(taskId, { type: "extension.error", error: error instanceof Error ? error.message : String(error) });
        }
      },
      get theme() { return themes?.theme ?? desktopPlainTextTheme; },
      getAllThemes: () => { if (themes) return themes.getAllThemes(); warnUnsupported("getAllThemes"); return []; },
      getTheme: (name: string) => { if (themes) return themes.getTheme(name); warnUnsupported("getTheme"); return undefined; },
      setTheme: (value: any) => { if (themes) return themes.setTheme(value); warnUnsupported("setTheme"); return { success: false, error: "The runtime does not expose desktop theme adaptation" }; },
      getToolsExpanded: () => toolsExpanded,
      setToolsExpanded: (expanded: boolean) => { toolsExpanded = expanded; present("tools-expanded", { expanded }); },
    };
  }

  syncEditorText(scopeId: string, text: string): void {
    this.editorTexts.set(scopeId, text);
    const scope = this.extensionUiScopes.get(scopeId);
    scope?.editor?.setText(text);
    if (scope?.editor) {
      const timer = scope.renderTimers.get("editor");
      if (!timer) scope.renderTimers.set("editor", setTimeout(() => {
        scope.renderTimers.delete("editor");
        if (scope.disposed || !scope.editor) return;
        try {
          this.callbacks.emitEvent(scope.taskId, { type: "extension.ui.presentation", action: "editor", active: true, lines: sanitizeLines(scope.editor.render(COMPONENT_WIDTH), 80, "▌") });
        } catch (error) {
          this.callbacks.emitEvent(scope.taskId, { type: "extension.error", error: error instanceof Error ? error.message : String(error) });
        }
      }, 50));
    }
  }

  dispatchInput(scopeId: string, data: string): ExtensionInputDispatchResult {
    const scope = this.extensionUiScopes.get(scopeId);
    if (!scope || scope.disposed) return { consume: false, data };
    let nextData = data;
    for (const handler of scope.terminalHandlers) {
      try {
        const result = handler(nextData);
        if (typeof result?.data === "string") nextData = result.data;
        if (result?.consume) return { consume: true, ...(nextData !== data ? { data: nextData } : {}) };
      } catch (error) {
        this.callbacks.emitEvent(scope.taskId, { type: "extension.error", error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (scope.editor) {
      try {
        scope.editor.handleInput?.(nextData);
        const text = scope.editor.getText();
        this.editorTexts.set(scopeId, text);
        this.callbacks.emitEvent(scope.taskId, { type: "extension.ui.presentation", action: "editor-text", text });
        const timer = scope.renderTimers.get("editor");
        if (!timer) scope.renderTimers.set("editor", setTimeout(() => {
          scope.renderTimers.delete("editor");
          if (!scope.editor || scope.disposed) return;
          this.callbacks.emitEvent(scope.taskId, { type: "extension.ui.presentation", action: "editor", active: true, lines: sanitizeLines(scope.editor.render(COMPONENT_WIDTH), 80, "▌") });
        }, 50));
        return { consume: true };
      } catch (error) {
        this.callbacks.emitEvent(scope.taskId, { type: "extension.error", error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { consume: false, ...(nextData !== data ? { data: nextData } : {}) };
  }

  async autocomplete(scopeId: string, text: string, cursor: number, force = false): Promise<ExtensionAutocompleteResult | null> {
    const scope = this.extensionUiScopes.get(scopeId);
    const provider = scope?.autocompleteProvider;
    if (!scope || scope.disposed || !provider) return null;
    const safeCursor = Math.max(0, Math.min(cursor, text.length));
    const lines = text.split("\n");
    const before = text.slice(0, safeCursor).split("\n");
    const cursorLine = before.length - 1;
    const cursorCol = before.at(-1)?.length ?? 0;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        provider.getSuggestions(lines, cursorLine, cursorCol, { signal: controller.signal, force }),
        new Promise<null>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, 1500); }),
      ]);
      if (!result || controller.signal.aborted || !Array.isArray(result.items)) return null;
      const prefix = typeof result.prefix === "string" ? result.prefix.slice(0, 4096) : "";
      const items = result.items.slice(0, 12).flatMap((item) => {
        if (!item || typeof item.value !== "string" || typeof item.label !== "string") return [];
        try {
          const applied = provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
          if (!applied || !Array.isArray(applied.lines)) return [];
          const nextLines = applied.lines.map((line) => typeof line === "string" ? line : "");
          const nextText = nextLines.join("\n").slice(0, 1_000_000);
          const nextCursor = Math.min(nextText.length, textOffset(nextLines, Math.max(0, applied.cursorLine), Math.max(0, applied.cursorCol)));
          return [{ value: item.value.slice(0, 4096), label: stripVTControlCharacters(item.label).slice(0, 4096), ...(typeof item.description === "string" ? { description: stripVTControlCharacters(item.description).slice(0, 4096) } : {}), text: nextText, cursor: nextCursor }];
        } catch { return []; }
      });
      return items.length ? { prefix, items } : null;
    } catch (error) {
      if (!controller.signal.aborted) this.callbacks.emitEvent(scope.taskId, { type: "extension.error", error: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
    }
  }

  async beforeToolCallWithExtension(taskId: string, context: any, previous: BeforeToolCall | undefined, extensionLoaded: boolean, signal?: AbortSignal, scopeId = taskId): Promise<unknown> {
    if (extensionLoaded) {
      if (this.mode === "deny") return { block: true, reason: "PFSAA 权限模式已禁止工具调用。" };
      if (this.mode === "allow" || this.mode === "yolo") return undefined;
      return previous?.(context, signal);
    }
    const toolName = context.toolCall?.name ?? "unknown";
    if (this.mode === "ask" && new Set(["read", "grep", "find", "ls"]).has(toolName)) return previous?.(context, signal);
    return this.beforeToolCall(taskId, context, previous, signal, scopeId);
  }
}

export { permissionConfigPath, resolvePermissionExtensionPath };
