import { validatePfsaaHostPayload, type AgentCoreSettingsSummary, type AgentCoreSettingsUpdate } from "@pfsaa/contracts";

export interface AgentCoreSettingsManager {
  getDefaultProvider(): string | undefined;
  getDefaultModel(): string | undefined;
  getDefaultThinkingLevel(): string | undefined;
  getAllModelThinkingLevels?(): Record<string, string>;
  getTransport(): AgentCoreSettingsSummary["transport"] | undefined;
  getCompactionSettings(): { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number } | undefined;
  getRetrySettings?(): { enabled: boolean; maxRetries: number; baseDelayMs: number };
  getProviderRetrySettings?(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number };
  getBranchSummarySettings?(): { reserveTokens?: number; skipPrompt?: boolean };
  getBranchSummarySkipPrompt?(): boolean;
  getHttpIdleTimeoutMs?(): number;
  getWebSocketConnectTimeoutMs?(): number;
  getDefaultTools?(): string[] | undefined;
  getThinkingBudgets?(): { minimal?: number; low?: number; medium?: number; high?: number } | undefined;
  getImageAutoResize?(): boolean;
  getBlockImages?(): boolean;
  getDefaultProjectTrust?(): AgentCoreSettingsSummary["defaultProjectTrust"];
  getShellPath?(): string | undefined;
  getShellCommandPrefix?(): string | undefined;
  getNpmCommand?(): string[] | undefined;
  getSessionDir?(): string | undefined;
  getEnableSkillCommands?(): boolean;
  getEnableInstallTelemetry?(): boolean;
  drainErrors?(): Array<{ error: Error }>;
  getSteeringMode(): AgentCoreSettingsSummary["steeringMode"];
  getFollowUpMode(): AgentCoreSettingsSummary["followUpMode"];
  getExternalEditorCommand?(): string;
  getGlobalSettings?(): { externalEditor?: unknown; httpProxy?: string };
  getProjectSettings?(): { externalEditor?: unknown };
  setDefaultModelAndProvider(provider: string, model: string): void;
  setDefaultThinkingLevel(level: string): void;
  setModelThinkingLevel?(provider: string, model: string, level: string): void;
  removeModelThinkingLevel?(provider: string, model: string): void;
  setTransport(transport: AgentCoreSettingsSummary["transport"]): void;
  setCompactionEnabled(enabled: boolean): void;
  setSteeringMode(mode: AgentCoreSettingsSummary["steeringMode"]): void;
  setFollowUpMode(mode: AgentCoreSettingsSummary["followUpMode"]): void;
  reload?(): Promise<void>;
  flush(): Promise<void>;
}

export interface AgentCoreSettingsRuntime {
  getModel(provider: string, model: string): unknown;
}

export interface AgentCoreSettingsStorage {
  withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined): void;
}

