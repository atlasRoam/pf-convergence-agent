const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  bashExecutionDetails,
  mergeMessageSnapshot,
  messageIdentity,
  messageSearchText,
  resetExtensionPresentation,
} = require("../dist/renderer/message-utils.js");
const {
  buildMessageTimelineItems,
  restoreCompletedActivity,
} = require("../dist/renderer/timeline-utils.js");

test("close-confirmation copy keys exist in both locale blocks", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../packages/i18n/src/index.ts"), "utf8");
  const keys = ["confirmCloseTitle", "confirmCloseBody", "confirmCloseDontAsk", "confirmCloseExit", "confirmCloseCancel"];
  // The catalog is a single `copy` object with `zh:` and `en:` literal blocks.
  const englishLocaleStart = source.indexOf("\n  en: {");
  const zhBlock = source.slice(source.indexOf("\n  zh: {"), englishLocaleStart);
  const enBlock = source.slice(englishLocaleStart);
  for (const key of keys) {
    assert.ok(zhBlock.includes(`${key}:`), `zh block must define ${key}`);
    assert.ok(enBlock.includes(`${key}:`), `en block must define ${key}`);
  }
});

const rendererSource = (relativePath) => fs.readFileSync(
  path.join(__dirname, "../src/renderer", relativePath),
  "utf8",
);

test("model cycling delegates to AgentCore so scoped order and Thinking remain authoritative", () => {
  const controller = rendererSource("use-app-controller.tsx");
  const host = fs.readFileSync(path.join(__dirname, "../../../packages/pfsaa-host/src/index.ts"), "utf8");
  assert.match(controller, /window\.pfsaa\.agent\.cycleModel\(activeTask\.id, direction, projectCwd\)/);
  assert.doesNotMatch(controller, /const next = \(base \+ direction \+ modelOptions\.length\)/);
  assert.match(host, /case "agent\.cycleModel":[\s\S]*?await session\.cycleModel\(payload\.direction\)/);
});

test("project trust stays host-enforced while the fixed workspace hides its UI entry", () => {
  const controller = rendererSource("use-app-controller.tsx");
  const overlays = rendererSource("app-overlays.tsx");
  const quickSettings = rendererSource("ui/quick-settings.tsx");
  const host = fs.readFileSync(path.join(__dirname, "../../../packages/pfsaa-host/src/index.ts"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "../src/preload/index.ts"), "utf8");
  assert.match(controller, /const status = await window\.pfsaa\.projects\.trustStatus\(project\.cwd\)/);
  assert.match(controller, /\(status\.source === "default" \|\| status\.source === "not-required"\) && status\.defaultPolicy === "ask"/);
  assert.doesNotMatch(overlays, /data-project-action="trust"/);
  assert.doesNotMatch(quickSettings, /id: "trust"/);
  assert.match(main, /"projects:trust-status"[\s\S]*?"projects\.trustStatus"/);
  assert.match(preload, /trustStatus: \(cwd: string\) => ipcRenderer\.invoke\("projects:trust-status", cwd\)/);
  assert.match(host, /createTrustAwareSettingsManager\(sdk, options\.cwd, options\.agentDir\)/);
  assert.match(host, /case "projects\.trustStatus"/);
  assert.match(host, /case "projects\.setTrust"[\s\S]*?invalidateResourceSessions\(\)/);
});

test("accepted built-in commands clear the Composer before asynchronous work settles", () => {
  const controller = rendererSource("use-app-controller.tsx");
  assert.match(controller, /async function handleBuiltinCommand\(text: string, onAccepted\?: \(\) => void\)/);
  assert.match(controller, /if \(!action\) return false;\s*onAccepted\?\.\(\);\s*await action\(\);/);
  assert.match(controller, /if \(await handleBuiltinCommand\(text, \(\) => \{[\s\S]*?setComposer\(""\); setSuggestionMode\(null\);\s*\}\)\) return;/);
});

test("manual compaction exposes Stop, aborts its controller, and preserves staged queue IDs", () => {
  const controller = rendererSource("use-app-controller.tsx");
  const host = fs.readFileSync(path.join(__dirname, "../../../packages/pfsaa-host/src/index.ts"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
  assert.match(controller, /onStop: \(\) => void abortActive\(\),\s*isSending: isWorking/);
  const abortHandler = host.slice(host.indexOf('case "agent.abort"'), host.indexOf('case "agent.setThinkingLevel"'));
  assert.match(abortHandler, /session\.abortCompaction\(\);\s*session\.abortBranchSummary\?\.\(\);\s*await session\.abort\(\)/);
  assert.match(host, /resumeManualCompactionQueue\(payload\.taskId, stateKey, session, completed\)/);
  assert.match(host, /trackQueuedPrompt\(stateKey, entry\.delivery, entry\.text, entry\.images, entry\.id\)/);
  assert.match(main, /command === "input.externalEdit" \|\| command === "sessions.compact"/);
});

function message(id, role, text, timestamp) {
  return { id, role, content: text, timestamp };
}

function activity(id) {
  return [{ id, kind: "thinking", label: id, startedAt: 1, endedAt: 2 }];
}

test("Extension presentation reset removes stale UI without clearing the active run", () => {
  const running = {
    isSending: true,
    isCompacting: false,
    streamText: "working",
    workingPhase: "thinking",
    activity: activity("live"),
    completedActivity: [],
    extensionStatuses: { demo: "Turns: 0" },
    extensionWidgets: [{ key: "demo", lines: ["Loaded"], placement: "aboveEditor" }],
    extensionWorkingMessage: "Demo work",
    extensionWorkingVisible: false,
    extensionWorkingFrames: ["a", "b"],
    extensionWorkingInterval: 80,
    extensionHiddenThinkingLabel: "Demo thinking",
  };
  const reset = resetExtensionPresentation(running);
  assert.equal(reset.isSending, true);
  assert.equal(reset.streamText, "working");
  assert.deepEqual(reset.activity, running.activity);
  assert.deepEqual(reset.extensionStatuses, {});
  assert.deepEqual(reset.extensionWidgets, []);
  assert.equal(reset.extensionWorkingMessage, undefined);
  assert.equal(reset.extensionWorkingVisible, true);
  assert.equal(reset.extensionWorkingFrames, undefined);
  assert.equal(reset.extensionHiddenThinkingLabel, undefined);
});

test("persisted user shell commands remain visible with their command and output", () => {
  const bashMessage = {
    role: "bashExecution",
    command: "dir",
    output: "file.txt\n",
    exitCode: 0,
    cancelled: false,
    timestamp: 10,
    excludeFromContext: false,
  };
  const items = buildMessageTimelineItems({
    messages: [bashMessage],
    language: "en",
    running: false,
    completedActivity: [],
    steeringMessageKeys: [],
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "message");
  assert.equal(items[0].message, bashMessage);
  assert.deepEqual(bashExecutionDetails(bashMessage), {
    command: "dir",
    output: "file.txt\n",
    excludeFromContext: false,
    exitCode: 0,
    cancelled: false,
    failed: false,
  });
  assert.equal(messageSearchText(bashMessage), "!dir\nfile.txt\n");
});

test("transcript search indexes visible shell command and output fields", () => {
  const bashMessage = {
    role: "bashExecution",
    command: "echo UI_SEARCH_ALPHA",
    output: "UI_SEARCH_ALPHA\n",
    exitCode: 0,
    cancelled: false,
    timestamp: 10,
    excludeFromContext: false,
  };
  assert.match(messageSearchText(bashMessage), /UI_SEARCH_ALPHA/);
  assert.equal(messageSearchText({ role: "assistant", stopReason: "error", errorMessage: "Provider unavailable", content: "" }), "Provider unavailable");
});

test("shell result UI stays compact, accessible, and actionable", () => {
  const source = rendererSource("ui/message-view.tsx");
  const shellOutput = rendererSource("ui/shell-output.tsx");
  const styles = rendererSource("styles.css");
  assert.match(source, /LONG_SHELL_OUTPUT_LINES/);
  assert.match(source, /copyText\(execution\.output\)/);
  assert.match(source, /<ShellOutput output=\{displayOutput\}/);
  assert.match(source, /aria-expanded=\{expanded\}/);
  assert.match(source, /aria-controls=\{outputId\}/);
  assert.match(source, /shellExitCode/);
  assert.match(source, /shellExcludedFromContext/);
  assert.match(source, /replace\(\/\\r\\n\?\/g, "\\n"\)\.replace\(\/\\n\+\$\/, ""\)/);
  assert.match(shellOutput, /disableStdin:\s*true/);
  assert.match(shellOutput, /convertEol:\s*true/);
  assert.match(shellOutput, /screenReaderMode:\s*true/);
  assert.match(shellOutput, /tabStopWidth:\s*8/);
  assert.match(shellOutput, /new fitModule\.FitAddon\(\)/);
  assert.match(shellOutput, /shell-command-output-fallback/);
  assert.match(styles, /\.shell-command-output-wrap\.collapsed/);
  assert.match(styles, /\.shell-command-output-terminal \{[^}]*height:\s*min\(calc\(var\(--shell-output-lines\) \* 17px \+ 25px\)/);
  assert.match(styles, /\.shell-command-output-wrap\.collapsed \.shell-command-output-terminal[^}]*height:\s*154px[^}]*max-height:\s*154px/);
  assert.match(styles, /\.shell-command-footer > button \{[^}]*min-height:\s*var\(--control-height\)/);
  assert.match(styles, /\.shell-command-copy:focus-visible/);
});

test("a running user shell command owns an independent live timeline row", () => {
  const shellActivity = [{ id: "shell-1", kind: "tool", label: "! shell", args: { command: "dir" }, result: "file.txt\n", startedAt: 10 }];
  const items = buildMessageTimelineItems({
    messages: [message("u1", "user", "hello", 1), message("a1", "assistant", "hi", 2)],
    language: "en",
    running: true,
    completedActivity: [],
    steeringMessageKeys: [],
    taskId: "task-1",
    activeActivity: shellActivity,
    workingPhase: "tool",
    toolName: "shell",
  });
  const liveItems = items.filter((item) => item.type === "live");
  assert.equal(liveItems.length, 1);
  assert.equal(liveItems[0].stableKey, "bash-live-task-1-shell-1");
  assert.equal(liveItems[0].activitySteps[0].result, "file.txt\n");
});

function describeTimeline(items) {
  return items.map((item) => item.type === "execution"
    ? `execution:${item.steps[0]?.id}`
    : item.type === "live"
      ? `live:${item.text}`
    : `message:${item.message.id}`);
}

test("empty project task creation keeps the target project cwd", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../src/renderer/app-sidebar.tsx"),
    "utf8",
  );

  assert.match(source, /onClick=\{\(\) => void onCreateTaskForProject\(project\)\}/);
});

