import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const expectedAgentCoreVersion = packageJson.dependencies["@earendil-works/pi-coding-agent"];
const expectedPermissionVersion = JSON.parse(readFileSync(path.join(root, "node_modules", "@gotgenes", "pi-permission-system", "package.json"), "utf8")).version;
const hostPath = path.join(root, "packages", "pfsaa-host", "dist", "index.js");
const agentCoreModulePath = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
const agentDir = mkdtempSync(path.join(os.tmpdir(), "pfsaa-source-smoke-"));
const extensionDir = path.join(agentDir, "extensions");
const packageWorkspace = path.join(agentDir, "package-workspace");
const packageSource = path.join(packageWorkspace, "demo-package");
const projectExtensionDir = path.join(packageWorkspace, ".pi", "extensions");
mkdirSync(extensionDir, { recursive: true });
mkdirSync(packageWorkspace, { recursive: true });
mkdirSync(packageSource, { recursive: true });
mkdirSync(projectExtensionDir, { recursive: true });
writeFileSync(path.join(packageSource, "package.json"), JSON.stringify({ name: "pfsaa-package-state-smoke", version: "1.0.0" }), "utf8");
writeFileSync(path.join(extensionDir, "pfsaa-runtime-smoke.ts"), `
export default function pfsaaRuntimeSmoke(pi) {
  pi.registerShortcut("ctrl+shift+y", {
    description: "PFSAA shortcut IPC smoke",
    handler: async (ctx) => {
      if (ctx.mode !== "tui" || ctx.ui.getEditorText() !== "live draft") throw new Error("Shortcut context/editor mirror mismatch");
      ctx.ui.setEditorText("updated draft");
      if (!ctx.ui.getAllThemes().some((theme) => theme.name === "light")) throw new Error("Theme catalog unavailable");
      if (!ctx.ui.setTheme("light").success || ctx.ui.theme.name !== "light") throw new Error("Theme selection failed");
    },
  });
  pi.registerCommand("pfsaa-runtime-smoke", {
    description: "Verify PFSAA extension runtime bindings",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") throw new Error(\`Expected tui extension mode, received \${ctx.mode}\`);
      await ctx.waitForIdle();
      ctx.ui.notify("pfsaa-runtime-smoke:tui", "info");
      const result = await ctx.newSession();
      if (result.cancelled) throw new Error("Extension-created session was cancelled");
    },
  });
}
`, "utf8");