function editorCommand(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedExternalEditor(value: string): string | undefined {
  const command = value.trim();
  if (!command) return undefined;
  if (command.length > 1000) throw new Error("External editor command must be 1000 characters or fewer");
  if (/[\r\n\0]/.test(command)) throw new Error("External editor command cannot contain line breaks or null characters");
  return command;
}

export function persistExternalEditorSetting(storage: AgentCoreSettingsStorage, value: string): void {
  const command = normalizedExternalEditor(value);
  storage.withLock("global", (current) => {
    const parsed = current?.trim() ? JSON.parse(current.replace(/^\uFEFF/, "")) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("User settings must contain a JSON object");
    if (command) parsed.externalEditor = command;
    else delete parsed.externalEditor;
    return JSON.stringify(parsed, null, 2);
  });
}

export function summarizeAgentCoreSettings(manager: AgentCoreSettingsManager): AgentCoreSettingsSummary {
  const compaction = manager.getCompactionSettings();
  const retry = manager.getRetrySettings?.();
  const providerRetry = manager.getProviderRetrySettings?.();
  const branchSummary = manager.getBranchSummarySettings?.();
  const thinkingBudgets = manager.getThinkingBudgets?.();
  let httpProxy = manager.getGlobalSettings?.().httpProxy ?? "";
  let httpProxyHasCredentials = false;
  if (httpProxy) {
    try { const url = new URL(httpProxy); httpProxyHasCredentials = Boolean(url.username || url.password); url.username = ""; url.password = ""; httpProxy = url.toString(); }
    catch { httpProxy = ""; }
  }
  const projectEditor = editorCommand(manager.getProjectSettings?.().externalEditor);
  const userEditor = editorCommand(manager.getGlobalSettings?.().externalEditor);
  const visualEditor = editorCommand(process.env.VISUAL);
  const environmentEditor = editorCommand(process.env.EDITOR);
  const defaultEditor = process.platform === "win32" ? "notepad" : "nano";
  const externalEditorSource = projectEditor ? "project" : userEditor ? "user" : visualEditor ? "visual" : environmentEditor ? "editor" : "default";
  return {
    retryEnabled: retry?.enabled,
    retryMaxRetries: retry?.maxRetries,
    retryBaseDelayMs: retry?.baseDelayMs,
    providerRetryTimeoutMs: providerRetry?.timeoutMs,
    providerRetryMaxRetries: providerRetry?.maxRetries,
    providerRetryMaxRetryDelayMs: providerRetry?.maxRetryDelayMs,
    compactionReserveTokens: compaction?.reserveTokens,
    compactionKeepRecentTokens: compaction?.keepRecentTokens,
    branchSummaryReserveTokens: branchSummary?.reserveTokens,
    branchSummarySkipPrompt: branchSummary?.skipPrompt ?? manager.getBranchSummarySkipPrompt?.(),
    httpProxy, httpProxyHasCredentials,
    httpIdleTimeoutMs: manager.getHttpIdleTimeoutMs?.(),
    websocketConnectTimeoutMs: manager.getWebSocketConnectTimeoutMs?.(),
    defaultTools: manager.getDefaultTools?.() ?? null,
    defaultProvider: manager.getDefaultProvider(),
    defaultModel: manager.getDefaultModel(),
    defaultThinkingLevel: manager.getDefaultThinkingLevel() ?? "off",
    modelThinkingLevels: { ...(manager.getAllModelThinkingLevels?.() ?? {}) },
    thinkingBudgets: thinkingBudgets ? { ...thinkingBudgets } : null,
    imageAutoResize: manager.getImageAutoResize?.() ?? true,
    blockImages: manager.getBlockImages?.() ?? false,
    defaultProjectTrust: manager.getDefaultProjectTrust?.() ?? "ask",
    shellPath: manager.getShellPath?.(),
    shellCommandPrefix: manager.getShellCommandPrefix?.(),
    npmCommand: manager.getNpmCommand?.() ?? null,
    sessionDir: manager.getSessionDir?.(),
    enableSkillCommands: manager.getEnableSkillCommands?.() ?? true,
    enableInstallTelemetry: manager.getEnableInstallTelemetry?.() ?? true,
    transport: manager.getTransport() ?? "auto",
    compactionEnabled: compaction?.enabled !== false,
    steeringMode: manager.getSteeringMode(),
    followUpMode: manager.getFollowUpMode(),
    externalEditor: userEditor,
    effectiveExternalEditor: manager.getExternalEditorCommand?.() ?? projectEditor ?? userEditor ?? visualEditor ?? environmentEditor ?? defaultEditor,
    externalEditorSource,
  };
}

export async function updateAgentCoreSettings(
  manager: AgentCoreSettingsManager,
  runtime: AgentCoreSettingsRuntime,
  payload: AgentCoreSettingsUpdate,
  storage?: AgentCoreSettingsStorage,
): Promise<AgentCoreSettingsSummary> {
  validatePfsaaHostPayload("settings.update", payload);
  const advanced = advancedSettingsPatch(payload);
  if (Object.keys(advanced).length && !storage) throw new Error("This runtime does not expose locked settings storage");
  if (payload.externalEditor !== undefined && !storage) throw new Error("This runtime does not expose locked settings storage");
  if (payload.externalEditor !== undefined) normalizedExternalEditor(payload.externalEditor);
  const provider = payload.defaultProvider?.trim();
  const model = payload.defaultModel?.trim();
  const modelThinkingPatch = payload.modelThinkingLevels;
  let parsedModelThinkingPatch: Array<{ provider: string; model: string; level: string | null }> | undefined;
  if (modelThinkingPatch !== undefined && Object.keys(modelThinkingPatch).length > 0) {
    if (!manager.setModelThinkingLevel || !manager.removeModelThinkingLevel) {
      throw new Error("This runtime does not expose per-model thinking settings");
    }
    parsedModelThinkingPatch = Object.entries(modelThinkingPatch).map(([reference, level]) => {
      const separator = reference.indexOf("/");
      const modelProvider = separator > 0 ? reference.slice(0, separator) : "";
      const modelId = separator > 0 ? reference.slice(separator + 1) : "";
      if (!modelProvider.trim() || !modelId.trim()) throw new Error(`Invalid model thinking setting: ${reference}`);
      return { provider: modelProvider, model: modelId, level };
    });
  }
  if (provider || model) {
    if (!provider || !model) throw new Error("defaultProvider and defaultModel must be updated together");
    if (!runtime.getModel(provider, model)) throw new Error(`Unknown model: ${provider}/${model}`);
    manager.setDefaultModelAndProvider(provider, model);
  }
  for (const { provider: modelProvider, model: modelId, level } of parsedModelThinkingPatch ?? []) {
    if (level === null) manager.removeModelThinkingLevel!(modelProvider, modelId);
    else manager.setModelThinkingLevel!(modelProvider, modelId, level);
  }
  if (payload.defaultThinkingLevel !== undefined) {
    const level = payload.defaultThinkingLevel;
    if (!new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).has(level)) throw new Error(`Unsupported default thinking level: ${level}`);
    manager.setDefaultThinkingLevel(level);
  }
  if (payload.transport !== undefined) {
    const transport = payload.transport;
    if (!new Set(["auto", "sse", "websocket", "websocket-cached"]).has(transport)) throw new Error(`Unsupported transport: ${transport}`);
    manager.setTransport(transport);
  }
  if (payload.compactionEnabled !== undefined) manager.setCompactionEnabled(payload.compactionEnabled);
  if (payload.steeringMode !== undefined) {
    const mode = payload.steeringMode;
    if (!new Set(["all", "one-at-a-time"]).has(mode)) throw new Error(`Unsupported steering mode: ${mode}`);
    manager.setSteeringMode(mode);
  }
  if (payload.followUpMode !== undefined) {
    const mode = payload.followUpMode;
    if (!new Set(["all", "one-at-a-time"]).has(mode)) throw new Error(`Unsupported follow-up mode: ${mode}`);
    manager.setFollowUpMode(mode);
  }
  await manager.flush();
  const failure = manager.drainErrors?.()[0];
  if (failure) throw failure.error;
  if (payload.externalEditor !== undefined && storage) {
    persistExternalEditorSetting(storage, payload.externalEditor);
    await manager.reload?.();
  }
  if (Object.keys(advanced).length && storage) {
    storage.withLock("global", (current) => {
      const parsed = current?.trim() ? JSON.parse(current.replace(/^\uFEFF/, "")) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("User settings must contain a JSON object");
      for (const [key, value] of Object.entries(advanced)) {
        if (value === null) delete parsed[key];
        else parsed[key] = mergeSettingsValue(parsed[key], value);
      }
      return JSON.stringify(parsed, null, 2);
    });
    await manager.reload?.();
  }
  return summarizeAgentCoreSettings(manager);
}