test("new task creation stays scoped to the current project", () => {
  const controller = fs.readFileSync(
    path.join(__dirname, "../src/renderer/use-app-controller.tsx"),
    "utf8",
  );

  // updateTaskLists applies its update to every project's cached list, so a
  // new task must be written to the current project only (regression: creating
  // a task once leaked a phantom session into every other expanded project).
  assert.match(controller, /setTasks\(\(current\) => sortTasksByUpdatedAt\(\[task, \.\.\.current\.filter/);
  assert.doesNotMatch(controller, /updateTaskLists\(\(current\) => sortTasksByUpdatedAt\(\[task, \.\.\.current\.filter/);
});

test("cross-project switches keep each sidebar session list cwd-scoped", () => {
  const sidebar = rendererSource("app-sidebar.tsx");
  const appView = rendererSource("app-view.tsx");

  const sidebarProps = appView.slice(appView.indexOf("<AppSidebar"), appView.indexOf("<PaneResizeHandle"));
  assert.match(sidebar, /const projectTasks = projectTasksByCwd\[project\.cwd\] \?\? \[\]/);
  assert.doesNotMatch(sidebar, /selected \? tasks : projectTasksByCwd/);
  assert.doesNotMatch(sidebarProps, /tasks=\{tasks\}/);
});

test("desktop sidebar collapse preserves compact navigation affordances", () => {
  const sidebar = rendererSource("app-sidebar.tsx");
  const appView = rendererSource("app-view.tsx");
  const styles = rendererSource("styles.css");
  const i18n = fs.readFileSync(path.join(__dirname, "../../../packages/i18n/src/index.ts"), "utf8");

  assert.match(appView, /COLLAPSED_SIDEBAR_WIDTH\s*=\s*64/);
  assert.match(appView, /readPfsaaStorage\("sidebar-collapsed"\)/);
  assert.match(appView, /writePfsaaStorage\("sidebar-collapsed"/);
  assert.match(appView, /sidebarCollapsed \? COLLAPSED_SIDEBAR_WIDTH : effectiveSidebarWidth/);
  assert.match(appView, /sidebarCollapsed \? "sidebar-collapsed"/);
  assert.match(appView, /onToggleSidebar=\{toggleSidebar\}/);
  assert.match(appView, /disabled=\{reviewDrawerOpen \|\| sidebarCollapsed\}/);
  assert.match(sidebar, /sidebarCollapsed: boolean/);
  assert.match(sidebar, /onToggleSidebar: \(\) => void/);
  assert.match(sidebar, /className=\{`sidebar \$\{mobileSidebarOpen \? "mobile-open" : ""\} \$\{sidebarCollapsed \? "sidebar-collapsed" : ""\}`\}/);
  assert.match(sidebar, /className="sidebar-collapse-toggle"/);
  assert.match(sidebar, /aria-controls="workspace-sidebar"/);
  assert.match(sidebar, /sidebarCollapsed \? t\.expandSidebar : t\.collapseSidebar/);
  assert.match(styles, /@media \(min-width: 561px\)[\s\S]*?\.sidebar\.sidebar-collapsed \.project-sessions, \.sidebar\.sidebar-collapsed \.empty-sidebar \{ display: none; \}/);
  assert.match(styles, /\.sidebar\.sidebar-collapsed \.project-row \{[^}]*width:\s*44px[^}]*min-height:\s*44px/);
  assert.match(styles, /\.sidebar\.sidebar-collapsed \.runtime-status button \{[^}]*width:\s*44px[^}]*min-height:\s*28px/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.sidebar-collapse-toggle \{ display: none; \}/);
  assert.match(i18n, /collapseSidebar: "收起项目侧栏"/);
  assert.match(i18n, /collapseSidebar: "Collapse project sidebar"/);
  assert.match(i18n, /expandSidebar: "展开项目侧栏"/);
  assert.match(i18n, /expandSidebar: "Expand project sidebar"/);
});

test("startup restores sessions for every persisted expanded project", () => {
  const controller = fs.readFileSync(
    path.join(__dirname, "../src/renderer/use-app-controller.tsx"),
    "utf8",
  );

  assert.match(controller, /const restoredExpandedCwds = new Set\(expandedProjectCwds\)/);
  assert.match(controller, /const restoredExpandedProjects = discoveredProjects\.filter\(\(project\) => project\.cwd !== selectedProject\.cwd && restoredExpandedCwds\.has\(project\.cwd\)\)/);
  assert.match(controller, /await Promise\.all\(restoredExpandedProjects\.map\(\(project\) => loadProjectSessions\(project\)\)\)/);
});

test("execution durations use durable AgentCore session metadata", () => {
  const host = fs.readFileSync(
    path.join(__dirname, "../../../packages/pfsaa-host/src/index.ts"),
    "utf8",
  );
  const contracts = fs.readFileSync(
    path.join(__dirname, "../../../packages/contracts/src/index.ts"),
    "utf8",
  );
  const sessionData = fs.readFileSync(
    path.join(__dirname, "../src/renderer/use-session-data.ts"),
    "utf8",
  );
  const timeline = fs.readFileSync(
    path.join(__dirname, "../src/renderer/timeline-utils.ts"),
    "utf8",
  );
  const runtimeEvents = fs.readFileSync(
    path.join(__dirname, "../src/renderer/use-runtime-events.ts"),
    "utf8",
  );
  const executionSummary = rendererSource("ui/execution-summary.tsx");

  assert.match(host, /appendCustomEntry/);
  assert.match(host, /agent_start/);
  assert.match(host, /agent_settled/);
  assert.match(host, /queueDelivery === "followUp"/);
  assert.match(host, /finishExecutionGroup/);
  assert.match(host, /case "sessions\.runMetadata"/);
  assert.match(contracts, /export interface SessionRunRecord/);
  assert.match(contracts, /runMetadata\(taskId: string/);
  assert.match(sessionData, /window\.pfsaa\.sessions\.runMetadata\(taskId, projectCwd\)/);
  assert.match(sessionData, /restoreCompletedActivity/);
  assert.match(timeline, /durationMs: record\.durationMs/);
  assert.match(runtimeEvents, /applyPersistedRunDurations/);
  assert.match(runtimeEvents, /sessions\.runMetadata\(taskId, projectCwd\)/);
  assert.match(executionSummary, /persistedDurationMs/);
  assert.match(timeline, /persisted:\$\{record\.id\}/);
});

test("running execution is a timer only and completed details stay bounded", () => {
  const executionSummary = rendererSource("ui/execution-summary.tsx");
  const styles = rendererSource("styles.css");

  assert.match(executionSummary, /if \(running\) \{\s*return <div className="execution-summary execution-summary-running" role="timer">/);
  assert.match(executionSummary, /<span>\{t\.executionProcessing\(duration\)\}<\/span>/);
  const runningBlock = executionSummary.slice(executionSummary.indexOf("if (running)"), executionSummary.indexOf("// A restored group"));
  assert.doesNotMatch(runningBlock, /<details|<summary|Icon/);
  assert.match(styles, /\.execution-details\s*\{[^}]*max-height:\s*min\(420px, 38vh\)[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s);
  assert.match(styles, /\.execution-summary-running\s*\{[^}]*cursor:\s*default/);
});

test("name command opens an editable rename dialog without an argument", () => {
  const controller = fs.readFileSync(
    path.join(__dirname, "../src/renderer/use-app-controller.tsx"),
    "utf8",
  );
  const dialogs = rendererSource("ui/dialogs.tsx");

  assert.match(controller, /command === "name"\) action = async \(\) => \{ if \(argument\) await renameSession\(argument\); else if \(activeTask\) setRenameOpen\(true\)/);
  assert.match(dialogs, /function RenameSessionDialog/);
});

test("conversation panes survive project switches and scope scroll snapshots", () => {
  const conversation = fs.readFileSync(
    path.join(__dirname, "../src/renderer/app-conversation.tsx"),
    "utf8",
  );
  const timeline = rendererSource("ui/message-timeline.tsx");

  assert.match(conversation, /cachedPaneKeys/);
  assert.match(conversation, /conversationPaneKey\(task\.projectId, task\.id\)/);
  assert.doesNotMatch(conversation, /<ConversationPaneDeck\s+key=\{projectCwd/);
  assert.match(timeline, /scrollPositionsRef\.current\[scrollKey\]/);
});

test("package enable/disable edits AgentCore autoload state instead of re-adding sources", () => {
  const host = fs.readFileSync(
    path.join(__dirname, "../../../packages/pfsaa-host/src/index.ts"),
    "utf8",
  );
  const packageSettings = rendererSource("ui/package-settings.tsx");

  assert.match(host, /function configurePackageSource/);
  assert.match(host, /manager\.listConfiguredPackages\?\.\(\)/);
  assert.match(host, /entry\.autoload === false/);
  assert.match(host, /disabled: item\.disabled === true \|\| disabledPackageKeys\.has/);
  assert.doesNotMatch(host, /disabled: item\.disabled === true \|\| item\.filtered === true/);
  assert.match(host, /packageConfigRevision/);
  assert.doesNotMatch(host, /function listConfiguredPackages/);
  assert.match(host, /autoload: false/);
  assert.doesNotMatch(host, /payload\.enabled\s*\?\s*manager\.addSourceToSettings/);
  assert.match(packageSettings, /item\.disabled/);
  assert.match(packageSettings, /onPackagesChanged/);
});

test("slash suggestion symbols keep their fixed visual width", () => {
  const styles = fs.readFileSync(
    path.join(__dirname, "../src/renderer/styles.css"),
    "utf8",
  );

  assert.match(styles, /\.suggestion-symbol\s*\{[^}]*flex:\s*0 0 22px/);
});

test("/settings opens the AgentCore settings surface backed by SettingsManager", () => {
  const controller = fs.readFileSync(
    path.join(__dirname, "../src/renderer/use-app-controller.tsx"),
    "utf8",
  );
  const capabilities = fs.readFileSync(
    path.join(__dirname, "../src/renderer/agentcore-capabilities.ts"),
    "utf8",
  );
  const settingsUi = fs.readFileSync(
    path.join(__dirname, "../src/renderer/ui/agentcore-settings.tsx"),
    "utf8",
  );

  assert.match(controller, /command === "settings"[\s\S]*?setAgentCoreSettingsOpen\(true\)/);
  assert.match(controller, /command === "fork"[\s\S]*?openSessionBranch\("fork"\)/);
  assert.match(controller, /command === "clone"[\s\S]*?openSessionBranch\("clone"\)/);
  assert.match(controller, /command === "tree"[\s\S]*?openSessionBranch\("tree"\)/);
  assert.doesNotMatch(controller, /pendingPiCommands/);
  assert.match(capabilities, /name: "settings"/);
  assert.match(settingsUi, /window\.pfsaa\.settings\.get/);
  assert.match(settingsUi, /window\.pfsaa\.settings\.update/);
});

test("AgentCore model metadata follows the current SDK shape", () => {
  const adapter = fs.readFileSync(
    path.join(__dirname, "../../../packages/agentcore-adapter/src/index.ts"),
    "utf8",
  );

  assert.match(adapter, /model\.thinkingLevelMap/);
  assert.match(adapter, /model\?\.modelId \|\| model\?\.id/);
  assert.doesNotMatch(adapter, /model\?\.provider && model\?\.id\) return/);
});

test("agent_end messages and auth cancellation stay on the bridge", () => {
  const host = fs.readFileSync(
    path.join(__dirname, "../../../packages/pfsaa-host/src/index.ts"),
    "utf8",
  );
  const eventAdapter = fs.readFileSync(
    path.join(__dirname, "../../../packages/pfsaa-host/src/agent-event-adapter.ts"),
    "utf8",
  );
  const contracts = fs.readFileSync(
    path.join(__dirname, "../../../packages/contracts/src/index.ts"),
    "utf8",
  );
  const runtimeEvents = fs.readFileSync(
    path.join(__dirname, "../src/renderer/use-runtime-events.ts"),
    "utf8",
  );

  assert.match(eventAdapter, /type: event\.type, willRetry: event\.willRetry, messages: jsonSafe\(event\.messages\)/);
  assert.match(runtimeEvents, /Array\.isArray\(event\.messages\)/);
  assert.match(host, /cancelled\?: boolean/);
  assert.match(contracts, /resolveAuth\(requestId: string, value: string, cancelled\?: boolean\)/);
  assert.match(host, /waiter\.reject\(new Error\("Authentication cancelled"\)\)/);
  assert.match(host, /await persistProviderApiKey\(runtime, payload\.providerId/);
  assert.doesNotMatch(host, /void runtime\.setRuntimeApiKey/);
});

test("PfsaaHost keeps mutable state and Agent event adaptation outside the orchestrator", () => {
  const host = fs.readFileSync(
    path.join(__dirname, "../../../packages/pfsaa-host/src/index.ts"),
    "utf8",
  );
  const state = fs.readFileSync(
    path.join(__dirname, "../../../packages/pfsaa-host/src/host-state.ts"),
    "utf8",
  );
  const adapter = fs.readFileSync(
    path.join(__dirname, "../../../packages/pfsaa-host/src/agent-event-adapter.ts"),
    "utf8",
  );

  assert.match(host, /from "\.\/host-state\.js"/);
  assert.match(host, /from "\.\/agent-event-adapter\.js"/);
  assert.doesNotMatch(host, /const (?:sessionManagers|agentSessions|activeChangeReviews) = new Map/);
  assert.match(state, /export const sessionManagers = new Map/);
  assert.match(state, /export const activeChangeReviews = new Map/);
  assert.match(adapter, /export function normalizeAgentEvent/);
});

test("OpenAI Codex OAuth prefers the loopback callback and restores the desktop window", () => {
  const host = fs.readFileSync(
    path.join(__dirname, "../../../packages/pfsaa-host/src/index.ts"),
    "utf8",
  );
  const main = fs.readFileSync(
    path.join(__dirname, "../src/main/index.ts"),
    "utf8",
  );
  const providerSettings = fs.readFileSync(
    path.join(__dirname, "../src/renderer/ui/provider-settings.tsx"),
    "utf8",
  );

  assert.match(host, /OPENAI_CODEX_LOOPBACK_PORT = 1455/);
  assert.match(host, /OPENAI_CODEX_FIXED_LOOPBACK_SDK_VERSIONS = new Set\(\["0\.84\.2", "0\.84\.3", "0\.84\.4", "0\.85\.0", "0\.85\.1"\]\)/);
  assert.match(host, /await waiter\.beforeResolve\?\.\(payload\.value as string\);\s+authWaiters\.delete/);
  assert.match(host, /PFSAA_OAUTH_CALLBACK_UNAVAILABLE/);
  assert.match(host, /signal\?\.addEventListener\("abort", onAbort, \{ once: true \}\)/);
  assert.match(host, /authWaiters\.delete\(promptId\);\s+waiter\.reject/);
  assert.match(main, /if \(method === "oauth"\) focusHostWindow\(\)/);
  assert.match(providerSettings, /authPrompt\.type !== "manual_code" \|\| manualAuthVisible/);
  assert.match(providerSettings, /setAuthPrompt\(null\);\s+setManualAuthVisible\(false\);\s+setAuthNotice\(null\)/);
});

test("closing Provider settings cancels an unfinished OAuth login", () => {
  const host = fs.readFileSync(
    path.join(__dirname, "../../../packages/pfsaa-host/src/index.ts"),
    "utf8",
  );
  const contracts = fs.readFileSync(
    path.join(__dirname, "../../../packages/contracts/src/index.ts"),
    "utf8",
  );
  const main = fs.readFileSync(
    path.join(__dirname, "../src/main/index.ts"),
    "utf8",
  );
  const preload = fs.readFileSync(
    path.join(__dirname, "../src/preload/index.ts"),
    "utf8",
  );
  const providerSettings = fs.readFileSync(
    path.join(__dirname, "../src/renderer/ui/provider-settings.tsx"),
    "utf8",
  );

  assert.match(contracts, /cancelLogin\(authOperationId: string\): Promise<void>/);
  assert.match(contracts, /\| "providers\.cancelLogin"/);
  assert.match(main, /"providers:cancel-login"/);
  assert.match(preload, /cancelLogin: .*"providers:cancel-login"/);
  assert.match(providerSettings, /activeOAuthLoginIdsRef\.current/);
  assert.match(providerSettings, /providers\.cancelLogin\(authOperationId\)/);
  assert.match(providerSettings, /crypto\.randomUUID\(\)/);
  assert.match(host, /activeProviderLoginByProvider\.get\(payload\.providerId\)/);
  assert.match(host, /controller\.abort\(new Error\("Authentication superseded by a new login attempt"\)\)/);
  assert.match(host, /createAuthInteraction\(operationId, payload\.providerId, undefined, operation\.controller\.signal\)/);
  assert.match(host, /case "providers\.cancelLogin"/);
  assert.match(host, /controller\.abort\(new Error\("Authentication cancelled"\)\)/);
});

test("PFSAA hides its unavailable change-review surface and makes Provider credential ownership explicit", () => {
  const contracts = fs.readFileSync(
    path.join(__dirname, "../../../packages/contracts/src/index.ts"),
    "utf8",
  );
  const host = fs.readFileSync(
    path.join(__dirname, "../../../packages/pfsaa-host/src/index.ts"),
    "utf8",
  );
  const controller = rendererSource("use-app-controller.tsx");
  const reviewState = rendererSource("use-change-review.ts");
  const conversation = rendererSource("app-conversation.tsx");
  const providerSettings = rendererSource("ui/provider-settings.tsx");

  assert.match(contracts, /changeReviewEnabled: boolean/);
  assert.match(host, /changeReviewEnabled: !pfsaa/);
  assert.match(controller, /enabled: capabilities\?\.changeReviewEnabled === true/);
  assert.match(reviewState, /if \(!enabled \|\| !scopeKey \|\| !taskId \|\| !projectCwd\)/);
  assert.match(conversation, /changeReviewEnabled && \(latestChangeReview \|\| changeReviewAvailability !== "available"\)/);
  assert.match(contracts, /authSource: ProviderAuthSource/);
  assert.match(contracts, /hasStoredCredential: boolean/);
  assert.match(host, /authSource: providerAuthSource\(auth, hasStoredCredential\)/);
  assert.match(host, /Only locally stored Provider credentials can be removed\./);
  assert.match(providerSettings, /provider\.hasStoredCredential/);
  assert.match(providerSettings, /logoutError && <div className="inline-error" role="alert">/);
});

test("AgentCore 0.84.4 thinking command remains handled by the desktop thinking selector", () => {
  const controller = fs.readFileSync(
    path.join(__dirname, "../src/renderer/use-app-controller.tsx"),
    "utf8",
  );
  const fallbacks = fs.readFileSync(
    path.join(__dirname, "../src/renderer/agentcore-capabilities.ts"),
    "utf8",
  );

  assert.match(controller, /if \(command === "thinking"\)/);
  assert.match(controller, /thinkingLevels\.find/);
  assert.match(controller, /await chooseThinking\(requestedLevel\)/);
  assert.match(fallbacks, /name: "thinking"/);
});

test("AgentCore 0.84.4 Extension UI prompt lifecycle events stay serializable at the bridge", () => {
  const adapter = fs.readFileSync(
    path.join(__dirname, "../../../packages/pfsaa-host/src/agent-event-adapter.ts"),
    "utf8",
  );

  assert.match(adapter, /event\.type === "ui_prompt_start" \|\| event\.type === "ui_prompt_end"/);
  assert.match(adapter, /reason: event\.reason/);
  assert.match(adapter, /kind: event\.kind/);
});

test("message identity remains stable when AgentCore omits message ids", () => {
  const value = {
    role: "user",
    timestamp: 42,
    content: [
      { type: "text", text: "hello" },
      { type: "image", mimeType: "image/png", data: "abc" },
    ],
  };
  assert.equal(messageIdentity(value), "message:user|42|hello|image/png");
});

test("incremental snapshots replace optimistic messages without reordering", () => {
  const optimistic = message("local-1", "user", "first", 1);
  const assistant = message("a1", "assistant", "reply", 2);
  const persisted = { role: "user", content: "first", timestamp: 3 };
  const merged = mergeMessageSnapshot([optimistic, assistant], [persisted]);

  assert.deepEqual(merged, [persisted, assistant]);
});

test("expanded Skill snapshots replace the original optimistic command", () => {
  const optimistic = message("local-skill", "user", "/skill:ui-ux-pro-max\n\nshow the dashboard", 1);
  const expanded = message("persisted-skill", "user", '<skill name="ui-ux-pro-max" location="C:\\skills\\ui-ux-pro-max\\SKILL.md">\n# UI guidance\n</skill>\n\nshow the dashboard', 2);

  assert.deepEqual(mergeMessageSnapshot([optimistic], [expanded], true), [expanded]);
  assert.deepEqual(mergeMessageSnapshot([optimistic], [expanded]), [expanded]);
});

test("authoritative snapshots preserve AgentCore order instead of timestamp order", () => {
  const optimistic = message("local-1", "user", "queued", 1);
  const liveOnly = message("live", "assistant", "still live", 99);
  const canonical = [
    message("u1", "user", "first", 30),
    message("a1", "assistant", "reply", 10),
    { role: "user", content: "queued", timestamp: 40 },
  ];
  const merged = mergeMessageSnapshot([optimistic, liveOnly], canonical, true);

  assert.deepEqual(merged.map((item) => item.id ?? item.content), ["u1", "a1", "queued", "live"]);
});

test("follow-up messages create distinct logical turns", () => {
  const messages = [
    message("u1", "user", "first", 1),
    message("a1", "assistant", "reply", 2),
    message("u2", "user", "follow up", 3),
    message("a2", "assistant", "reply 2", 4),
  ];
  const items = buildMessageTimelineItems({
    messages,
    language: "en",
    running: false,
    completedActivity: [activity("run-1"), activity("run-2")],
    steeringMessageKeys: [],
  });

  assert.deepEqual(describeTimeline(items), [
    "message:u1",
    "execution:run-1",
    "message:a1",
    "message:u2",
    "execution:run-2",
    "message:a2",
  ]);
});

test("failed model response stays visible instead of being dropped", () => {
  const failed = {
    id: "a-fail",
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "error",
    errorMessage: "Codex error: The usage limit has been reached",
    timestamp: 2,
  };
  const items = buildMessageTimelineItems({
    messages: [
      message("u1", "user", "hello", 1),
      failed,
    ],
    language: "en",
    running: false,
    completedActivity: [activity("run-fail")],
    steeringMessageKeys: [],
  });

  assert.deepEqual(describeTimeline(items), [
    "message:u1",
    "execution:run-fail",
    "message:a-fail",
  ]);
});

test("steering messages stay inside one logical turn", () => {
  const steering = message("u-steer", "user", "adjust", 3);
  const messages = [
    message("u1", "user", "first", 1),
    message("a1", "assistant", "partial", 2),
    steering,
    message("a2", "assistant", "adjusted", 4),
  ];
  const items = buildMessageTimelineItems({
    messages,
    language: "en",
    running: false,
    completedActivity: [activity("shared-run")],
    steeringMessageKeys: [messageIdentity(steering)],
  });

  assert.equal(items.filter((item) => item.type === "execution").length, 1);
  assert.deepEqual(items.filter((item) => item.type === "message").map((item) => item.message.id), ["u1", "a1", "u-steer", "a2"]);
});

test("historical turns without metadata do not invent a duration", () => {
  const items = buildMessageTimelineItems({
    messages: [
      message("u1", "user", "first", 1_000),
      message("a1", "assistant", "reply", 4_500),
    ],
    language: "en",
    running: false,
    completedActivity: [],
    steeringMessageKeys: [],
    taskId: "restarted-task",
  });

  const summary = items.find((item) => item.type === "execution");
  assert.equal(Boolean(summary), true);
  assert.equal(summary.steps[0].timing, "unknown");
});

test("session reload keeps AgentCore thinking and tool details while restoring duration", () => {
  const groups = restoreCompletedActivity([
    message("u1", "user", "inspect", 1_000),
    {
      id: "a1",
      role: "assistant",
      timestamp: 2_000,
      content: [
        { type: "thinking", thinking: "check the workspace" },
        { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
        { type: "text", text: "done" },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "tool-1",
      timestamp: 3_000,
      content: [{ type: "text", text: "file contents" }],
    },
  ], "en", [{ id: "run-1", startedAt: 1_000, endedAt: 4_000, durationMs: 3_000 }]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0][0].detail, "check the workspace");
  assert.equal(groups[0].find((step) => step.kind === "tool").result, "file contents");
  assert.equal(groups[0][0].durationMs, 3_000);
});

test("the active final turn keeps a stable summary and response item", () => {
  const messages = [
    message("u1", "user", "first", 1),
  ];
  const items = buildMessageTimelineItems({
    messages,
    language: "en",
    running: true,
    completedActivity: [],
    steeringMessageKeys: [],
    taskId: "task-1",
    activeActivity: activity("active-run"),
    liveText: "partial",
    workingPhase: "responding",
  });

  assert.equal(items.some((item) => item.type === "execution"), true);
  assert.equal(items.some((item) => item.type === "live"), true);
  assert.equal(items.find((item) => item.type === "live").stableKey, "response-task-1-0");

  const settled = buildMessageTimelineItems({
    messages: [...messages, message("a1", "assistant", "partial", 2)],
    language: "en",
    running: false,
    completedActivity: [activity("active-run")],
    steeringMessageKeys: [],
    taskId: "task-1",
  });
  assert.equal(settled.find((item) => item.type === "message" && item.message.id === "a1").stableKey, "response-task-1-0");
});

test("Assistant continuations keep unique identities and compact spacing into live activity", () => {
  const items = buildMessageTimelineItems({
    messages: [
      message("u1", "user", "build", 1),
      message("a-progress-1", "assistant", "starting", 2),
      message("a-progress-2", "assistant", "packaging", 3),
      message("a-final", "assistant", "done", 4),
    ],
    language: "en",
    running: false,
    completedActivity: [activity("run")],
    steeringMessageKeys: [],
    taskId: "task-progress",
  });
  const assistantItems = items.filter((item) => item.type === "message" && item.message.role === "assistant");
  assert.equal(assistantItems.length, 3);
  assert.equal(assistantItems.at(-1).stableKey, "response-task-progress-0");
  assert.equal(new Set(assistantItems.map((item) => item.stableKey ?? messageIdentity(item.message))).size, 3);

  const timelineView = rendererSource("ui/message-timeline.tsx");
  const styles = rendererSource("styles.css");
  assert.match(timelineView, /if \(item\?\.type === "live"\) return true/);
  assert.match(timelineView, /assistant-continues/);
  assert.match(timelineView, /timeline-item-\$\{items\[index\]\?\.type/);
  assert.doesNotMatch(timelineView, /live-message-status/);
  assert.match(styles, /--conversation-turn-gap:\s*28px/);
  assert.match(styles, /--conversation-continuation-gap:\s*20px/);
  assert.match(styles, /\.timeline-item\.assistant-continues \.assistant-message/);
  assert.match(styles, /\.live-activity \{[^}]*border:\s*0;[^}]*background:\s*transparent;/);
  assert.match(styles, /\.live-response-content\.after-activity/);
});

test("per-run file changes open a bounded and accessible split-pane review", () => {
  const contracts = fs.readFileSync(path.join(__dirname, "../../../packages/contracts/src/index.ts"), "utf8");
  const host = fs.readFileSync(path.join(__dirname, "../../../packages/pfsaa-host/src/index.ts"), "utf8");
  const reviewStore = fs.readFileSync(path.join(__dirname, "../../../packages/pfsaa-host/src/session-change-review-store.ts"), "utf8");
  const i18n = fs.readFileSync(path.join(__dirname, "../../../packages/i18n/src/index.ts"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "../src/preload/index.ts"), "utf8");
  const conversation = rendererSource("app-conversation.tsx");
  const review = rendererSource("ui/change-review.tsx");
  const mergeEditor = rendererSource("ui/change-review-merge.tsx");
  const reviewModel = rendererSource("change-review-model.ts");
  const reviewState = rendererSource("use-change-review.ts");
  const resizeHandle = rendererSource("ui/pane-resize-handle.tsx");
  const styles = rendererSource("styles.css");

  assert.match(contracts, /export interface SessionChangeReview/);
  assert.match(contracts, /changeReviews\(taskId: string/);
  assert.match(contracts, /changeReview\(taskId: string, reviewId: string/);
  assert.match(contracts, /resolveChangeReviewHunk\(taskId: string/);
  assert.match(contracts, /changeReviewMergeSource\(taskId: string/);
  assert.match(contracts, /applyChangeReviewMerge\(taskId: string/);
  assert.match(reviewStore, /pfsaa\.change-review-store/);
  assert.match(reviewStore, /MAX_REVIEW_HISTORY_BYTES/);
  assert.match(reviewStore, /sanitizeSessionChangeReview/);
  assert.match(host, /event\.type === "tool_execution_end"[\s\S]*?previewChangeReview/);
  assert.match(host, /cancelChangeReviewPreview[\s\S]*?previewController\?\.abort/);
  assert.match(host, /pendingChangeReviewWrites/);
  assert.match(host, /case "runtime\.shutdown"/);
  assert.match(host, /case "sessions\.changeReviews"/);
  assert.match(host, /case "sessions\.changeReview"/);
  assert.match(host, /case "sessions\.resolveChangeReviewHunk"/);
  assert.match(host, /case "sessions\.changeReviewMergeSource"/);
  assert.match(host, /case "sessions\.applyChangeReviewMerge"/);
  assert.match(preload, /sessions:change-reviews/);
  assert.match(preload, /sessions:change-review/);
  assert.match(preload, /sessions:resolve-change-review-hunk/);
  assert.match(preload, /sessions:change-review-merge-source/);
  assert.match(preload, /sessions:apply-change-review-merge/);
  assert.match(main, /sessions:change-reviews/);
  assert.match(main, /sessions:change-review/);
  assert.match(main, /sessions:resolve-change-review-hunk/);
  assert.match(main, /sessions:change-review-merge-source/);
  assert.match(main, /sessions:apply-change-review-merge/);
  assert.match(main, /before-quit[\s\S]*?runtime\.shutdown/);
  assert.match(conversation, /ChangeReviewLauncher/);
  assert.match(conversation, /ChangeReviewPanel/);
  assert.match(conversation, /inert=\{changeReviewOpen && changeReviewDrawer\}/);
  assert.match(rendererSource("app-view.tsx"), /reviewDrawerOpen[\s\S]*?change-review-backdrop/);
  assert.match(rendererSource("app-sidebar.tsx"), /inert=\{backgroundInert\}/);
  assert.match(rendererSource("app-view.tsx"), /disabled=\{reviewDrawerOpen(?: \|\| sidebarCollapsed)?\}/);
  assert.match(review, /parseUnifiedPatch/);
  assert.match(review, /change-review-line-number/);
  assert.match(review, /ChangeReviewMergeEditor = lazy/);
  assert.match(review, /change-review-hunk-resolution-actions/);
  assert.match(review, /data-resolution=\{resolution\}/);
  assert.match(review, /resolution === "reverted" \? "x"/);
  assert.match(review, /change-review-revert-popover/);
  assert.match(review, /change-review-hunk-controls-sticky/);
  assert.match(review, /resolved-\$\{resolution\}/);
  assert.match(styles, /\.change-review-revert-popover/);
  assert.match(styles, /\.change-review-hunk-group\[class\*="resolved-"\]/);
  assert.match(styles, /\.change-review-hunk-group\[class\*="resolved-"\]::before/);
  assert.match(styles, /--resolution-line-background:/);
  assert.match(styles, /\.change-review-hunk-group\[class\*="resolved-"\] > \.change-review-line\.addition/);
  assert.match(styles, /\.change-review-hunk-group\[class\*="resolved-"\] > \.change-review-line:not\(\.hunk\):not\(\.meta\) code/);
  assert.match(styles, /\.change-review-hunk-group\[class\*="resolved-"\] > \.change-review-split-row \.change-review-split-cell code/);
  assert.match(styles, /opacity: 1; filter: none/);
  assert.match(styles, /\.change-review-hunk-resolution\.reverted[^}]*color: var\(--red\)/);
  assert.match(mergeEditor, /unifiedMergeView/);
  assert.match(mergeEditor, /diffConfig: \{ scanLimit: 500, timeout: 1_000 \}/);
  assert.match(mergeEditor, /useDialogFocus/);
  assert.match(review, /changeReviewUnchangedLines/);
  assert.match(i18n, /changeReviewSplit: "拆分差异"/);
  assert.match(i18n, /changeReviewSplit: "Split diff"/);
  assert.doesNotMatch(i18n, /并排差异|Side-by-side diff/);
  assert.match(reviewModel, /buildChangeFileTree/);
  assert.match(reviewModel, /sideBySideRows/);
  assert.match(reviewModel, /reviewTreeKeyboardAction/);
  assert.match(review, /change-review-tree-directory/);
  assert.match(review, /aria-expanded=\{isExpanded\}/);
  assert.match(review, /className="change-review-tree-toggle"/);
  assert.match(review, /aria-pressed=\{allExpanded\}/);
  assert.match(review, /onClick=\{toggleAllDirectories\}/);
  assert.match(review, /toggleAllDirectories[\s\S]*?onExpandedPaths\(allDirectories\)[\s\S]*?onExpandedPaths\(\[\]\)/);
  assert.match(review, /expandedPathsRef/);
  assert.match(review, /event\.key\.length === 1[\s\S]*?typeaheadRef/);
  assert.match(review, /change-review-run-menu/);
  assert.match(review, /data-dialog-escape-boundary/);
  assert.doesNotMatch(review, /<select/);
  assert.match(review, /change-review-files-resize-handle/);
  assert.match(review, /useDialogFocus\(panelRef, onClose, drawer, returnFocusRef\)/);
  assert.match(conversation, /change-review-panel-resize-handle/);
  assert.match(resizeHandle, /role="separator"/);
  assert.match(resizeHandle, /setPointerCapture/);
  assert.match(reviewState, /viewStatesRef/);
  assert.match(reviewState, /REVIEW_VIEW_STORAGE_NAME/);
  assert.match(reviewState, /launcherReview/);
  assert.match(reviewState, /sessions\.changeReview/);
  assert.doesNotMatch(reviewState, /setOpen\(false\)/);
  assert.match(styles, /\.conversation-layout\.review-open/);
  assert.match(styles, /\.change-review-panel/);
  assert.match(styles, /\.change-review-backdrop/);
  assert.match(styles, /\.change-review-split-row/);
  assert.match(styles, /\.change-review-split-cell\.empty[\s\S]*?repeating-linear-gradient/);
  assert.match(styles, /\.change-review-split-marker[\s\S]*?width:\s*3px/);
  assert.match(styles, /\.change-review-split-gap-cell/);
  assert.match(styles, /\.change-review-merge-dialog/);
  assert.match(styles, /\.change-review-hunk-resolution-actions/);
  assert.match(styles, /--review-file-header-height:\s*44px/);
  assert.match(styles, /--review-toolbar-height:\s*40px/);
  assert.match(styles, /--selection-bg:/);
  assert.match(styles, /--selection-bg-subtle:/);
  assert.match(styles, /--selection-control-shadow:/);
  assert.doesNotMatch(styles, /--selection-shadow:\s*inset/);
  assert.doesNotMatch(styles, /--selection-control-shadow:\s*inset/);
  assert.match(styles, /input\[type="checkbox"\], input\[type="radio"\][^}]*accent-color:\s*var\(--selection-indicator/);
  assert.match(styles, /\.change-review-diff\s*\{[^}]*grid-template-rows:\s*var\(--review-file-header-height\)\s+var\(--review-toolbar-height\)/);
  assert.match(styles, /\.change-review-files-title\s*\{[^}]*min-height:\s*var\(--review-file-header-height\)/);
  assert.match(styles, /\.change-review-file-filter\s*\{[^}]*top:\s*var\(--review-file-header-height\)[^}]*min-height:\s*var\(--review-toolbar-height\)/);
  assert.match(styles, /\.change-review-code\.split\s*\{[\s\S]*?--split-canvas:\s*var\(--diff-split-canvas\)/);
  assert.doesNotMatch(styles, /\.app-shell\.dark \.change-review-code\.split/);
  assert.match(styles, /\.change-review-tree-toggle\[aria-pressed="true"\]/);
  assert.match(styles, /\.change-review-segmented button\[aria-pressed="true"\][^}]*background:\s*var\(--selection-bg\)[^}]*box-shadow:\s*var\(--selection-control-shadow\)/);
  assert.match(styles, /\.change-review-tree-file\.active[^}]*background:\s*var\(--selection-bg\)[^}]*box-shadow:\s*var\(--selection-shadow\)/);
  assert.match(styles, /@media \(max-width: 1280px\)[\s\S]*?\.change-review-panel/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.change-review-tree-row/);
  assert.match(styles, /@media \(max-width: 560px\)[\s\S]*?\.change-review-body/);
  assert.match(styles, /\.pane-resize-handle/);
});

test("queued messages expose image thumbnails, editing, and arbitrary deletion", () => {
  const composer = rendererSource("ui/composer.tsx");
  const controller = rendererSource("use-app-controller.tsx");
  const styles = rendererSource("styles.css");
  const contracts = fs.readFileSync(path.join(__dirname, "../../../packages/contracts/src/index.ts"), "utf8");
  const host = fs.readFileSync(path.join(__dirname, "../../../packages/pfsaa-host/src/index.ts"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "../src/preload/index.ts"), "utf8");

  assert.match(contracts, /export interface AgentQueuedMessage/);
  assert.match(contracts, /editQueue\(taskId: string, messageId: string/);
  assert.match(contracts, /deleteQueue\(taskId: string, messageId: string/);
  assert.match(composer, /composer-queue-thumbnail/);
  assert.match(composer, /props\.onEditQueue\(item\.message, item\.delivery\)/);
  assert.match(composer, /props\.onDeleteQueue\(item\.message\)/);
  assert.match(composer, /composer-queue-edit-banner/);
  assert.match(styles, /\.composer-queue \{[^}]*margin:\s*0 auto -11px/);
  assert.match(styles, /\.composer-queue-header \{ display:\s*none;/);
  assert.match(styles, /\.composer-queue-delete:hover:not\(:disabled\)/);
  assert.match(controller, /window\.pfsaa\.agent\.editQueue/);
  assert.match(controller, /window\.pfsaa\.agent\.deleteQueue/);
  assert.match(host, /case "agent\.editQueue"/);
  assert.match(host, /case "agent\.deleteQueue"/);
  assert.match(host, /original\.steering\.filter\(\(message\) => message\.id !== messageId\)/);
  assert.match(host, /queueRebuilds\.add\(stateKey\)/);
  assert.match(main, /agent:edit-queue/);
  assert.match(main, /agent:delete-queue/);
  assert.match(preload, /agent:edit-queue/);
  assert.match(preload, /agent:delete-queue/);
});

test("queue processing mode reflects the AgentCore mode and acknowledges mutations", () => {
  const composer = rendererSource("ui/composer.tsx");
  const controller = rendererSource("use-app-controller.tsx");
  const styles = rendererSource("styles.css");

  assert.match(composer, /props\.queueState\.steeringMode === props\.queueState\.followUpMode/);
  assert.match(composer, /role="menuitemradio" aria-checked=\{queueBatchMode === "all"\}/);
  assert.match(composer, /role="menuitemradio" aria-checked=\{queueBatchMode === "one-at-a-time"\}/);
  assert.match(composer, /className={`queue-mode-option/);
  assert.match(composer, /pendingQueueBatchMode === "all"[\s\S]*queue-mode-pending/);
  assert.match(composer, /const applied = await props\.onQueueModes/);
  assert.match(composer, /if \(applied\) setQueueMenuOpen\(false\)/);
  assert.match(controller, /async function setQueueModes[\s\S]*setQueueMutationBusy\(true\)[\s\S]*return true[\s\S]*return false[\s\S]*setQueueMutationBusy\(false\)/);
  assert.match(styles, /\.queue-mode-option\.active/);
  assert.match(styles, /\.queue-mode-option:not\(\.active\) > svg \{ opacity: 0; \}/);
});

test("review split compression keeps the queue delivery control on one line", () => {
  const composer = rendererSource("ui/composer.tsx");
  const styles = rendererSource("styles.css");

  assert.match(composer, /composer-model-control/);
  assert.match(composer, /composer-queue-control/);
  assert.match(composer, /composer-mention/);
  assert.match(styles, /\.conversation-primary \{[^}]*container-name:\s*conversation-primary;[^}]*container-type:\s*inline-size;/);
  assert.match(styles, /\.composer-queue-control[^}]*flex:\s*0 0 auto/);
  assert.match(styles, /\.composer-model-control \{[^}]*min-width:\s*0;[^}]*flex:\s*0 1 auto;[^}]*max-width:\s*min\(300px, 42vw\)/);
  assert.match(styles, /\.composer-model-control \.model-chip \{[^}]*width:\s*auto;[^}]*max-width:\s*100%/);
  assert.match(styles, /\.model-chip \{[^}]*width:\s*max-content;[^}]*max-width:\s*min\(300px, 42vw\)/);
  assert.match(styles, /\.chip, \.model-chip \{[^}]*white-space:\s*nowrap/);
  assert.match(styles, /@container conversation-primary \(max-width: 760px\)[\s\S]*\.composer-hint \{ display:\s*none;/);
  assert.match(styles, /@container conversation-primary \(max-width: 560px\)[\s\S]*\.composer-mention, \.model-provider \{ display:\s*none;/);
  assert.doesNotMatch(styles, /\.composer-tools \.chip\.subtle \{ display:\s*none;/);
  assert.match(styles, /\.change-review-hunk-actions \{[^}]*flex-direction:\s*row;[^}]*padding:\s*2px;[^}]*border:/);
  assert.match(styles, /\.change-review-hunk-actions button:hover:not\(:disabled\) \{[^}]*box-shadow:/);
});

test("model menu hides its scrollbar without disabling overflow scrolling", () => {
  const styles = rendererSource("styles.css");

  assert.match(styles, /\.inline-menu, \.suggestion-popover \{[^}]*overflow:\s*auto/);
  assert.match(styles, /\.inline-menu \{[^}]*max-height:\s*min\(360px, 52vh\)/);
  assert.match(styles, /\.model-menu-list \{[^}]*max-height:\s*max\(80px, min\(300px, calc\(52vh - 54px\)\)\)[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-width:\s*none/);
  assert.match(styles, /\.model-menu-list::-webkit-scrollbar \{[^}]*display:\s*none/);
  assert.doesNotMatch(styles, /\.model-menu-list\s*\{[^}]*overflow(?:-[xy])?:\s*(?:hidden|clip)/);
  assert.match(rendererSource("ui/composer.tsx"), /className="inline-menu model-menu"[^>]*data-conversation-scroll-island="true"/);
  assert.match(rendererSource("ui/composer.tsx"), /onWheelCapture=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(rendererSource("ui/message-timeline.tsx"), /\[data-conversation-scroll-island\], \.inline-menu, \.suggestion-popover, \.select-control-menu/);
});

test("session tree uses fixed branch rails instead of message-depth width", () => {
  const styles = rendererSource("styles.css");
  const dialog = rendererSource("ui/session-branch-dialog.tsx");
  const controller = rendererSource("use-app-controller.tsx");

  assert.match(styles, /\.session-branch-row \{[^}]*grid-template-columns:\s*52px minmax\(0, 1fr\)/);
  assert.doesNotMatch(styles, /--tree-depth/);
  assert.match(dialog, /SESSION_TREE_PAGE_SIZE = 160/);
  assert.match(dialog, /visibleEntries\.map/);
  assert.match(dialog, /skipSummaryPrompt/);
  assert.match(dialog, /data-summary-prompt-skipped/);
  assert.match(controller, /settings\.get\(projectCwd\)/);
  assert.match(controller, /sessionBranchSkipPrompt/);
});

test("renderer controls share theme tokens across surfaces and modes", () => {
  const styles = rendererSource("styles.css");

  assert.match(styles, /--radius-control:\s*8px/);
  assert.match(styles, /--radius-dialog:\s*14px/);
  assert.match(styles, /--control-height-touch:\s*44px/);
  assert.match(styles, /--shadow-popover:/);
  assert.match(styles, /--overlay-scrim:/);
  assert.match(styles, /--selection-bg:/);
  assert.match(styles, /--selection-bg-subtle:/);
  assert.match(styles, /--selection-border:/);
  assert.match(styles, /--selection-shadow:/);
  assert.match(styles, /--selection-control-shadow:/);
  assert.doesNotMatch(styles, /--selection-shadow:\s*inset/);
  assert.doesNotMatch(styles, /--selection-control-shadow:\s*inset/);
  assert.match(styles, /\.app-shell\.dark, \.overlay-root\.dark\s*\{[\s\S]*?--overlay-scrim:/);
  assert.match(styles, /\.app-shell\.dark, \.overlay-root\.dark\s*\{[\s\S]*?--selection-bg:/);
  assert.match(styles, /\.select-control \{[^}]*border:\s*1px solid var\(--line\)[^}]*border-radius:\s*var\(--radius-control\)/);
  assert.match(styles, /\.extension-widget[^}]*border:\s*1px solid var\(--line\)[^}]*border-radius:\s*var\(--radius-control\)/);
  assert.match(styles, /\.task-context-menu, \.image-context-menu[^}]*box-shadow:\s*var\(--shadow-popover\)/);
  assert.match(styles, /\.change-review-hunk-actions button:hover:not\(:disabled\)[^}]*box-shadow:\s*var\(--shadow-subtle\)/);
  assert.match(styles, /\.project-group\.selected > \.project-row[^}]*color:\s*var\(--text\)/);
  assert.doesNotMatch(styles, /\.project-group\.selected > \.project-row[^}]*background:/);
  assert.doesNotMatch(styles, /\.project-group\.selected > \.project-row[^}]*box-shadow:/);
  assert.match(styles, /\.task-row\.active[^}]*background:\s*var\(--selection-bg-subtle\)[^}]*box-shadow:\s*var\(--selection-shadow\)/);
  assert.match(styles, /\.inline-menu > button\.active[^}]*background:\s*var\(--selection-bg\)[^}]*box-shadow:\s*var\(--selection-control-shadow\)/);
  assert.match(styles, /\.composer-thinking-control \.inline-menu\s*\{[^}]*right:\s*auto;[^}]*left:\s*0/);
  assert.match(styles, /\.provider-filters button\[aria-pressed="true"\][^}]*background:\s*var\(--selection-bg\)[^}]*box-shadow:\s*var\(--selection-control-shadow\)/);
  assert.doesNotMatch(styles, /\.provider-filters button\[aria-pressed="true"\][^}]*border-color:\s*var\(--selection-border\)/);
  assert.doesNotMatch(styles, /\.change-review-run-trigger\[aria-expanded="true"\][^}]*border-color:\s*var\(--selection-border\)/);
});

test("runtime activity aligns to the newest persisted turn", () => {
  const messages = [
    message("u1", "user", "old", 1),
    message("a1", "assistant", "old reply", 2),
    message("u2", "user", "new", 3),
    message("a2", "assistant", "new reply", 4),
  ];
  const items = buildMessageTimelineItems({
    messages,
    language: "en",
    running: false,
    completedActivity: [activity("new-runtime")],
    steeringMessageKeys: [],
  });

  assert.equal(describeTimeline(items).includes("execution:new-runtime"), true);
  assert.equal(describeTimeline(items).indexOf("execution:new-runtime") > describeTimeline(items).indexOf("message:u2"), true);
});

test("long queued histories retain every turn in canonical order", () => {
  const messages = [];
  const completedActivity = [];
  for (let index = 0; index < 500; index += 1) {
    messages.push(message(`u${index}`, "user", `prompt ${index}`, index * 2));
    messages.push(message(`a${index}`, "assistant", `reply ${index}`, index * 2 + 1));
    completedActivity.push(activity(`run-${index}`));
  }
  const items = buildMessageTimelineItems({
    messages,
    language: "en",
    running: false,
    completedActivity,
    steeringMessageKeys: [],
  });

  assert.equal(items.length, 1_500);
  assert.deepEqual(describeTimeline(items).slice(0, 6), [
    "message:u0",
    "execution:run-0",
    "message:a0",
    "message:u1",
    "execution:run-1",
    "message:a1",
  ]);
  assert.deepEqual(describeTimeline(items).slice(-3), [
    "message:u499",
    "execution:run-499",
    "message:a499",
  ]);
});

test("the timeline renders in plain document flow with native scroll anchoring", () => {
  const timeline = rendererSource("ui/message-timeline.tsx");
  const styles = rendererSource("styles.css");

  // Virtualization fights asynchronously sized rows (Mermaid, KaTeX, syntax
  // highlighting): the measurement cache is always one paint stale, which is
  // what produced jumping, overlapping rows and rubber-banding.
  assert.doesNotMatch(timeline, /react-virtual|useVirtualizer|getVirtualItems|measureElement/);
  assert.doesNotMatch(styles, /timeline-virtual-host|timeline-spacer/);
  assert.match(timeline, /className="timeline-list"/);

  // Load-bearing: `overflow-anchor: none` was the virtual-list era setting. With
  // a plain list it is the browser's anchoring that stops late-resolving content
  // above the viewport from moving the reader's position.
  assert.match(styles, /\.conversation-scroll\s*\{[^}]*overflow-anchor:\s*auto/);
  assert.doesNotMatch(styles, /\.conversation-scroll\s*\{[^}]*overflow-anchor:\s*none/);

  // Unbounded mounting would exhaust the renderer heap on long sessions.
  assert.match(timeline, /const FOLD_WINDOW = \d+/);
  assert.match(timeline, /className="timeline-show-earlier"/);
});

test("auto-scroll survives content shrinking and programmatic smooth scrolls", () => {
  const timeline = rendererSource("ui/message-timeline.tsx");

  // Regression: following used to be dropped whenever scrollTop decreased. The
  // transcript legitimately shrinks (live row replaced by the final message, the
  // working indicator disappearing, an execution summary collapsing), so that
  // inference silently killed auto-scroll mid-stream. Only a real upward wheel
  // gesture may opt out now; touch keeps direction inference because it emits no
  // wheel events, and then only while a finger is actually down.
  assert.match(timeline, /if \(event\.deltaY >= 0\) return;/);
  assert.match(timeline, /if \(touchActiveRef\.current && previous && top < previous\.top - 1\)/);
  assert.doesNotMatch(timeline, /const movingAwayFromEnd/);

  // Being merely close to the bottom must not restore follow. Otherwise a
  // late content resize can pin the last part of a downward wheel gesture.
  assert.match(timeline, /const AT_BOTTOM_EPSILON = 1/);
  assert.match(timeline, /const atBottom = Math\.max\(0, element\.scrollHeight - element\.clientHeight - top\) <= AT_BOTTOM_EPSILON/);
  assert.match(timeline, /else if \(atBottom\) \{ userScrollOverrideRef\.current = false; endPinning\(\); \}/);
  assert.match(timeline, /const wasFollowing = previous\?\.follow \?\? false/);
  assert.match(timeline, /const follow = userScrollOverrideRef\.current \? false : atBottom \|\| pinningRef\.current \|\| wasFollowing/);
  assert.match(timeline, /if \(userScrollOverrideRef\.current\) return;[\s\S]*?if \(scrollPositionsRef\.current\[scrollKey\]\?\.follow\) pinToBottom\(\);/);

  // A smooth scroll reports "not at the bottom" for its whole duration, which
  // flashed the jump-to-latest button back on mid-animation.
  assert.match(timeline, /atBottom \|\| pinningRef\.current/);
  assert.match(timeline, /beginPinning\(\);/);
  assert.match(timeline, /pinningTimeoutRef\.current = window\.setTimeout/);

  // sendPrompt calls scrollToLatest before the optimistic message exists, so the
  // follow intent has to be recorded, not just the current offset.
  assert.match(timeline, /scrollToLatest: \(behavior\) => \{[\s\S]*?setFollow\(true\)/);
});

test("nested process scrolling does not change transcript follow state", () => {
  const timeline = rendererSource("ui/message-timeline.tsx");
  const liveActivity = rendererSource("ui/live-activity.tsx");
  const executionSummary = rendererSource("ui/execution-summary.tsx");

  assert.match(timeline, /target\.closest\("\[data-conversation-scroll-island\], \.inline-menu, \.suggestion-popover, \.select-control-menu"\)/);
  assert.match(timeline, /if \(isNestedScrollIsland\(event\.target\)\) return;/);
  assert.match(timeline, /if \(!element \|\| event\.target !== element\) return;/);
  assert.match(liveActivity, /data-conversation-scroll-island="true"/);
  assert.match(executionSummary, /data-conversation-scroll-island="true"/);
});

test("inactive conversation panes stay laid out so the browser keeps their scrollTop", () => {
  const conversation = rendererSource("app-conversation.tsx");
  const styles = rendererSource("styles.css");

  assert.match(conversation, /active \? "is-active" : "is-inactive"/);
  // `display: none` drops the scroll box, which resets scrollTop to 0 and made
  // task switches lose the reader's position. `visibility: hidden` keeps the
  // layout box, so the browser preserves each pane's offset and no manual
  // save/restore logic is needed at all.
  assert.match(styles, /\.conversation-scroll\.is-inactive\s*\{[^}]*visibility:\s*hidden/);
  assert.doesNotMatch(styles, /\.conversation-scroll\.is-inactive\s*\{[^}]*display:\s*none/);
});

test("markdown math never rewrites fenced code and strips delimiters first", () => {
  const markdown = rendererSource("ui/markdown.tsx");

  // Regression: the \[..\] -> $$ normalizer used to run over the whole document
  // and corrupted the contents of ```latex fences.
  assert.match(markdown, /CODE_OR_MATH/);
  // Regression: a ```latex fence whose body already carries $$ or \[ was fed to
  // KaTeX verbatim, so the delimiters have to be stripped before the language
  // tag is trusted.
  assert.match(markdown, /parseMathCode/);
  assert.match(markdown, /KATEX_MACROS/);
});

test("long running turn surfaces live thinking, short turn does not", () => {
  const longActivity = [{
    id: "t-long",
    kind: "thinking",
    label: "Thinking",
    detail: "Let me inspect the failing typecheck output and trace the root cause across the affected modules.",
    startedAt: Date.now() - 30_000,
  }];
  const longItems = buildMessageTimelineItems({
    messages: [message("u1", "user", "first", 1)],
    language: "en",
    running: true,
    completedActivity: [],
    steeringMessageKeys: [],
    taskId: "task-long",
    activeActivity: longActivity,
  });
  const longLive = longItems.find((item) => item.type === "live");
  assert.ok(longLive, "running turn with enough thinking exposes a live item");
  assert.deepEqual(longLive.activitySteps.map((step) => step.id), ["t-long"]);
  assert.equal(longLive.activitySteps[0].detail, longActivity[0].detail);

  const shortActivity = [{
    id: "t-short",
    kind: "thinking",
    label: "Thinking",
    detail: "quick note",
    startedAt: Date.now() - 1_000,
  }];
  const shortItems = buildMessageTimelineItems({
    messages: [message("u1", "user", "first", 1)],
    language: "en",
    running: true,
    completedActivity: [],
    steeringMessageKeys: [],
    taskId: "task-short",
    activeActivity: shortActivity,
  });
  const shortLive = shortItems.find((item) => item.type === "live");
  assert.ok(shortLive, "running turn still exposes a live item");
  assert.deepEqual(shortLive.activitySteps, [], "short turn under the threshold hides live thinking");
});

test("live activity interleaves compact thinking and tool calls", () => {
  const activeActivity = [
    { id: "think-1", kind: "thinking", label: "Thinking", detail: "**Inspecting files**\n\n\n\nbefore the tool call", startedAt: Date.now() - 4_000, endedAt: Date.now() - 3_000 },
    { id: "tool-1", kind: "tool", label: "read", args: { path: "src/index.ts" }, result: "contents", startedAt: Date.now() - 3_000, endedAt: Date.now() - 2_000 },
    { id: "think-2", kind: "thinking", label: "Thinking", detail: "**Applying the result**", startedAt: Date.now() - 2_000 },
  ];
  const items = buildMessageTimelineItems({
    messages: [message("u1", "user", "first", 1)],
    language: "en",
    running: true,
    completedActivity: [],
    steeringMessageKeys: [],
    taskId: "task-live-tools",
    activeActivity,
  });
  const live = items.find((item) => item.type === "live");
  assert.ok(live, "running turn exposes a live item");
  assert.deepEqual(live.activitySteps.map((step) => step.id), ["think-1", "tool-1", "think-2"], "tool calls stay between their surrounding thinking blocks");
  assert.doesNotMatch(live.activitySteps[0].detail, /\n{3,}/, "provider blank-line runs are collapsed in the live feed");

  const liveActivity = rendererSource("ui/live-activity.tsx");
  assert.match(liveActivity, /steps\.map/);
  assert.match(liveActivity, /step\.kind === "thinking"/);
  assert.match(liveActivity, /t\.executionTools/);
  assert.match(liveActivity, /MarkdownContent text=\{step\.detail/);
});

test("live activity follows refreshed and asynchronously resized content", () => {
  const liveActivity = rendererSource("ui/live-activity.tsx");

  assert.match(liveActivity, /list\.scrollTop = list\.scrollHeight/);
  assert.match(liveActivity, /if \(followingRef\.current\) pinToLatest\(\)/);
  assert.match(liveActivity, /new ResizeObserver/);
  assert.match(liveActivity, /observer\.observe\(content\)/);
  assert.match(liveActivity, /\[pinToLatest, steps\.length\]/);
  assert.match(liveActivity, /event\.deltaY < 0/);
});

test("live thinking retracts into the collapsed summary on settle", () => {
  const thinking = "the agent reasoned through several approaches before settling on the fix";
  const activeActivity = [{
    id: "t-active",
    kind: "thinking",
    label: "Thinking",
    detail: thinking,
    startedAt: Date.now() - 30_000,
  }];
  const running = buildMessageTimelineItems({
    messages: [message("u1", "user", "first", 1)],
    language: "en",
    running: true,
    completedActivity: [],
    steeringMessageKeys: [],
    taskId: "task-retract",
    activeActivity,
  });
  assert.ok(running.find((item) => item.type === "live" && item.activitySteps.some((step) => step.kind === "thinking")), "thinking is live during the run");

  const settled = buildMessageTimelineItems({
    messages: [message("u1", "user", "first", 1), message("a1", "assistant", "here is the fix", 2)],
    language: "en",
    running: false,
    completedActivity: [[{ id: "t-active", kind: "thinking", label: "Thinking", detail: thinking, startedAt: Date.now() - 30_000, endedAt: Date.now() - 1_000, timing: "unknown" }]],
    steeringMessageKeys: [],
    taskId: "task-retract",
  });
  assert.equal(settled.some((item) => item.type === "live"), false, "no live item remains after settle");
  assert.ok(settled.find((item) => item.type === "execution"), "thinking retracted into the collapsed summary");
  assert.ok(settled.find((item) => item.type === "message" && item.message.id === "a1"), "formal reply is present");
});

test("live thinking re-appears in a later round of a steered run", () => {
  // A long run where the user steers mid-run keeps one timeline turn. The first
  // reply (a1) lands, then the agent thinks again (round 2). The live thinking
  // panel must re-surface for round 2 even though an assistant reply already
  // exists in the turn, and it must NOT linger the ended round-1 thinking.
  const round1Thinking = {
    id: "t-round1",
    kind: "thinking",
    label: "Thinking",
    detail: "round one reasoning that was already formalized into the reply above",
    startedAt: Date.now() - 40_000,
    endedAt: Date.now() - 20_000,
  };
  const round2Thinking = {
    id: "t-round2",
    kind: "thinking",
    label: "Thinking",
    detail: "now reasoning about the new steering question the user just asked, tracing how the proposed fix interacts with the existing retry path and what edge cases the prior round may have missed",
    startedAt: Date.now() - 9_000,
  };
  const items = buildMessageTimelineItems({
    messages: [
      message("u1", "user", "first", 1),
      message("a1", "assistant", "here is the first fix", 2),
      message("u2", "user", "but what about the edge case", 3),
    ],
    language: "en",
    running: true,
    completedActivity: [],
    steeringMessageKeys: ["id:u2"],
    taskId: "task-steer",
    activeActivity: [round1Thinking, round2Thinking],
  });
  const live = items.find((item) => item.type === "live");
  assert.ok(live, "a live item still appears after a prior reply in the same run");
  assert.equal(live.activitySteps.find((step) => step.kind === "thinking")?.detail, round2Thinking.detail, "live thinking shows only the in-progress round, not the ended prior one");
  assert.ok(items.find((item) => item.type === "message" && item.message.id === "a1"), "prior reply stays visible above the live panel");
});

test("ended thinking retracts once a later reply formalizes it", () => {
  // Round 2 finishes (a2 landed) while the run is still going (e.g. willRetry
  // pending). The round-2 thinking has ended and a reply exists, so the live
  // panel must not keep showing that ended thinking beneath the new reply.
  const round2Thinking = {
    id: "t-round2",
    kind: "thinking",
    label: "Thinking",
    detail: "reasoning that is now finalized into the second reply",
    startedAt: Date.now() - 30_000,
    endedAt: Date.now() - 3_000,
  };
  const items = buildMessageTimelineItems({
    messages: [
      message("u1", "user", "first", 1),
      message("a1", "assistant", "first fix", 2),
      message("u2", "user", "edge case?", 3),
      message("a2", "assistant", "second fix", 4),
    ],
    language: "en",
    running: true,
    completedActivity: [],
    steeringMessageKeys: ["id:u2"],
    taskId: "task-ended",
    activeActivity: [round2Thinking],
  });
  const live = items.find((item) => item.type === "live");
  assert.ok(live, "live item still exists while the run continues");
  assert.equal(live.activitySteps.some((step) => step.kind === "thinking"), false, "ended thinking with a reply present does not linger in the live panel");
});
