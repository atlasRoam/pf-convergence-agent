import { validatePfsaaHostPayload, type PermissionMode, type PfsaaHostRequest, type PfsaaHostResponse, type AgentCorePackageResourceType, type AgentCoreSettingsUpdate, type ProviderAuthSource, type ProviderRemovalResult, type ProviderSummary, type ScopedModelSelection, type SessionChangeFile, type SessionChangeReview, type SessionChangeReviewCollection, type SessionRunRecord } from "@pfsaa/contracts";
import { deriveSessionTitle, isCommandDerivedSessionTitle, isDefaultSessionTitle } from "@pfsaa/domain";
import { configureAgentCoreHttpNetworking, getModelRuntime, loadAgentCoreSdk, modelSummary, resolveAgentCoreModule, sessionModelLabel, type AgentCoreSdk } from "@pfsaa/agentcore-adapter";
import { PermissionEngine, resolvePermissionExtensionPath } from "@pfsaa/permission-engine";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import {
  createAgentRunReservation,
  isExtensionCommand,
  queuePromptDuringCompaction,
  waitForReservedAgentRun,
} from "./agent-prompt-coordination.js";
import { normalizeAgentEvent } from "./agent-event-adapter.js";
import { withExternalEditorPathAliases } from "./external-editor-command.js";
import { createExtensionTheme } from "./extension-theme.js";
import {
  activeChangeReviews,
  activeProviderLoginByProvider,
  activeProviderLogins,
  agentSessionRuntimes,
  agentRunReservations,
  agentSessionPackageRevisions,
  agentSessionPromises,
  agentSessionRevisions,
  agentSessions,
  authWaiters,
  capabilitySessions,
  changeReviewMutationLocks,
  executionGroupStarts,
  LEGACY_SESSION_RUN_METADATA_TYPES,
  manualCompactionQueues,
  pendingChangeReviewWrites,
  pendingChangeReviewWritesBySession,
  sessionFiles,
  sessionManagers,
  SESSION_RUN_METADATA_TYPE,
  titledSessions,
  type ActiveChangeReviewSegment,
  type ActiveChangeReviewTracker,
  type AuthWaiter,
  type ActiveProviderLogin,
} from "./host-state.js";
import { summarizeAgentCoreSettings, updateAgentCoreSettings } from "./settings-command-handler.js";
import {
  acceptChangeReviewHunk,
  applyChangeReviewMerge,
  buildSessionChangeReview,
  inspectGitWorkspaceAvailability,
  inspectWorkspaceChangeState,
  loadChangeReviewMergeSource,
  revertChangeReviewHunk,
  withResolvedReviewHunks,
  type WorkspaceChangeInspection,
  type WorkspaceReviewMutation,
} from "./session-change-review.js";
import {
  copySessionChangeReviewStore,
  deleteSessionChangeReviewStore,
  flushSessionChangeReviewStore,
  loadSessionChangeReviews,
  persistSessionChangeReview,
  sessionChangeReviewStorePath,
  summarizeSessionChangeReview,
} from "./session-change-review-store.js";
import { sessionTranscriptMessages } from "./session-transcript.js";
import { canonicalProjectPath, createTrustAwareSettingsManager, readProjectTrustStatus } from "./project-trust.js";
import { buildSessionTreeSnapshot } from "./session-tree.js";
import { assertPfsaaCwd, pfsaaResourceOptions, pfsaaRuntime } from "./pfsaa-runtime.js";
import { createCustomProvider, getProviderUiState, hideProvider, normalizedProviderBaseUrl, providerConfigurations, removeCustomProvider, restoreEditableProviderFields, restoreProvider, updateEditableProvider } from "./provider-config-store.js";

const pfsaa = pfsaaRuntime();

function providerAuthSource(auth: { configured?: boolean; source?: string } | undefined, hasStoredCredential: boolean): ProviderAuthSource {
  if (hasStoredCredential) return "stored";
  switch (auth?.source) {
    case "environment": return "environment";
    case "models_json_key":
    case "models_json_command": return "models-json";
    case "runtime": return "runtime";
    case "fallback": return "external";
    default: return auth?.configured ? "external" : "none";
  }
}

function providerConfigAgentDir(): string {
  return pfsaa?.agentDir
    ?? process.env.AGENTCORE_AGENT_DIR
    ?? process.env.PI_CODING_AGENT_DIR
    ?? path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent");
}

type ProviderListVisibility = "visible" | "hidden";

async function listProviderSummaries(runtime: any, visibility: ProviderListVisibility): Promise<ProviderSummary[]> {
  const agentDir = providerConfigAgentDir();
  const [{ customProviderIds, hiddenProviders }, configurations, credentials] = await Promise.all([
    getProviderUiState(agentDir),
    providerConfigurations(agentDir),
    runtime.listCredentials(),
  ]);
  const configuredProviderIds = new Set(configurations.ids);
  const customProviderIdSet = new Set(customProviderIds.filter((providerId) => configuredProviderIds.has(providerId)));
  const credentialByProvider = new Map<string, any>(credentials.map((credential: any) => [credential.providerId, credential] as [string, any]));
  const providersById = new Map<string, any>(runtime.getProviders().map((provider: any) => [provider.id, provider]));
  const summaries = [...providersById.values()].map((provider): ProviderSummary => {
    const editable = configurations.editable[provider.id];
    const auth = runtime.getProviderAuthStatus(provider.id);
    const credential = credentialByProvider.get(provider.id);
    const hasStoredCredential = Boolean(credential);
    const authMethods = [
      provider.auth?.apiKey ? "api-key" : undefined,
      provider.auth?.oauth ? "oauth" : undefined,
    ].filter((method): method is "api-key" | "oauth" => Boolean(method));
    return {
      id: provider.id,
      name: provider.name ?? provider.id,
      authState: auth.configured ? "configured" : credential?.type === "oauth" ? "expired" : "missing",
      authMethod: credential?.type === "oauth" ? "oauth" : credential?.type === "api_key" ? "api-key" : null,
      authSource: providerAuthSource(auth, hasStoredCredential),
      hasStoredCredential,
      authMethods,
      modelCount: runtime.getModels(provider.id).length,
      isCustom: customProviderIdSet.has(provider.id),
      isEditable: Boolean(editable),
      ...(editable ? {
        baseUrl: editable.baseUrl,
        models: editable.models.map((model) => ({ ...model })),
      } : {}),
    };
  });
  const hiddenProviderIds = new Set(Object.keys(hiddenProviders));
  const matching = summaries.filter((provider) => visibility === "hidden" ? hiddenProviderIds.has(provider.id) : !hiddenProviderIds.has(provider.id));
  if (visibility === "visible") return matching;
  for (const [providerId, name] of Object.entries(hiddenProviders)) {
    if (providersById.has(providerId)) continue;
    matching.push({
      id: providerId,
      name,
      authState: "missing",
      authMethod: null,
      authSource: "none",
      hasStoredCredential: false,
      authMethods: [],
      modelCount: 0,
      isCustom: false,
      isEditable: false,
    });
  }
  return matching;
}

function assertCustomProviderIsNotInUse(providerId: string): void {
  if (activeProviderLoginByProvider.has(providerId)) throw new Error("PFSAA_PROVIDER_AUTH_IN_PROGRESS");
  if ([...agentSessions.values()].some((session) => session.model?.provider === providerId)) {
    throw new Error("PFSAA_PROVIDER_IN_USE");
  }
}

function assertEditableProviderUpdateIsSafe(provider: ProviderSummary, baseUrl: string, models: readonly { id: string }[]): void {
  if (activeProviderLoginByProvider.has(provider.id)) throw new Error("PFSAA_PROVIDER_AUTH_IN_PROGRESS");
  const selectedModelIds = [...agentSessions.values()]
    .map((session) => session.model)
    .filter((model) => model?.provider === provider.id)
    .map((model) => model.id);
  if (selectedModelIds.length === 0) return;
  const nextModelIds = new Set(models.map((model) => model.id.trim()));
  if (normalizedProviderBaseUrl(baseUrl) !== provider.baseUrl || selectedModelIds.some((id) => !nextModelIds.has(id))) {
    throw new Error("PFSAA_PROVIDER_IN_USE");
  }
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) throw new Error("The model list response is too large to read safely.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel();
      throw new Error("The model list response is too large to read safely.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function discoverOpenAICompatibleModels(baseUrl: string, apiKey: string | undefined, configuredHeaders?: unknown): Promise<Array<{ id: string; name: string }>> {
  const headers = new Headers({ accept: "application/json" });
  if (configuredHeaders && typeof configuredHeaders === "object") {
    try {
      new Headers(configuredHeaders as HeadersInit).forEach((value, name) => {
        if (name !== "authorization" && name !== "host" && name !== "content-length") headers.set(name, value);
      });
    } catch {
      throw new Error("The Provider contains invalid custom request headers.");
    }
  }
  if (apiKey) headers.set("authorization", `Bearer ${apiKey}`);
  const endpoint = `${normalizedProviderBaseUrl(baseUrl)}/models`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new Error("Model discovery timed out after 12 seconds.", { cause: error });
    if (error instanceof Error && error.message.includes("too large")) throw error;
    throw new Error("Could not reach the Provider model-list endpoint. Check the service URL and network access.", { cause: error });
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error(`Model discovery was rejected by the Provider (HTTP ${response.status}). Check the API key.`);
    throw new Error(`The Provider model-list endpoint returned HTTP ${response.status}.`);
  }
  let document: unknown;
  try {
    document = JSON.parse(await readBoundedResponseText(response, 1_048_576));
  } catch (error) {
    if (error instanceof Error && error.message.includes("too large")) throw error;
    throw new Error("The Provider returned an invalid model-list response.", { cause: error });
  }
  if (!document || typeof document !== "object" || !Array.isArray((document as { data?: unknown }).data)) {
    throw new Error("The Provider response does not contain an OpenAI-compatible model list.");
  }
  const models = new Map<string, { id: string; name: string }>();
  for (const entry of (document as { data: unknown[] }).data) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    const name = (entry as { name?: unknown }).name;
    if (typeof id !== "string" || !id.trim() || id.length > 200 || [...id].some((character) => character.codePointAt(0)! < 0x20)) continue;
    const trimmedId = id.trim();
    const candidateName = typeof name === "string" && name.trim() ? name.trim().slice(0, 200) : trimmedId;
    if (!models.has(trimmedId)) models.set(trimmedId, { id: trimmedId, name: candidateName });
    if (models.size > 200) throw new Error("The Provider returned more than 200 models. Add model IDs manually or narrow the Provider catalog.");
  }
  if (models.size === 0) throw new Error("The Provider returned no usable models.");
  return [...models.values()];
}

function resourceLoaderOptions(sdk: AgentCoreSdk, cwd: string, agentDir: string, settingsManager: any) {
  const permissionExtensionPath = pfsaa ? undefined : resolvePermissionExtensionPath();
  return pfsaa
    ? pfsaaResourceOptions(pfsaa, cwd, agentDir, settingsManager)
    : {
        cwd, agentDir, settingsManager,
        additionalExtensionPaths: permissionExtensionPath ? [permissionExtensionPath] : undefined,
        extensionFactories: sdk.builtInExtensions,
      };
}

function execFileText(file: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      ...options,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

const parentPort = (process as typeof process & {
  parentPort?: {
    on(event: "message", listener: (event: { data: unknown }) => void): void;
    postMessage(message: unknown): void;
  };
}).parentPort;
const proxyResolveWaiters = new Map<string, {
  resolve: (rules: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function resolveSystemProxy(url: string): Promise<string> {
  if (!process.send) return Promise.reject(new Error("Desktop system proxy bridge is unavailable"));
  const requestId = randomUUID();
  return new Promise<string>((resolve, reject) => {
    const hostname = new URL(url).hostname;
    const timer = setTimeout(() => {
      proxyResolveWaiters.delete(requestId);
      reject(new Error(`System proxy resolution timed out for ${hostname}`));
    }, 10_000);
    proxyResolveWaiters.set(requestId, { resolve, reject, timer });
    process.send?.({ type: "proxy.resolve", requestId, url });
  });
}

function handleProxyResolveResult(message: { requestId: string; rules?: string; error?: string }): void {
  const waiter = proxyResolveWaiters.get(message.requestId);
  if (!waiter) return;
  proxyResolveWaiters.delete(message.requestId);
  clearTimeout(waiter.timer);
  if (typeof message.rules === "string") waiter.resolve(message.rules);
  else waiter.reject(new Error(message.error || "System proxy resolution failed"));
}

function publicRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/([a-z][a-z\d+.-]*:\/\/)[^/@\s]+@/gi, "$1***@");
}

const httpNetworkingReady = configureAgentCoreHttpNetworking({ resolveSystemProxy });
// AgentSession can enter automatic-compaction preflight before AgentCore reports
// `isStreaming`. Track both the start and finish boundary so another renderer
// request cannot mistake that preflight window for an idle Agent.

function clearAgentRunReservation(stateKey: string): void {
  const reservation = agentRunReservations.get(stateKey);
  reservation?.markStarted(false);
  reservation?.markFinished();
  agentRunReservations.delete(stateKey);
}
// System prompt for LLM session-title generation. Matches the user's language,
// asks for a 3–8 word summary of intent (not a copy of the text), and demands
// the title alone with no quoting or markdown so extraction is trivial.
const SESSION_TITLE_SYSTEM_PROMPT = [
  "你是一个 AI 编程助手的会话标题生成器。根据用户的第一条消息，生成一个简洁、描述性的会话标题。",
  "规则：",
  "- 3 到 8 个词。",
  "- 概括用户意图，不要直接照搬原文。",
  "- 只输出标题本身，不要引号、不要结尾标点、不要 markdown、不要任何解释。",
  "- 使用与用户相同的语言。",
  "",
  "You are a session-title generator for an AI coding assistant. Given the user's first message, produce a concise, descriptive title.",
  "Rules:",
  "- 3 to 8 words.",
  "- Summarize the user's intent; do not just copy the text.",
  "- Output ONLY the title. No quotes, no trailing punctuation, no markdown, no explanation.",
  "- Match the user's language.",
].join("\n");
let packageConfigRevision = 0;

/**
 * AgentCore session IDs are normally UUIDs, but imported JSONL files can preserve an
 * ID that already exists in another project. Keep every in-memory resource
 * scoped to its project so an operation in one workspace can never address a
 * same-ID session in another workspace.
 */
function sessionStateKey(taskId: string, cwd: string): string {
  const resolvedCwd = path.resolve(cwd);
  const normalizedCwd = process.platform === "win32" ? resolvedCwd.toLowerCase() : resolvedCwd;
  return JSON.stringify([normalizedCwd, taskId]);
}
function normalizePackageInstallSource(source: string): string {
  const trimmed = source.trim();
  // AgentCore's package manager distinguishes npm packages with the `npm:` prefix.
  // Keep explicit paths and Git/URL sources untouched; a bare package name is
  // the common input users expect in the desktop package panel.
  if (/^(?:npm:|https?:\/\/|git\+|git@|ssh:\/\/|file:|~[\\/]|\.{0,2}[\\/]|[A-Za-z]:[\\/]|[\\/])/.test(trimmed)) return trimmed;
  if (/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(?:@[^\s]+)?$/.test(trimmed)) return `npm:${trimmed}`;
  return trimmed;
}

function resolveWorkspaceCwd(): string {
  const configuredWorkspace = process.env.PFSAA_WORKSPACE_CWD || process.env.PIDECK_WORKSPACE_CWD;
  if (configuredWorkspace) return configuredWorkspace;
  let current = process.cwd();
  while (true) {
    const packagePath = path.join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { workspaces?: unknown };
        if (packageJson.workspaces || existsSync(path.join(current, ".git"))) return current;
      } catch {
        // Continue walking up when a package manifest is not readable.
      }
    }
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

function send(response: PfsaaHostResponse) {
  parentPort?.postMessage(response);
  process.send?.(response);
}

function emit(taskId: string, event: unknown) {
  parentPort?.postMessage({ type: "agent.event", taskId, event });
  process.send?.({ type: "agent.event", taskId, event });
}

function emitAuth(requestId: string, event: unknown) {
  parentPort?.postMessage({ type: "auth.event", requestId, event });
  process.send?.({ type: "auth.event", requestId, event });
}

/**
 * Adapt AgentCore's AuthInteraction to the renderer bridge. API-key login can supply
 * the value already entered in the settings form for the first prompt; any
 * additional provider-specific fields still use the normal interactive prompt.
 */
const OPENAI_CODEX_FIXED_LOOPBACK_SDK_VERSIONS = new Set(["0.84.2", "0.84.3", "0.84.4", "0.85.0", "0.85.1"]);
const OPENAI_CODEX_LOOPBACK_PORT = 1455;

function isOpenAICodexBrowserMethodPrompt(providerId: string, prompt: any): boolean {
  const version = sdkVersion();
  if (providerId !== "openai-codex" || !version || !OPENAI_CODEX_FIXED_LOOPBACK_SDK_VERSIONS.has(version) || prompt?.type !== "select") return false;
  const optionIds = Array.isArray(prompt.options) ? prompt.options.map((option: any) => option?.id) : [];
  return optionIds.includes("browser") && optionIds.includes("device_code");
}

/**
 * AgentCore 0.84.2–0.85.1's OpenAI Codex browser flow silently falls back to manual URL
 * entry when its fixed loopback listener cannot bind. Probe the same endpoint
 * immediately before AgentCore starts it so the UI can keep the method picker open
 * and offer device-code login instead of presenting a mysterious stale form.
 */
async function assertOpenAICodexLoopbackAvailable(): Promise<void> {
  const host = process.env.PI_OAUTH_CALLBACK_HOST?.trim() || "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(new Error(`PFSAA_OAUTH_CALLBACK_UNAVAILABLE:${error.code ?? "UNKNOWN"}`));
    });
    server.listen({ host, port: OPENAI_CODEX_LOOPBACK_PORT, exclusive: true }, () => {
      server.close((error) => {
        if (error) reject(new Error("PFSAA_OAUTH_CALLBACK_UNAVAILABLE:CLOSE_FAILED"));
        else resolve();
      });
    });
  });
}