function mergeSettingsValue(current: unknown, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const currentObject = current && typeof current === "object" && !Array.isArray(current)
    ? current as Record<string, unknown>
    : {};
  const merged = { ...currentObject };
  for (const [key, next] of Object.entries(value as Record<string, unknown>)) {
    if (next === null) delete merged[key];
    else merged[key] = mergeSettingsValue(currentObject[key], next);
  }
  return merged;
}

/** Only AgentCore settings keys, written through AgentCore's own lock; untouched keys survive. */
export function advancedSettingsPatch(payload: AgentCoreSettingsUpdate): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const retry: Record<string, unknown> = {};
  const providerRetry: Record<string, unknown> = {};
  const compaction: Record<string, unknown> = {};
  const branchSummary: Record<string, unknown> = {};
  const images: Record<string, unknown> = {};
  if (payload.retryEnabled !== undefined) retry.enabled = payload.retryEnabled;
  if (payload.retryMaxRetries !== undefined) retry.maxRetries = payload.retryMaxRetries;
  if (payload.retryBaseDelayMs !== undefined) retry.baseDelayMs = payload.retryBaseDelayMs;
  if (payload.providerRetryTimeoutMs !== undefined) providerRetry.timeoutMs = payload.providerRetryTimeoutMs;
  if (payload.providerRetryMaxRetries !== undefined) providerRetry.maxRetries = payload.providerRetryMaxRetries;
  if (payload.providerRetryMaxRetryDelayMs !== undefined) providerRetry.maxRetryDelayMs = payload.providerRetryMaxRetryDelayMs;
  if (Object.keys(providerRetry).length) retry.provider = providerRetry;
  if (payload.compactionReserveTokens !== undefined) compaction.reserveTokens = payload.compactionReserveTokens;
  if (payload.compactionKeepRecentTokens !== undefined) compaction.keepRecentTokens = payload.compactionKeepRecentTokens;
  if (payload.branchSummaryReserveTokens !== undefined) branchSummary.reserveTokens = payload.branchSummaryReserveTokens;
  if (payload.branchSummarySkipPrompt !== undefined) branchSummary.skipPrompt = payload.branchSummarySkipPrompt;
  if (Object.keys(retry).length) patch.retry = retry;
  if (Object.keys(compaction).length) patch.compaction = compaction;
  if (Object.keys(branchSummary).length) patch.branchSummary = branchSummary;
  if (payload.httpIdleTimeoutMs !== undefined) patch.httpIdleTimeoutMs = payload.httpIdleTimeoutMs;
  if (payload.websocketConnectTimeoutMs !== undefined) patch.websocketConnectTimeoutMs = payload.websocketConnectTimeoutMs;
  if (payload.defaultTools !== undefined) patch.defaultTools = payload.defaultTools === null ? null : [...new Set(payload.defaultTools)];
  if (payload.thinkingBudgets !== undefined) patch.thinkingBudgets = payload.thinkingBudgets === null ? null : { ...payload.thinkingBudgets };
  if (payload.imageAutoResize !== undefined) images.autoResize = payload.imageAutoResize;
  if (payload.blockImages !== undefined) images.blockImages = payload.blockImages;
  if (Object.keys(images).length) patch.images = images;
  if (payload.defaultProjectTrust !== undefined) patch.defaultProjectTrust = payload.defaultProjectTrust;
  if (payload.shellPath !== undefined) patch.shellPath = payload.shellPath.trim() || null;
  if (payload.shellCommandPrefix !== undefined) patch.shellCommandPrefix = payload.shellCommandPrefix.trim() || null;
  if (payload.npmCommand !== undefined) {
    if (payload.npmCommand === null) patch.npmCommand = null;
    else {
      const command = payload.npmCommand.map((part) => part.trim());
      if (command.some((part) => !part)) throw new Error("npmCommand entries cannot be empty");
      patch.npmCommand = command;
    }
  }
  if (payload.sessionDir !== undefined) patch.sessionDir = payload.sessionDir.trim() || null;
  if (payload.enableSkillCommands !== undefined) patch.enableSkillCommands = payload.enableSkillCommands;
  if (payload.enableInstallTelemetry !== undefined) patch.enableInstallTelemetry = payload.enableInstallTelemetry;
  if (payload.httpProxy !== undefined) {
    const proxy = payload.httpProxy.trim();
    if (proxy) {
      let url: URL;
      try { url = new URL(proxy); } catch { throw new Error("Use an absolute HTTP(S) proxy URL"); }
      if (!new Set(["http:", "https:"]).has(url.protocol) || !url.hostname || url.hash || /[\r\n\0]/.test(proxy)) throw new Error("Use an absolute HTTP(S) proxy URL");
    }
    patch.httpProxy = proxy || null;
  }
  return patch;
}