await new Promise((resolve, reject) => {
  let stderr = "";
  let requested = false;
  let settled = false;
  let taskId;
  let extensionModeSeen = false;
  let extensionReplacementSeen = false;
  let extensionEditorSeen = false;
  let extensionThemeSeen = false;
  const child = fork(hostPath, [], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PFSAA_HOST_PROCESS: "1", PFSAA_RUNTIME_MODULE: agentCoreModulePath },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const finish = (error) => {
    if (settled) return;
    settled = true;
    globalThis.clearTimeout(timer);
    child.kill();
    // The forked PfsaaHost may finish its last settings write just after the
    // child is killed. Retry the recursive cleanup so that a transient
    // ENOTEMPTY on CI does not turn a successful smoke run into a failure.
    rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    if (error) reject(new Error(`${error.message}${stderr ? `\n${stderr.trim()}` : ""}`));
    else resolve();
  };
  const timer = globalThis.setTimeout(() => finish(new Error("Source PfsaaHost IPC smoke timed out")), 30_000);
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  child.on("error", (error) => finish(error));
  child.on("exit", (code, signal) => {
    if (!settled) finish(new Error(`Source PfsaaHost exited before completing smoke (code ${code ?? "null"}, signal ${signal ?? "none"})`));
  });
  child.on("message", (message) => {
    if (message?.type === "agent.event" && message.event?.type === "extension.ui.presentation") {
      if (message.event.action === "editor-text" && message.event.text === "updated draft") extensionEditorSeen = true;
      if (message.event.action === "theme" && message.event.theme?.appearance === "light") extensionThemeSeen = true;
    }
    if (message?.type === "agent.event" && message.event?.type === "session.replaced") {
      const replacedExpectedTask = Boolean(message.event.task?.id && message.event.previousTaskId === taskId);
      extensionReplacementSeen = replacedExpectedTask;
      if (message.event.task?.id) taskId = message.event.task.id;
      return;
    }
    if (message?.type === "agent.event" && message.event?.type === "extension.ui.notify" && message.event.message === "pfsaa-runtime-smoke:tui") {
      extensionModeSeen = true;
      return;
    }
    if (message?.type === "runtime.status" && message.payload === "connected" && !requested) {
      requested = true;
      child.send({ id: "runtime-status", command: "runtime.status" });
      return;
    }
    if (message?.id === "runtime-status") {
      if (!message.ok || message.result !== "connected") {
        finish(new Error(`Unexpected runtime.status response: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "app-info", command: "app.info" });
      return;
    }
    if (message?.id === "app-info") {
      if (!message.ok || message.result?.version !== expectedAgentCoreVersion) {
        finish(new Error(`Source AgentCore SDK mismatch: expected ${expectedAgentCoreVersion}, received ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "permission-status", command: "permissions.status" });
      return;
    }
    if (message?.id === "permission-status") {
      if (!message.ok || message.result?.source !== "pi-permission-system" || !String(message.result?.configPath ?? "").startsWith(agentDir)) {
        finish(new Error(`Unexpected permission status: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "project-trust-before", command: "projects.trustStatus", payload: { cwd: packageWorkspace } });
      return;
    }
    if (message?.id === "project-trust-before") {
      if (!message.ok || message.result?.hasTrustRequiringResources !== true || message.result?.trusted !== false || message.result?.source !== "default") {
        finish(new Error(`Unexpected unresolved project trust: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "project-trust-save", command: "projects.setTrust", payload: { cwd: packageWorkspace, trusted: true } });
      return;
    }
    if (message?.id === "project-trust-save") {
      if (!message.ok || message.result?.trusted !== true || message.result?.source !== "saved") {
        finish(new Error(`Project trust was not persisted: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "package-disable", command: "packages.configure", payload: { source: packageSource, enabled: false, local: true, cwd: packageWorkspace } });
      return;
    }
    if (message?.id === "package-disable") {
      if (!message.ok) {
        finish(new Error(`Could not disable smoke package: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "package-filter", command: "packages.configureResource", payload: { source: packageSource, type: "extension", path: "extension.js", enabled: false, local: true, cwd: packageWorkspace } });
      return;
    }
    if (message?.id === "package-filter") {
      if (!message.ok) {
        finish(new Error(`Could not configure smoke package resource: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "package-list-disabled", command: "packages.list", payload: { cwd: packageWorkspace } });
      return;
    }
    if (message?.id === "package-list-disabled") {
      const configured = Array.isArray(message.result) ? message.result.find((item) => item?.source === packageSource && item.scope === "project") : undefined;
      if (!message.ok || configured?.disabled !== true || configured?.filtered !== true) {
        finish(new Error(`Disabled package state was not reported: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "package-enable", command: "packages.configure", payload: { source: packageSource, enabled: true, local: true, cwd: packageWorkspace } });
      return;
    }
    if (message?.id === "package-enable") {
      if (!message.ok) {
        finish(new Error(`Could not enable smoke package: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "package-list-enabled", command: "packages.list", payload: { cwd: packageWorkspace } });
      return;
    }
    if (message?.id === "package-list-enabled") {
      const configured = Array.isArray(message.result) ? message.result.find((item) => item?.source === packageSource && item.scope === "project") : undefined;
      if (!message.ok || configured?.disabled !== false || configured?.filtered !== true) {
        finish(new Error(`Enabled filtered package state was not reported: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "projects-list", command: "projects.list", payload: { knownCwds: [root] } });
      return;
    }
    if (message?.id === "projects-list") {
      if (!message.ok || !Array.isArray(message.result)) {
        finish(new Error(`Unexpected projects.list response: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "models-list", command: "models.list" });
      return;
    }
    if (message?.id === "models-list") {
      if (!message.ok || !Array.isArray(message.result)) {
        finish(new Error(`Unexpected models.list response: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "providers-list", command: "providers.list" });
      return;
    }
    if (message?.id === "providers-list") {
      if (!message.ok || !Array.isArray(message.result)) {
        finish(new Error(`Unexpected providers.list response: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "session-create", command: "sessions.create", payload: { cwd: root, name: "Permission extension smoke" } });
      return;
    }
    if (message?.id === "session-create") {
      taskId = message.ok ? message.result?.id : undefined;
      if (!taskId) {
        finish(new Error(`Could not create smoke session: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "agent-execute-bash", command: "agent.executeBash", payload: { taskId, cwd: root, command: "printf pfsaa-shell-smoke", excludeFromContext: false } });
      return;
    }
    if (message?.id === "agent-execute-bash") {
      if (!message.ok || message.result?.output !== "pfsaa-shell-smoke" || message.result?.exitCode !== 0) {
        finish(new Error(`Unexpected agent.executeBash response: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "session-shell-messages", command: "sessions.messages", payload: { taskId, cwd: root } });
      return;
    }
    if (message?.id === "session-shell-messages") {
      const bashMessage = Array.isArray(message.result) ? message.result.find((entry) => entry?.role === "bashExecution") : undefined;
      if (!message.ok || bashMessage?.command !== "printf pfsaa-shell-smoke" || bashMessage?.output !== "pfsaa-shell-smoke") {
        finish(new Error(`User shell result was not persisted in the session transcript: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "session-run-metadata", command: "sessions.runMetadata", payload: { taskId, cwd: root } });
      return;
    }
    if (message?.id === "session-run-metadata") {
      if (!message.ok || !Array.isArray(message.result)) {
        finish(new Error(`Unexpected sessions.runMetadata response: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "session-change-reviews", command: "sessions.changeReviews", payload: { taskId, cwd: root } });
      return;
    }
    if (message?.id === "session-change-reviews") {
      if (!message.ok || message.result?.availability !== "not-git" || !Array.isArray(message.result?.reviews)) {
        finish(new Error(`Unexpected sessions.changeReviews response: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "session-change-review", command: "sessions.changeReview", payload: { taskId, reviewId: "missing-review", cwd: root } });
      return;
    }
    if (message?.id === "session-change-review") {
      if (!message.ok || message.result !== null) {
        finish(new Error(`Unexpected sessions.changeReview response: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "session-tree", command: "sessions.tree", payload: { taskId, cwd: root } });
      return;
    }
    if (message?.id === "session-tree") {
      if (!message.ok || !Array.isArray(message.result?.entries) || !message.result?.leafId || !message.result.entries.some((entry) => entry.current && entry.active)) {
        finish(new Error(`Unexpected sessions.tree response: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "session-clone", command: "sessions.clone", payload: { taskId, cwd: root } });
      return;
    }
    if (message?.id === "session-clone") {
      if (message.ok || !String(message.error ?? "").includes("has not been saved yet")) {
        finish(new Error(`Unsaved sessions.clone did not return an actionable error: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "session-capabilities", command: "sessions.capabilities", payload: { taskId, cwd: root } });
      return;
    }
    if (message?.id === "session-capabilities") {
      const commands = Array.isArray(message.result?.slashCommands) ? message.result.slashCommands : [];
      if (!message.ok || !commands.some((command) => command?.name === "permission-system" && command.source === "extension")) {
        finish(new Error(`Permission Extension did not load with its command source metadata: ${JSON.stringify(message)}`));
        return;
      }
      if (!commands.some((command) => command?.name === "llama" && command.source === "extension")) {
        finish(new Error(`AgentCore built-in llama command is missing from capabilities: ${JSON.stringify(message)}`));
        return;
      }
      if (!message.result?.extensionShortcuts?.some((shortcut) => shortcut.key === "ctrl+shift+y")) {
        finish(new Error("Registered extension shortcut missing from capabilities"));
        return;
      }
      child.send({ id: "extension-shortcut", command: "extension.shortcut.invoke", payload: { taskId, cwd: root, key: "ctrl+shift+y", text: "live draft" } });
      return;
    }
    if (message?.id === "extension-shortcut") {
      if (!message.ok || !extensionEditorSeen || !extensionThemeSeen) {
        finish(new Error(`Extension shortcut/editor/theme IPC failed: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "agent-cycle-model", command: "agent.cycleModel", payload: { taskId, cwd: root, direction: "forward" } });
      return;
    }
    if (message?.id === "agent-cycle-model") {
      if (!message.ok || typeof message.result?.thinkingLevel !== "string" || !Array.isArray(message.result?.thinkingLevels)) {
        finish(new Error(`Unexpected agent.cycleModel response: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "agent-queue", command: "agent.queue", payload: { taskId, cwd: root } });
      return;
    }
    if (message?.id === "agent-queue") {
      if (!message.ok || !Array.isArray(message.result?.steering) || !Array.isArray(message.result?.followUp)) {
        finish(new Error(`Unexpected agent.queue response: ${JSON.stringify(message)}`));
        return;
      }
      // AgentCore 0.84.4 added the RPC clear_queue surface while PFSAA's direct
      // AgentSession bridge already exposes the same queue-clearing contract.
      // Exercise the bridge against the real SDK before testing stale-ID
      // validation below.
      child.send({ id: "agent-clear-queue", command: "agent.clearQueue", payload: { taskId, cwd: root } });
      return;
    }
    if (message?.id === "agent-clear-queue") {
      if (!message.ok || !Array.isArray(message.result?.steering) || !Array.isArray(message.result?.followUp)) {
        finish(new Error(`Unexpected agent.clearQueue response: ${JSON.stringify(message)}`));
        return;
      }
      // A successful arbitrary deletion requires a live queued prompt and would
      // trigger Provider side effects. Exercise the command safely with a stale
      // stable ID and require the actionable validation error instead.
      child.send({ id: "agent-delete-queue", command: "agent.deleteQueue", payload: { taskId, cwd: root, messageId: "missing-smoke-queue-entry" } });
      return;
    }
    if (message?.id === "agent-delete-queue") {
      if (message.ok || !String(message.error ?? "").includes("Queued message is no longer available")) {
        finish(new Error(`Unexpected agent.deleteQueue response: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "settings-get", command: "settings.get", payload: { cwd: root } });
      return;
    }
    if (message?.id === "settings-get") {
      if (!message.ok || !message.result || typeof message.result.compactionEnabled !== "boolean" || typeof message.result.effectiveExternalEditor !== "string" || !message.result.modelThinkingLevels || typeof message.result.modelThinkingLevels !== "object") {
        finish(new Error(`Unexpected settings.get response: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "settings-update-branch-summary", command: "settings.update", payload: { cwd: root, branchSummarySkipPrompt: true } });
      return;
    }
    if (message?.id === "settings-update-branch-summary") {
      if (!message.ok || message.result?.branchSummarySkipPrompt !== true) {
        finish(new Error(`Unexpected branchSummary.skipPrompt settings update: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "settings-clear-branch-summary", command: "settings.update", payload: { cwd: root, branchSummarySkipPrompt: false } });
      return;
    }
    if (message?.id === "settings-clear-branch-summary") {
      if (!message.ok || message.result?.branchSummarySkipPrompt !== false) {
        finish(new Error(`Unexpected branchSummary.skipPrompt settings reset: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "settings-update-thinking", command: "settings.update", payload: { cwd: root, modelThinkingLevels: { "smoke-provider/smoke-model": "max" } } });
      return;
    }
    if (message?.id === "settings-update-thinking") {
      if (!message.ok || message.result?.modelThinkingLevels?.["smoke-provider/smoke-model"] !== "max") {
        finish(new Error(`Unexpected modelThinkingLevels settings update: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "settings-clear-thinking", command: "settings.update", payload: { cwd: root, modelThinkingLevels: { "smoke-provider/smoke-model": null } } });
      return;
    }
    if (message?.id === "settings-clear-thinking") {
      if (!message.ok || Object.prototype.hasOwnProperty.call(message.result?.modelThinkingLevels ?? {}, "smoke-provider/smoke-model")) {
        finish(new Error(`Unexpected modelThinkingLevels removal: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "settings-update-editor", command: "settings.update", payload: { cwd: root, externalEditor: "pfsaa-smoke-editor --wait" } });
      return;
    }
    if (message?.id === "settings-update-editor") {
      if (!message.ok || message.result?.externalEditor !== "pfsaa-smoke-editor --wait" || message.result?.effectiveExternalEditor !== "pfsaa-smoke-editor --wait" || message.result?.externalEditorSource !== "user") {
        finish(new Error(`Unexpected external editor settings update: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "session-reload", command: "sessions.reload", payload: { taskId, cwd: root } });
      return;
    }
    if (message?.id === "session-reload") {
      if (!message.ok || !Array.isArray(message.result?.slashCommands)) {
        finish(new Error(`Unexpected sessions.reload response: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "workspace-snapshot", command: "workspace.snapshot", payload: { cwd: root } });
      return;
    }
    if (message?.id === "workspace-snapshot") {
      if (!message.ok || !message.result || !Array.isArray(message.result.files)) {
        finish(new Error(`Unexpected workspace.snapshot response: ${JSON.stringify(message)}`));
        return;
      }
      child.send({ id: "extension-runtime-command", command: "agent.prompt", payload: { taskId, cwd: root, text: "/pfsaa-runtime-smoke" } });
      return;
    }
    if (message?.id === "extension-runtime-command") {
      if (!message.ok || message.result?.disposition !== "extension-command" || !extensionModeSeen || !extensionReplacementSeen) {
        finish(new Error(`Extension runtime bindings did not execute through tui mode and AgentSessionRuntime: ${JSON.stringify({ message, extensionModeSeen, extensionReplacementSeen })}`));
        return;
      }
      finish();
    }
  });
});

process.stdout.write(`PfsaaHost IPC smoke passed with AgentCore SDK ${expectedAgentCoreVersion} and pi-permission-system ${expectedPermissionVersion}.\n`);