function createAuthInteraction(requestId: string, providerId: string, initialSecret?: string, operationSignal?: AbortSignal) {
  let initialSecretAvailable = Boolean(initialSecret);
  let promptSequence = 0;
  return {
    signal: operationSignal,
    prompt: (prompt: any) => {
      if (operationSignal?.aborted) return Promise.reject(operationSignal.reason ?? new Error("Authentication cancelled"));
      if (initialSecretAvailable && prompt?.type !== "select") {
        initialSecretAvailable = false;
        return Promise.resolve(initialSecret as string);
      }
      const promptId = `${requestId}:${++promptSequence}`;
      emitAuth(promptId, { type: "prompt", prompt: jsonSafe(prompt) });
      const beforeResolve = isOpenAICodexBrowserMethodPrompt(providerId, prompt)
        ? async (value: string) => { if (value === "browser") await assertOpenAICodexLoopbackAvailable(); }
        : undefined;
      return new Promise<string>((resolve, reject) => {
        const promptSignal = prompt?.signal as AbortSignal | undefined;
        const signal = operationSignal && promptSignal
          ? AbortSignal.any([operationSignal, promptSignal])
          : operationSignal ?? promptSignal;
        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        const waiter: AuthWaiter = {
          beforeResolve,
          resolve: (value) => { cleanup(); resolve(value); },
          reject: (reason) => { cleanup(); reject(reason); },
        };
        const onAbort = () => {
          if (authWaiters.get(promptId) !== waiter) return;
          authWaiters.delete(promptId);
          waiter.reject(signal?.reason ?? new Error("Authentication prompt cancelled"));
        };
        authWaiters.set(promptId, waiter);
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    notify: (event: unknown) => {
      if (!operationSignal?.aborted) emitAuth(requestId, { type: "notify", event: jsonSafe(event) });
    },
  };
}

async function persistProviderApiKey(runtime: any, providerId: string, apiKey: string, requestId: string): Promise<void> {
  const provider = runtime.getProvider?.(providerId);
  if (!provider?.auth?.apiKey?.login) throw new Error(`${provider?.name ?? providerId} does not support API-key login`);
  // ModelRuntime.login persists the returned credential through AgentCore's
  // credential store. setRuntimeApiKey is intentionally runtime-only.
  await runtime.login(providerId, "api-key", createAuthInteraction(requestId, providerId, apiKey));
}

function emitApproval(requestId: string, taskId: string, toolName: string, args: unknown) {
  const message = { type: "approval.requested", requestId, taskId, event: { toolName, args: jsonSafe(args) } };
  parentPort?.postMessage(message);
  process.send?.(message);
}

function emitExtensionUiRequest(requestId: string, taskId: string, request: Record<string, unknown>) {
  const message = { type: "extension.ui.request", requestId, taskId, event: { requestId, taskId, ...jsonSafe(request) } };
  parentPort?.postMessage(message);
  process.send?.(message);
}

const permissionEngine = new PermissionEngine({ emitApproval, emitEvent: emit, emitUiRequest: emitExtensionUiRequest });
function jsonSafe<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return String(value) as T;
  }
}

function persistSessionRun(session: any, taskId: string, startedAt: number, endedAt: number): void {
  const appendEntry = session.sessionManager?.appendCustomEntry;
  if (typeof appendEntry !== "function") return;
  const record: SessionRunRecord = {
    id: `${taskId}:${startedAt}`,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
  };
  try {
    appendEntry.call(session.sessionManager, SESSION_RUN_METADATA_TYPE, record);
  } catch {
    // A non-persistent/in-memory AgentCore session should not prevent the runtime
    // event from reaching the renderer.
  }
}

function finishExecutionGroup(session: any, stateKey: string, taskId: string, endedAt: number): void {
  const startedAt = executionGroupStarts.get(stateKey);
  executionGroupStarts.delete(stateKey);
  if (startedAt !== undefined) persistSessionRun(session, taskId, startedAt, endedAt);
}

function sessionRunMetadata(session: any): SessionRunRecord[] {
  const entries = session.sessionManager?.getBranch?.() ?? session.sessionManager?.getEntries?.() ?? [];
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry: any) => entry?.type === "custom" && (entry.customType === SESSION_RUN_METADATA_TYPE || LEGACY_SESSION_RUN_METADATA_TYPES.has(entry.customType)))
    .map((entry: any) => entry.data)
    .filter((record: any): record is SessionRunRecord => Boolean(
      record
      && typeof record.id === "string"
      && Number.isFinite(record.startedAt)
      && Number.isFinite(record.endedAt)
      && Number.isFinite(record.durationMs),
    ));
}

async function sessionChangeReviewCollection(session: any, cwd: string, diffApiAvailable: boolean): Promise<SessionChangeReviewCollection> {
  let storageRetryFailed = false;
  try { await flushSessionChangeReviewStore(session); }
  catch { storageRetryFailed = true; }
  const loaded = await loadSessionChangeReviews(session);
  if (storageRetryFailed) {
    return { availability: "error", reason: "review-storage-failed", reviews: loaded.reviews.map(summarizeSessionChangeReview) };
  }
  if (loaded.invalid) {
    return { availability: "error", reason: "review-data-invalid", reviews: loaded.reviews.map(summarizeSessionChangeReview) };
  }
  if (!diffApiAvailable) {
    return { availability: "error", reason: "diff-api-unavailable", reviews: loaded.reviews.map(summarizeSessionChangeReview) };
  }
  const inspection = await inspectGitWorkspaceAvailability(cwd, AbortSignal.timeout(15_000));
  return {
    availability: inspection.status,
    ...(inspection.status === "error" ? { reason: inspection.reason } : {}),
    reviews: loaded.reviews.map(summarizeSessionChangeReview),
  };
}

function emptyRunningChangeReview(taskId: string, startedAt: number): SessionChangeReview {
  return {
    schemaVersion: 2,
    id: `${taskId}:${startedAt}`,
    state: "running",
    startedAt,
    endedAt: startedAt,
    files: [],
    additions: 0,
    deletions: 0,
    truncated: false,
    fileCountTruncated: false,
  };
}

function emitChangeReviewStatus(taskId: string, inspection: WorkspaceChangeInspection): void {
  emit(taskId, {
    type: "change-review.status",
    availability: inspection.status,
    ...(inspection.status === "error" ? { reason: inspection.reason } : {}),
  });
}

function inspectionState(inspection: WorkspaceChangeInspection) {
  return inspection.status === "available" ? inspection.state : null;
}

function updateChangeReviewOutcome(stateKey: string, message: any): void {
  if (message?.role !== "assistant") return;
  const tracker = activeChangeReviews.get(stateKey);
  if (!tracker) return;
  if (message.stopReason === "stop") tracker.current.outcome = "succeeded";
  else if (message.stopReason === "aborted") tracker.current.outcome = "aborted";
  else if (message.stopReason === "error" || message.stopReason === "length") tracker.current.outcome = "failed";
}

function trackChangeReviewWrite(stateKey: string, promise: Promise<void>): void {
  pendingChangeReviewWrites.add(promise);
  const sessionWrites = pendingChangeReviewWritesBySession.get(stateKey) ?? new Set<Promise<void>>();
  sessionWrites.add(promise);
  pendingChangeReviewWritesBySession.set(stateKey, sessionWrites);
  void promise.finally(() => {
    pendingChangeReviewWrites.delete(promise);
    sessionWrites.delete(promise);
    if (!sessionWrites.size) pendingChangeReviewWritesBySession.delete(stateKey);
  });
}

function cancelChangeReviewPreview(tracker: ActiveChangeReviewTracker): void {
  if (tracker.previewTimer) clearTimeout(tracker.previewTimer);
  tracker.previewTimer = undefined;
  tracker.previewController?.abort(new Error("Change review preview superseded"));
  tracker.previewController = undefined;
  tracker.previewRevision += 1;
}

function announceChangeReviewBaseline(
  stateKey: string,
  tracker: ActiveChangeReviewTracker,
  segment: ActiveChangeReviewSegment,
  taskId: string,
): void {
  void segment.baseline.then((inspection) => {
    if (activeChangeReviews.get(stateKey) !== tracker) return;
    if (tracker.current !== segment) return;
    emitChangeReviewStatus(taskId, inspection);
    if (inspection.status === "available") {
      emit(taskId, { type: "change-review.updated", review: emptyRunningChangeReview(taskId, segment.startedAt) });
    }
  }).catch((error) => console.error(`PfsaaHost change review baseline failed for ${taskId}`, error));
}

function startChangeReview(
  stateKey: string,
  taskId: string,
  cwd: string,
  startedAt: number,
  generateUnifiedPatch: NonNullable<Awaited<ReturnType<typeof loadAgentCoreSdk>>["generateUnifiedPatch"]> | undefined,
): void {
  if (pfsaa) {
    emit(taskId, { type: "change-review.status", availability: "not-git" });
    return;
  }
  if (!generateUnifiedPatch) {
    emit(taskId, { type: "change-review.status", availability: "error", reason: "diff-api-unavailable" });
    return;
  }
  const segment = { startedAt, baseline: inspectWorkspaceChangeState(cwd) };
  const tracker: ActiveChangeReviewTracker = { current: segment, persistence: Promise.resolve(), previewRevision: 0 };
  activeChangeReviews.set(stateKey, tracker);
  announceChangeReviewBaseline(stateKey, tracker, segment, taskId);
}

function finalizeChangeReviewSegment(
  session: any,
  stateKey: string,
  taskId: string,
  segment: ActiveChangeReviewSegment,
  finalInspection: Promise<WorkspaceChangeInspection>,
  endedAt: number,
  generateUnifiedPatch: NonNullable<Awaited<ReturnType<typeof loadAgentCoreSdk>>["generateUnifiedPatch"]> | undefined,
): Promise<void> {
  if (!generateUnifiedPatch) return Promise.resolve();
  return Promise.all([segment.baseline, finalInspection])
    .then(async ([beforeInspection, afterInspection]) => {
      if (beforeInspection.status !== "available") {
        emitChangeReviewStatus(taskId, beforeInspection);
        return;
      }
      if (afterInspection.status !== "available") {
        emitChangeReviewStatus(taskId, afterInspection);
        return;
      }
      const review = await buildSessionChangeReview(
        taskId,
        segment.startedAt,
        endedAt,
        inspectionState(beforeInspection),
        inspectionState(afterInspection),
        generateUnifiedPatch,
      );
      if (!review || sessionManagers.get(stateKey) !== session.sessionManager) return;
      if (segment.outcome) review.outcome = segment.outcome;
      let storageFailed = false;
      try {
        await persistSessionChangeReview(session, review);
      } catch (error) {
        storageFailed = true;
        console.error(`PfsaaHost change review storage failed for ${taskId}`, error);
      }
      emit(taskId, { type: "change-review.updated", review: jsonSafe(review) });
      if (storageFailed) emit(taskId, { type: "change-review.status", availability: "error", reason: "review-storage-failed" });
    })
    .catch((error) => console.error(`PfsaaHost change review failed for ${taskId}`, error));
}

function rotateChangeReview(
  session: any,
  stateKey: string,
  taskId: string,
  cwd: string,
  boundary: number,
  generateUnifiedPatch: NonNullable<Awaited<ReturnType<typeof loadAgentCoreSdk>>["generateUnifiedPatch"]> | undefined,
): void {
  const tracker = activeChangeReviews.get(stateKey);
  if (!tracker) {
    startChangeReview(stateKey, taskId, cwd, boundary, generateUnifiedPatch);
    return;
  }
  cancelChangeReviewPreview(tracker);
  const previous = tracker.current;
  const boundaryInspection = inspectWorkspaceChangeState(cwd);
  const current = { startedAt: boundary, baseline: boundaryInspection };
  tracker.current = current;
  announceChangeReviewBaseline(stateKey, tracker, current, taskId);
  tracker.persistence = tracker.persistence.then(() => finalizeChangeReviewSegment(
    session,
    stateKey,
    taskId,
    previous,
    boundaryInspection,
    boundary,
    generateUnifiedPatch,
  ));
  trackChangeReviewWrite(stateKey, tracker.persistence);
}

function finishChangeReview(
  session: any,
  stateKey: string,
  taskId: string,
  cwd: string,
  endedAt: number,
  generateUnifiedPatch: NonNullable<Awaited<ReturnType<typeof loadAgentCoreSdk>>["generateUnifiedPatch"]> | undefined,
): void {
  const tracker = activeChangeReviews.get(stateKey);
  if (!tracker) return;
  cancelChangeReviewPreview(tracker);
  activeChangeReviews.delete(stateKey);
  const finalInspection = inspectWorkspaceChangeState(cwd);
  tracker.persistence = tracker.persistence.then(() => finalizeChangeReviewSegment(
    session,
    stateKey,
    taskId,
    tracker.current,
    finalInspection,
    endedAt,
    generateUnifiedPatch,
  ));
  trackChangeReviewWrite(stateKey, tracker.persistence);
}

function previewChangeReview(
  stateKey: string,
  taskId: string,
  cwd: string,
  generateUnifiedPatch: NonNullable<Awaited<ReturnType<typeof loadAgentCoreSdk>>["generateUnifiedPatch"]> | undefined,
): void {
  const tracker = activeChangeReviews.get(stateKey);
  if (!tracker || !generateUnifiedPatch) return;
  cancelChangeReviewPreview(tracker);
  const segment = tracker.current;
  const revision = tracker.previewRevision;
  tracker.previewTimer = setTimeout(() => {
    tracker.previewTimer = undefined;
    const controller = new AbortController();
    tracker.previewController = controller;
    const previewInspection = inspectWorkspaceChangeState(cwd, controller.signal);
    void Promise.all([segment.baseline, previewInspection])
      .then(async ([beforeInspection, afterInspection]) => {
        if (beforeInspection.status !== "available" || afterInspection.status !== "available") {
          if (afterInspection.status !== "available") emitChangeReviewStatus(taskId, afterInspection);
          return;
        }
        const review = await buildSessionChangeReview(
          taskId,
          segment.startedAt,
          Date.now(),
          beforeInspection.state,
          afterInspection.state,
          generateUnifiedPatch,
          "running",
          controller.signal,
        );
        const current = activeChangeReviews.get(stateKey);
        if (!review || current !== tracker || current.current !== segment || current.previewRevision !== revision) return;
        emit(taskId, { type: "change-review.updated", review: jsonSafe(review) });
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.error(`PfsaaHost live change review failed for ${taskId}`, error);
      })
      .finally(() => {
        if (tracker.previewController === controller) tracker.previewController = undefined;
      });
  }, 180);
}

async function withChangeReviewMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = changeReviewMutationLocks.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const settled = result.then(() => undefined, () => undefined);
  changeReviewMutationLocks.set(key, settled);
  try { return await result; }
  finally { if (changeReviewMutationLocks.get(key) === settled) changeReviewMutationLocks.delete(key); }
}

async function mutateStoredReviewFile<T>(
  session: any,
  stateKey: string,
  taskId: string,
  reviewId: string,
  filePath: string,
  mutate: (file: SessionChangeFile) => Promise<{ file: SessionChangeFile; result: T; workspaceMutation?: WorkspaceReviewMutation }>,
): Promise<{ review: SessionChangeReview; result: T }> {
  return withChangeReviewMutation(`${stateKey}\0${reviewId}\0${filePath}`, async () => {
    const loaded = await loadSessionChangeReviews(session);
    const review = loaded.reviews.find((item) => item.id === reviewId);
    if (!review) throw new Error("Change review not found");
    if (review.state !== "completed") throw new Error("Wait for the run to finish before resolving changes");
    const file = review.files.find((item) => item.path === filePath);
    if (!file) throw new Error("Change review file not found");
    const mutation = await mutate(file);
    const updated = { ...review, files: review.files.map((item) => item.path === filePath ? mutation.file : item) };
    try { await persistSessionChangeReview(session, updated); }
    catch (error) {
      if (mutation.workspaceMutation) await mutation.workspaceMutation.rollback().catch(() => undefined);
      throw error;
    }
    emit(taskId, { type: "change-review.updated", review: jsonSafe(updated) });
    return { review: updated, result: mutation.result };
  });
}

type NormalizedPromptImage = { type: "image"; data: string; mimeType: string };

function normalizePromptImages(images: unknown): NormalizedPromptImage[] | undefined {
  if (!Array.isArray(images)) return undefined;

  const normalized = images
    .map((image) => {
      if (!image || typeof image !== "object") return undefined;
      const record = image as Record<string, unknown>;
      const data = typeof record.data === "string" ? record.data : undefined;
      const mimeType = typeof record.mimeType === "string" ? record.mimeType : undefined;
      if (!data || !mimeType) return undefined;
      return { type: "image", data, mimeType } as const;
    })
    .filter((image): image is NormalizedPromptImage => image !== undefined);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSessionImages(sessionManager: any): boolean {
  const entries = sessionManager.getEntries?.();
  if (!Array.isArray(entries)) return false;

  let changed = false;
  for (const entry of entries) {
    if (!entry || entry.type !== "message") continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      if (record.type == null && typeof record.data === "string" && typeof record.mimeType === "string") {
        record.type = "image";
        changed = true;
      }
    }
  }

  if (!changed) return false;

  const sessionFile = sessionManager.getSessionFile?.();
  const header = sessionManager.getHeader?.();
  if (sessionFile && header) {
    const lines = [JSON.stringify(header), ...entries.map((entry: unknown) => JSON.stringify(entry))];
    writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf8");
  }

  return true;
}

function queueState(session: any) {
  return {
    steering: [...(session.getSteeringMessages?.() ?? [])],
    followUp: [...(session.getFollowUpMessages?.() ?? [])],
    steeringMode: session.steeringMode ?? "one-at-a-time",
    followUpMode: session.followUpMode ?? "one-at-a-time",
  };
}

type QueuedPromptImage = { id: string; text: string; images: NormalizedPromptImage[] };
type QueuedPromptImageState = { steering: QueuedPromptImage[]; followUp: QueuedPromptImage[] };
type QueueDeliveryHint = { text: string; delivery: "steer" | "followUp" };

// AgentSession exposes queue text for display, while its internal queue also
// carries images. Keep stable IDs and image attachments in this PfsaaHost sidecar
// so thumbnails, promotion, and editing can rebuild the real AgentCore queue without
// silently dropping attachments.
const queuedPromptImages = new Map<string, QueuedPromptImageState>();
const queueDeliveryHints = new Map<string, QueueDeliveryHint[]>();
const queueMutationLocks = new Map<string, Promise<void>>();
const queueRebuilds = new Set<string>();

function emptyQueuedPromptImageState(): QueuedPromptImageState {
  return { steering: [], followUp: [] };
}

function queuedPromptImageState(taskId: string): QueuedPromptImageState {
  return queuedPromptImages.get(taskId) ?? emptyQueuedPromptImageState();
}

function reconcileQueuedPromptImages(taskId: string, steering: string[], followUp: string[]) {
  const previous = queuedPromptImageState(taskId);
  const reconcile = (texts: string[], entries: QueuedPromptImage[]) => {
    const remaining = [...entries];
    // AgentCore consumes queues from the front. When the queue shrinks, align from
    // the end so duplicate text keeps the newest remaining entry's stable ID;
    // appends are already tracked before AgentCore emits queue_update and align from
    // the front in normal order.
    if (entries.length > texts.length) {
      const result = new Array<QueuedPromptImage>(texts.length);
      for (let textIndex = texts.length - 1; textIndex >= 0; textIndex -= 1) {
        const text = texts[textIndex]!;
        let entryIndex = -1;
        for (let index = remaining.length - 1; index >= 0; index -= 1) {
          if (remaining[index]?.text === text) { entryIndex = index; break; }
        }
        const [entry] = remaining.splice(entryIndex >= 0 ? entryIndex : Math.max(0, remaining.length - 1), 1);
        result[textIndex] = entry ? { ...entry, text } : { id: randomUUID(), text, images: [] };
      }
      return result;
    }
    return texts.map((text) => {
      const index = remaining.findIndex((entry) => entry.text === text);
      const [entry] = remaining.splice(index >= 0 ? index : 0, 1);
      return entry ? { ...entry, text } : { id: randomUUID(), text, images: [] };
    });
  };
  queuedPromptImages.set(taskId, {
    steering: reconcile(steering, previous.steering),
    followUp: reconcile(followUp, previous.followUp),
  });
}

function setQueuedPromptImages(taskId: string, steering: QueuedPromptImage[], followUp: QueuedPromptImage[]) {
  queuedPromptImages.set(taskId, {
    steering: steering.map((entry) => ({ id: entry.id, text: entry.text, images: [...entry.images] })),
    followUp: followUp.map((entry) => ({ id: entry.id, text: entry.text, images: [...entry.images] })),
  });
}

function queuedPromptImagesForTexts(texts: string[], candidates: QueuedPromptImage[]): QueuedPromptImage[] {
  const remaining = [...candidates];
  return texts.map((text) => {
    const index = remaining.findIndex((entry) => entry.text === text);
    const [entry] = remaining.splice(index >= 0 ? index : 0, 1);
    return entry ? { ...entry, text } : { id: randomUUID(), text, images: [] };
  });
}

function queueStateWithDetails(session: any, taskId: string) {
  const current = queueState(session);
  reconcileQueuedPromptImages(taskId, current.steering, current.followUp);
  const details = queuedPromptImageState(taskId);
  const messages = (texts: string[], entries: QueuedPromptImage[]) => texts.map((text, index) => ({
    id: entries[index]?.id ?? randomUUID(),
    text,
    images: (entries[index]?.images ?? []).map((image) => ({ data: image.data, mimeType: image.mimeType })),
  }));
  const staged = manualCompactionQueues.list(taskId);
  const stagedMessages = (delivery: "steer" | "followUp") => staged
    .filter((entry) => entry.delivery === delivery)
    .map((entry) => ({
      id: entry.id,
      text: entry.text,
      images: entry.images.map((image) => ({ data: image.data, mimeType: image.mimeType })),
    }));
  return {
    steering: [...messages(current.steering, details.steering), ...stagedMessages("steer")],
    followUp: [...messages(current.followUp, details.followUp), ...stagedMessages("followUp")],
    steeringMode: current.steeringMode,
    followUpMode: current.followUpMode,
  };
}

function queueMessageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((part: any) => part?.type === "text" ? part.text : "").filter(Boolean).join("\n");
}

function recordQueueDeliveryHints(taskId: string, steering: string[], followUp: string[]) {
  if (queueRebuilds.has(taskId)) return;
  const previous = queuedPromptImageState(taskId);
  const pending = queueDeliveryHints.get(taskId) ?? [];
  const recordRemoved = (previousEntries: QueuedPromptImage[], currentTexts: string[], delivery: "steer" | "followUp") => {
    const remaining = [...currentTexts];
    for (const entry of previousEntries) {
      const index = remaining.indexOf(entry.text);
      if (index >= 0) remaining.splice(index, 1);
      else pending.push({ text: entry.text, delivery });
    }
  };
  recordRemoved(previous.steering, steering, "steer");
  recordRemoved(previous.followUp, followUp, "followUp");
  if (pending.length > 0) queueDeliveryHints.set(taskId, pending);
}

function consumeQueueDeliveryHint(taskId: string, text: string): "steer" | "followUp" | undefined {
  const pending = queueDeliveryHints.get(taskId);
  if (!pending?.length) return undefined;
  const index = pending.findIndex((hint) => hint.text === text);
  if (index < 0) return undefined;
  const [hint] = pending.splice(index, 1);
  if (pending.length > 0) queueDeliveryHints.set(taskId, pending);
  else queueDeliveryHints.delete(taskId);
  return hint.delivery;
}

function trackQueuedPrompt(taskId: string, delivery: "steer" | "followUp", text: string, images?: NormalizedPromptImage[], id: string = randomUUID()) {
  const state = queuedPromptImageState(taskId);
  const bucket = delivery === "steer" ? state.steering : state.followUp;
  bucket.push({ id, text, images: images ? [...images] : [] });
  queuedPromptImages.set(taskId, state);
}

async function withQueueMutationLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
  const previous = queueMutationLocks.get(taskId);
  let release!: () => void;
  const lock = new Promise<void>((resolve) => { release = resolve; });
  queueMutationLocks.set(taskId, lock);
  try {
    // Queue mutations are serialized rather than rejected, so rapid user
    // prompts remain ordered while promote/clear cannot interleave with them.
    await previous?.catch(() => undefined);
    return await operation();
  } finally {
    release();
    if (queueMutationLocks.get(taskId) === lock) queueMutationLocks.delete(taskId);
  }
}

async function resumeManualCompactionQueue(taskId: string, stateKey: string, session: any, resume = true): Promise<void> {
  const queued = manualCompactionQueues.drain(stateKey);
  if (!resume) {
    for (const entry of queued) {
      trackQueuedPrompt(stateKey, entry.delivery, entry.text, entry.images, entry.id);
      await (entry.delivery === "steer" ? session.steer(entry.text, entry.images) : session.followUp(entry.text, entry.images));
    }
    emit(taskId, { type: "queue_update", ...queueStateWithDetails(session, stateKey) });
    return;
  }
  emit(taskId, { type: "queue_update", ...queueStateWithDetails(session, stateKey) });
  if (queued.length === 0) return;

  const [first, ...remaining] = queued;
  const reservation = createAgentRunReservation();
  agentRunReservations.set(stateKey, reservation);
  void (async () => {
    try {
      await session.prompt(first!.text, {
        source: "interactive",
        images: first!.images,
        preflightResult: (started: boolean) => reservation.markStarted(started),
      });
    } catch (error) {
      emit(taskId, { type: "prompt_error", message: publicRuntimeError(error) });
      try { await session.abort(); } catch { /* Preserve the original prompt error. */ }
    } finally {
      reservation.markStarted(false);
      reservation.markFinished();
      if (agentRunReservations.get(stateKey) === reservation) agentRunReservations.delete(stateKey);
    }
  })();

  const started = await reservation.started;
  if (!started) return;
  await withQueueMutationLock(stateKey, async () => {
    for (const entry of remaining) {
      trackQueuedPrompt(stateKey, entry.delivery, entry.text, entry.images, entry.id);
      await session.prompt(entry.text, {
        source: "interactive",
        images: entry.images,
        streamingBehavior: entry.delivery,
      });
    }
    const current = queueState(session);
    reconcileQueuedPromptImages(stateKey, current.steering, current.followUp);
    emit(taskId, { type: "queue_update", ...queueStateWithDetails(session, stateKey) });
  });
}

async function extensionShortcuts(session: any): Promise<Array<{ key: string; description?: string }>> {
  if (!session.extensionRunner?.getShortcuts) return [];
  const sdk = await loadAgentCoreSdk();
  const keybindings = sdk.KeybindingsManager?.create(sdk.getAgentDir?.()).getEffectiveConfig() ?? {};
  return [...session.extensionRunner.getShortcuts(keybindings).entries()].map(([key, shortcut]: [string, { description?: string }]) => ({ key, description: shortcut.description }));
}

async function createPackageManagerContext(cwd: string): Promise<{ manager: any; settingsManager: any }> {
  const sdk = await loadAgentCoreSdk();
  if (!sdk.DefaultPackageManager || !sdk.SettingsManager) throw new Error("Package management is not available in this runtime");
  const agentDir = sdk.getAgentDir?.() ?? path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent");
  const { settingsManager } = createTrustAwareSettingsManager(sdk, cwd, agentDir);
  return { manager: new sdk.DefaultPackageManager({ cwd, agentDir, settingsManager }), settingsManager };
}

async function createPackageManager(cwd: string): Promise<any> {
  return (await createPackageManagerContext(cwd)).manager;
}

async function settingsContextFor(cwd: string): Promise<{ sdk: AgentCoreSdk; agentDir: string; settingsManager: any }> {
  const sdk = await loadAgentCoreSdk();
  if (!sdk.SettingsManager) throw new Error("Settings are not available in this runtime");
  const agentDir = sdk.getAgentDir?.() ?? path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent");
  return { sdk, agentDir, settingsManager: createTrustAwareSettingsManager(sdk, cwd, agentDir).settingsManager };
}

async function settingsManagerFor(cwd: string): Promise<any> {
  return (await settingsContextFor(cwd)).settingsManager;
}

function packageSourceString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "source" in value && typeof value.source === "string") return value.source;
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the parameter keeps the scope decision explicit at every callsite
function packageSettingsKey(local: boolean): "packages" {
  // Kept as a named helper so the scope decision stays explicit at every
  // callsite; AgentCore exposes separate getters/setters for the two scopes.
  return "packages";
}

function configurePackageSource(settingsManager: any, source: string, enabled: boolean, local: boolean): boolean {
  const settings = local ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
  const packages = [...(settings[packageSettingsKey(local)] ?? [])];
  const index = packages.findIndex((entry) => packageSourceString(entry) === source);
  const current = index >= 0 ? packages[index] : undefined;

  if (enabled) {
    // Remove only the package-level autoload override. Keep resource filters
    // intact; AgentCore's config TUI uses the same object-to-string cleanup rule.
    if (typeof current === "string") return false;
    if (index >= 0 && current && typeof current === "object") {
      if (current.autoload !== false) return false;
      const next = { ...current };
      delete next.autoload;
      const hasFilters = ["extensions", "skills", "prompts", "themes"].some((key) => next[key] !== undefined);
      packages[index] = hasFilters ? next : next.source;
    }
    else packages.push(source);
  } else {
    // Disabling is an autoload override, not removal. Preserve any existing
    // resource filters while forcing the package itself to stay unloaded.
    if (index < 0) packages.push({ source, autoload: false });
    else if (typeof current === "string") packages[index] = { source: current, autoload: false };
    else if (current && typeof current === "object" && current.autoload !== false) packages[index] = { ...current, autoload: false };
    else return false;
  }

  if (local) settingsManager.setProjectPackages(packages);
  else settingsManager.setPackages(packages);
  return true;
}

async function listWorkspaceFiles(cwd: string): Promise<Array<{ path: string; kind: "file" | "directory"; size?: number }>> {
  const files: Array<{ path: string; kind: "file" | "directory"; size?: number }> = [];
  const ignored = new Set([".git", "node_modules", "dist", "dist-renderer", ".cache"]);
  async function walk(directory: string, relative = "", depth = 0): Promise<void> {
    if (depth > 4) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name)) continue;
      const entryRelative = relative ? path.join(relative, entry.name) : entry.name;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push({ path: entryRelative.replaceAll("\\", "/"), kind: "directory" });
        await walk(entryPath, entryRelative, depth + 1);
      } else if (entry.isFile()) {
        try {
          files.push({ path: entryRelative.replaceAll("\\", "/"), kind: "file", size: (await stat(entryPath)).size });
        } catch {
          files.push({ path: entryRelative.replaceAll("\\", "/"), kind: "file" });
        }
      }
    }
  }
  await walk(cwd);
  return files;
}

async function gitChanges(cwd: string): Promise<Array<{ path: string; status: string; additions: number; deletions: number }>> {
  try {
    const [statusOutput, statOutput] = await Promise.all([
      execFileText("git", ["-C", cwd, "status", "--porcelain", "--untracked-files=all"], { timeout: 10_000 }),
      execFileText("git", ["-C", cwd, "diff", "--numstat", "HEAD"], { timeout: 10_000 }),
    ]);
    const numstat = new Map<string, { additions: number; deletions: number }>();
    for (const line of statOutput.split(/\r?\n/)) {
      const match = /^(\d+|-)\s+(\d+|-)\s+(.+)$/.exec(line.trim());
      if (match) numstat.set(match[3].replaceAll("\\", "/"), { additions: Number(match[1] === "-" ? 0 : match[1]), deletions: Number(match[2] === "-" ? 0 : match[2]) });
    }
    return statusOutput.split(/\r?\n/).filter(Boolean).map((line) => {
      const status = line.slice(0, 2).trim() || "?";
      const rawPath = line.slice(3).replace(/^".* -> /, "").replace(/^"|"$/g, "");
      return { path: rawPath.replaceAll("\\", "/"), status, ...(numstat.get(rawPath) ?? { additions: 0, deletions: 0 }) };
    });
  } catch {
    return [];
  }
}

async function listSlashCommands(session: any) {
  const builtins = (await import(pathToFileURL(path.join(path.dirname(resolveAgentCoreModule()), "core", "slash-commands.js")).href)).BUILTIN_SLASH_COMMANDS as Array<{ name: string; description?: string; argumentHint?: string }>;
  const prompts = session.resourceLoader?.getPrompts?.().prompts?.map((prompt: any) => ({ name: prompt.name, description: prompt.description })) ?? [];
  const skills = session.resourceLoader?.getSkills?.().skills?.map((skill: any) => ({ name: `skill:${skill.name}`, description: skill.description })) ?? [];
  const extensionCommands = session.extensionRunner?.getRegisteredCommands?.().map((command: any) => ({
    name: command.invocationName ?? command.name,
    description: command.description,
    source: "extension",
  })) ?? [];
  return { builtins: jsonSafe([...builtins, ...extensionCommands]), prompts: jsonSafe(prompts), skills: jsonSafe(skills) };
}

const packageResourceSettingKey: Record<AgentCorePackageResourceType, "extensions" | "skills" | "prompts" | "themes"> = {
  extension: "extensions",
  skill: "skills",
  prompt: "prompts",
  theme: "themes",
};

function configurePackageResource(settingsManager: any, source: string, type: AgentCorePackageResourceType, resourcePath: string, enabled: boolean, local: boolean): boolean {
  const normalizedPath = resourcePath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalizedPath || path.posix.isAbsolute(normalizedPath) || normalizedPath.split("/").includes("..")) {
    throw new Error("Package resource path must stay inside the package");
  }
  const settings = local ? settingsManager.getProjectSettings() : settingsManager.getGlobalSettings();
  const packages = [...(settings[packageSettingsKey(local)] ?? [])];
  const index = packages.findIndex((entry) => packageSourceString(entry) === source);
  if (index < 0) throw new Error(`Package is not configured in this scope: ${source}`);
  const current = packages[index];
  const next = typeof current === "string" ? { source: current } : { ...current };
  const settingKey = packageResourceSettingKey[type];
  const includePattern = `+${normalizedPath}`;
  const excludePattern = `-${normalizedPath}`;
  const patterns = Array.isArray(next[settingKey])
    ? next[settingKey].filter((pattern: string) => pattern !== includePattern && pattern !== excludePattern)
    : [];
  patterns.push(enabled ? includePattern : excludePattern);
  next[settingKey] = patterns;
  packages[index] = next;
  if (local) settingsManager.setProjectPackages(packages);
  else settingsManager.setPackages(packages);
  return true;
}

async function listPackageResources(manager: any, configuredPackage: any): Promise<Array<{ type: AgentCorePackageResourceType; path: string; enabled: boolean }>> {
  let unfiltered: any;
  try {
    unfiltered = await manager.resolveExtensionSources([configuredPackage.source], { local: configuredPackage.scope === "project" });
  } catch {
    return [];
  }
  let effective: any = { extensions: [], skills: [], prompts: [], themes: [] };
  try { effective = await manager.resolve(async () => "skip"); } catch { /* Keep installed resources visible even when another package is missing. */ }
  const effectiveByPath = new Map<string, boolean>();
  for (const plural of ["extensions", "skills", "prompts", "themes"] as const) {
    for (const resource of effective?.[plural] ?? []) effectiveByPath.set(path.resolve(resource.path), resource.enabled !== false);
  }
  const types: Array<[AgentCorePackageResourceType, "extensions" | "skills" | "prompts" | "themes"]> = [
    ["extension", "extensions"], ["skill", "skills"], ["prompt", "prompts"], ["theme", "themes"],
  ];
  return types.flatMap(([type, plural]) => (unfiltered?.[plural] ?? []).flatMap((resource: any) => {
    const baseDir = resource.metadata?.baseDir ?? configuredPackage.installedPath;
    if (!baseDir) return [];
    const relativePath = path.relative(baseDir, resource.path).replaceAll("\\", "/");
    if (!relativePath || relativePath === ".." || relativePath.startsWith("../")) return [];
    return [{ type, path: relativePath, enabled: effectiveByPath.get(path.resolve(resource.path)) === true }];
  }));
}

function scopedModelSelections(session: any): ScopedModelSelection[] {
  if (!Array.isArray(session.scopedModels)) return [];
  return session.scopedModels.flatMap((item: any) => item?.model?.provider && item?.model?.id
    ? [{
        providerId: item.model.provider,
        modelId: item.model.id,
        ...(typeof item.thinkingLevel === "string" ? { thinkingLevel: item.thinkingLevel } : {}),
      }]
    : []);
}

function firstUserText(manager: any): string {
  for (const entry of manager.getEntries?.() ?? []) {
    if (entry?.type === "message" && entry.message?.role === "user") {
      const content = entry.message.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
    }
  }
  return "";
}

function changelogPath(): string {
  const moduleDir = path.dirname(resolveAgentCoreModule());
  const candidates = [path.join(moduleDir, "CHANGELOG.md"), path.join(moduleDir, "..", "CHANGELOG.md")];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function sdkVersion(): string | null {
  try {
    const moduleDir = path.dirname(resolveAgentCoreModule());
    const packageJson = JSON.parse(readFileSync(path.join(moduleDir, "..", "package.json"), "utf8")) as { version?: string };
    return packageJson.version ?? null;
  } catch {
    return null;
  }
}

function taskSummaryFromAgentSession(session: any, cwd: string) {
  const taskId = session.sessionId ?? session.sessionManager?.getSessionId?.();
  const titleSource = session.sessionName || session.sessionManager?.getSessionName?.() || firstUserText(session.sessionManager);
  return {
    id: taskId,
    title: deriveSessionTitle(titleSource) || session.sessionName || taskId.slice(0, 8),
    projectId: cwd,
    state: "idle" as const,
    model: session.model ? `${session.model.provider}/${session.model.id}` : "No model selected",
    updatedAt: new Date().toISOString(),
  };
}

async function ensureAgentSession(taskId: string, cwd: string): Promise<any> {
  const stateKey = sessionStateKey(taskId, cwd);
  const existing = agentSessions.get(stateKey);
  if (existing) {
    const sessionRevision = agentSessionRevisions.get(stateKey);
    const sessionPackageRevision = agentSessionPackageRevisions.get(stateKey);
    if ((sessionRevision === permissionEngine.revision && sessionPackageRevision === packageConfigRevision) || existing.isStreaming || agentRunReservations.has(stateKey)) {
      if (!existing.isStreaming) normalizeSessionImages(existing.sessionManager);
      return existing;
    }
    // Do not interrupt an active turn. Once idle, recreate against the new
    // extension configuration while keeping the same AgentCore SessionManager/file.
    const existingRuntime = agentSessionRuntimes.get(stateKey);
    if (existingRuntime?.dispose) await existingRuntime.dispose();
    else existing.dispose?.();
    agentSessions.delete(stateKey);
    agentSessionRuntimes.delete(stateKey);
    agentSessionRevisions.delete(stateKey);
    agentSessionPackageRevisions.delete(stateKey);
    // Queue contents live only on AgentSession. Drop renderer-side queue
    // sidecars and delivery hints when the idle session is recreated.
    queuedPromptImages.delete(stateKey);
    queueDeliveryHints.delete(stateKey);
    queueRebuilds.delete(stateKey);
    clearAgentRunReservation(stateKey);
  }
  const pending = agentSessionPromises.get(stateKey);
  if (pending) return pending;

  const creationRevision = permissionEngine.revision;
  const creation = (async () => {
    const sdk = await loadAgentCoreSdk();
    if (!sdk.AgentSessionRuntime) throw new Error("The installed runtime module does not expose AgentSessionRuntime");
    const agentDir = sdk.getAgentDir?.() ?? path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent");
    const modelRuntime = await getModelRuntime();
    let manager = sessionManagers.get(stateKey);
    if (!manager) {
      // A restart can receive a session operation before sessions.list warms
      // this cache. Never silently replace that persisted ID with a new one.
      let sessionPath = sessionFiles.get(stateKey);
      if (!sessionPath) {
        const persisted = (await sdk.SessionManager.list(cwd, pfsaa?.sessionDir)).find((session) => session.id === taskId);
        sessionPath = persisted?.path;
        if (sessionPath) sessionFiles.set(stateKey, sessionPath);
      }
      if (!sessionPath) throw new Error(`The session no longer exists: ${taskId}. Refresh the session list or create a new session.`);
      manager = sdk.SessionManager.open(sessionPath, pfsaa?.sessionDir, pfsaa ? cwd : undefined);
      sessionManagers.set(stateKey, manager);
    }
    normalizeSessionImages(manager);

    const createRuntime = async (options: { cwd: string; agentDir: string; sessionManager: any; sessionStartEvent?: any }) => {
      const { settingsManager } = createTrustAwareSettingsManager(sdk, options.cwd, options.agentDir);
      const resourceLoader = sdk.DefaultResourceLoader
        ? new sdk.DefaultResourceLoader(resourceLoaderOptions(sdk, options.cwd, options.agentDir, settingsManager))
        : undefined;
      await resourceLoader?.reload?.();
      const modelPatterns = settingsManager?.getEnabledModels?.();
      const scopeResult = Array.isArray(modelPatterns) && modelPatterns.length > 0 && sdk.resolveModelScopeWithDiagnostics
        ? await sdk.resolveModelScopeWithDiagnostics(modelPatterns, modelRuntime, { signal: AbortSignal.timeout(15_000) })
        : { scopedModels: [], diagnostics: [] };
      const created = await sdk.createAgentSession({
        cwd: options.cwd,
        agentDir: options.agentDir,
        sessionManager: options.sessionManager,
        modelRuntime,
        resourceLoader,
        settingsManager,
        scopedModels: scopeResult.scopedModels,
        sessionStartEvent: options.sessionStartEvent,
      });
      const extensionErrors = created.extensionsResult?.errors ?? created.session.resourceLoader?.getExtensions?.().errors ?? [];
      const diagnostics = [
        ...scopeResult.diagnostics,
        ...extensionErrors.map((error: { path: string; error: string }) => ({ type: "error", message: error.error, path: error.path })),
      ];
      return {
        ...created,
        services: {
          cwd: options.cwd,
          agentDir: options.agentDir,
          modelRuntime,
          settingsManager: settingsManager ?? created.session.settingsManager,
          resourceLoader: resourceLoader ?? created.session.resourceLoader,
          diagnostics,
        },
        diagnostics,
      };
    };

    const initial = await createRuntime({ cwd, agentDir, sessionManager: manager });
    const runtime = new sdk.AgentSessionRuntime(initial.session, initial.services, createRuntime, initial.diagnostics, initial.modelFallbackMessage);
    const binding = { taskId, cwd, stateKey };

    const resourceDiagnostics = (session: any, baseDiagnostics: any[] = []) => {
      const diagnostics = [...baseDiagnostics];
      for (const getter of ["getSkills", "getPrompts", "getThemes"] as const) {
        const result = session.resourceLoader?.[getter]?.();
        if (Array.isArray(result?.diagnostics)) diagnostics.push(...result.diagnostics);
      }
      const extensions = session.resourceLoader?.getExtensions?.();
      for (const error of extensions?.errors ?? []) diagnostics.push({ type: "error", message: error.error, path: error.path });
      diagnostics.push(...(session.extensionRunner?.getCommandDiagnostics?.() ?? []));
      diagnostics.push(...(session.extensionRunner?.getShortcutDiagnostics?.() ?? []));
      const seen = new Set<string>();
      return diagnostics.filter((diagnostic: any) => {
        const key = JSON.stringify([diagnostic?.type, diagnostic?.message, diagnostic?.path]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    const emitSessionSnapshot = (replace = true) => {
      emit(binding.taskId, {
        type: "message.snapshot",
        replace,
        messages: jsonSafe(sessionTranscriptMessages(runtime.session, sdk.sessionEntryToContextMessages)),
      });
    };

    const reloadExtensions = async () => {
      const session = runtime.session;
      if (session.isStreaming || session.isCompacting || agentRunReservations.has(binding.stateKey)) {
        throw new Error("Wait for the current agent run or compaction to finish before reloading extensions");
      }
      await session.reload({ beforeSessionStart: () => permissionEngine.resetUi(binding.taskId) });
      agentSessionPackageRevisions.set(binding.stateKey, packageConfigRevision);
      agentSessionRevisions.set(binding.stateKey, permissionEngine.revision);
      const diagnostics = resourceDiagnostics(session, runtime.diagnostics as any[]);
      if (diagnostics.length) emit(binding.taskId, { type: "extension.diagnostics", diagnostics: jsonSafe(diagnostics) });
      emitSessionSnapshot(true);
    };

    const bindSession = async (session: any, diagnostics: any[] = []) => {
      const boundTaskId = binding.taskId;
      const boundCwd = binding.cwd;
      const boundStateKey = binding.stateKey;
      const permissionExtensionPath = pfsaa ? undefined : resolvePermissionExtensionPath();
      const permissionExtensionLoaded = Boolean(permissionExtensionPath && session.extensionRunner?.getRegisteredCommands?.().some((command: any) => (command.invocationName ?? command.name) === "permission-system"));
      const [initialGitBranch, modelRuntime] = await Promise.all([
        execFileText("git", ["branch", "--show-current"], { cwd: boundCwd, timeout: 1_000 }).then((value) => value.trim() || "detached").catch(() => null),
        getModelRuntime(),
      ]);
      let gitBranch = initialGitBranch;
      const footerData = {
        getGitBranch: () => gitBranch,
        getProviderCount: () => modelRuntime.getProviders().filter((provider: any) => modelRuntime.getModels(provider.id).length > 0).length,
        onBranchChange: (callback: () => void) => {
          let checking = false;
          const timer = setInterval(() => {
            if (checking) return;
            checking = true;
            void execFileText("git", ["branch", "--show-current"], { cwd: boundCwd, timeout: 1_000 })
              .then((value) => value.trim() || "detached")
              .catch(() => null)
              .then((nextBranch) => {
                if (nextBranch === gitBranch) return;
                gitBranch = nextBranch;
                try { callback(); } catch { /* Extension callbacks must not break the Host watcher. */ }
              })
              .finally(() => { checking = false; });
          }, 2_000);
          timer.unref();
          return () => clearInterval(timer);
        },
      };
      // PFSAA adapts AgentCore's interactive component surfaces, so extensions see
      // the same TUI-capable mode they use in AgentCore's interactive application.
      const extensionUiContext = permissionEngine.createUi(
        boundTaskId,
        boundStateKey,
        sdk.themeApi ? createExtensionTheme(sdk.themeApi, session, (snapshot) => emit(boundTaskId, { type: "extension.ui.presentation", action: "theme", theme: snapshot })) : undefined,
        sdk.KeybindingsManager?.create(sdk.getAgentDir?.()),
        footerData,
      );
      await session.bindExtensions?.({
        uiContext: extensionUiContext,
        mode: "tui",
        commandContextActions: {
          waitForIdle: () => runtime.session.waitForIdle(),
          newSession: async (options: any) => {
            const result = await runtime.newSession(options);
            if (!result.cancelled) emitSessionSnapshot(true);
            return result;
          },
          fork: async (entryId: string, options: any) => {
            const result = await runtime.fork(entryId, options);
            if (!result.cancelled) {
              if (result.selectedText) emit(binding.taskId, { type: "extension.ui.presentation", action: "editor-text", text: result.selectedText });
              emitSessionSnapshot(true);
            }
            return { cancelled: result.cancelled };
          },
          navigateTree: async (targetId: string, options: any) => {
            const result = await runtime.session.navigateTree(targetId, options);
            if (!result.cancelled) {
              if (result.editorText) emit(binding.taskId, { type: "extension.ui.presentation", action: "editor-text", text: result.editorText });
              emitSessionSnapshot(true);
            }
            return { cancelled: result.cancelled };
          },
          switchSession: async (sessionPath: string, options: any) => {
            const result = await runtime.switchSession(sessionPath, options);
            if (!result.cancelled) emitSessionSnapshot(true);
            return result;
          },
          reload: reloadExtensions,
        },
        shutdownHandler: () => emit(binding.taskId, { type: "extension.shutdown.requested" }),
        onError: (error: any) => emit(binding.taskId, {
          type: "extension.error",
          extensionPath: error?.extensionPath,
          event: error?.event,
          error: publicRuntimeError(error?.error ?? "Unknown extension error"),
        }),
      });
      const previousBeforeToolCall = session.agent.beforeToolCall;
      session.agent.beforeToolCall = (context: any, signal?: AbortSignal) => permissionEngine.beforeToolCallWithExtension(
        boundTaskId,
        context,
        previousBeforeToolCall,
        permissionExtensionLoaded,
        signal,
        boundStateKey,
      );
      const loadedDiagnostics = resourceDiagnostics(session, diagnostics);
      if (loadedDiagnostics.length) emit(boundTaskId, { type: "extension.diagnostics", diagnostics: jsonSafe(loadedDiagnostics) });

      session.subscribe((event: any) => {
      try {
        if (event.type === "queue_update") {
          // A clear-and-rebuild mutation is exposed atomically through its IPC
          // response; suppress AgentCore's intermediate empty/partial queue events so
          // the Renderer cannot edit or promote a transient row.
          if (queueRebuilds.has(boundStateKey)) return;
          const steering = Array.isArray(event.steering) ? event.steering : [];
          const followUp = Array.isArray(event.followUp) ? event.followUp : [];
          recordQueueDeliveryHints(boundStateKey, steering, followUp);
          reconcileQueuedPromptImages(boundStateKey, steering, followUp);
          emit(boundTaskId, { type: "queue_update", ...queueStateWithDetails(session, boundStateKey) });
          return;
        }
        // A delivery hint is only meaningful until the current agent run is
        // settled. If AgentCore aborts or drops a queued message without emitting its
        // message_start event, discard the hint so a later identical prompt
        // cannot inherit the wrong steering/follow-up classification.
        if (event.type === "agent_settled") queueDeliveryHints.delete(boundStateKey);
        if (event.type === "agent_start") {
          const startedAt = Date.now();
          executionGroupStarts.set(boundStateKey, startedAt);
          startChangeReview(boundStateKey, boundTaskId, boundCwd, startedAt, sdk.generateUnifiedPatch);
        }
        if (event.type === "agent_settled") {
          const endedAt = Date.now();
          finishExecutionGroup(session, boundStateKey, boundTaskId, endedAt);
          finishChangeReview(session, boundStateKey, boundTaskId, boundCwd, endedAt, sdk.generateUnifiedPatch);
        }
        if (event.type === "message_start" && event.message?.role === "user") {
          const queueDelivery = consumeQueueDeliveryHint(boundStateKey, queueMessageText(event.message));
          if (queueDelivery === "followUp") {
            const boundary = Date.now();
            finishExecutionGroup(session, boundStateKey, boundTaskId, boundary);
            executionGroupStarts.set(boundStateKey, boundary);
            rotateChangeReview(session, boundStateKey, boundTaskId, boundCwd, boundary, sdk.generateUnifiedPatch);
          } else if (!executionGroupStarts.has(boundStateKey)) {
            const startedAt = Date.now();
            executionGroupStarts.set(boundStateKey, startedAt);
            startChangeReview(boundStateKey, boundTaskId, boundCwd, startedAt, sdk.generateUnifiedPatch);
          }
          emit(boundTaskId, normalizeAgentEvent(event, queueDelivery));
          return;
        }
        if (event.type === "message_end") updateChangeReviewOutcome(boundStateKey, event.message);
        if (event.type === "agent_end" && Array.isArray(event.messages)) {
          updateChangeReviewOutcome(boundStateKey, [...event.messages].reverse().find((message: any) => message?.role === "assistant"));
        }
        if (event.type === "tool_execution_end" && /^(?:edit|write|bash|powershell)$/i.test(event.toolName ?? "")) {
          previewChangeReview(boundStateKey, boundTaskId, boundCwd, sdk.generateUnifiedPatch);
        }
        emit(boundTaskId, normalizeAgentEvent(event));
      } catch (error) {
        console.error(`PfsaaHost agent event handler failed for ${boundTaskId}`, error);
      }
    });
    session.subscribe((event: any) => {
      try {
        if (event.type === "message_end") {
          // AgentSession persists the message immediately after notifying its
          // subscribers. Defer the snapshot one tick so the renderer receives
          // the completed assistant reply before the next queued message starts.
          setTimeout(() => emit(boundTaskId, { type: "message.snapshot", messages: jsonSafe(sessionTranscriptMessages(session, sdk.sessionEntryToContextMessages)) }), 0);
        } else if (event.type === "agent_settled") {
          emit(boundTaskId, { type: "message.snapshot", messages: jsonSafe(sessionTranscriptMessages(session, sdk.sessionEntryToContextMessages)) });
        } else if (event.type === "compaction_end") {
          // AgentSession.messages now contains only the compacted model context,
          // but the display transcript still comes from every persisted entry
          // on the active Session branch. Replace the Renderer snapshot so a
          // branch/compaction boundary is applied authoritatively without
          // hiding the summarized prefix after a later restart.
          emit(boundTaskId, { type: "message.snapshot", replace: true, messages: jsonSafe(sessionTranscriptMessages(session, sdk.sessionEntryToContextMessages)) });
        }
      } catch (error) {
        console.error(`PfsaaHost message snapshot handler failed for ${boundTaskId}`, error);
      }
    });
    };

    runtime.setBeforeSessionInvalidate?.(() => {
      permissionEngine.resetUi(binding.taskId);
      permissionEngine.dispose(binding.stateKey);
    });
    runtime.setRebindSession?.(async (session: any) => {
      const previousTaskId = binding.taskId;
      const previousStateKey = binding.stateKey;
      const nextCwd = runtime.cwd;
      const nextTaskId = session.sessionId;
      const nextStateKey = sessionStateKey(nextTaskId, nextCwd);
      binding.taskId = nextTaskId;
      binding.cwd = nextCwd;
      binding.stateKey = nextStateKey;
      agentSessions.delete(previousStateKey);
      agentSessionRuntimes.delete(previousStateKey);
      agentSessionRevisions.delete(previousStateKey);
      agentSessionPackageRevisions.delete(previousStateKey);
      queuedPromptImages.delete(previousStateKey);
      queueDeliveryHints.delete(previousStateKey);
      queueRebuilds.delete(previousStateKey);
      clearAgentRunReservation(previousStateKey);
      sessionManagers.set(nextStateKey, session.sessionManager);
      const nextSessionFile = session.sessionFile;
      if (nextSessionFile) sessionFiles.set(nextStateKey, nextSessionFile);
      agentSessions.set(nextStateKey, session);
      agentSessionRuntimes.set(nextStateKey, runtime);
      agentSessionRevisions.set(nextStateKey, permissionEngine.revision);
      agentSessionPackageRevisions.set(nextStateKey, packageConfigRevision);
      await bindSession(session, runtime.diagnostics as any[]);
      emit(previousTaskId, {
        type: "session.replaced",
        previousTaskId,
        task: taskSummaryFromAgentSession(session, nextCwd),
      });
      if (runtime.modelFallbackMessage) emit(nextTaskId, { type: "model.fallback", message: runtime.modelFallbackMessage });
    });

    await bindSession(initial.session, initial.diagnostics);
    agentSessions.set(stateKey, initial.session);
    agentSessionRuntimes.set(stateKey, runtime);
    agentSessionRevisions.set(stateKey, creationRevision);
    agentSessionPackageRevisions.set(stateKey, packageConfigRevision);
    if (initial.modelFallbackMessage) emit(taskId, { type: "model.fallback", message: initial.modelFallbackMessage });
    return initial.session;
  })();
  agentSessionPromises.set(stateKey, creation);
  try {
    return await creation;
  } finally {
    agentSessionPromises.delete(stateKey);
  }
}

function invalidateResourceSessions(): void {
  packageConfigRevision += 1;
  capabilitySessions.clear();
}

async function ensureCapabilitySession(cwd: string): Promise<any> {
  const existing = capabilitySessions.get(cwd);
  if (existing) return existing;
  const sdk = await loadAgentCoreSdk();
  const agentDir = sdk.getAgentDir?.() ?? path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent");
  const { settingsManager } = createTrustAwareSettingsManager(sdk, cwd, agentDir);
  const resourceLoader = sdk.DefaultResourceLoader
    ? new sdk.DefaultResourceLoader(resourceLoaderOptions(sdk, cwd, agentDir, settingsManager))
    : undefined;
  await resourceLoader?.reload?.();
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    modelRuntime: await getModelRuntime(),
    settingsManager,
    resourceLoader,
  });
  capabilitySessions.set(cwd, session);
  return session;
}

async function handle(request: PfsaaHostRequest): Promise<void> {
  try {
    validatePfsaaHostPayload(request.command, request.payload);
    if (pfsaa) {
      const payload = request.payload as { cwd?: unknown } | undefined;
      assertPfsaaCwd(payload?.cwd, pfsaa);
      if (request.command.startsWith("packages.") || [
        "projects.setTrust", "sessions.import", "sessions.share", "sessions.changeReview", "sessions.resolveChangeReviewHunk",
        "sessions.changeReviewMergeSource", "sessions.applyChangeReviewMerge",
      ].includes(request.command)) throw new Error(`PFSAA does not support ${request.command} in this release.`);
    }
    await httpNetworkingReady;
    switch (request.command) {
      case "runtime.status":
        send({ id: request.id, ok: true, result: "connected" });
        return;
      case "runtime.shutdown": {
        const deadline = Date.now() + 3_000;
        while (pendingChangeReviewWrites.size && Date.now() < deadline) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            Promise.allSettled([...pendingChangeReviewWrites]),
            new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(1, deadline - Date.now())); }),
          ]);
          if (timer) clearTimeout(timer);
        }
        await Promise.allSettled([...sessionManagers.values()].map((manager) => flushSessionChangeReviewStore(manager)));
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "app.changelog": {
        send({ id: request.id, ok: true, result: existsSync(changelogPath()) ? readFileSync(changelogPath(), "utf8") : "" });
        return;
      }
      case "app.info": {
        send({ id: request.id, ok: true, result: { version: sdkVersion() } });
        return;
      }
      case "projects.list": {
        if (pfsaa) {
          const sessions = await (await loadAgentCoreSdk()).SessionManager.list(pfsaa.runtime, pfsaa.sessionDir);
          send({ id: request.id, ok: true, result: [{ id: pfsaa.runtime, cwd: pfsaa.runtime, name: "PFSAA", taskCount: sessions.length }] });
          return;
        }
        const currentCwd = path.resolve(resolveWorkspaceCwd());
        const knownCwds = typeof request.payload === "object" && request.payload && "knownCwds" in request.payload && Array.isArray(request.payload.knownCwds)
          ? request.payload.knownCwds.filter((cwd): cwd is string => typeof cwd === "string" && existsSync(cwd)).map((cwd) => path.resolve(cwd))
          : [];
        const sessions = await (await loadAgentCoreSdk()).SessionManager.listAll();
        const projects = new Map<string, { id: string; cwd: string; name: string; taskCount: number; updatedAt: number }>();
        for (const session of sessions) {
          if (typeof session?.cwd !== "string" || !session.cwd || !existsSync(session.cwd)) continue;
          const cwd = path.resolve(session.cwd);
          const key = process.platform === "win32" ? cwd.toLowerCase() : cwd;
          const existing = projects.get(key);
          const modified = new Date(session.modified ?? 0).getTime();
          if (existing) {
            existing.taskCount += 1;
            existing.updatedAt = Math.max(existing.updatedAt, modified);
          } else {
            projects.set(key, {
              id: cwd,
              cwd,
              name: path.basename(cwd) || cwd,
              taskCount: 1,
              updatedAt: modified,
            });
          }
        }
        const currentKey = process.platform === "win32" ? currentCwd.toLowerCase() : currentCwd;
        if (!projects.has(currentKey)) {
          projects.set(currentKey, {
            id: currentCwd,
            cwd: currentCwd,
            name: path.basename(currentCwd) || currentCwd,
            taskCount: 0,
            updatedAt: Date.now(),
          });
        }
        for (const [index, cwd] of knownCwds.entries()) {
          const key = process.platform === "win32" ? cwd.toLowerCase() : cwd;
          const existing = projects.get(key);
          const updatedAt = Date.now() + knownCwds.length - index;
          if (existing) existing.updatedAt = Math.max(existing.updatedAt, updatedAt);
          else projects.set(key, {
            id: cwd,
            cwd,
            name: path.basename(cwd) || cwd,
            taskCount: 0,
            updatedAt,
          });
        }
        send({
          id: request.id,
          ok: true,
          result: [...projects.values()]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(({ updatedAt: _updatedAt, ...project }) => project),
        });
        return;
      }
      case "projects.trustStatus": {
        const payload = request.payload as { cwd?: string } | undefined;
        if (!payload?.cwd) throw new Error("cwd is required");
        const sdk = await loadAgentCoreSdk();
        const agentDir = sdk.getAgentDir?.() ?? path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent");
        send({ id: request.id, ok: true, result: readProjectTrustStatus(sdk, payload.cwd, agentDir) });
        return;
      }
      case "projects.setTrust": {
        const payload = request.payload as { cwd?: string; trusted?: boolean } | undefined;
        if (!payload?.cwd || typeof payload.trusted !== "boolean") throw new Error("cwd and trusted are required");
        const sdk = await loadAgentCoreSdk();
        const agentDir = sdk.getAgentDir?.() ?? path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent");
        if (!sdk.ProjectTrustStore) throw new Error("Project trust is not available in this runtime");
        new sdk.ProjectTrustStore(agentDir).set(canonicalProjectPath(payload.cwd), payload.trusted);
        invalidateResourceSessions();
        send({ id: request.id, ok: true, result: readProjectTrustStatus(sdk, payload.cwd, agentDir) });
        return;
      }
      case "sessions.list": {
        const cwd = typeof request.payload === "object" && request.payload && "cwd" in request.payload && typeof request.payload.cwd === "string"
          ? request.payload.cwd
          : resolveWorkspaceCwd();
        const sdk = await loadAgentCoreSdk();
        const sessions = await sdk.SessionManager.list(cwd, pfsaa?.sessionDir);
        for (const session of sessions) sessionFiles.set(sessionStateKey(session.id, cwd), session.path);
        send({
          id: request.id,
          ok: true,
          result: sessions.map((session: any) => {
            const storedName = typeof session.name === "string" ? session.name : "";
            const firstMessage = typeof session.firstMessage === "string" ? session.firstMessage : "";
            const titleSource = isDefaultSessionTitle(storedName) || isCommandDerivedSessionTitle(storedName)
              ? firstMessage
              : storedName || firstMessage;
            return {
              id: session.id,
              title: deriveSessionTitle(titleSource) || storedName || session.id.slice(0, 8),
              projectId: cwd,
              state: "idle",
              model: sessionModelLabel(session, sdk),
              updatedAt: new Date(session.modified ?? Date.now()).toISOString(),
            };
          }),
        });
        return;
      }
      case "models.list": {
        const runtime = await getModelRuntime();
        const providers = runtime.getProviders();
        const models = providers.flatMap((provider: any) => {
          const auth = runtime.getProviderAuthStatus(provider.id);
          return runtime.getModels(provider.id).map((model: any) => modelSummary(provider, model, Boolean(auth.configured)));
        });
        send({ id: request.id, ok: true, result: jsonSafe(models) });
        return;
      }
      case "models.refresh": {
        const runtime = await getModelRuntime();
        const refresh = await runtime.refresh({ signal: AbortSignal.timeout(30_000), allowNetwork: true });
        if (refresh?.aborted) throw new Error("Model catalog refresh was cancelled");
        const errors = refresh?.errors instanceof Map ? [...refresh.errors.values()] : [];
        if (errors.length) throw new Error(`Model catalog refresh failed: ${publicRuntimeError(errors[0])}`);
        const models = runtime.getProviders().flatMap((provider: any) => {
          const auth = runtime.getProviderAuthStatus(provider.id);
          return runtime.getModels(provider.id).map((model: any) => modelSummary(provider, model, Boolean(auth.configured)));
        });
        send({ id: request.id, ok: true, result: jsonSafe(models) });
        return;
      }
      case "workspace.snapshot": {
        const payload = request.payload as { cwd?: string } | undefined;
        const cwd = payload?.cwd ?? resolveWorkspaceCwd();
        if (pfsaa) {
          send({ id: request.id, ok: true, result: { cwd, files: [], changes: [], refreshedAt: new Date().toISOString() } });
          return;
        }
        send({
          id: request.id,
          ok: true,
          result: {
            cwd,
            files: await listWorkspaceFiles(cwd),
            changes: await gitChanges(cwd),
            refreshedAt: new Date().toISOString(),
          },
        });
        return;
      }
      case "input.keybindings": {
        const sdk = await loadAgentCoreSdk();
        if (!sdk.KeybindingsManager) throw new Error("This runtime does not expose configurable keybindings");
        const bindings = sdk.KeybindingsManager.create(sdk.getAgentDir?.()).getEffectiveConfig();
        send({
          id: request.id,
          ok: true,
          result: Object.fromEntries(Object.entries(bindings).map(([action, keys]) => [action, Array.isArray(keys) ? keys : [keys]])),
        });
        return;
      }
      case "input.externalEdit": {
        const payload = request.payload as { content?: string; cwd?: string } | undefined;
        const cwd = payload?.cwd ?? resolveWorkspaceCwd();
        const sdk = await loadAgentCoreSdk();
        const editInExternalEditor = sdk.editInExternalEditor;
        if (!editInExternalEditor) throw new Error("This runtime does not expose the external editor helper");
        const settingsManager = await settingsManagerFor(cwd);
        const command = settingsManager.getExternalEditorCommand?.();
        if (!command) throw new Error("No external editor is configured. Set externalEditor in settings or set VISUAL/EDITOR.");
        const result = await withExternalEditorPathAliases(command, (adaptedCommand) => editInExternalEditor({ command: adaptedCommand, content: payload?.content ?? "" }));
        if (result.status !== "complete") throw new Error(`External editor failed to complete: ${command}`);
        send({ id: request.id, ok: true, result: result.content });
        return;
      }
      case "sessions.create": {
        const payload = request.payload as { cwd?: string; name?: string } | undefined;
        const cwd = payload?.cwd ?? resolveWorkspaceCwd();
        const sessionManager = (await loadAgentCoreSdk()).SessionManager.create(cwd, pfsaa?.sessionDir);
        if (payload?.name) sessionManager.appendSessionInfo(payload.name);
        const sessionId = sessionManager.getSessionId();
        const stateKey = sessionStateKey(sessionId, cwd);
        sessionManagers.set(stateKey, sessionManager);
        const sessionFile = sessionManager.getSessionFile?.();
        if (sessionFile) sessionFiles.set(stateKey, sessionFile);
        send({
          id: request.id,
          ok: true,
          result: {
            id: sessionId,
            title: payload?.name ?? "Untitled task",
            projectId: cwd,
            state: "idle",
            model: "No model selected",
            updatedAt: new Date().toISOString(),
          },
        });
        return;
      }
      case "sessions.messages": {
        const payload = request.payload as { taskId?: string; cwd?: string } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const sdk = await loadAgentCoreSdk();
        const session = agentSessions.get(stateKey) ?? await ensureAgentSession(
          payload.taskId,
          cwd,
        );
        send({ id: request.id, ok: true, result: jsonSafe(sessionTranscriptMessages(session, sdk.sessionEntryToContextMessages)) });
        return;
      }
      case "sessions.runMetadata": {
        const payload = request.payload as { taskId?: string; cwd?: string } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        const session = await ensureAgentSession(payload.taskId, payload.cwd ?? resolveWorkspaceCwd());
        send({ id: request.id, ok: true, result: jsonSafe(sessionRunMetadata(session)) });
        return;
      }
      case "sessions.changeReviews": {
        if (pfsaa) {
          send({ id: request.id, ok: true, result: { availability: "not-git", reviews: [] } });
          return;
        }
        const payload = request.payload as { taskId?: string; cwd?: string } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const session = await ensureAgentSession(payload.taskId, cwd);
        const sdk = await loadAgentCoreSdk();
        send({ id: request.id, ok: true, result: jsonSafe(await sessionChangeReviewCollection(session, cwd, typeof sdk.generateUnifiedPatch === "function")) });
        return;
      }
      case "sessions.changeReview": {
        const payload = request.payload as { taskId?: string; reviewId?: string; cwd?: string } | undefined;
        if (!payload?.taskId || !payload.reviewId) throw new Error("taskId and reviewId are required");
        if (payload.reviewId.length > 512) throw new Error("reviewId is too long");
        const session = await ensureAgentSession(payload.taskId, payload.cwd ?? resolveWorkspaceCwd());
        const loaded = await loadSessionChangeReviews(session);
        const review = loaded.reviews.find((item) => item.id === payload.reviewId) ?? null;
        send({ id: request.id, ok: true, result: jsonSafe(review) });
        return;
      }
      case "sessions.resolveChangeReviewHunk": {
        const payload = request.payload as { taskId: string; reviewId: string; filePath: string; hunkIndex: number; action: "accept" | "revert"; cwd?: string };
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        const { review } = await mutateStoredReviewFile(session, stateKey, payload.taskId, payload.reviewId, payload.filePath, async (file) => {
          if (payload.action === "accept") return { file: acceptChangeReviewHunk(file, payload.hunkIndex), result: undefined };
          const workspaceMutation = await revertChangeReviewHunk(cwd, file, payload.hunkIndex);
          return {
            file: withResolvedReviewHunks(file, workspaceMutation.hunkIndexes, workspaceMutation.action),
            result: undefined,
            workspaceMutation,
          };
        });
        send({ id: request.id, ok: true, result: jsonSafe(review) });
        return;
      }
      case "sessions.changeReviewMergeSource": {
        const payload = request.payload as { taskId: string; reviewId: string; filePath: string; cwd?: string };
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        const source = await withChangeReviewMutation(`${stateKey}\0${payload.reviewId}\0${payload.filePath}`, async () => {
          const loaded = await loadSessionChangeReviews(session);
          const review = loaded.reviews.find((item) => item.id === payload.reviewId);
          if (!review) throw new Error("Change review not found");
          if (review.state !== "completed") throw new Error("Wait for the run to finish before merging changes");
          const file = review.files.find((item) => item.path === payload.filePath);
          if (!file) throw new Error("Change review file not found");
          return loadChangeReviewMergeSource(review.id, cwd, file);
        });
        send({ id: request.id, ok: true, result: jsonSafe(source) });
        return;
      }
      case "sessions.applyChangeReviewMerge": {
        const payload = request.payload as { taskId: string; reviewId: string; filePath: string; content: string; currentRevision: string; cwd?: string };
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        const { review } = await mutateStoredReviewFile(session, stateKey, payload.taskId, payload.reviewId, payload.filePath, async (file) => {
          const workspaceMutation = await applyChangeReviewMerge(payload.reviewId, cwd, file, payload.content, payload.currentRevision);
          return {
            file: withResolvedReviewHunks(file, workspaceMutation.hunkIndexes, workspaceMutation.action),
            result: undefined,
            workspaceMutation,
          };
        });
        send({ id: request.id, ok: true, result: jsonSafe(review) });
        return;
      }
      case "sessions.capabilities": {
        const payload = request.payload as { taskId?: string; cwd?: string } | undefined;
        const cwd = payload?.cwd ?? resolveWorkspaceCwd();
        const session = payload?.taskId
          ? await ensureAgentSession(payload.taskId, cwd)
          : await ensureCapabilitySession(cwd);
        const runtime = await getModelRuntime();
        const activeModel = session.model;
        const provider = activeModel ? runtime.getProvider(activeModel.provider) : undefined;
        const auth = provider ? runtime.getProviderAuthStatus(provider.id) : undefined;
        // If a package changed while the task was streaming, keep the active
        // AgentSession intact but read command/prompt/skill metadata from a
        // fresh capability session so disabled package commands disappear
        // immediately from the desktop suggestions.
        const commandSession = payload?.taskId && agentSessionPackageRevisions.get(sessionStateKey(payload.taskId, cwd)) !== packageConfigRevision
          ? await ensureCapabilitySession(cwd)
          : session;
        const slash = await listSlashCommands(commandSession);
        send({
          id: request.id,
          ok: true,
          result: {
            changeReviewEnabled: !pfsaa,
            model: activeModel && provider ? modelSummary(provider, activeModel, Boolean(auth?.configured)) : undefined,
            thinkingLevel: session.thinkingLevel,
            thinkingLevels: session.getAvailableThinkingLevels(),
            slashCommands: slash.builtins,
            prompts: slash.prompts,
            skills: slash.skills,
            scopedModels: scopedModelSelections(session),
            contextUsage: jsonSafe(session.getContextUsage?.()),
            extensionShortcuts: await extensionShortcuts(session),
          },
        });
        return;
      }
      case "sessions.tree": {
        const payload = request.payload as { taskId?: string; cwd?: string } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        const session = await ensureAgentSession(payload.taskId, payload.cwd ?? resolveWorkspaceCwd());
        send({ id: request.id, ok: true, result: jsonSafe(buildSessionTreeSnapshot(session)) });
        return;
      }
      case "sessions.fork": {
        const payload = request.payload as { taskId?: string; entryId?: string; cwd?: string } | undefined;
        if (!payload?.taskId || !payload.entryId) throw new Error("taskId and entryId are required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        if (session.isStreaming || session.isCompacting || agentRunReservations.has(stateKey)) throw new Error("Wait for the current agent run or compaction to finish before forking the session");
        if (!session.getUserMessagesForForking?.().some((message: any) => message.entryId === payload.entryId)) throw new Error("The selected entry is not a user message that can be forked");
        const runtime = agentSessionRuntimes.get(stateKey);
        if (!runtime) throw new Error("The session runtime is not available");
        const result = await runtime.fork(payload.entryId);
        send({
          id: request.id,
          ok: true,
          result: jsonSafe({
            cancelled: result.cancelled,
            ...(result.cancelled ? {} : { task: taskSummaryFromAgentSession(runtime.session, runtime.cwd), editorText: result.selectedText ?? "" }),
          }),
        });
        return;
      }
      case "sessions.clone": {
        const payload = request.payload as { taskId?: string; cwd?: string } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        if (session.isStreaming || session.isCompacting || agentRunReservations.has(stateKey)) throw new Error("Wait for the current agent run or compaction to finish before cloning the session");
        const leafId = session.sessionManager?.getLeafId?.();
        if (!leafId) throw new Error("Cannot clone an empty session");
        const runtime = agentSessionRuntimes.get(stateKey);
        if (!runtime) throw new Error("The session runtime is not available");
        const result = await runtime.fork(leafId, { position: "at" });
        send({
          id: request.id,
          ok: true,
          result: jsonSafe({
            cancelled: result.cancelled,
            ...(result.cancelled ? {} : { task: taskSummaryFromAgentSession(runtime.session, runtime.cwd), editorText: "" }),
          }),
        });
        return;
      }
      case "sessions.navigateTree": {
        const payload = request.payload as { taskId?: string; entryId?: string; summarize?: boolean; customInstructions?: string; cwd?: string } | undefined;
        if (!payload?.taskId || !payload.entryId) throw new Error("taskId and entryId are required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        if (session.isStreaming || session.isCompacting || agentRunReservations.has(stateKey)) throw new Error("Wait for the current agent run or compaction to finish before navigating the session tree");
        if (!session.sessionManager?.getEntry?.(payload.entryId)) throw new Error("The selected session entry no longer exists");
        if (payload.entryId === session.sessionManager?.getLeafId?.()) {
          send({ id: request.id, ok: true, result: { cancelled: false } });
          return;
        }
        const result = await session.navigateTree(payload.entryId, {
          summarize: payload.summarize ?? false,
          ...(payload.customInstructions?.trim() ? { customInstructions: payload.customInstructions.trim() } : {}),
        });
        if (!result.cancelled && !result.aborted) {
          emit(payload.taskId, { type: "message.snapshot", replace: true, messages: jsonSafe(sessionTranscriptMessages(session, (await loadAgentCoreSdk()).sessionEntryToContextMessages)) });
        }
        send({ id: request.id, ok: true, result: jsonSafe({ cancelled: result.cancelled || Boolean(result.aborted), editorText: result.editorText }) });
        return;
      }
      case "sessions.compact": {
        const payload = request.payload as { taskId?: string; instructions?: string; cwd?: string } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        const sdk = await loadAgentCoreSdk();
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        if (manualCompactionQueues.isActive(stateKey)) throw new Error("Manual compaction is already running for this session");
        manualCompactionQueues.begin(stateKey);
        let result: unknown;
        let completed = false;
        try {
          result = await session.compact(payload.instructions);
          completed = true;
          emit(payload.taskId, { type: "message.snapshot", replace: true, messages: jsonSafe(sessionTranscriptMessages(session, sdk.sessionEntryToContextMessages)) });
        } finally {
          await resumeManualCompactionQueue(payload.taskId, stateKey, session, completed);
        }
        send({ id: request.id, ok: true, result: jsonSafe(result) });
        return;
      }
      case "sessions.reload": {
        const payload = request.payload as { taskId?: string; cwd?: string } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        if (session.isStreaming || session.isCompacting || agentRunReservations.has(stateKey)) throw new Error("Wait for the current agent run or compaction to finish before reloading extensions");
        await session.reload({ beforeSessionStart: () => permissionEngine.resetUi(payload.taskId!) });
        agentSessionPackageRevisions.set(stateKey, packageConfigRevision);
        agentSessionRevisions.set(stateKey, permissionEngine.revision);
        const runtime = await getModelRuntime();
        const activeModel = session.model;
        const provider = activeModel ? runtime.getProvider(activeModel.provider) : undefined;
        const auth = provider ? runtime.getProviderAuthStatus(provider.id) : undefined;
        const slash = await listSlashCommands(session);
        const capabilities = {
          changeReviewEnabled: !pfsaa,
          model: activeModel && provider ? modelSummary(provider, activeModel, Boolean(auth?.configured)) : undefined,
          thinkingLevel: session.thinkingLevel,
          thinkingLevels: session.getAvailableThinkingLevels(),
          slashCommands: slash.builtins,
          prompts: slash.prompts,
          skills: slash.skills,
          scopedModels: scopedModelSelections(session),
          contextUsage: jsonSafe(session.getContextUsage?.()),
          extensionShortcuts: await extensionShortcuts(session),
        };
        send({ id: request.id, ok: true, result: capabilities });
        return;
      }
      case "sessions.export": {
        const payload = request.payload as { taskId?: string; format?: "jsonl" | "html"; cwd?: string; outputPath?: string } | undefined;
        if (!payload?.taskId || !payload.format) throw new Error("taskId and format are required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        await Promise.allSettled([...(pendingChangeReviewWritesBySession.get(stateKey) ?? [])]);
        if (payload.format === "jsonl") await flushSessionChangeReviewStore(session);
        const outputPath = payload.format === "html" ? await session.exportToHtml(payload.outputPath) : session.exportToJsonl(payload.outputPath);
        const copiedReviewStore = payload.format === "jsonl" && await copySessionChangeReviewStore(session, outputPath);
        send({
          id: request.id,
          ok: true,
          result: {
            path: outputPath,
            ...(copiedReviewStore ? { reviewPath: sessionChangeReviewStorePath(outputPath) } : {}),
          },
        });
        return;
      }
      case "sessions.import": {
        const payload = request.payload as { taskId?: string; inputPath?: string; cwd?: string } | undefined;
        if (!payload?.inputPath?.trim()) throw new Error("inputPath is required");
        const inputPath = path.resolve(payload.inputPath.trim());
        if (!existsSync(inputPath)) throw new Error(`Session file not found: ${inputPath}`);
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const sdk = await loadAgentCoreSdk();
        const currentStateKey = payload.taskId ? sessionStateKey(payload.taskId, cwd) : undefined;
        const currentPath = currentStateKey ? sessionFiles.get(currentStateKey) : undefined;
        const currentManager = currentStateKey ? sessionManagers.get(currentStateKey) : undefined;
        const scratchManager = sdk.SessionManager.create(cwd);
        const targetDir = currentManager?.getSessionDir?.() ?? (currentPath ? path.dirname(currentPath) : undefined) ?? scratchManager.getSessionDir?.() ?? path.join(cwd, ".pi", "sessions");
        mkdirSync(targetDir, { recursive: true });
        const destination = path.join(targetDir, `import-${Date.now()}-${path.basename(inputPath)}`);
        copyFileSync(inputPath, destination);
        await copySessionChangeReviewStore(inputPath, destination);
        const manager = sdk.SessionManager.open(destination, targetDir, cwd);
        normalizeSessionImages(manager);
        const sessionId = manager.getSessionId();
        const stateKey = sessionStateKey(sessionId, cwd);
        sessionManagers.set(stateKey, manager);
        sessionFiles.set(stateKey, destination);
        const titleSource = manager.getSessionName?.() || firstUserText(manager);
        send({
          id: request.id,
          ok: true,
          result: {
            id: sessionId,
            title: deriveSessionTitle(titleSource) || manager.getSessionName?.() || sessionId.slice(0, 8),
            projectId: cwd,
            state: "idle",
            model: sessionModelLabel({ path: destination }, sdk),
            updatedAt: new Date().toISOString(),
          },
        });
        return;
      }
      case "sessions.rename": {
        const payload = request.payload as { taskId?: string; name?: string; cwd?: string } | undefined;
        if (!payload?.taskId || !payload.name?.trim()) throw new Error("taskId and name are required");
        const session = await ensureAgentSession(payload.taskId, payload.cwd ?? resolveWorkspaceCwd());
        session.setSessionName(payload.name.trim());
        const name = session.sessionManager?.getSessionName?.() ?? payload.name.trim();
        emit(payload.taskId, { type: "session_info_changed", name });
        send({ id: request.id, ok: true, result: name });
        return;
      }
      case "sessions.generateTitle": {
        const payload = request.payload as { taskId?: string; message?: string; cwd?: string; model?: { providerId: string; modelId: string } } | undefined;
        // Missing input yields no title; the renderer keeps its truncated fallback.
        if (!payload?.taskId || !payload.message?.trim()) {
          send({ id: request.id, ok: true, result: null });
          return;
        }
        try {
          const runtime = await getModelRuntime();
          const model = payload.model?.providerId && payload.model?.modelId
            ? runtime.getModel(payload.model.providerId, payload.model.modelId)
            : undefined;
          if (!model) {
            send({ id: request.id, ok: true, result: null });
            return;
          }
          const result = await runtime.complete(model, {
            systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: payload.message }],
          }, {});
          const raw = Array.isArray(result?.content)
            ? result.content
                .filter((block: any) => block?.type === "text" && typeof block.text === "string")
                .map((block: any) => block.text)
                .join("")
            : "";
          const cleaned = raw.trim().replace(/^["'「『]+|["'」』]+$/g, "").replace(/\s+/g, " ").trim();
          // Cap length and reject garbage so a bad reply falls back to truncation.
          send({ id: request.id, ok: true, result: cleaned.length > 0 && cleaned.length <= 60 ? cleaned : null });
        } catch {
          // Auth or network failure: let the renderer keep its truncated fallback.
          send({ id: request.id, ok: true, result: null });
        }
        return;
      }
      case "sessions.stats": {
        const payload = request.payload as { taskId?: string; cwd?: string } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        const session = await ensureAgentSession(payload.taskId, payload.cwd ?? resolveWorkspaceCwd());
        send({ id: request.id, ok: true, result: jsonSafe(session.getSessionStats()) });
        return;
      }
      case "sessions.share": {
        const payload = request.payload as { taskId?: string; cwd?: string } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        const session = await ensureAgentSession(payload.taskId, payload.cwd ?? resolveWorkspaceCwd());
        await execFileText("gh", ["auth", "status"], { timeout: 30_000 });
        const tempPath = path.join(os.tmpdir(), `pfsaa-session-${Date.now()}.html`);
        try {
          await session.exportToHtml(tempPath);
          const gistUrl = (await execFileText("gh", ["gist", "create", "--public=false", tempPath], { timeout: 10 * 60_000 })).trim();
          const gistId = gistUrl.split("/").filter(Boolean).pop();
          if (!gistId) throw new Error("Could not parse the gist URL returned by gh");
          const viewerBase = process.env.PI_SHARE_VIEWER_URL ?? "https://pi.dev/session/";
          send({ id: request.id, ok: true, result: { url: `${viewerBase}#${gistId}`, gistUrl } });
        } finally {
          try { await unlink(tempPath); } catch { /* Best effort cleanup. */ }
        }
        return;
      }
      case "agent.prompt": {
        const payload = request.payload as { taskId?: string; text?: string; cwd?: string; images?: Array<{ data: string; mimeType: string }>; delivery?: "steer" | "followUp" } | undefined;
        const images = normalizePromptImages(payload?.images);
        if (!payload?.taskId || (!payload.text && !images?.length)) throw new Error("taskId and text or images are required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        if (manualCompactionQueues.isActive(stateKey) && !isExtensionCommand(session, payload.text ?? "")) {
          manualCompactionQueues.enqueue(stateKey, {
            id: randomUUID(),
            text: payload.text ?? "",
            images: images ?? [],
            delivery: payload.delivery ?? "followUp",
          });
          emit(payload.taskId, { type: "queue_update", ...queueStateWithDetails(session, stateKey) });
          send({ id: request.id, ok: true, result: { disposition: "queued" } });
          return;
        }
        const sessionName = session.sessionManager?.getSessionName?.();
        if (!titledSessions.has(stateKey) && (isDefaultSessionTitle(sessionName) || isCommandDerivedSessionTitle(sessionName))) {
          const title = deriveSessionTitle(payload.text ?? "");
          if (title) {
            if (typeof session.setSessionName === "function") session.setSessionName(title);
            else session.sessionManager?.appendSessionInfo?.(title);
            titledSessions.add(stateKey);
          }
        }
        let pendingRun = agentRunReservations.get(stateKey);
        // Outside compaction, wait until the earlier prompt either enters AgentCore's
        // streaming state or finishes its preflight. This closes the tiny gap
        // before `isStreaming` becomes authoritative without inventing a
        // renderer-owned execution queue.
        if (pendingRun && !session.isStreaming && !session.isCompacting) {
          await waitForReservedAgentRun(pendingRun, () => Boolean(session.isStreaming));
          pendingRun = agentRunReservations.get(stateKey);
        }
        const queuedDelivery = (session.isStreaming || pendingRun)
          ? payload.delivery ?? ("followUp" as const)
          : undefined;
        const directReservation = queuedDelivery ? undefined : createAgentRunReservation();
        if (directReservation) agentRunReservations.set(stateKey, directReservation);
        const runPrompt = async (): Promise<"completed" | "queued" | "extension-command"> => {
          // AgentCore CLI executes extension commands immediately during compaction;
          // ordinary prompts enter AgentSession's real steer/follow-up queues.
          const extensionCommand = Boolean(queuedDelivery && isExtensionCommand(session, payload.text ?? ""));
          if (queuedDelivery && !extensionCommand) trackQueuedPrompt(stateKey, queuedDelivery, payload.text ?? "", images);
          const queuedDuringCompaction = queuedDelivery
            ? await queuePromptDuringCompaction(session, payload.text ?? "", images, queuedDelivery)
            : false;
          if (queuedDuringCompaction) {
            const current = queueState(session);
            reconcileQueuedPromptImages(stateKey, current.steering, current.followUp);
            return "queued";
          }
          const promptText = payload.text ?? "";
          await session.prompt(promptText, {
            source: "interactive",
            images,
            ...(queuedDelivery && !extensionCommand ? { streamingBehavior: queuedDelivery } : {}),
            ...(directReservation ? { preflightResult: (started: boolean) => directReservation.markStarted(started) } : {}),
          });
          if (queuedDelivery && !extensionCommand) {
            const current = queueState(session);
            reconcileQueuedPromptImages(stateKey, current.steering, current.followUp);
          }
          if (extensionCommand || isExtensionCommand(session, payload.text ?? "")) return "extension-command";
          return queuedDelivery ? "queued" : "completed";
        };
        let disposition: "completed" | "queued" | "extension-command";
        try {
          disposition = queuedDelivery ? await withQueueMutationLock(stateKey, runPrompt) : await runPrompt();
        } catch (error) {
          if (queuedDelivery) {
            const current = queueState(session);
            reconcileQueuedPromptImages(stateKey, current.steering, current.followUp);
          }
          // A competing Agent.prompt can make AgentSession emit `agent_settled`
          // and report idle while the lower-level Agent still owns an active
          // run. Always abort after a failed prompt so subsequent prompts can
          // recover from that split state.
          try { await session.abort(); } catch { /* Preserve the original prompt error. */ }
          throw error;
        } finally {
          if (directReservation && agentRunReservations.get(stateKey) === directReservation) {
            directReservation.markStarted(false);
            directReservation.markFinished();
            agentRunReservations.delete(stateKey);
          }
        }
        send({ id: request.id, ok: true, result: { disposition } });
        return;
      }
      case "agent.executeBash": {
        const payload = request.payload as { taskId?: string; command?: string; excludeFromContext?: boolean; cwd?: string } | undefined;
        if (!payload?.taskId || !payload.command?.trim()) throw new Error("taskId and command are required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        if (session.isStreaming || session.isCompacting || agentRunReservations.has(stateKey)) throw new Error("Wait for the current agent run or compaction to finish before running a shell command");
        const bashId = randomUUID();
        emit(payload.taskId, { type: "bash_execution_start", id: bashId, command: payload.command.trim(), excludeFromContext: payload.excludeFromContext === true });
        let result: any;
        try {
          result = await session.executeBash(payload.command.trim(), undefined, {
            excludeFromContext: payload.excludeFromContext === true,
            id: bashId,
          });
          emit(payload.taskId, { type: "bash_execution_end", id: bashId, result: jsonSafe(result) });
        } catch (error) {
          emit(payload.taskId, { type: "bash_execution_end", id: bashId, error: publicRuntimeError(error) });
          throw error;
        }
        const sdk = await loadAgentCoreSdk();
        emit(payload.taskId, { type: "message.snapshot", messages: jsonSafe(sessionTranscriptMessages(session, sdk.sessionEntryToContextMessages)) });
        send({ id: request.id, ok: true, result: jsonSafe(result) });
        return;
      }
      case "sessions.delete": {
        const payload = request.payload as { taskId?: string; cwd?: string } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const sessionPath = sessionFiles.get(stateKey);
        const session = agentSessions.get(stateKey);
        session?.abortBash?.();
        if (session?.isStreaming) await session.abort();
        await Promise.allSettled([...(pendingChangeReviewWritesBySession.get(stateKey) ?? [])]);
        const agentRuntime = agentSessionRuntimes.get(stateKey);
        if (agentRuntime?.dispose) await agentRuntime.dispose();
        else await session?.dispose?.();
        if (sessionPath) await deleteSessionChangeReviewStore(sessionPath);
        else if (session) await deleteSessionChangeReviewStore(session);
        if (sessionPath && existsSync(sessionPath)) await unlink(sessionPath);
        sessionFiles.delete(stateKey);
        titledSessions.delete(stateKey);
        sessionManagers.delete(stateKey);
        agentSessions.delete(stateKey);
        agentSessionRuntimes.delete(stateKey);
        agentSessionPackageRevisions.delete(stateKey);
        agentSessionRevisions.delete(stateKey);
        queuedPromptImages.delete(stateKey);
        queueDeliveryHints.delete(stateKey);
        queueMutationLocks.delete(stateKey);
        queueRebuilds.delete(stateKey);
        manualCompactionQueues.dispose(stateKey);
        clearAgentRunReservation(stateKey);
        executionGroupStarts.delete(stateKey);
        const activeReview = activeChangeReviews.get(stateKey);
        if (activeReview) cancelChangeReviewPreview(activeReview);
        activeChangeReviews.delete(stateKey);
        pendingChangeReviewWritesBySession.delete(stateKey);
        permissionEngine.dispose(stateKey);
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "agent.abort": {
        const payload = request.payload as { taskId?: string; cwd?: string } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        const stateKey = sessionStateKey(payload.taskId, payload.cwd ?? resolveWorkspaceCwd());
        const session = agentSessions.get(stateKey);
        if (session) {
          session.abortBash?.();
          session.abortCompaction();
          session.abortBranchSummary?.();
          await session.abort();
        }
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "agent.setThinkingLevel": {
        const payload = request.payload as { taskId?: string; level?: string; cwd?: string } | undefined;
        if (!payload?.taskId || !payload.level) throw new Error("taskId and level are required");
        const session = await ensureAgentSession(payload.taskId, payload.cwd ?? resolveWorkspaceCwd());
        session.setThinkingLevel(payload.level, { persist: true });
        send({ id: request.id, ok: true, result: session.thinkingLevel });
        return;
      }
      case "agent.setModel": {
        const payload = request.payload as { taskId?: string; providerId?: string; modelId?: string; cwd?: string } | undefined;
        if (!payload?.taskId || !payload.providerId || !payload.modelId) throw new Error("taskId, providerId and modelId are required");
        const session = await ensureAgentSession(payload.taskId, payload.cwd ?? resolveWorkspaceCwd());
        const runtime = await getModelRuntime();
        const model = runtime.getModel(payload.providerId, payload.modelId);
        if (!model) throw new Error(`Unknown model: ${payload.providerId}/${payload.modelId}`);
        await session.setModel(model, { persist: true });
        send({ id: request.id, ok: true, result: { providerId: model.provider, modelId: model.id, name: model.name } });
        return;
      }
      case "agent.cycleModel": {
        const payload = request.payload as { taskId?: string; direction?: "forward" | "backward"; cwd?: string } | undefined;
        if (!payload?.taskId || payload.direction !== "forward" && payload.direction !== "backward") throw new Error("taskId and direction are required");
        const session = await ensureAgentSession(payload.taskId, payload.cwd ?? resolveWorkspaceCwd());
        await session.cycleModel(payload.direction);
        const runtime = await getModelRuntime();
        const activeModel = session.model;
        const provider = activeModel ? runtime.getProvider(activeModel.provider) : undefined;
        const auth = provider ? runtime.getProviderAuthStatus(provider.id) : undefined;
        send({
          id: request.id,
          ok: true,
          result: {
            model: activeModel && provider ? modelSummary(provider, activeModel, Boolean(auth?.configured)) : undefined,
            thinkingLevel: session.thinkingLevel,
            thinkingLevels: session.getAvailableThinkingLevels(),
            contextUsage: jsonSafe(session.getContextUsage?.()),
          },
        });
        return;
      }
      case "agent.setScopedModels": {
        const payload = request.payload as { taskId?: string; models?: ScopedModelSelection[] | null; persist?: boolean; cwd?: string } | undefined;
        if (!payload?.taskId || !Array.isArray(payload.models) && payload.models !== null) throw new Error("taskId and models are required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const session = await ensureAgentSession(payload.taskId, cwd);
        const runtime = await getModelRuntime();
        const selections = payload.models ?? [];
        const scoped: Array<{ model: any; thinkingLevel?: string }> = [];
        const seen = new Set<string>();
        for (const selection of selections) {
          const reference = `${selection.providerId}/${selection.modelId}`;
          if (seen.has(reference)) throw new Error(`Duplicate scoped model: ${reference}`);
          seen.add(reference);
          const model = runtime.getModel(selection.providerId, selection.modelId);
          if (!model) throw new Error(`Unknown model: ${reference}`);
          const provider = runtime.getProvider(selection.providerId);
          if (!provider) throw new Error(`Unknown provider: ${selection.providerId}`);
          const availableThinkingLevels = modelSummary(provider, model, true).thinkingLevels;
          if (selection.thinkingLevel && !availableThinkingLevels.includes(selection.thinkingLevel)) {
            throw new Error(`Thinking level ${selection.thinkingLevel} is not available for ${reference}`);
          }
          scoped.push({ model, ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}) });
        }
        session.setScopedModels(scoped);
        if (payload.persist) {
          const sdk = await loadAgentCoreSdk();
          if (!sdk.SettingsManager) throw new Error("Settings are not available in this runtime");
          const agentDir = sdk.getAgentDir?.() ?? path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), ".pi", "agent");
          const settings = sdk.SettingsManager.create(cwd, agentDir);
          const patterns = selections.map((selection) => `${selection.providerId}/${selection.modelId}${selection.thinkingLevel ? `:${selection.thinkingLevel}` : ""}`);
          settings.setEnabledModels(patterns.length > 0 ? patterns : undefined);
        }
        send({ id: request.id, ok: true, result: scopedModelSelections(session) });
        return;
      }
      case "agent.queue": {
        const payload = request.payload as { taskId?: string; cwd?: string } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        const current = queueState(session);
        reconcileQueuedPromptImages(stateKey, current.steering, current.followUp);
        send({ id: request.id, ok: true, result: queueStateWithDetails(session, stateKey) });
        return;
      }
      case "agent.setQueueModes": {
        const payload = request.payload as { taskId?: string; cwd?: string; steeringMode?: "all" | "one-at-a-time"; followUpMode?: "all" | "one-at-a-time" } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        if (payload.steeringMode) session.setSteeringMode(payload.steeringMode);
        if (payload.followUpMode) session.setFollowUpMode(payload.followUpMode);
        send({ id: request.id, ok: true, result: queueStateWithDetails(session, stateKey) });
        return;
      }
      case "agent.clearQueue": {
        const payload = request.payload as { taskId?: string; cwd?: string } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        await withQueueMutationLock(stateKey, async () => {
          queueRebuilds.add(stateKey);
          try {
            session.clearQueue();
            manualCompactionQueues.clear(stateKey);
            setQueuedPromptImages(stateKey, [], []);
            queueDeliveryHints.delete(stateKey);
            send({ id: request.id, ok: true, result: queueStateWithDetails(session, stateKey) });
          } finally {
            queueRebuilds.delete(stateKey);
          }
        });
        return;
      }
      case "agent.promoteQueue": {
        const payload = request.payload as { taskId?: string; cwd?: string; followUpIndex?: number } | undefined;
        if (!payload?.taskId) throw new Error("taskId is required");
        if (!Number.isInteger(payload.followUpIndex) || (payload.followUpIndex ?? -1) < 0) throw new Error("followUpIndex is required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const session = await ensureAgentSession(payload.taskId, cwd);
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const nativeFollowUpCount = queueState(session).followUp.length;
        if ((payload.followUpIndex ?? 0) >= nativeFollowUpCount) {
          if (!manualCompactionQueues.promote(stateKey, (payload.followUpIndex ?? 0) - nativeFollowUpCount)) throw new Error("Queued message is no longer available");
          const result = queueStateWithDetails(session, stateKey);
          emit(payload.taskId, { type: "queue_update", ...result });
          send({ id: request.id, ok: true, result });
          return;
        }
        await withQueueMutationLock(stateKey, async () => {
          // Validate against the live queue before clearing it. A stale UI
          // index must never cause a different message to be promoted.
          const liveQueue = queueState(session);
          const followUpIndex = payload.followUpIndex!;
          if (typeof liveQueue.followUp[followUpIndex] !== "string") throw new Error("Queued message is no longer available");

          const imageState = queuedPromptImageState(stateKey);
          const queued = {
            steering: liveQueue.steering.map((text, index) => imageState.steering[index] ?? { id: randomUUID(), text, images: [] }),
            followUp: liveQueue.followUp.map((text, index) => imageState.followUp[index] ?? { id: randomUUID(), text, images: [] }),
          };
          const selected = queued.followUp[followUpIndex];
          if (!selected) throw new Error("Queued message is no longer available");
          queueRebuilds.add(stateKey);
          try {
            session.clearQueue();
            try {
              // Promote means the selected follow-up is first in the steering
              // queue, ahead of any older steering messages.
              await session.steer(selected.text, selected.images);
              for (const message of queued.steering) await session.steer(message.text, message.images);
              for (const [index, message] of queued.followUp.entries()) {
                if (index !== followUpIndex) await session.followUp(message.text, message.images);
              }
            } catch (error) {
              // Rebuild the original queue if any requeue operation fails. Keep
              // the operation failure visible while making the queue recoverable.
              try {
                session.clearQueue();
                for (const message of queued.steering) await session.steer(message.text, message.images);
                for (const message of queued.followUp) await session.followUp(message.text, message.images);
                const restored = queueState(session);
                setQueuedPromptImages(
                  stateKey,
                  queuedPromptImagesForTexts(restored.steering, queued.steering),
                  queuedPromptImagesForTexts(restored.followUp, queued.followUp),
                );
              } catch (restoreError) {
                // Both failures are concatenated into the message so the UI shows the
                // original error and the restore failure without relying on error.cause.
                // eslint-disable-next-line preserve-caught-error
                throw new Error(`${error instanceof Error ? error.message : String(error)}; queue restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
              }
              throw error;
            }
            const next = queueState(session);
            setQueuedPromptImages(
              stateKey,
              queuedPromptImagesForTexts(next.steering, [selected, ...queued.steering]),
              queuedPromptImagesForTexts(next.followUp, queued.followUp.filter((_message, index) => index !== followUpIndex)),
            );
            send({ id: request.id, ok: true, result: queueStateWithDetails(session, stateKey) });
          } finally {
            queueRebuilds.delete(stateKey);
          }
        });
        return;
      }
      case "agent.editQueue": {
        const payload = request.payload as { taskId?: string; cwd?: string; messageId?: string; text?: string; images?: Array<{ data: string; mimeType: string }> } | undefined;
        const images = normalizePromptImages(payload?.images) ?? [];
        if (!payload?.taskId || !payload.messageId || (!payload.text?.trim() && images.length === 0)) throw new Error("taskId, messageId, and text or images are required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        if (manualCompactionQueues.edit(stateKey, payload.messageId, payload.text?.trim() ?? "", images)) {
          const result = queueStateWithDetails(session, stateKey);
          emit(payload.taskId, { type: "queue_update", ...result });
          send({ id: request.id, ok: true, result });
          return;
        }
        await withQueueMutationLock(stateKey, async () => {
          const liveQueue = queueState(session);
          reconcileQueuedPromptImages(stateKey, liveQueue.steering, liveQueue.followUp);
          const imageState = queuedPromptImageState(stateKey);
          const original = {
            steering: liveQueue.steering.map((text, index) => imageState.steering[index] ?? { id: randomUUID(), text, images: [] }),
            followUp: liveQueue.followUp.map((text, index) => imageState.followUp[index] ?? { id: randomUUID(), text, images: [] }),
          };
          const steeringIndex = original.steering.findIndex((message) => message.id === payload.messageId);
          const followUpIndex = original.followUp.findIndex((message) => message.id === payload.messageId);
          if (steeringIndex < 0 && followUpIndex < 0) throw new Error("Queued message is no longer available");

          const edited = { id: payload.messageId!, text: payload.text?.trim() ?? "", images };
          const updated = {
            steering: original.steering.map((message, index) => index === steeringIndex ? edited : message),
            followUp: original.followUp.map((message, index) => index === followUpIndex ? edited : message),
          };
          queueRebuilds.add(stateKey);
          try {
            session.clearQueue();
            try {
              for (const message of updated.steering) await session.steer(message.text, message.images);
              for (const message of updated.followUp) await session.followUp(message.text, message.images);
            } catch (error) {
              try {
                session.clearQueue();
                for (const message of original.steering) await session.steer(message.text, message.images);
                for (const message of original.followUp) await session.followUp(message.text, message.images);
                setQueuedPromptImages(stateKey, original.steering, original.followUp);
              } catch (restoreError) {
                // eslint-disable-next-line preserve-caught-error
                throw new Error(`${error instanceof Error ? error.message : String(error)}; queue restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
              }
              throw error;
            }
            const next = queueState(session);
            setQueuedPromptImages(
              stateKey,
              queuedPromptImagesForTexts(next.steering, updated.steering),
              queuedPromptImagesForTexts(next.followUp, updated.followUp),
            );
            send({ id: request.id, ok: true, result: queueStateWithDetails(session, stateKey) });
          } finally {
            queueRebuilds.delete(stateKey);
          }
        });
        return;
      }
      case "agent.deleteQueue": {
        const payload = request.payload as { taskId?: string; cwd?: string; messageId?: string } | undefined;
        if (!payload?.taskId || !payload.messageId) throw new Error("taskId and messageId are required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        if (manualCompactionQueues.delete(stateKey, payload.messageId)) {
          const result = queueStateWithDetails(session, stateKey);
          emit(payload.taskId, { type: "queue_update", ...result });
          send({ id: request.id, ok: true, result });
          return;
        }
        await withQueueMutationLock(stateKey, async () => {
          // AgentCore exposes clearQueue(), steer(), and followUp(), but no arbitrary
          // row deletion API. Validate the stable Renderer ID against the live
          // queue, then atomically rebuild the remaining real AgentCore queue.
          const liveQueue = queueState(session);
          reconcileQueuedPromptImages(stateKey, liveQueue.steering, liveQueue.followUp);
          const imageState = queuedPromptImageState(stateKey);
          const original = {
            steering: liveQueue.steering.map((text, index) => imageState.steering[index] ?? { id: randomUUID(), text, images: [] }),
            followUp: liveQueue.followUp.map((text, index) => imageState.followUp[index] ?? { id: randomUUID(), text, images: [] }),
          };
          const messageId = payload.messageId!;
          if (!original.steering.some((message) => message.id === messageId) && !original.followUp.some((message) => message.id === messageId)) {
            throw new Error("Queued message is no longer available");
          }
          const updated = {
            steering: original.steering.filter((message) => message.id !== messageId),
            followUp: original.followUp.filter((message) => message.id !== messageId),
          };

          queueRebuilds.add(stateKey);
          try {
            session.clearQueue();
            try {
              for (const message of updated.steering) await session.steer(message.text, message.images);
              for (const message of updated.followUp) await session.followUp(message.text, message.images);
            } catch (error) {
              try {
                session.clearQueue();
                for (const message of original.steering) await session.steer(message.text, message.images);
                for (const message of original.followUp) await session.followUp(message.text, message.images);
                setQueuedPromptImages(stateKey, original.steering, original.followUp);
              } catch (restoreError) {
                // eslint-disable-next-line preserve-caught-error
                throw new Error(`${error instanceof Error ? error.message : String(error)}; queue restore failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`);
              }
              throw error;
            }
            const next = queueState(session);
            setQueuedPromptImages(
              stateKey,
              queuedPromptImagesForTexts(next.steering, updated.steering),
              queuedPromptImagesForTexts(next.followUp, updated.followUp),
            );
            send({ id: request.id, ok: true, result: queueStateWithDetails(session, stateKey) });
          } finally {
            queueRebuilds.delete(stateKey);
          }
        });
        return;
      }
      case "settings.get": {
        const payload = request.payload as { cwd?: string } | undefined;
        const manager = await settingsManagerFor(payload?.cwd ?? resolveWorkspaceCwd());
        send({ id: request.id, ok: true, result: summarizeAgentCoreSettings(manager) });
        return;
      }
      case "settings.update": {
        const payload = request.payload as (AgentCoreSettingsUpdate & { cwd?: string }) | undefined;
        const cwd = typeof payload?.cwd === "string" ? payload.cwd : resolveWorkspaceCwd();
        const { sdk, agentDir, settingsManager } = await settingsContextFor(cwd);
        const runtime = await getModelRuntime();
        const storage = sdk.FileSettingsStorage ? new sdk.FileSettingsStorage(cwd, agentDir) : undefined;
        send({ id: request.id, ok: true, result: await updateAgentCoreSettings(settingsManager, runtime, payload ?? {}, storage) });
        return;
      }
      case "extension.editor.sync": {
        const payload = request.payload as { taskId?: string; text?: string; cwd?: string } | undefined;
        if (!payload?.taskId || typeof payload.text !== "string") throw new Error("taskId and text are required");
        permissionEngine.syncEditorText(sessionStateKey(payload.taskId, payload.cwd ?? resolveWorkspaceCwd()), payload.text);
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "extension.shortcut.invoke": {
        const payload = request.payload as { taskId?: string; key?: string; text?: string; cwd?: string } | undefined;
        if (!payload?.taskId || !payload.key || typeof payload.text !== "string") throw new Error("taskId, key and text are required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        const stateKey = sessionStateKey(payload.taskId, cwd);
        const session = await ensureAgentSession(payload.taskId, cwd);
        permissionEngine.syncEditorText(stateKey, payload.text);
        const sdk = await loadAgentCoreSdk();
        const bindings = sdk.KeybindingsManager?.create(sdk.getAgentDir?.()).getEffectiveConfig() ?? {};
        const shortcut = session.extensionRunner?.getShortcuts(bindings).get(payload.key.toLowerCase());
        if (!shortcut) throw new Error(`Extension shortcut is no longer available: ${payload.key}`);
        await shortcut.handler(session.extensionRunner.createContext());
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "extension.input.dispatch": {
        const payload = request.payload as { taskId?: string; data?: string; cwd?: string } | undefined;
        if (!payload?.taskId || typeof payload.data !== "string") throw new Error("taskId and data are required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        await ensureAgentSession(payload.taskId, cwd);
        send({ id: request.id, ok: true, result: permissionEngine.dispatchInput(sessionStateKey(payload.taskId, cwd), payload.data) });
        return;
      }
      case "extension.autocomplete": {
        const payload = request.payload as { taskId?: string; text?: string; cursor?: number; force?: boolean; cwd?: string } | undefined;
        if (!payload?.taskId || typeof payload.text !== "string" || typeof payload.cursor !== "number") throw new Error("taskId, text and cursor are required");
        const cwd = payload.cwd ?? resolveWorkspaceCwd();
        await ensureAgentSession(payload.taskId, cwd);
        send({ id: request.id, ok: true, result: await permissionEngine.autocomplete(sessionStateKey(payload.taskId, cwd), payload.text, payload.cursor, payload.force === true) });
        return;
      }
      case "extension.ui.resolve": {
        const payload = request.payload as { requestId?: string; value?: string | boolean } | undefined;
        if (!payload?.requestId) throw new Error("requestId is required");
        permissionEngine.resolveUi(payload.requestId, payload.value);
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "extension.ui.input": {
        const payload = request.payload as { requestId?: string; data?: string } | undefined;
        if (!payload?.requestId || typeof payload.data !== "string") throw new Error("requestId and data are required");
        permissionEngine.inputUi(payload.requestId, payload.data);
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "packages.list": {
        const payload = request.payload as { cwd?: string } | undefined;
        const { manager, settingsManager } = await createPackageManagerContext(payload?.cwd ?? resolveWorkspaceCwd());
        const packages = manager.listConfiguredPackages?.() ?? [];
        const disabledPackageKeys = new Set<string>();
        for (const [scope, configured] of [
          ["user", settingsManager.getGlobalSettings().packages ?? []],
          ["project", settingsManager.getProjectSettings().packages ?? []],
        ] as const) {
          for (const entry of configured) {
            if (entry && typeof entry === "object" && entry.autoload === false) disabledPackageKeys.add(`${scope}:${entry.source}`);
          }
        }
        const summaries = await Promise.all(packages.map(async (item: any) => ({
          source: item.source,
          scope: item.scope,
          filtered: Boolean(item.filtered),
          // AgentCore's `filtered` flag covers every object-form package entry, including
          // resource-only filters. Only autoload=false disables the whole package.
          disabled: item.disabled === true || disabledPackageKeys.has(`${item.scope}:${item.source}`),
          installedPath: item.installedPath,
          resources: await listPackageResources(manager, item),
        })));
        send({ id: request.id, ok: true, result: jsonSafe(summaries) });
        return;
      }
      case "packages.install": {
        const payload = request.payload as { source?: string; local?: boolean; cwd?: string } | undefined;
        if (!payload?.source?.trim()) throw new Error("source is required");
        const manager = await createPackageManager(payload.cwd ?? resolveWorkspaceCwd());
        const source = normalizePackageInstallSource(payload.source);
        await manager.installAndPersist(source, { local: payload.local === true });
        invalidateResourceSessions();
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "packages.remove": {
        const payload = request.payload as { source?: string; local?: boolean; cwd?: string } | undefined;
        if (!payload?.source?.trim()) throw new Error("source is required");
        const manager = await createPackageManager(payload.cwd ?? resolveWorkspaceCwd());
        await manager.removeAndPersist(payload.source.trim(), { local: payload.local === true });
        invalidateResourceSessions();
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "packages.update": {
        const payload = request.payload as { source?: string; cwd?: string } | undefined;
        const manager = await createPackageManager(payload?.cwd ?? resolveWorkspaceCwd());
        await manager.update(payload?.source?.trim() || undefined);
        invalidateResourceSessions();
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "packages.configure": {
        const payload = request.payload as { source?: string; enabled?: boolean; local?: boolean; cwd?: string } | undefined;
        if (!payload?.source?.trim()) throw new Error("source is required");
        const { settingsManager } = await createPackageManagerContext(payload.cwd ?? resolveWorkspaceCwd());
        const changed = configurePackageSource(settingsManager, payload.source.trim(), payload.enabled === true, payload.local === true);
        if (changed) invalidateResourceSessions();
        send({ id: request.id, ok: true, result: { changed } });
        return;
      }
      case "packages.configureResource": {
        const payload = request.payload as { source?: string; type?: AgentCorePackageResourceType; path?: string; enabled?: boolean; local?: boolean; cwd?: string } | undefined;
        if (!payload?.source?.trim() || !payload.type || !payload.path?.trim() || typeof payload.enabled !== "boolean") throw new Error("source, type, path and enabled are required");
        const { settingsManager } = await createPackageManagerContext(payload.cwd ?? resolveWorkspaceCwd());
        configurePackageResource(settingsManager, payload.source.trim(), payload.type, payload.path.trim(), payload.enabled, payload.local === true);
        invalidateResourceSessions();
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "packages.checkUpdates": {
        const payload = request.payload as { cwd?: string } | undefined;
        const manager = await createPackageManager(payload?.cwd ?? resolveWorkspaceCwd());
        if (typeof manager.checkForAvailableUpdates !== "function") throw new Error("This runtime cannot check package updates");
        const updates = await manager.checkForAvailableUpdates();
        send({ id: request.id, ok: true, result: updates.map((update: any) => update.source) });
        return;
      }
      case "providers.list": {
        const runtime = await getModelRuntime();
        send({ id: request.id, ok: true, result: await listProviderSummaries(runtime, "visible") });
        return;
      }
      case "providers.listHidden": {
        const runtime = await getModelRuntime();
        send({ id: request.id, ok: true, result: await listProviderSummaries(runtime, "hidden") });
        return;
      }
      case "providers.discoverModels": {
        const payload = request.payload as { baseUrl?: string; providerId?: string; apiKey?: string } | undefined;
        if (!payload?.baseUrl) throw new Error("baseUrl is required");
        const runtime = await getModelRuntime();
        let apiKey = payload.apiKey?.trim() || undefined;
        let configuredHeaders: unknown;
        if (payload.providerId) {
          const provider = (await listProviderSummaries(runtime, "visible")).find((entry) => entry.id === payload.providerId);
          if (!provider?.isEditable) throw new Error("Only locally configured OpenAI-compatible Providers can be probed from this form.");
          const model = runtime.getModels(payload.providerId)[0];
          const auth = await runtime.getAuth(model ?? payload.providerId);
          apiKey ??= auth?.auth?.apiKey;
          configuredHeaders = auth?.auth?.headers;
        }
        if (!apiKey && !payload.providerId) throw new Error("An API key is required to discover models.");
        const discovered = await discoverOpenAICompatibleModels(payload.baseUrl, apiKey, configuredHeaders);
        send({ id: request.id, ok: true, result: discovered });
        return;
      }
      case "providers.create": {
        const payload = request.payload as { name?: string; baseUrl?: string; models?: Array<{ id: string; name: string }>; apiKey?: string } | undefined;
        if (!payload?.name || !payload.baseUrl || !payload.models?.length || !payload.apiKey) throw new Error("name, baseUrl, models and apiKey are required");
        const apiKey = payload.apiKey.trim();
        if (!apiKey) throw new Error("An API key is required");
        const runtime = await getModelRuntime();
        const agentDir = providerConfigAgentDir();
        let providerId: string | undefined;
        try {
          const created = await createCustomProvider(agentDir, {
            name: payload.name,
            baseUrl: payload.baseUrl,
            models: payload.models,
          }, runtime.getProviders().map((provider: any) => provider.id));
          providerId = created.providerId;
          const refresh = await runtime.refresh({ providers: [providerId], allowNetwork: false });
          const refreshError = refresh.errors?.get(providerId);
          if (refreshError) throw refreshError;
          if (!runtime.getProvider(providerId) || payload.models.some((model) => !runtime.getModel(providerId!, model.id.trim()))) {
            throw new Error("PFSAA_PROVIDER_CONFIGURATION_INVALID");
          }
          await persistProviderApiKey(runtime, providerId, apiKey, request.id);
          const summary = (await listProviderSummaries(runtime, "visible")).find((provider) => provider.id === providerId);
          if (!summary) throw new Error("PFSAA_PROVIDER_CONFIGURATION_INVALID");
          send({ id: request.id, ok: true, result: summary });
        } catch (error) {
          if (providerId) {
            await runtime.logout(providerId).catch(() => undefined);
            await removeCustomProvider(agentDir, providerId).catch(() => undefined);
            await runtime.refresh({ providers: [providerId], allowNetwork: false }).catch(() => undefined);
          }
          throw error;
        }
        return;
      }
      case "providers.update": {
        const payload = request.payload as { providerId?: string; name?: string; baseUrl?: string; models?: Array<{ id: string; name: string }> } | undefined;
        if (!payload?.providerId || !payload.name || !payload.baseUrl || !payload.models?.length) throw new Error("providerId, name, baseUrl and models are required");
        const runtime = await getModelRuntime();
        const provider = (await listProviderSummaries(runtime, "visible")).find((entry) => entry.id === payload.providerId);
        if (!provider?.isEditable) throw new Error("Only locally configured OpenAI-compatible Providers can be edited.");
        assertEditableProviderUpdateIsSafe(provider, payload.baseUrl, payload.models);
        const agentDir = providerConfigAgentDir();
        const previous = await updateEditableProvider(agentDir, provider.id, {
          name: payload.name,
          baseUrl: payload.baseUrl,
          models: payload.models,
        });
        try {
          const refresh = await runtime.refresh({ providers: [provider.id], allowNetwork: false });
          const refreshError = refresh.errors?.get(provider.id);
          if (refreshError) throw refreshError;
          if (!runtime.getProvider(provider.id) || payload.models.some((model) => !runtime.getModel(provider.id, model.id.trim()))) {
            throw new Error("PFSAA_PROVIDER_CONFIGURATION_INVALID");
          }
        } catch (error) {
          await restoreEditableProviderFields(agentDir, provider.id, previous);
          await runtime.refresh({ providers: [provider.id], allowNetwork: false }).catch(() => undefined);
          throw error;
        }
        const summary = (await listProviderSummaries(runtime, "visible")).find((entry) => entry.id === provider.id);
        if (!summary) throw new Error("PFSAA_PROVIDER_CONFIGURATION_INVALID");
        send({ id: request.id, ok: true, result: summary });
        return;
      }
      case "providers.remove": {
        const payload = request.payload as { providerId?: string } | undefined;
        if (!payload?.providerId) throw new Error("providerId is required");
        const runtime = await getModelRuntime();
        const provider = (await listProviderSummaries(runtime, "visible")).find((entry) => entry.id === payload.providerId);
        if (!provider) throw new Error("Provider is not available in PFSAA settings.");
        if (provider.isCustom) assertCustomProviderIsNotInUse(provider.id);
        if (provider.hasStoredCredential) await runtime.logout(provider.id);
        let result: ProviderRemovalResult;
        if (provider.isCustom) {
          await removeCustomProvider(providerConfigAgentDir(), provider.id);
          const refresh = await runtime.refresh({ providers: [provider.id], allowNetwork: false });
          const refreshError = refresh.errors?.get(provider.id);
          if (refreshError) throw refreshError;
          result = { providerId: provider.id, action: "removed" };
        } else {
          await hideProvider(providerConfigAgentDir(), provider.id, provider.name);
          result = { providerId: provider.id, action: "hidden" };
        }
        send({ id: request.id, ok: true, result });
        return;
      }
      case "providers.restore": {
        const payload = request.payload as { providerId?: string } | undefined;
        if (!payload?.providerId) throw new Error("providerId is required");
        await restoreProvider(providerConfigAgentDir(), payload.providerId);
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "providers.login": {
        const payload = request.payload as { providerId?: string; method?: "api-key" | "oauth"; secret?: string; authOperationId?: string } | undefined;
        if (!payload?.providerId || !payload.method) throw new Error("providerId and method are required");
        if (payload.authOperationId !== undefined && (!payload.authOperationId.trim() || payload.authOperationId.length > 200)) throw new Error("Invalid auth operation ID");
        if (payload.method === "api-key") {
          const runtime = await getModelRuntime();
          const apiKey = payload.secret?.trim();
          if (!apiKey) throw new Error("An API key is required");
          await persistProviderApiKey(runtime, payload.providerId, apiKey, request.id);
        } else {
          const operationId = payload.authOperationId?.trim() || request.id;
          const previousOperation = activeProviderLoginByProvider.get(payload.providerId);
          previousOperation?.controller.abort(new Error("Authentication superseded by a new login attempt"));
          const duplicateOperation = activeProviderLogins.get(operationId);
          if (duplicateOperation !== previousOperation) duplicateOperation?.controller.abort(new Error("Authentication superseded by a new login attempt"));
          const operation: ActiveProviderLogin = { operationId, providerId: payload.providerId, controller: new AbortController() };
          activeProviderLogins.set(operationId, operation);
          activeProviderLoginByProvider.set(payload.providerId, operation);
          try {
            const runtime = await getModelRuntime();
            await runtime.login(payload.providerId, "oauth", createAuthInteraction(operationId, payload.providerId, undefined, operation.controller.signal));
          } finally {
            if (activeProviderLogins.get(operationId) === operation) activeProviderLogins.delete(operationId);
            if (activeProviderLoginByProvider.get(payload.providerId) === operation) activeProviderLoginByProvider.delete(payload.providerId);
          }
        }
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "providers.cancelLogin": {
        const payload = request.payload as { authOperationId?: string } | undefined;
        if (!payload?.authOperationId) throw new Error("authOperationId is required");
        activeProviderLogins.get(payload.authOperationId)?.controller.abort(new Error("Authentication cancelled"));
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "providers.setApiKey": {
        const payload = request.payload as { providerId?: string; apiKey?: string } | undefined;
        if (!payload?.providerId || !payload.apiKey) throw new Error("providerId and apiKey are required");
        const runtime = await getModelRuntime();
        const apiKey = payload.apiKey.trim();
        if (!apiKey) throw new Error("An API key is required");
        await persistProviderApiKey(runtime, payload.providerId, apiKey, request.id);
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "providers.logout": {
        const payload = request.payload as { providerId?: string } | undefined;
        if (!payload?.providerId) throw new Error("providerId is required");
        const runtime = await getModelRuntime();
        const hasStoredCredential = (await runtime.listCredentials())
          .some((credential: any) => credential.providerId === payload.providerId);
        if (!hasStoredCredential) {
          throw new Error("Only locally stored Provider credentials can be removed.");
        }
        await runtime.logout(payload.providerId);
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "providers.auth-response": {
        const payload = request.payload as { requestId?: string; value?: string; cancelled?: boolean } | undefined;
        if (!payload?.requestId || (!payload.cancelled && payload.value === undefined)) throw new Error("requestId and value are required");
        const waiter = authWaiters.get(payload.requestId);
        if (!waiter) throw new Error("Auth prompt is no longer active");
        if (payload.cancelled) {
          authWaiters.delete(payload.requestId);
          waiter.reject(new Error("Authentication cancelled"));
        } else {
          // Validation failures deliberately leave the AgentCore prompt pending. The
          // Renderer can display the actionable error and the user can select
          // device-code login without restarting the whole auth operation.
          await waiter.beforeResolve?.(payload.value as string);
          authWaiters.delete(payload.requestId);
          waiter.resolve(payload.value as string);
        }
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      case "permissions.status":
        send({ id: request.id, ok: true, result: permissionEngine.status() });
        return;
      case "permissions.setMode": {
        const payload = request.payload as { mode?: PermissionMode } | undefined;
        if (!payload?.mode || !["ask", "allow", "deny", "yolo"].includes(payload.mode)) throw new Error("Invalid permission mode");
        capabilitySessions.clear();
        send({ id: request.id, ok: true, result: await permissionEngine.setMode(payload.mode) });
        return;
      }
      case "approval.resolve": {
        const payload = request.payload as { requestId?: string; decision?: "allow-once" | "deny" } | undefined;
        if (!payload?.requestId || !payload.decision) throw new Error("requestId and decision are required");
        // A permission-level switch may have already resolved this request.
        // Treat a late UI click as an idempotent no-op.
        try { permissionEngine.resolve(payload.requestId, payload.decision); } catch { /* Already resolved. */ }
        send({ id: request.id, ok: true, result: undefined });
        return;
      }
      default: {
        // An unknown command must fail fast. Without this the renderer would
        // wait for the request timeout instead of seeing an actionable error.
        send({ id: request.id, ok: false, error: `Unknown PfsaaHost command: ${String((request as { command?: unknown }).command ?? "")}` });
        return;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = process.env.PFSAA_DEBUG || process.env.PIDECK_DEBUG
      ? (error instanceof Error ? `\n${error.stack ?? ""}` : "")
      : "";
    send({ id: request.id, ok: false, error: `${message}${detail}` });
  }
}

parentPort?.on("message", (event: { data: unknown }) => void handle(event.data as PfsaaHostRequest));
process.on("message", (message: PfsaaHostRequest | { type?: string; requestId?: string; rules?: string; error?: string }) => {
  if ("type" in message && message.type === "proxy.resolve-result" && typeof message.requestId === "string") {
    handleProxyResolveResult({ requestId: message.requestId, rules: message.rules, error: message.error });
    return;
  }
  void handle(message as PfsaaHostRequest);
});
process.on("disconnect", () => {
  for (const waiter of proxyResolveWaiters.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error("Desktop system proxy bridge disconnected"));
  }
  proxyResolveWaiters.clear();
});
void httpNetworkingReady.then(() => {
  parentPort?.postMessage({ type: "runtime.status", payload: "connected" });
  process.send?.({ type: "runtime.status", payload: "connected" });
}).catch((error) => {
  const message = { type: "runtime.error", payload: { message: publicRuntimeError(error) } };
  parentPort?.postMessage(message);
  process.send?.(message);
  console.error(`PfsaaHost HTTP networking initialization failed: ${publicRuntimeError(error)}`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100);
});

// Observe fatal errors without changing Node's default crash semantics. Main
// owns the exit path: it rejects pending calls, publishes "disconnected", and
// can fork a clean PfsaaHost on restart. Continuing after an uncaught exception
// would leave SDK/session state in an undefined condition.
process.on("uncaughtExceptionMonitor", (error) => {
  console.error("PfsaaHost uncaught exception", error);
});
