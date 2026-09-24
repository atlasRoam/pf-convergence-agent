const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync, fork } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const parseJsonc = require("jsonc-parser").parse;

const { assertKnownProjectCwd, assertTrustedIpcSender } = require("../dist/main/ipc-security.js");
const { externalEditorCommandForPath } = require("../dist/main/external-editor.js");
const { windowThemeColors } = require("../dist/main/window-theme.js");
const { loadQueueForCurrentTask } = require("../dist/renderer/queue-load.js");
const { isPackagedAgentCoreAdapter, modelSummary, packagedAgentCoreNodeModules, systemProxyRoutesFromElectronRules } = require("../../../packages/agentcore-adapter/dist/index.js");
const { validatePfsaaHostPayload } = require("../../../packages/contracts/dist/index.js");
const { localizeCommandDescription } = require("../../../packages/i18n/dist/index.js");
const { PermissionEngine } = require("../../../packages/permission-engine/dist/index.js");
const { copyElectronRuntimeLicenses } = require("../../../scripts/copy-electron-runtime-licenses.cjs");
const { acceptChangeReviewHunk, applyChangeReviewMerge, buildSessionChangeReview, captureWorkspaceChangeState, inspectGitWorkspaceAvailability, loadChangeReviewMergeSource, MAX_REVIEW_CAPTURE_PATHS, revertChangeReviewHunk, withResolvedReviewHunks } = require("../../../packages/pfsaa-host/dist/session-change-review.js");
const { createAgentRunReservation, isExtensionCommand, ManualCompactionPromptQueue, queuePromptDuringCompaction, waitForReservedAgentRun } = require("../../../packages/pfsaa-host/dist/agent-prompt-coordination.js");
const { updateAgentCoreSettings } = require("../../../packages/pfsaa-host/dist/settings-command-handler.js");
const { replaceQuotedAbsolutePaths } = require("../../../packages/pfsaa-host/dist/external-editor-command.js");
const { copySessionChangeReviewStore, deleteSessionChangeReviewStore, flushSessionChangeReviewStore, loadSessionChangeReviews, persistSessionChangeReview, sanitizeSessionChangeReview, sessionChangeReviewStorePath, summarizeSessionChangeReview } = require("../../../packages/pfsaa-host/dist/session-change-review-store.js");
const { sessionTranscriptMessages } = require("../../../packages/pfsaa-host/dist/session-transcript.js");
const { createTrustAwareSettingsManager, readProjectTrustStatus } = require("../../../packages/pfsaa-host/dist/project-trust.js");
const { buildSessionTreeSnapshot } = require("../../../packages/pfsaa-host/dist/session-tree.js");
const { createCustomProvider, getProviderUiState, hideProvider, removeCustomProvider, restoreProvider, updateCustomProvider } = require("../../../packages/pfsaa-host/dist/provider-config-store.js");
const { buildChangeFileTree, parseUnifiedPatch, reviewTreeKeyboardAction, sideBySideRows } = require("../dist/renderer/change-review-model.js");
const { ComposerHistory } = require("../dist/renderer/composer-history.js");
const { commandModel, exportArguments } = require("../dist/renderer/agentcore-command-arguments.js");
const { ansiColorToHex, createExtensionTheme } = require("../../../packages/pfsaa-host/dist/extension-theme.js");
const { parseExtensionTheme, extensionThemeStyle } = require("../dist/renderer/extension-theme.js");

test("slash arguments preserve provider/model IDs and export paths including spaces", () => {
  const models = [{ providerId: "a", id: "org/model" }, { providerId: "b", id: "org/model" }];
  assert.equal(commandModel(models, "a/org/model"), models[0]);
  assert.equal(commandModel(models, "org/model"), undefined);
  assert.equal(commandModel(models, "missing/model"), undefined);
  assert.deepEqual(exportArguments('"reports/my session.html"'), { format: "html", outputPath: "reports/my session.html" });
  assert.deepEqual(exportArguments("jsonl"), { format: "jsonl" });
  assert.deepEqual(exportArguments("reports/session.jsonl"), { format: "jsonl", outputPath: "reports/session.jsonl" });
  assert.deepEqual(exportArguments(""), { format: "html" });
});

test("extension editor mirror is scoped, live, supports paste, and is disposed", () => {
  const engine = new PermissionEngine({ emitApproval() {}, emitEvent() {} });
  const a = engine.createUi("same-id", "project-a");
  const b = engine.createUi("same-id", "project-b");
  engine.syncEditorText("project-a", "typed draft");
  assert.equal(a.getEditorText(), "typed draft");
  assert.equal(b.getEditorText(), "");
  a.pasteToEditor(" + pasted");
  assert.equal(a.getEditorText(), "typed draft + pasted");
  a.setEditorText("replaced");
  assert.equal(a.getEditorText(), "replaced");
  engine.dispose("project-a");
  assert.equal(engine.createUi("same-id", "project-a").getEditorText(), "");
});

test("AgentCore theme adaptation keeps objects in Host and sends only validated color tokens", () => {
  const theme = name => ({ name, getFgAnsi: () => "\u001b[38;2;16;32;48m", getBgAnsi: () => "\u001b[48;5;255m" });
  const events = [];
  const api = { getThemeByName: name => ["dark", "light"].includes(name) ? theme(name) : undefined, getAvailableThemesWithPaths: () => [{ name: "light" }, { name: "dark" }] };
  const a = createExtensionTheme(api, {}, value => events.push(value));
  const b = createExtensionTheme(api, {}, () => {});
  const copied = { ...a };
  assert.equal(copied.setTheme("light").success, true);
  assert.equal(copied.theme.name, "light");
  assert.equal(b.theme.name, "dark");
  assert.equal(copied.setTheme("missing").success, false);
  assert.equal(events[0].colors.accent, "#102030");
  assert.equal(ansiColorToHex("\u001b[38;5;196m"), "#ff0000");
  assert.equal(ansiColorToHex("\u001b[38;2;999;0;0m"), undefined);
  const parsed = parseExtensionTheme({ appearance: "light", colors: { text: "url(file:///secret)", accent: "#123456", evil: "#ffffff" } });
  assert.deepEqual(extensionThemeStyle(parsed), { "--accent": "#123456" });
});

test("advanced AgentCore settings preserve nested unknowns and proxy credentials", async () => {
  let stored = JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 50 }, retry: { provider: { maxRetries: 7, unknown: true } }, httpProxy: "http://user:password@localhost:8888", anotherSetting: true });
  let current = JSON.parse(stored);
  const manager = {
    getDefaultProvider: () => undefined, getDefaultModel: () => undefined, getDefaultThinkingLevel: () => "off", setDefaultThinkingLevel: level => { current.defaultThinkingLevel = level; }, getTransport: () => "auto",
    getCompactionSettings: () => current.compaction, getRetrySettings: () => ({ enabled: true, maxRetries: 3, baseDelayMs: 2000, ...current.retry }),
    getSteeringMode: () => "all", getFollowUpMode: () => "all", getGlobalSettings: () => current, getDefaultTools: () => current.defaultTools,
    flush: async () => {}, reload: async () => { current = JSON.parse(stored); },
  };
  const storage = { withLock: (_scope, mutate) => { stored = mutate(stored); } };
  const result = await updateAgentCoreSettings(manager, {}, { compactionReserveTokens: 8192, retryMaxRetries: 5, defaultTools: [] }, storage);
  assert.equal(current.compaction.enabled, false);
  assert.equal(current.compaction.keepRecentTokens, 50);
  assert.equal(current.retry.provider.maxRetries, 7);
  assert.equal(current.retry.maxRetries, 5);
  assert.equal(current.anotherSetting, true);
  assert.equal(current.httpProxy, "http://user:password@localhost:8888");
  assert.equal(result.httpProxyHasCredentials, true);
  assert.equal(result.httpProxy.includes("password"), false);
  assert.deepEqual(current.defaultTools, []);
  await updateAgentCoreSettings(manager, {}, {
    providerRetryTimeoutMs: 120000,
    providerRetryMaxRetries: 2,
    providerRetryMaxRetryDelayMs: 45000,
    branchSummaryReserveTokens: 4096,
    branchSummarySkipPrompt: true,
    websocketConnectTimeoutMs: 9000,
    thinkingBudgets: { low: 4096, high: 32768 },
    imageAutoResize: false,
    blockImages: true,
    defaultProjectTrust: "always",
    shellPath: "C:/Program Files/Git/bin/bash.exe",
    shellCommandPrefix: "shopt -s expand_aliases",
    npmCommand: ["mise", "exec", "node@20", "--", "npm"],
    sessionDir: ".pi/sessions",
    enableSkillCommands: false,
    enableInstallTelemetry: false,
  }, storage);
  assert.deepEqual(current.retry.provider, { maxRetries: 2, unknown: true, timeoutMs: 120000, maxRetryDelayMs: 45000 });
  assert.deepEqual(current.branchSummary, { reserveTokens: 4096, skipPrompt: true });
  assert.equal(current.websocketConnectTimeoutMs, 9000);
  assert.deepEqual(current.thinkingBudgets, { low: 4096, high: 32768 });
  assert.deepEqual(current.images, { autoResize: false, blockImages: true });
  assert.equal(current.defaultProjectTrust, "always");
  assert.equal(current.shellPath, "C:/Program Files/Git/bin/bash.exe");
  assert.equal(current.shellCommandPrefix, "shopt -s expand_aliases");
  assert.deepEqual(current.npmCommand, ["mise", "exec", "node@20", "--", "npm"]);
  assert.equal(current.sessionDir, ".pi/sessions");
  assert.equal(current.enableSkillCommands, false);
  assert.equal(current.enableInstallTelemetry, false);
  await updateAgentCoreSettings(manager, {}, { defaultTools: null, httpProxy: "" }, storage);
  assert.equal(current.defaultTools, undefined);
  assert.equal(current.httpProxy, undefined);
  await updateAgentCoreSettings(manager, {}, { defaultThinkingLevel: "max" }, storage);
  assert.equal(current.defaultThinkingLevel, "max");
  await assert.rejects(updateAgentCoreSettings(manager, {}, { retryMaxRetries: -1 }, storage), /retryMaxRetries/);
  await assert.rejects(updateAgentCoreSettings(manager, {}, { httpProxy: "file:///tmp/a" }, storage), /HTTP/);
});

test("PfsaaHost DTO validation rejects coercible booleans and unknown fields", () => {
  assert.throws(() => validatePfsaaHostPayload("settings.update", { compactionEnabled: "false" }), /compactionEnabled must be a boolean/);
  assert.throws(() => validatePfsaaHostPayload("settings.update", { externalEditor: "x".repeat(1001) }), /externalEditor/);
  assert.throws(() => validatePfsaaHostPayload("packages.configure", { source: "demo", enabled: true, unexpected: true }), /unknown field/);
  assert.throws(() => validatePfsaaHostPayload("agent.cycleModel", { taskId: "task", direction: "next" }), /direction/);
  assert.doesNotThrow(() => validatePfsaaHostPayload("settings.update", { compactionEnabled: false, transport: "auto" }));
  assert.doesNotThrow(() => validatePfsaaHostPayload("settings.update", { transport: "websocket-cached", thinkingBudgets: { low: 4096 } }));
  assert.doesNotThrow(() => validatePfsaaHostPayload("settings.update", { externalEditor: "code --wait" }));
  assert.doesNotThrow(() => validatePfsaaHostPayload("agent.prompt", { taskId: "task", text: "hello", images: undefined, delivery: undefined }));
  assert.doesNotThrow(() => validatePfsaaHostPayload("agent.cycleModel", { taskId: "task", direction: "backward" }));
  assert.doesNotThrow(() => validatePfsaaHostPayload("projects.trustStatus", { cwd: "D:/workspace" }));
  assert.doesNotThrow(() => validatePfsaaHostPayload("providers.setApiKey", { providerId: "openai", apiKey: "secret" }));
  assert.throws(() => validatePfsaaHostPayload("providers.setApiKey", { providerId: "openai", secret: "secret" }), /apiKey/);
  assert.doesNotThrow(() => validatePfsaaHostPayload("providers.create", { name: "Private gateway", baseUrl: "https://models.example.test/v1", models: [{ id: "model-a", name: "Model A" }], apiKey: "secret" }));
  assert.throws(() => validatePfsaaHostPayload("providers.create", { name: "Private gateway", baseUrl: "https://models.example.test/v1", models: [{ id: "model-a", name: "Model A" }], apiKey: "secret", extra: true }), /unknown field/);
  assert.doesNotThrow(() => validatePfsaaHostPayload("providers.update", { providerId: "pfsaa-private-gateway", name: "Private gateway", baseUrl: "https://models.example.test/v1", models: [{ id: "model-a", name: "Model A" }] }));
  assert.doesNotThrow(() => validatePfsaaHostPayload("providers.discoverModels", { providerId: "pfsaa-private-gateway", baseUrl: "https://models.example.test/v1" }));
  assert.doesNotThrow(() => validatePfsaaHostPayload("providers.remove", { providerId: "pfsaa-private-gateway" }));
  assert.doesNotThrow(() => validatePfsaaHostPayload("settings.update", { modelThinkingLevels: { "openai/gpt-test": "max", "anthropic/claude": null } }));
  assert.throws(() => validatePfsaaHostPayload("settings.update", { modelThinkingLevels: { "openai/gpt-test": "unsupported" } }), /modelThinkingLevels/);
  assert.doesNotThrow(() => validatePfsaaHostPayload("sessions.fork", { taskId: "task", entryId: "entry", cwd: "/workspace" }));
  assert.doesNotThrow(() => validatePfsaaHostPayload("sessions.navigateTree", { taskId: "task", entryId: "entry", summarize: true, customInstructions: "Keep decisions" }));
  assert.throws(() => validatePfsaaHostPayload("sessions.navigateTree", { taskId: "task", entryId: "entry", summarize: "yes" }), /summarize/);
  assert.throws(() => validatePfsaaHostPayload("sessions.fork", { taskId: "task", entryId: "" }), /entryId/);
});

test("Provider config store preserves user configuration while managing PFSAA-owned providers", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-provider-store-"));
  try {
    fs.writeFileSync(path.join(agentDir, "models.json"), `{
  // Existing model configuration must survive PFSAA edits.
  "providers": {
    "existing": { "name": "Existing", "baseUrl": "https://existing.example/v1", "api": "openai-completions", "models": [{ "id": "existing-model" }] }
  },
  "unknownSetting": true
}\n`);
    const { providerId } = await createCustomProvider(agentDir, {
      name: "Private gateway",
      baseUrl: "https://models.example.test/v1/",
      models: [{ id: "model-a", name: "Model A" }, { id: "model-b", name: "Model B" }],
    }, ["pfsaa-runtime-provider"]);
    assert.equal(providerId, "pfsaa-private-gateway");
    const modelsText = fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
    assert.match(modelsText, /Existing model configuration/);
    assert.match(modelsText, /"unknownSetting": true/);
    assert.match(modelsText, /"pfsaa-private-gateway"/);
    const previous = await updateCustomProvider(agentDir, providerId, {
      name: "Private model gateway",
      baseUrl: "https://models.example.test/v2",
      models: [{ id: "model-a", name: "Renamed Model A" }, { id: "model-c", name: "Model C" }],
    });
    assert.equal(previous.baseUrl, "https://models.example.test/v1");
    const updatedModels = parseJsonc(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"));
    assert.equal(updatedModels.providers[providerId].name, "Private model gateway");
    assert.equal(updatedModels.providers[providerId].baseUrl, "https://models.example.test/v2");
    assert.deepEqual(updatedModels.providers[providerId].models, [{ id: "model-a", name: "Renamed Model A" }, { id: "model-c", name: "Model C" }]);
    assert.match(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"), /Existing model configuration/);
    assert.match(fs.readFileSync(path.join(agentDir, "models.json"), "utf8"), /"unknownSetting": true/);

    let uiState = await getProviderUiState(agentDir);
    assert.deepEqual(uiState.customProviderIds, [providerId]);
    await hideProvider(agentDir, "openai", "OpenAI");
    uiState = await getProviderUiState(agentDir);
    assert.equal(uiState.hiddenProviders.openai, "OpenAI");
    await restoreProvider(agentDir, "openai");
    assert.equal((await getProviderUiState(agentDir)).hiddenProviders.openai, undefined);

    await removeCustomProvider(agentDir, providerId);
    const afterRemoval = fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
    assert.doesNotMatch(afterRemoval, /"pfsaa-private-gateway"/);
    assert.match(afterRemoval, /"existing"/);
    assert.deepEqual((await getProviderUiState(agentDir)).customProviderIds, []);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("session tree DTO preserves branches and exposes only serializable summaries", () => {
  const skillInstructions = "# Review\n".repeat(100).trimEnd();
  const user = { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: `<skill name="review" location="/skills/review/SKILL.md">\n${skillInstructions}\n</skill>\n\nOriginal request` }] } };
  const assistant = { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "First answer" }] } };
  const branch = { type: "message", id: "u2", parentId: "u1", timestamp: "2026-01-01T00:02:00.000Z", message: { role: "user", content: "Alternative" } };
  const entries = new Map([[user.id, user], [assistant.id, assistant], [branch.id, branch]]);
  const snapshot = buildSessionTreeSnapshot({
    getUserMessagesForForking: () => [{ entryId: "u1", text: "Original request" }, { entryId: "u2", text: "Alternative" }],
    sessionManager: {
      getLeafId: () => "a1",
      getEntry: id => entries.get(id),
      getTree: () => [{ entry: user, label: "Start", children: [{ entry: assistant, children: [] }, { entry: branch, children: [] }] }],
    },
  });
  assert.equal(snapshot.entries.length, 3);
  assert.deepEqual(snapshot.entries.map(entry => [entry.id, entry.depth, entry.active, entry.forkable]), [
    ["u1", 0, true, true], ["a1", 1, true, false], ["u2", 1, false, true],
  ]);
  assert.equal(snapshot.entries[0].childCount, 2);
  assert.equal(snapshot.entries[0].label, "Start");
  assert.equal(snapshot.entries[0].preview, "/skill:review Original request");
  assert.doesNotMatch(snapshot.entries[0].preview, /# Review/);
  assert.doesNotThrow(() => structuredClone(snapshot));
});

test("session tree projection stays iterative and bounded for very deep conversations", () => {
  const entries = new Map();
  const rootEntry = { type: "message", id: "entry-0", parentId: null, message: { role: "user", content: "Start" } };
  const root = { entry: rootEntry, children: [] };
  entries.set(rootEntry.id, rootEntry);
  let node = root;
  for (let index = 1; index < 8_000; index += 1) {
    const entry = { type: "message", id: `entry-${index}`, parentId: `entry-${index - 1}`, message: { role: index % 2 ? "assistant" : "user", content: `Message ${index}` } };
    const child = { entry, children: [] };
    node.children.push(child);
    node = child;
    entries.set(entry.id, entry);
  }
  const snapshot = buildSessionTreeSnapshot({
    getUserMessagesForForking: () => [],
    sessionManager: {
      getLeafId: () => "entry-7999",
      getEntry: id => entries.get(id),
      getTree: () => [root],
    },
  });
  assert.equal(snapshot.entries.length, 5_000);
  assert.equal(snapshot.entries.at(-1).depth, 4_999);
  assert.equal(snapshot.truncated, true);
});

test("project trust gates AgentCore resources and reports saved, inherited, and default decisions", () => {
  const project = path.join(path.parse(process.cwd()).root, "workspace", "project");
  const parent = path.dirname(project);
  let hasResources = true;
  let entry = null;
  const managerOptions = [];
  const sdk = {
    hasTrustRequiringProjectResources: () => hasResources,
    ProjectTrustStore: class { getEntry() { return entry; } },
    SettingsManager: {
      create: (_cwd, _agentDir, options) => {
        managerOptions.push(options);
        return { getDefaultProjectTrust: () => "ask", isProjectTrusted: () => options?.projectTrusted };
      },
    },
  };

  assert.deepEqual(readProjectTrustStatus(sdk, project, "agent-dir"), {
    cwd: path.resolve(project), hasTrustRequiringResources: true, trusted: false, source: "default", defaultPolicy: "ask",
  });
  entry = { path: parent, decision: true };
  assert.equal(readProjectTrustStatus(sdk, project, "agent-dir").source, "inherited");
  assert.equal(readProjectTrustStatus(sdk, project, "agent-dir").trusted, true);
  entry = { path: project, decision: false };
  assert.equal(readProjectTrustStatus(sdk, project, "agent-dir").source, "saved");
  assert.equal(createTrustAwareSettingsManager(sdk, project, "agent-dir").settingsManager.isProjectTrusted(), false);
  assert.equal(managerOptions.at(-1).projectTrusted, false);
  hasResources = false;
  assert.equal(readProjectTrustStatus(sdk, project, "agent-dir").source, "saved");
  assert.equal(readProjectTrustStatus(sdk, project, "agent-dir").trusted, false);
  entry = null;
  assert.equal(readProjectTrustStatus(sdk, project, "agent-dir").source, "not-required");
  assert.equal(readProjectTrustStatus(sdk, project, "agent-dir").trusted, false);
});

test("project trust treats filesystem aliases as the same saved project", t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-trust-alias-"));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const canonical = fs.realpathSync(project);
  const sdk = {
    hasTrustRequiringProjectResources: cwd => cwd === canonical,
    ProjectTrustStore: class { getEntry() { return { path: canonical, decision: true }; } },
    SettingsManager: { create: () => ({ getDefaultProjectTrust: () => "ask" }) },
  };
  const status = readProjectTrustStatus(sdk, project, "agent-dir");
  assert.equal(status.cwd, canonical);
  assert.equal(status.source, "saved");
  assert.equal(status.trusted, true);
});

test("application menu requests allow only fixed groups and finite bounded anchors", () => {
  const { applicationMenuRequestSchema } = require("../../../packages/contracts/dist/index.js");
  for (const menu of ["all", "edit", "view", "help"]) assert.equal(applicationMenuRequestSchema.parse({ menu, x: 12.5, y: 40 }).menu, menu);
  assert.throws(() => applicationMenuRequestSchema.parse({ menu: "file", x: 0, y: 0 }));
  for (const value of [{ menu: "quit", x: 0, y: 0 }, { menu: "edit", x: -1, y: 0 }, { menu: "edit", x: NaN, y: 0 }, { menu: "edit", x: Infinity, y: 0 }, { menu: "edit", x: "1", y: 0 }, { menu: "edit", x: 0, y: 0, command: "copy" }]) assert.throws(() => applicationMenuRequestSchema.parse(value));
});

test("title-bar menus reuse localized native roles and preserve packaged restrictions", () => {
  const { buildApplicationMenuTemplate } = require("../dist/main/application-menu.js");
  const { appMenuCopy } = require("../../../packages/i18n/dist/index.js");
  let about = 0;
  for (const language of ["zh", "en"]) {
    const menu = buildApplicationMenuTemplate(language, true, () => about++, "win32");
    assert.deepEqual(menu.map(({ id }) => id), ["edit", "view", "help"]);
    assert.deepEqual(menu.map(({ label }) => label), menu.map(({ id }) => appMenuCopy[language][id]));
    assert.deepEqual(menu[0].submenu.filter(({ role }) => role).map(({ role }) => role), ["undo", "redo", "cut", "copy", "paste", "selectAll"]);
    assert.deepEqual(menu[1].submenu.filter(({ role }) => role).map(({ role }) => role), ["resetZoom", "zoomIn", "zoomOut", "togglefullscreen"]);
    menu[2].submenu[0].click();
    const macMenu = buildApplicationMenuTemplate(language, true, () => {}, "darwin");
    assert.deepEqual(macMenu.map(({ id }) => id), ["file", "edit", "view", "help"]);
    assert.deepEqual(macMenu[0].submenu.filter(({ role }) => role).map(({ role }) => role), ["close", "quit"]);
  }
  assert.equal(about, 2);
  assert.equal(appMenuCopy.zh.aboutBody("1.2.3", "0.84.4"), "PFSAA 1.2.3\n运行组件 0.84.4");
  assert.equal(appMenuCopy.en.aboutBody("1.2.3", "0.84.4"), "PFSAA 1.2.3\nRuntime 0.84.4");
  assert.doesNotMatch(appMenuCopy.en.aboutBody("1.2.3", "0.84.4"), /Electron|Node/);
  assert.ok(buildApplicationMenuTemplate("en", false, () => {}, "win32").find(({ id }) => id === "view").submenu.some(({ role }) => role === "toggleDevTools"));
  const main = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "../src/preload/index.ts"), "utf8");
  assert.match(main, /registerTrustedIpcHandler\("app:popup-menu"/);
  assert.match(main, /process\.platform !== "win32" \|\| !hostWindow/);
  assert.match(preload, /popupMenu:.*ipcRenderer\.invoke\("app:popup-menu", request\)/);
});

test("native menu popup scales anchors, rejects reentry, and releases on close/error", async () => {
  const { EventEmitter } = require("node:events");
  const { popupApplicationMenu } = require("../dist/main/application-menu.js");
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentSize: () => [500, 300], webContents: { getZoomFactor: () => 1.5 } });
  let popup;
  const edit = { popup: (options) => { popup = options; } };
  const menu = { getMenuItemById: (id) => id === "edit" ? { submenu: edit } : null, popup: edit.popup };
  const pending = popupApplicationMenu(window, menu, { menu: "edit", x: 10.5, y: 40 });
  assert.equal(popup.x, 16);
  assert.equal(popup.y, 60);
  assert.equal(popup.window, window);
  await assert.rejects(popupApplicationMenu(window, menu, { menu: "all", x: 0, y: 0 }), /already open/);
  popup.callback();
  await pending;
  assert.equal(window.listenerCount("closed"), 0);
  const all = popupApplicationMenu(window, menu, { menu: "all", x: 10_000, y: 10_000 });
  assert.equal(popup.x, 499);
  assert.equal(popup.y, 299);
  window.emit("closed");
  await all;
  await assert.rejects(popupApplicationMenu(window, menu, { menu: "help", x: 0, y: 0 }), /unavailable/);
  await assert.rejects(popupApplicationMenu(window, { popup: () => { throw new Error("native failure"); } }, { menu: "all", x: 0, y: 0 }), /native failure/);
  assert.equal(window.listenerCount("closed"), 0);
  const retry = popupApplicationMenu(window, menu, { menu: "all", x: 0, y: 0 });
  popup.callback();
  await retry;
});

test("built-in slash command descriptions are localized without rewriting custom resources", () => {
  assert.equal(localizeCommandDescription("settings", "Theme, message delivery, transport, and other preferences", "zh"), "配置主题、消息投递、传输方式及其他偏好");
  assert.equal(localizeCommandDescription("llama", "Download, load, and unload llama.cpp router models", "zh"), "下载、加载或卸载 llama.cpp 路由模型");
  assert.equal(localizeCommandDescription("custom-command", "Project-owned description", "zh"), "Project-owned description");
});

test("Vite watches shared UI source instead of a stale prebundled icon catalog", async () => {
  const configPath = path.resolve(__dirname, "../vite.config.mts");
  const { default: config } = await import(pathToFileURL(configPath).href);
  assert.equal(config.resolve.alias["@pfsaa/ui-system"], path.resolve(__dirname, "../../../packages/ui-system/src/index.tsx"));
  assert.ok(config.optimizeDeps.exclude.includes("@pfsaa/ui-system"));
  assert.ok(!config.optimizeDeps.include.includes("@pfsaa/ui-system"));
  assert.equal(config.resolve.alias["@pfsaa/i18n"], path.resolve(__dirname, "../../../packages/i18n/src/index.ts"));
  assert.ok(config.optimizeDeps.exclude.includes("@pfsaa/i18n"));
  assert.ok(!config.optimizeDeps.include.includes("@pfsaa/i18n"));
});

test("AgentCore settings handler persists partial defaults without requiring a model", async () => {
  const calls = [];
  let compaction = true;
  let transport = "auto";
  const manager = {
    getDefaultProvider: () => undefined,
    getDefaultModel: () => undefined,
    getDefaultThinkingLevel: () => "off",
    getTransport: () => transport,
    getCompactionSettings: () => ({ enabled: compaction }),
    getSteeringMode: () => "one-at-a-time",
    getFollowUpMode: () => "one-at-a-time",
    setDefaultModelAndProvider: () => calls.push("model"),
    setDefaultThinkingLevel: (value) => calls.push(["thinking", value]),
    setTransport: (value) => { transport = value; calls.push(["transport", value]); },
    setCompactionEnabled: (value) => { compaction = value; calls.push(["compaction", value]); },
    setSteeringMode: (value) => calls.push(["steering", value]),
    setFollowUpMode: (value) => calls.push(["follow-up", value]),
    flush: async () => calls.push("flush"),
  };
  const result = await updateAgentCoreSettings(manager, { getModel: () => undefined }, { compactionEnabled: false, transport: "websocket" });
  assert.equal(result.compactionEnabled, false);
  assert.deepEqual(calls, [["transport", "websocket"], ["compaction", false], "flush"]);
});

test("AgentCore settings handler applies modelThinkingLevels through AgentCore SettingsManager", async () => {
  const modelThinkingLevels = { "openai/gpt-test": "high", "anthropic/claude": "low" };
  let flushed = 0;
  const manager = {
    getDefaultProvider: () => "openai",
    getDefaultModel: () => "gpt-test",
    getDefaultThinkingLevel: () => "medium",
    getAllModelThinkingLevels: () => ({ ...modelThinkingLevels }),
    getTransport: () => "auto",
    getCompactionSettings: () => ({ enabled: true }),
    getSteeringMode: () => "one-at-a-time",
    getFollowUpMode: () => "one-at-a-time",
    setDefaultModelAndProvider: () => undefined,
    setDefaultThinkingLevel: () => undefined,
    setTransport: () => undefined,
    setCompactionEnabled: () => undefined,
    setSteeringMode: () => undefined,
    setFollowUpMode: () => undefined,
    setModelThinkingLevel: (provider, model, level) => { modelThinkingLevels[`${provider}/${model}`] = level; },
    removeModelThinkingLevel: (provider, model) => { delete modelThinkingLevels[`${provider}/${model}`]; },
    flush: async () => { flushed += 1; },
  };

  const result = await updateAgentCoreSettings(manager, { getModel: () => undefined }, {
    modelThinkingLevels: { "openai/gpt-test": "max", "google/gemini": "xhigh" },
  });
  assert.deepEqual(result.modelThinkingLevels, {
    "openai/gpt-test": "max",
    "anthropic/claude": "low",
    "google/gemini": "xhigh",
  });
  await updateAgentCoreSettings(manager, { getModel: () => undefined }, { modelThinkingLevels: { "anthropic/claude": null } });
  assert.deepEqual(modelThinkingLevels, { "openai/gpt-test": "max", "google/gemini": "xhigh" });
  assert.equal(flushed, 2);
  await assert.rejects(
    updateAgentCoreSettings(manager, { getModel: () => undefined }, { modelThinkingLevels: { "invalid": "low" } }),
    /Invalid model thinking setting/,
  );
});

test("AgentCore settings persist a user external editor through AgentCore locked storage and report its effective source", async () => {
  let stored = JSON.stringify({ theme: "dark" });
  let globalSettings = JSON.parse(stored);
  const storage = {
    withLock: (scope, update) => {
      assert.equal(scope, "global");
      stored = update(stored);
    },
  };
  const manager = {
    getDefaultProvider: () => undefined,
    getDefaultModel: () => undefined,
    getDefaultThinkingLevel: () => "off",
    getTransport: () => "auto",
    getCompactionSettings: () => ({ enabled: true }),
    getSteeringMode: () => "one-at-a-time",
    getFollowUpMode: () => "one-at-a-time",
    getGlobalSettings: () => globalSettings,
    getProjectSettings: () => ({}),
    getExternalEditorCommand: () => globalSettings.externalEditor ?? "notepad",
    setDefaultModelAndProvider: () => undefined,
    setDefaultThinkingLevel: () => undefined,
    setTransport: () => undefined,
    setCompactionEnabled: () => undefined,
    setSteeringMode: () => undefined,
    setFollowUpMode: () => undefined,
    flush: async () => undefined,
    reload: async () => { globalSettings = JSON.parse(stored); },
  };

  const configured = await updateAgentCoreSettings(manager, { getModel: () => undefined }, { externalEditor: "  code --wait  " }, storage);
  assert.deepEqual(JSON.parse(stored), { theme: "dark", externalEditor: "code --wait" });
  assert.equal(configured.externalEditor, "code --wait");
  assert.equal(configured.effectiveExternalEditor, "code --wait");
  assert.equal(configured.externalEditorSource, "user");

  const automatic = await updateAgentCoreSettings(manager, { getModel: () => undefined }, { externalEditor: "" }, storage);
  assert.deepEqual(JSON.parse(stored), { theme: "dark" });
  assert.equal(automatic.externalEditor, undefined);
  await assert.rejects(updateAgentCoreSettings(manager, { getModel: () => undefined }, { externalEditor: "code\n--wait" }, storage), /line breaks/);
});

test("native editor selections produce cross-platform AgentCore commands and alias quoted Unix paths", () => {
  assert.equal(externalEditorCommandForPath("C:\\Program Files\\Editor\\Editor.exe", "win32"), '"C:\\Program Files\\Editor\\Editor.exe"');
  assert.equal(externalEditorCommandForPath("/Applications/Visual Studio Code.app", "darwin"), 'open -W -a "/Applications/Visual Studio Code.app"');
  assert.equal(externalEditorCommandForPath("/opt/Visual Editor/editor", "linux"), '"/opt/Visual Editor/editor"');
  assert.throws(() => externalEditorCommandForPath("/opt/a'\"b/editor", "linux"), /quote characters/);

  const targets = [];
  const macCommand = replaceQuotedAbsolutePaths('open -W -a "/Applications/Visual Studio Code.app"', "darwin", (target) => {
    targets.push(target);
    return "/tmp/pfsaa-editor/target-0.app";
  });
  assert.equal(macCommand, "open -W -a /tmp/pfsaa-editor/target-0.app");
  assert.deepEqual(targets, ["/Applications/Visual Studio Code.app"]);
  assert.equal(replaceQuotedAbsolutePaths('"C:\\Program Files\\Editor\\Editor.exe" --wait', "win32", () => "unused"), '"C:\\Program Files\\Editor\\Editor.exe" --wait');
});

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
}

function cssThemeTokens(css, selector) {
  const selectorStart = css.indexOf(`${selector} {`);
  assert.notEqual(selectorStart, -1, `missing CSS theme block: ${selector}`);
  const blockStart = css.indexOf("{", selectorStart);
  const blockEnd = css.indexOf("}", blockStart);
  return Object.fromEntries([...css.slice(blockStart + 1, blockEnd).matchAll(/(--[\w-]+):\s*(#[\da-f]{6});/gi)].map((match) => [match[1], match[2]]));
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
    return channels.map((channel) => channel <= .03928 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
      .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  };
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (values[0] + .05) / (values[1] + .05);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("agent prompt coordination queues messages during automatic compaction and closes the preflight race", async () => {
  const runningReservation = createAgentRunReservation();
  let streaming = false;
  let runningGateResolved = false;
  const runningGate = waitForReservedAgentRun(runningReservation, () => streaming).then(() => {
    runningGateResolved = true;
  });
  await Promise.resolve();
  assert.equal(runningGateResolved, false);
  streaming = true;
  runningReservation.markStarted();
  await runningGate;
  assert.equal(runningGateResolved, true);

  const failedPreflight = createAgentRunReservation();
  let failedGateResolved = false;
  const failedGate = waitForReservedAgentRun(failedPreflight, () => false).then(() => {
    failedGateResolved = true;
  });
  failedPreflight.markStarted();
  await Promise.resolve();
  assert.equal(failedGateResolved, false);
  failedPreflight.markFinished();
  await failedGate;

  const calls = [];
  const session = {
    isCompacting: true,
    isStreaming: false,
    extensionRunner: { getRegisteredCommands: () => [{ invocationName: "permission-system" }] },
    steer: async (text, images) => calls.push(["steer", text, images]),
    followUp: async (text, images) => calls.push(["followUp", text, images]),
  };
  const images = [{ type: "image", data: "base64", mimeType: "image/png" }];
  assert.equal(await queuePromptDuringCompaction(session, "second message", images, "followUp"), true);
  assert.deepEqual(calls, [["followUp", "second message", images]]);
  assert.equal(isExtensionCommand(session, "/permission-system strict"), true);
  assert.equal(await queuePromptDuringCompaction(session, "/permission-system strict", undefined, "steer"), false);
  assert.equal(calls.length, 1);

  const root = path.join(__dirname, "../../..");
  const hostSource = readText(path.join(root, "packages/pfsaa-host/src/index.ts"));
  const controllerSource = readText(path.join(root, "apps/desktop/src/renderer/use-app-controller.tsx"));
  assert.match(hostSource, /preflightResult:\s*\(started:\s*boolean\)\s*=>\s*directReservation\.markStarted\(started\)/);
  assert.match(hostSource, /queuePromptDuringCompaction\(session/);
  assert.match(hostSource, /try \{ await session\.abort\(\); \} catch/);
  assert.match(controllerSource, /isCompacting:\s*continuingExecution\s*\?\s*Boolean\(activeTaskUi\?\.isCompacting\)\s*:\s*false/);
});

test("manual compaction queue preserves ordering and supports queue mutations", () => {
  const queue = new ManualCompactionPromptQueue();
  const key = "task\0cwd";
  queue.begin(key);
  queue.enqueue(key, { id: "follow-1", text: "later", images: [], delivery: "followUp" });
  queue.enqueue(key, { id: "steer-1", text: "now", images: [{ type: "image", data: "x", mimeType: "image/png" }], delivery: "steer" });
  assert.deepEqual(queue.list(key).map((entry) => entry.id), ["follow-1", "steer-1"]);
  assert.equal(queue.edit(key, "follow-1", "edited", []), true);
  assert.equal(queue.promote(key, 0), true);
  assert.equal(queue.delete(key, "steer-1"), true);
  assert.deepEqual(queue.drain(key).map((entry) => [entry.id, entry.text, entry.delivery]), [["follow-1", "edited", "steer"]]);
  assert.equal(queue.isActive(key), false);

  const root = path.join(__dirname, "../../..");
  const hostSource = readText(path.join(root, "packages/pfsaa-host/src/index.ts"));
  const settingsHandlerSource = readText(path.join(root, "packages/pfsaa-host/src/settings-command-handler.ts"));
  assert.match(hostSource, /case "sessions\.compact"[\s\S]*?manualCompactionQueues\.begin/);
  assert.match(hostSource, /resumeManualCompactionQueue/);
  assert.match(hostSource, /case "sessions\.reload"[\s\S]*?await session\.reload\(\{[\s\S]*?beforeSessionStart:[\s\S]*?permissionEngine\.resetUi/);
  assert.match(hostSource, /case "agent\.executeBash"[\s\S]*?session\.executeBash/);
  assert.match(hostSource, /case "settings\.update"[\s\S]*?updateAgentCoreSettings/);
  assert.match(hostSource, /bindExtensions\?\.\(\{[\s\S]*?mode: "tui"/);
  assert.match(hostSource, /case "extension\.ui\.input"[\s\S]*?permissionEngine\.inputUi/);
  assert.match(settingsHandlerSource, /setDefaultModelAndProvider/);
});

test("Extension UI maps persistent component, terminal, editor, and autocomplete APIs", async () => {
  const events = [];
  const engine = new PermissionEngine({ emitApproval: () => undefined, emitEvent: (_taskId, event) => events.push(event) });
  let branch = "main";
  let branchChanged;
  let branchUnsubscribed = false;
  const ui = engine.createUi("task", "scope", undefined, undefined, {
    getGitBranch: () => branch,
    getProviderCount: () => 3,
    onBranchChange: (callback) => { branchChanged = callback; return () => { branchUnsubscribed = true; }; },
  });
  const boundUi = { ...ui };
  assert.equal(boundUi.theme.fg("accent", "Ready"), "Ready");
  assert.equal(boundUi.theme.bg("selectedBg", "Selected"), "Selected");
  assert.equal(boundUi.theme.bold("Strong"), "Strong");
  assert.equal(boundUi.theme.getThinkingBorderColor("high")("Thinking"), "Thinking");
  ui.setStatus("sync", "Ready");
  ui.setWorkingMessage("Indexing");
  ui.setWorkingVisible(false);
  ui.setWorkingIndicator({ frames: ["a", "b"], interval: 80 });
  ui.setWidget("files", ["one", "two"], { placement: "aboveEditor" });
  let widgetDisposed = false;
  ui.setWidget("live", (tui) => ({ render: () => { tui.requestRender(); return ["\u001b[31mlive\u001b[0m"]; }, dispose: () => { widgetDisposed = true; } }), { placement: "belowEditor" });
  ui.setHeader(() => ({ render: () => ["Header"] }));
  ui.setFooter((tui, _theme, data) => {
    const unsubscribe = data.onBranchChange(() => tui.requestRender());
    return { render: () => [`Footer ${data.getGitBranch()} ${data.getAvailableProviderCount()} ${data.getExtensionStatuses().get("sync")}`], dispose: unsubscribe };
  });
  branch = "feature";
  branchChanged();
  ui.setTitle("Extension title");
  ui.setEditorText("draft");
  const received = [];
  const unsubscribe = ui.onTerminalInput((data) => { received.push(data); return data === "x" ? { consume: true } : { data: data.toUpperCase() }; });
  assert.deepEqual(engine.dispatchInput("scope", "x"), { consume: true });
  assert.deepEqual(engine.dispatchInput("scope", "a"), { consume: false, data: "A" });
  assert.deepEqual(received, ["x", "a"]);
  unsubscribe();

  let editorText = "";
  const editorComponent = {
    render: () => [`Editor ${editorText}`],
    handleInput(data) { editorText += data; this.onChange?.(editorText); },
    getText: () => editorText,
    setText: (text) => { editorText = text; },
  };
  const editorFactory = () => editorComponent;
  ui.setEditorComponent(editorFactory);
  assert.equal(ui.getEditorComponent(), editorFactory);
  assert.deepEqual(engine.dispatchInput("scope", "!"), { consume: true });
  assert.equal(ui.getEditorText(), "draft!");
  editorComponent.onSubmit("send me");

  ui.addAutocompleteProvider(() => ({
    triggerCharacters: [":"],
    async getSuggestions() { return { prefix: ":a", items: [{ value: "alpha", label: "Alpha", description: "first" }] }; },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const line = lines[cursorLine];
      const next = [...lines];
      next[cursorLine] = `${line.slice(0, cursorCol - prefix.length)}${item.value}${line.slice(cursorCol)}`;
      return { lines: next, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
    },
  }));
  assert.deepEqual(await engine.autocomplete("scope", "say :a now", 6), { prefix: ":a", items: [{ value: "alpha", label: "Alpha", description: "first", text: "say alpha now", cursor: 9 }] });
  await new Promise((resolve) => setTimeout(resolve, 70));

  engine.resetUi("task");
  const actions = events.filter((event) => event.type === "extension.ui.presentation").map((event) => event.action);
  for (const action of ["status", "widget", "header", "footer", "editor", "terminal-input", "autocomplete", "editor-submit", "reset"]) assert.equal(actions.includes(action), true, action);
  assert.equal(widgetDisposed, true);
  assert.equal(branchUnsubscribed, true);
  assert.equal(events.some((event) => event.type === "extension.ui.presentation" && event.action === "footer" && event.lines?.[0] === "Footer feature 3 Ready"), true);
  assert.equal(events.filter((event) => event.type === "extension.ui.unsupported").length, 0);
  assert.equal(events.filter((event) => event.type === "extension.ui.unsupported" && event.capability === "theme").length, 0);
});

test("Extension UI forwards custom AgentCore component renders and terminal input", async () => {
  const requests = [];
  const events = [];
  const engine = new PermissionEngine({
    emitApproval: () => undefined,
    emitEvent: (_taskId, event) => events.push(event),
    emitUiRequest: (requestId, taskId, request) => requests.push({ requestId, taskId, ...request }),
  });
  const ui = engine.createUi("task");
  let received;
  const result = ui.custom((_tui, _theme, _keybindings, done) => ({
    render: () => ["AgentCore screen"],
    handleInput: (data) => {
      received = data;
      if (data === "done") done("completed");
    },
    invalidate: () => undefined,
  }));
  await Promise.resolve();
  assert.equal(requests[0].kind, "custom");
  assert.deepEqual(requests[0].lines, ["AgentCore screen"]);
  engine.inputUi(requests[0].requestId, "\x1b[B");
  assert.equal(received, "\x1b[B");
  engine.inputUi(requests[0].requestId, "done");
  assert.equal(await result, "completed");
  assert.equal(events.some((event) => event.type === "extension.ui.dismiss" && event.requestId === requests[0].requestId), true);
});

test("language switch button presents the target language", () => {
  const { languageSwitchTarget } = require("../dist/renderer/use-preferences.js");
  assert.deepEqual(languageSwitchTarget("zh"), { language: "en", label: "EN" });
  assert.deepEqual(languageSwitchTarget("en"), { language: "zh", label: "中" });
});

test("composer history preserves exact Skill, prompt, built-in, and extension command submissions", () => {
  const history = new ComposerHistory();
  const taskId = "task";
  const persisted = ["older message"];
  history.add(taskId, "/skill:review fix this", persisted);
  history.add(taskId, "/compact keep decisions", persisted);
  history.add(taskId, "/release-notes beta", persisted);
  history.add(taskId, "/permission-system strict", persisted);

  // AgentCore persists expanded Skill/template contents after submission. A later
  // message refresh must not replace the raw editor history captured above.
  const expanded = ["older message", '<skill name="review">full SKILL.md contents</skill>'];
  assert.equal(history.navigate(taskId, "previous", "draft", expanded).value, "/permission-system strict");
  assert.equal(history.navigate(taskId, "previous", "draft", expanded).value, "/release-notes beta");
  assert.equal(history.navigate(taskId, "previous", "draft", expanded).value, "/compact keep decisions");
  assert.equal(history.navigate(taskId, "previous", "draft", expanded).value, "/skill:review fix this");
  assert.equal(history.navigate(taskId, "next", "draft", expanded).value, "/compact keep decisions");
  assert.equal(history.navigate(taskId, "next", "draft", expanded).value, "/release-notes beta");
  assert.equal(history.navigate(taskId, "next", "draft", expanded).value, "/permission-system strict");
  assert.equal(history.navigate(taskId, "next", "draft", expanded).value, "draft");
});

test("Extension commands report completion without clearing an existing model run", () => {
  const root = path.join(__dirname, "../../..");
  const hostSource = readText(path.join(root, "packages/pfsaa-host/src/index.ts"));
  const rendererSource = readText(path.join(root, "apps/desktop/src/renderer/use-app-controller.tsx"));
  assert.match(hostSource, /return "extension-command"/);
  assert.match(hostSource, /result: \{ disposition \}/);
  assert.match(rendererSource, /promptResult\?\.disposition === "extension-command" && !continuingExecution/);
  assert.match(rendererSource, /const extensionCommandCandidate = isRegisteredExtensionCommand\(text\)/);
  assert.match(rendererSource, /!continuingExecution && !extensionCommandCandidate/);
});

test("session reload keeps persisted messages from before context compaction", async () => {
  const root = path.join(__dirname, "../../..");
  const sdk = await import(pathToFileURL(path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
  const manager = sdk.SessionManager.inMemory("C:/pfsaa-compaction-regression");
  manager.appendMessage({ role: "user", content: "old persisted turn", timestamp: 1 });
  const firstKeptEntryId = manager.appendMessage({ role: "user", content: "recent retained turn", timestamp: 2 });
  manager.appendCompaction("summary of the old turn", firstKeptEntryId, 2048);

  const compactedContext = manager.buildSessionContext().messages;
  assert.deepEqual(compactedContext.map((message) => message.role), ["compactionSummary", "user"]);
  assert.equal(compactedContext.some((message) => message.content === "old persisted turn"), false);

  const transcript = sessionTranscriptMessages(
    { messages: compactedContext, sessionManager: manager },
    sdk.sessionEntryToContextMessages,
  );
  assert.deepEqual(transcript.map((message) => message.role), ["user", "user", "compactionSummary"]);
  assert.equal(transcript.some((message) => message.content === "old persisted turn"), true);

  const hostSource = readText(path.join(root, "packages/pfsaa-host/src/index.ts"));
  assert.match(hostSource, /case "sessions\.messages"[\s\S]*?sessionTranscriptMessages/);
  assert.match(hostSource, /event\.type === "compaction_end"[\s\S]*?sessionTranscriptMessages/);
});

test("per-run change review excludes dirty files that predate the agent turn", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-change-review-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "tracked.txt"), "alpha\n", "utf8");
  fs.writeFileSync(path.join(workspace, "preexisting.txt"), "committed\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=PFSAA Test", "-c", "user.email=pfsaa@example.invalid", "commit", "--quiet", "-m", "baseline"], { cwd: workspace });

  fs.writeFileSync(path.join(workspace, "preexisting.txt"), "user change before run\n", "utf8");
  const before = await captureWorkspaceChangeState(workspace);
  fs.writeFileSync(path.join(workspace, "tracked.txt"), "beta\n", "utf8");
  fs.writeFileSync(path.join(workspace, "added.txt"), "new file\n", "utf8");
  const after = await captureWorkspaceChangeState(workspace);
  const sdk = await import(pathToFileURL(path.join(__dirname, "../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
  const review = await buildSessionChangeReview("task-review", 100, 200, before, after, sdk.generateUnifiedPatch);

  assert.ok(review);
  assert.equal(review.state, "completed");
  assert.deepEqual(review.files.map((file) => file.path), ["added.txt", "tracked.txt"]);
  assert.equal(review.files.some((file) => file.path === "preexisting.txt"), false);
  assert.equal(review.files.find((file) => file.path === "added.txt").status, "added");
  assert.match(review.files.find((file) => file.path === "tracked.txt").patch, /^--- tracked\.txt[\s\S]*^\+beta$/m);

  const unchanged = await buildSessionChangeReview("task-review", 200, 300, after, await captureWorkspaceChangeState(workspace), sdk.generateUnifiedPatch);
  assert.ok(unchanged);
  assert.deepEqual(unchanged.files, []);
});

test("change review reports rename, delete, binary, oversized, and mode-only changes", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-change-types-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "rename-me.txt"), "rename and edit\n", "utf8");
  fs.writeFileSync(path.join(workspace, "delete-me.txt"), "delete\n", "utf8");
  fs.writeFileSync(path.join(workspace, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(path.join(workspace, "mode.sh"), "#!/bin/sh\necho ok\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=PFSAA Test", "-c", "user.email=pfsaa@example.invalid", "commit", "--quiet", "-m", "baseline"], { cwd: workspace });

  const before = await captureWorkspaceChangeState(workspace);
  execFileSync("git", ["mv", "rename-me.txt", "renamed.txt"], { cwd: workspace });
  fs.appendFileSync(path.join(workspace, "renamed.txt"), "changed\n");
  fs.rmSync(path.join(workspace, "delete-me.txt"));
  fs.writeFileSync(path.join(workspace, "binary.bin"), Buffer.from([0, 9, 8, 7]));
  fs.writeFileSync(path.join(workspace, "oversized.txt"), Buffer.alloc(760_000, 65));
  if (process.platform === "win32") execFileSync("git", ["update-index", "--chmod=+x", "mode.sh"], { cwd: workspace });
  else fs.chmodSync(path.join(workspace, "mode.sh"), 0o755);
  const after = await captureWorkspaceChangeState(workspace);
  assert.match(after?.dirtyFiles.get("oversized.txt")?.digest ?? "", /^sample:/);
  assert.equal(after?.dirtyFiles.get("oversized.txt")?.content, undefined);
  const sdk = await import(pathToFileURL(path.join(__dirname, "../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
  const review = await buildSessionChangeReview("change-types", 1, 2, before, after, sdk.generateUnifiedPatch);

  assert.ok(review);
  const renamed = review.files.find((file) => file.path === "renamed.txt");
  assert.equal(renamed?.status, "renamed");
  assert.equal(renamed?.previousPath, "rename-me.txt");
  assert.equal(review.files.find((file) => file.path === "delete-me.txt")?.status, "deleted");
  assert.equal(review.files.find((file) => file.path === "binary.bin")?.binary, true);
  assert.equal(review.files.find((file) => file.path === "oversized.txt")?.truncated, true);
  const mode = review.files.find((file) => file.path === "mode.sh");
  assert.equal(mode?.oldMode, "100644");
  assert.equal(mode?.newMode, "100755");
});

test("change review follows a run that commits its changes", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-change-commit-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, "committed.txt"), "before\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=PFSAA Test", "-c", "user.email=pfsaa@example.invalid", "commit", "--quiet", "-m", "baseline"], { cwd: workspace });
  const before = await captureWorkspaceChangeState(workspace);
  fs.writeFileSync(path.join(workspace, "committed.txt"), "after\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=PFSAA Test", "-c", "user.email=pfsaa@example.invalid", "commit", "--quiet", "-m", "agent change"], { cwd: workspace });
  const after = await captureWorkspaceChangeState(workspace);
  const sdk = await import(pathToFileURL(path.join(__dirname, "../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
  const review = await buildSessionChangeReview("commit-review", 1, 2, before, after, sdk.generateUnifiedPatch);
  assert.equal(review?.files[0]?.path, "committed.txt");
  assert.match(review?.files[0]?.patch ?? "", /^\+after$/m);
});

test("change review resolves exact hunks and editable merges without overwriting concurrent edits", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-change-merge-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
  const filePath = path.join(workspace, "two-hunks.txt");
  const baseline = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  fs.writeFileSync(filePath, baseline, "utf8");
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=PFSAA Test", "-c", "user.email=pfsaa@example.invalid", "commit", "--quiet", "-m", "baseline"], { cwd: workspace });
  const before = await captureWorkspaceChangeState(workspace);
  const changed = baseline.replace("line 1\n", "changed 1\n").replace("line 14\n", "changed 14\n");
  fs.writeFileSync(filePath, changed, "utf8");
  const after = await captureWorkspaceChangeState(workspace);
  const sdk = await import(pathToFileURL(path.join(__dirname, "../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
  const review = await buildSessionChangeReview("merge-review", 1, 2, before, after, sdk.generateUnifiedPatch);
  const file = review?.files[0];
  assert.ok(file);
  assert.equal((file.patch.match(/^@@/gm) ?? []).length, 2);

  const accepted = acceptChangeReviewHunk(file, 0);
  assert.equal(accepted.hunkResolutions[0].action, "accepted");
  const source = await loadChangeReviewMergeSource(review.id, workspace, accepted);
  assert.deepEqual(source.unresolvedHunks, [1]);
  assert.match(source.originalContent, /^changed 1$/m);
  assert.match(source.originalContent, /^line 14$/m);

  const reverted = await revertChangeReviewHunk(workspace, accepted, 1);
  assert.match(fs.readFileSync(filePath, "utf8"), /^line 14$/m);
  await reverted.rollback();
  assert.equal(fs.readFileSync(filePath, "utf8"), changed);

  const mergedContent = source.originalContent.replace("line 14\n", "manually merged 14\n");
  const merged = await applyChangeReviewMerge(review.id, workspace, accepted, mergedContent, source.currentRevision);
  assert.equal(merged.action, "merged");
  assert.deepEqual(merged.hunkIndexes, [1]);
  assert.match(fs.readFileSync(filePath, "utf8"), /^manually merged 14$/m);
  fs.appendFileSync(filePath, "external after merge\n");
  await merged.rollback();
  assert.match(fs.readFileSync(filePath, "utf8"), /external after merge/);
  fs.writeFileSync(filePath, changed, "utf8");

  const fresh = await loadChangeReviewMergeSource(review.id, workspace, file);
  fs.appendFileSync(filePath, "external edit\n");
  await assert.rejects(() => applyChangeReviewMerge(review.id, workspace, file, fresh.currentContent, fresh.currentRevision), /changed while the merge editor was open/);
  fs.writeFileSync(filePath, changed, "utf8");

  if (process.platform !== "win32") {
    fs.symlinkSync(filePath, path.join(workspace, "linked.txt"));
    await assert.rejects(() => loadChangeReviewMergeSource(review.id, workspace, { ...file, path: "linked.txt" }), /regular files/);
  }

  const addedPath = path.join(workspace, "added.txt");
  const beforeAdded = await captureWorkspaceChangeState(workspace);
  fs.writeFileSync(addedPath, "new\n", "utf8");
  const addedReview = await buildSessionChangeReview("added-review", 3, 4, beforeAdded, await captureWorkspaceChangeState(workspace), sdk.generateUnifiedPatch);
  const addedFile = addedReview.files.find((item) => item.path === "added.txt");
  assert.ok(addedFile);
  const removed = await revertChangeReviewHunk(workspace, addedFile, 0);
  assert.equal(fs.existsSync(addedPath), false);
  await removed.rollback();
  assert.equal(fs.readFileSync(addedPath, "utf8"), "new\n");
  assert.equal(withResolvedReviewHunks(accepted, [1], removed.action).hunkResolutions.length, 2);
});

test("change review candidate work and output stay bounded", async () => {
  const beforeFiles = new Map();
  const afterFiles = new Map();
  for (let index = 0; index < 250; index += 1) {
    const filePath = `file-${String(index).padStart(3, "0")}.txt`;
    beforeFiles.set(filePath, { exists: true, content: Buffer.from("before\n"), digest: "before", binary: false, truncated: false, mode: "100644" });
    afterFiles.set(filePath, { exists: true, content: Buffer.from("after\n"), digest: "after", binary: false, truncated: false, mode: "100644" });
  }
  const state = (dirtyFiles, captureTruncated) => ({ cwd: "C:/bounded", repoRoot: "C:/bounded", scopePrefix: "", dirtyFiles, renames: new Map(), captureTruncated });
  const review = await buildSessionChangeReview("bounded", 1, 2, state(beforeFiles, true), state(afterFiles, true), (filePath, oldText, newText) => `--- ${filePath}\n+++ ${filePath}\n@@ -1 +1 @@\n-${oldText.trim()}\n+${newText.trim()}\n`);
  assert.ok(review);
  assert.equal(review.files.length, 200);
  assert.equal(review.fileCountTruncated, true);
  assert.equal(review.omittedFiles, undefined);
  assert.equal(review.files.every((file) => Buffer.byteLength(file.patch ?? "", "utf8") <= 250_000), true);

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-change-capture-bound-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: workspace });
    for (let index = 0; index < MAX_REVIEW_CAPTURE_PATHS + 5; index += 1) fs.writeFileSync(path.join(workspace, `untracked-${index}.txt`), "x\n");
    const captured = await captureWorkspaceChangeState(workspace);
    assert.equal(captured?.dirtyFiles.size <= MAX_REVIEW_CAPTURE_PATHS, true);
    assert.equal(captured?.captureTruncated, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("review persistence is schema-validated and bounded across reloads", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-review-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionFile = path.join(directory, "session.jsonl");
  fs.writeFileSync(sessionFile, "{}\n");
  const entries = [];
  const manager = {
    getSessionFile: () => sessionFile,
    getEntries: () => entries,
    appendCustomEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
  };
  const session = { sessionManager: manager };
  const makeReview = (index) => ({
    schemaVersion: 2,
    id: `review-${index}`,
    state: "completed",
    outcome: "succeeded",
    startedAt: index,
    endedAt: index + 1,
    files: [{ path: `file-${index}.txt`, status: "modified", additions: 1, deletions: 1, patch: `--- file-${index}.txt\n+++ file-${index}.txt\n@@ -1 +1 @@\n-a\n+b\n`, patchAvailable: true, binary: false, truncated: false, hunkResolutions: [{ hunkIndex: 0, action: "accepted", resolvedAt: index + 1 }] }],
    additions: 1,
    deletions: 1,
    truncated: false,
    fileCountTruncated: false,
  });
  for (let index = 0; index < 25; index += 1) await persistSessionChangeReview(session, makeReview(index));
  await Promise.all(Array.from({ length: 10 }, (_, index) => persistSessionChangeReview(session, makeReview(index + 25))));
  const loaded = await loadSessionChangeReviews(session);
  assert.equal(loaded.invalid, false);
  assert.equal(loaded.reviews.length, 20);
  assert.equal(loaded.reviews[0].id, "review-15");
  assert.equal(loaded.reviews.at(-1).id, "review-34");
  assert.equal(loaded.reviews.at(-1).files[0].patchAvailable, true);
  assert.deepEqual(loaded.reviews.at(-1).files[0].hunkResolutions, [{ hunkIndex: 0, action: "accepted", resolvedAt: 35 }]);
  assert.equal(loaded.reviews.at(-1).outcome, "succeeded");
  const summary = summarizeSessionChangeReview(loaded.reviews.at(-1));
  assert.equal(summary.files[0].patch, undefined);
  assert.equal(summary.files[0].patchAvailable, true);
  assert.equal(entries.filter((entry) => entry.customType === "pfsaa.change-review-store").length, 1);
  assert.equal(fs.statSync(sessionChangeReviewStorePath(session)).size < 12_512_000, true);
  const exportedSession = path.join(directory, "export.jsonl");
  fs.writeFileSync(exportedSession, "{}\n");
  assert.equal(await copySessionChangeReviewStore(session, exportedSession), true);
  const exportedManager = { getSessionFile: () => exportedSession, getEntries: () => [] };
  assert.equal((await loadSessionChangeReviews(exportedManager)).reviews.at(-1).id, "review-34");
  await deleteSessionChangeReviewStore(exportedSession);
  assert.equal(fs.existsSync(sessionChangeReviewStorePath(exportedManager)), false);

  const malicious = sanitizeSessionChangeReview({
    ...makeReview(99),
    files: [{ ...makeReview(99).files[0], path: "../outside", patch: "x".repeat(300_000) }],
    additions: 999999,
  });
  assert.ok(malicious);
  assert.deepEqual(malicious.files, []);
  assert.equal(malicious.additions, 0);
  assert.equal(malicious.fileCountTruncated, true);
  assert.equal(sanitizeSessionChangeReview({ ...makeReview(101), startedAt: 1e30, endedAt: 1e30 }), null);
  const oversizedPatch = sanitizeSessionChangeReview({
    ...makeReview(100),
    files: [{ ...makeReview(100).files[0], patch: "x".repeat(300_000) }],
  });
  assert.equal(oversizedPatch.files[0].patch, undefined);
  assert.equal(oversizedPatch.files[0].patchAvailable, true);
  assert.equal(oversizedPatch.files[0].truncated, true);

  const delayedDirectory = path.join(directory, "delayed");
  const delayedEntries = [];
  const delayedManager = {
    getSessionFile: () => path.join(delayedDirectory, "session.jsonl"),
    getEntries: () => delayedEntries,
    appendCustomEntry(customType, data) { delayedEntries.push({ type: "custom", customType, data }); },
  };
  await assert.rejects(() => persistSessionChangeReview(delayedManager, makeReview(200)));
  assert.equal((await loadSessionChangeReviews(delayedManager)).reviews.at(-1).id, "review-200");
  fs.mkdirSync(delayedDirectory, { recursive: true });
  assert.equal(await flushSessionChangeReviewStore(delayedManager), true);
  assert.equal(fs.existsSync(sessionChangeReviewStorePath(delayedManager)), true);

  fs.writeFileSync(sessionChangeReviewStorePath(session), "{bad json", "utf8");
  const invalid = await loadSessionChangeReviews(session);
  assert.equal(invalid.invalid, true);
  assert.equal(fs.existsSync(sessionChangeReviewStorePath(session)), false);
});

test("malformed imported legacy review metadata is reported without crossing the payload boundary", async () => {
  const manager = {
    getEntries: () => [{
      type: "custom",
      customType: "pfsaa.change-review",
      data: {
        schemaVersion: 1,
        id: "legacy-malformed",
        state: "completed",
        startedAt: 1,
        endedAt: 2,
        files: [{ path: "../../outside", status: "modified", additions: 5, deletions: 0, patch: "x".repeat(400_000), binary: false, truncated: false }],
        additions: 5,
        deletions: 0,
        truncated: false,
      },
    }],
  };
  const loaded = await loadSessionChangeReviews(manager);
  assert.equal(loaded.invalid, true);
  assert.equal(loaded.reviews[0].files.length, 0);
  assert.equal(loaded.reviews[0].fileCountTruncated, true);
});

test("review diff and tree interaction models handle whitespace, split rows, filtering, and keyboard navigation", () => {
  const patch = "--- src/a.ts\n+++ src/a.ts\n@@ -1,2 +1,2 @@\n-const value = 1;\n+const  value = 1;\n return value;\n";
  const lines = parseUnifiedPatch(patch);
  assert.equal(lines.filter((line) => line.whitespaceOnly).length, 2);
  assert.equal(sideBySideRows(lines).some((row) => row.oldLine?.kind === "deletion" && row.newLine?.kind === "addition"), true);
  const splitGap = sideBySideRows(parseUnifiedPatch("@@ -1,1 +1,1 @@\n first\n@@ -10,1 +10,1 @@\n second\n"))
    .find((row) => row.kind === "hunk" && row.hunkIndex === 1);
  assert.equal(splitGap?.oldOmittedLines, 8);
  assert.equal(splitGap?.newOmittedLines, 8);
  const files = [
    { path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patchAvailable: true, binary: false, truncated: false },
    { path: "src/deep/b.ts", status: "added", additions: 4, deletions: 0, patchAvailable: true, binary: false, truncated: false },
  ];
  const tree = buildChangeFileTree(files);
  assert.equal(tree[0].fileCount, 2);
  assert.equal(tree[0].additions, 5);
  assert.equal(buildChangeFileTree(files, "deep")[0].fileCount, 1);
  assert.deepEqual(reviewTreeKeyboardAction(["directory:src", "file:src/a.ts"], "directory:src", "ArrowRight", "directory", false), { expandKey: "directory:src" });
  assert.deepEqual(reviewTreeKeyboardAction(["directory:src", "file:src/a.ts"], "file:src/a.ts", "ArrowUp", "file", false), { focusKey: "directory:src" });
});

test("review availability distinguishes non-Git workspaces", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-not-git-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  assert.deepEqual(await inspectGitWorkspaceAvailability(workspace), { status: "not-git" });
});

test("system proxy rules preserve per-URL HTTP, SOCKS, and direct fallback order", () => {
  assert.deepEqual(systemProxyRoutesFromElectronRules("PROXY 127.0.0.1:7897; SOCKS5 localhost:1080; DIRECT"), [
    { type: "proxy", url: "http://127.0.0.1:7897/" },
    { type: "proxy", url: "socks5://localhost:1080" },
    { type: "direct" },
  ]);
  assert.deepEqual(systemProxyRoutesFromElectronRules("DIRECT"), [{ type: "direct" }]);
});

test("AgentCore HTTP networking gives AgentCore settings priority over the system-proxy fallback", () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-proxy-settings-"));
  const root = path.join(__dirname, "../../..");
  const adapterPath = path.join(root, "packages/agentcore-adapter/dist/index.js");
  const agentCoreModule = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  const script = `
    const { configureAgentCoreHttpNetworking } = require(${JSON.stringify(adapterPath)});
    configureAgentCoreHttpNetworking({ resolveSystemProxy: async () => { throw new Error("system resolver must not run"); } }).then(() => process.stdout.write(JSON.stringify({
      http: process.env.HTTP_PROXY ?? null,
      https: process.env.HTTPS_PROXY ?? null,
      noProxy: process.env.NO_PROXY ?? null,
    })));
  `;
  const environment = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PFSAA_RUNTIME_MODULE: agentCoreModule,
    PFSAA_USE_SYSTEM_PROXY: "1",
  };
  for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]) delete environment[key];

  try {
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ httpProxy: "http://pi.proxy:9000" }));
    const output = execFileSync(process.execPath, ["-e", script], { encoding: "utf8", env: environment });
    assert.deepEqual(JSON.parse(output), {
      http: "http://pi.proxy:9000",
      https: "http://pi.proxy:9000",
      noProxy: null,
    });

  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("AgentCore HTTP networking resolves each request URL and fails over before transmission", () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-dynamic-proxy-"));
  const root = path.join(__dirname, "../../..");
  const adapterPath = path.join(root, "packages/agentcore-adapter/dist/index.js");
  const agentCoreModule = path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  fs.writeFileSync(path.join(agentDir, "settings.json"), "{}");
  const script = `
    const http = require("node:http");
    const { configureAgentCoreHttpNetworking } = require(${JSON.stringify(adapterPath)});
    (async () => {
      const origins = [];
      let proxyHits = 0;
      const proxy = http.createServer((request, response) => {
        proxyHits += 1;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ path: request.url, method: request.method }));
      });
      const unavailableProxy = http.createServer();
      const direct = http.createServer((_request, response) => response.end("direct"));
      await new Promise((resolve) => unavailableProxy.listen(0, "127.0.0.1", resolve));
      const unavailableAddress = unavailableProxy.address();
      await new Promise((resolve) => unavailableProxy.close(resolve));
      await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
      await new Promise((resolve) => direct.listen(0, "127.0.0.1", resolve));
      const address = proxy.address();
      const directAddress = direct.address();
      await configureAgentCoreHttpNetworking({
        resolveSystemProxy: async (origin) => {
          origins.push(origin);
          return "PROXY 127.0.0.1:" + unavailableAddress.port + "; PROXY 127.0.0.1:" + address.port + "; DIRECT";
        },
      });
      const response = await fetch("http://pfsaa-proxy-target.invalid/token", { method: "POST", body: "code=test" });
      const result = await response.json();
      process.env.NO_PROXY = "127.0.0.1";
      const directResult = await fetch("http://127.0.0.1:" + directAddress.port + "/health").then((value) => value.text());
      await new Promise((resolve) => proxy.close(resolve));
      await new Promise((resolve) => direct.close(resolve));
      process.stdout.write(JSON.stringify({ origins, path: result.path, method: result.method, proxyHits, directResult }));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const environment = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PFSAA_RUNTIME_MODULE: agentCoreModule,
    PFSAA_USE_SYSTEM_PROXY: "1",
  };
  for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]) delete environment[key];
  try {
    const output = execFileSync(process.execPath, ["-e", script], { encoding: "utf8", env: environment });
    assert.deepEqual(JSON.parse(output), {
      origins: ["http://pfsaa-proxy-target.invalid/token"],
      path: "http://pfsaa-proxy-target.invalid/token",
      method: "POST",
      proxyHits: 1,
      directResult: "direct",
    });
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a cancelled Provider OAuth login can start a fresh attempt", async () => {
  const root = path.join(__dirname, "../../..");
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-oauth-cancel-"));
  const child = fork(path.join(root, "packages/pfsaa-host/dist/index.js"), [], {
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PFSAA_HOST_PROCESS: "1",
      PFSAA_RUNTIME_MODULE: path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  let stderr = "";
  let phase = "starting";
  let firstLoginRejected = false;
  let firstCancelResolved = false;
  let secondLoginRejected = false;
  let secondCancelResolved = false;
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`OAuth cancellation regression timed out${stderr ? `\n${stderr.trim()}` : ""}`)), 20_000);
      const fail = (error) => { clearTimeout(timer); reject(error); };
      const maybeStartSecondAttempt = () => {
        if (!firstLoginRejected || !firstCancelResolved || phase !== "cancelling-first") return;
        phase = "waiting-second-prompt";
        child.send({ id: "oauth-login-2", command: "providers.login", payload: { providerId: "openai-codex", method: "oauth", authOperationId: "oauth-operation-2" } });
      };
      const maybeFinish = () => {
        if (!secondLoginRejected || !secondCancelResolved) return;
        clearTimeout(timer);
        resolve();
      };

      child.once("error", fail);
      child.once("exit", (code, signal) => {
        if (phase !== "complete") fail(new Error(`PfsaaHost exited during OAuth cancellation regression (code ${code ?? "null"}, signal ${signal ?? "none"})${stderr ? `\n${stderr.trim()}` : ""}`));
      });
      child.on("message", (message) => {
        if (message?.type === "proxy.resolve") {
          child.send({ type: "proxy.resolve-result", requestId: message.requestId, rules: "DIRECT" });
          return;
        }
        if (message?.type === "runtime.status" && message.payload === "connected" && phase === "starting") {
          phase = "waiting-first-prompt";
          child.send({ id: "oauth-login-1", command: "providers.login", payload: { providerId: "openai-codex", method: "oauth", authOperationId: "oauth-operation-1" } });
          return;
        }
        if (message?.type === "auth.event" && message.requestId === "oauth-operation-1:1" && phase === "waiting-first-prompt") {
          phase = "cancelling-first";
          child.send({ id: "oauth-cancel-1", command: "providers.cancelLogin", payload: { authOperationId: "oauth-operation-1" } });
          return;
        }
        if (message?.id === "oauth-cancel-1") {
          if (!message.ok) { fail(new Error(`First OAuth cancellation failed: ${message.error ?? "unknown error"}`)); return; }
          firstCancelResolved = true;
          maybeStartSecondAttempt();
          return;
        }
        if (message?.id === "oauth-login-1") {
          if (message.ok || !String(message.error ?? "").includes("Authentication cancelled")) { fail(new Error(`First OAuth login was not cancelled: ${JSON.stringify(message)}`)); return; }
          firstLoginRejected = true;
          maybeStartSecondAttempt();
          return;
        }
        if (message?.type === "auth.event" && message.requestId === "oauth-operation-2:1" && phase === "waiting-second-prompt") {
          phase = "cancelling-second";
          child.send({ id: "oauth-cancel-2", command: "providers.cancelLogin", payload: { authOperationId: "oauth-operation-2" } });
          return;
        }
        if (message?.id === "oauth-cancel-2") {
          if (!message.ok) { fail(new Error(`Second OAuth cancellation failed: ${message.error ?? "unknown error"}`)); return; }
          secondCancelResolved = true;
          maybeFinish();
          return;
        }
        if (message?.id === "oauth-login-2") {
          if (message.ok || !String(message.error ?? "").includes("Authentication cancelled")) { fail(new Error(`Second OAuth login was not cancelled: ${JSON.stringify(message)}`)); return; }
          secondLoginRejected = true;
          maybeFinish();
        }
      });
    });
    phase = "complete";
  } finally {
    child.kill();
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a stale queue request cannot overwrite the newly selected task", async () => {
  const first = deferred();
  const second = deferred();
  const committed = [];
  let firstIsCurrent = true;

  const firstLoad = loadQueueForCurrentTask({
    load: () => first.promise,
    isCurrent: () => firstIsCurrent,
    onLoaded: (queue) => committed.push(queue.taskId),
    onError: (error) => { throw error; },
  });
  firstIsCurrent = false;
  const secondLoad = loadQueueForCurrentTask({
    load: () => second.promise,
    isCurrent: () => true,
    onLoaded: (queue) => committed.push(queue.taskId),
    onError: (error) => { throw error; },
  });

  second.resolve({ taskId: "task-b" });
  await secondLoad;
  first.resolve({ taskId: "task-a" });
  await firstLoad;

  assert.deepEqual(committed, ["task-b"]);
});

test("stale queue failures are ignored after task selection changes", async () => {
  const request = deferred();
  const errors = [];
  let current = true;
  const load = loadQueueForCurrentTask({
    load: () => request.promise,
    isCurrent: () => current,
    onLoaded: () => assert.fail("stale request must not commit"),
    onError: (error) => errors.push(error),
  });
  current = false;
  request.reject(new Error("old task failed"));
  await load;
  assert.deepEqual(errors, []);
});

test("IPC accepts only the active window main frame", () => {
  const mainFrame = {};
  const webContents = { mainFrame };
  const window = { isDestroyed: () => false, webContents };

  assert.doesNotThrow(() => assertTrustedIpcSender({ sender: webContents, senderFrame: mainFrame }, window));
  assert.throws(
    () => assertTrustedIpcSender({ sender: {}, senderFrame: mainFrame }, window),
    /untrusted renderer/,
  );
  assert.throws(
    () => assertTrustedIpcSender({ sender: webContents, senderFrame: {} }, window),
    /untrusted renderer/,
  );
  assert.throws(
    () => assertTrustedIpcSender({ sender: webContents, senderFrame: mainFrame }, { ...window, isDestroyed: () => true }),
    /untrusted renderer/,
  );
});

test("PfsaaHost networking startup failures reach the Renderer as sanitized runtime errors", () => {
  const contracts = fs.readFileSync(path.join(__dirname, "../../../packages/contracts/src/index.ts"), "utf8");
  const host = fs.readFileSync(path.join(__dirname, "../../../packages/pfsaa-host/src/index.ts"), "utf8");
  const runtimeEvents = fs.readFileSync(path.join(__dirname, "../src/renderer/use-runtime-events.ts"), "utf8");
  assert.match(contracts, /"runtime\.error"/);
  assert.match(host, /publicRuntimeError\(error\)/);
  assert.match(host, /type: "runtime\.error"/);
  assert.match(runtimeEvents, /runtimeEvent\.type === "runtime\.error"/);
  assert.match(runtimeEvents, /runtimeStartFailed/);
});

test("Electron renderer enforces CSP and rejects in-window navigation", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "../src/main/index.ts"), "utf8");
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /img-src 'self' data: blob:/);
  assert.doesNotMatch(html, /img-src[^;]*https:/);
  assert.doesNotMatch(html, /connect-src[^;]*wss?:/);
  assert.match(main, /webContents\.on\("will-navigate", \(event\) => event\.preventDefault\(\)\)/);
});

test("PfsaaHost lifecycle ignores events from a replaced process and waits for real IPC readiness", () => {
  const main = readText(path.join(__dirname, "../src/main/index.ts"));
  assert.match(main, /if \(host !== startedHost\) return;/);
  assert.match(main, /teardownHost\("PfsaaHost exited", startedHost\)/);
  assert.match(main, /await requestHost\("runtime\.status"\)/);
  assert.doesNotMatch(main, /setTimeout\(resolve, 50\)/);
});

test("PfsaaHost scopes same-ID session resources to their project", () => {
  const host = readText(path.join(__dirname, "../../../packages/pfsaa-host/src/index.ts"));
  assert.match(host, /function sessionStateKey\(taskId: string, cwd: string\)/);
  assert.match(host, /const stateKey = sessionStateKey\(payload\.taskId, cwd\);[\s\S]*?sessionFiles\.delete\(stateKey\)/);
  assert.match(host, /permissionEngine\.dispose\(stateKey\)/);
});

test("inactive conversation panes suspend observers and modal overlays isolate the shell", () => {
  const conversation = readText(path.join(__dirname, "../src/renderer/app-conversation.tsx"));
  const view = readText(path.join(__dirname, "../src/renderer/app-view.tsx"));
  const overlays = readText(path.join(__dirname, "../src/renderer/app-overlays.tsx"));
  const styles = readText(path.join(__dirname, "../src/renderer/styles.css"));
  assert.match(conversation, /if \(!active\) return;[\s\S]*?\}, \[active\]\);/);
  assert.match(view, /inert=\{modalOverlayOpen\}/);
  assert.match(view, /aria-hidden=\{modalOverlayOpen \|\| undefined\}/);
  assert.match(view, /settingsOpen, agentCoreSettingsOpen/);
  assert.match(view, /settingsOpen \|\| agentCoreSettingsOpen/);
  const shortcuts = fs.readFileSync(path.join(__dirname, "../src/renderer/use-global-shortcuts.ts"), "utf8");
  assert.match(shortcuts, /settingsOpen: boolean;\s*agentCoreSettingsOpen: boolean;/);
  assert.match(shortcuts, /settingsOpen \|\| agentCoreSettingsOpen/);
  assert.match(view, /backgroundInert=\{mobileSidebarOpen\}/);
  assert.match(overlays, /className=\{`overlay-root \$\{controller\.activeTaskUi\?\.extensionTheme\?\.appearance \?\? theme\}\$\{isMac \? " platform-macos" : " platform-overlay"\}`\}/);
  assert.match(styles, /\.app-shell, \.overlay-root \{[\s\S]*?--layer-modal: 40;/);
  assert.match(styles, /\.overlay-root \{\s*color: var\(--text\);\s*\}/);
  assert.match(styles, /\.app-shell\.dark, \.overlay-root\.dark \{/);
  assert.match(styles, /\.settings-backdrop \{[\s\S]*?top: var\(--titlebar-height\);/);
  assert.match(styles, /\.titlebar \{[\s\S]*?background: var\(--canvas\);/);
});

test("light and dark semantic text colors remain readable on primary surfaces", () => {
  const styles = readText(path.join(__dirname, "../src/renderer/styles.css"));
  const themes = [
    ["light", cssThemeTokens(styles, ".app-shell, .overlay-root")],
    ["dark", cssThemeTokens(styles, ".app-shell.dark, .overlay-root.dark")],
  ];
  const pairs = [
    ["--text", "--canvas"], ["--text", "--surface"],
    ["--muted", "--canvas"], ["--muted", "--surface"],
    ["--faint", "--canvas"], ["--faint", "--surface"],
    ["--green", "--surface"], ["--amber", "--surface"], ["--red", "--surface"],
    ["--accent-foreground", "--accent"],
  ];
  for (const [themeName, tokens] of themes) {
    for (const [foreground, background] of pairs) {
      assert.ok(tokens[foreground] && tokens[background], `${themeName} is missing ${foreground} or ${background}`);
      const ratio = contrastRatio(tokens[foreground], tokens[background]);
      assert.ok(ratio >= 4.5, `${themeName} ${foreground} on ${background} contrast ${ratio.toFixed(2)} is below 4.5:1`);
    }
  }
});

test("notifications preserve severity and use semantic theme surfaces", () => {
  const overlays = readText(path.join(__dirname, "../src/renderer/app-overlays.tsx"));
  const runtimeEvents = readText(path.join(__dirname, "../src/renderer/use-runtime-events.ts"));
  const notice = readText(path.join(__dirname, "../src/renderer/use-notice.ts"));
  const styles = readText(path.join(__dirname, "../src/renderer/styles.css"));
  assert.match(overlays, /toast toast-\$\{item\.kind\}/);
  assert.match(overlays, /item\.kind === "warning" \? t\.noticeWarning/);
  assert.match(overlays, /item\.kind === "info" \? "info" : "alert"/);
  assert.match(runtimeEvents, /level === "error" \|\| level === "warning"/);
  assert.match(runtimeEvents, /showNotice\(event\.message, noticeKind\(event\.level\)\)/);
  assert.match(runtimeEvents, /runtimeStartFailed[\s\S]*?, "error"\)/);
  assert.match(runtimeEvents, /model\.fallback[\s\S]*?showNotice\(event\.message, "warning"\)/);
  assert.match(runtimeEvents, /prompt_error[\s\S]*?showNotice\(event\.message, "error"\)/);
  assert.match(notice, /NoticeKind = "info" \| "warning" \| "error"/);
  assert.match(notice, /NOTICE_VISIBLE_MS = 8_000/);
  assert.match(notice, /if \(kind !== "error"\)/);
  assert.match(overlays, /<button className="toast-close"[\s\S]*?dismissNotice\(item\.id\)/);
  assert.doesNotMatch(overlays, /item\.kind === "error" && <button className="toast-close"/);
  assert.match(styles, /\.toast \{[\s\S]*?background: var\(--surface-raised\); color: var\(--text\);/);
  assert.match(styles, /\.toast\.toast-info \{/);
  assert.match(styles, /\.toast\.toast-warning \{/);
  assert.match(styles, /\.toast\.toast-error \{/);
  assert.doesNotMatch(styles, /\.toast \{[^}]*background: var\(--text\);[^}]*color: var\(--canvas\);/);
});

test("packaged AgentCore adapter paths are detected on macOS and Windows", () => {
  const macPath = "/Applications/PFSAA.app/Contents/Resources/app.asar/node_modules/@pfsaa/agentcore-adapter/dist";
  const windowsPath = "C:\\Program Files\\PFSAA\\resources\\app.asar\\node_modules\\@pfsaa\\agentcore-adapter\\dist";
  assert.equal(isPackagedAgentCoreAdapter(macPath), true);
  assert.equal(isPackagedAgentCoreAdapter(windowsPath), true);
  assert.equal(packagedAgentCoreNodeModules(macPath), "/Applications/PFSAA.app/Contents/Resources/app.asar/node_modules");
  assert.equal(packagedAgentCoreNodeModules(windowsPath)?.replaceAll("\\", "/"), "C:/Program Files/PFSAA/resources/app.asar/node_modules");
  assert.equal(isPackagedAgentCoreAdapter(path.join(__dirname, "../../../packages/agentcore-adapter/dist")), false);
});

test("AgentCore permission Extension is locked consistently across workspaces", () => {
  const root = path.join(__dirname, "../../..");
  const rootPackage = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const desktopPackage = JSON.parse(fs.readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const installed = JSON.parse(fs.readFileSync(path.join(root, "node_modules/@gotgenes/pi-permission-system/package.json"), "utf8"));

  assert.equal(rootPackage.dependencies["@gotgenes/pi-permission-system"], "^31.1.1");
  assert.equal(desktopPackage.dependencies["@gotgenes/pi-permission-system"], "^31.1.1");
  assert.equal(lock.packages["node_modules/@gotgenes/pi-permission-system"].version, "31.1.1");
  assert.equal(installed.version, "31.1.1");
  assert.equal(installed.exports["."].default, "./src/service.ts");
});

test("PFSAA repairs an escaped config newline and writes an explicit bash fallback", (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-permission-config-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  const configPath = path.join(agentDir, "extensions", "pi-permission-system", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ permission: { "*": "allow", bash: { rm: "deny" } }, yoloMode: false }, null, 2)}\\n`);
  execFileSync(process.execPath, ["-e", `const { PermissionEngine } = require(${JSON.stringify(path.join(__dirname, "../../../packages/permission-engine/dist/index.js"))}); new PermissionEngine({ emitApproval() {}, emitEvent() {} });`], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(config.permission.bash, { rm: "deny", "*": "allow" });
  assert.deepEqual(Object.keys(config.permission.bash), ["*", "rm"]);
});

test("permission mode preserves explicit bash policy and rejects malformed config without changing mode", (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-permission-config-"));
  t.after(() => fs.rmSync(agentDir, { recursive: true, force: true }));
  execFileSync(process.execPath, ["-e", `
    const assert = require("node:assert/strict");
    const fs = require("node:fs");
    const path = require("node:path");
    const { PermissionEngine } = require(${JSON.stringify(path.join(__dirname, "../../../packages/permission-engine/dist/index.js"))});
    const configPath = path.join(process.env.PI_CODING_AGENT_DIR, "extensions/pi-permission-system/config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    (async () => {
      for (const bash of ["deny", { "*": "deny", "git status": "allow" }]) {
        fs.writeFileSync(configPath, JSON.stringify({ permission: { "*": "ask", bash }, custom: true }));
        const engine = new PermissionEngine({ emitApproval() {}, emitEvent() {} });
        await engine.setMode("allow");
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        assert.deepEqual(config.permission.bash, bash);
        assert.equal(config.custom, true);
      }
      fs.writeFileSync(configPath, "{malformed");
      const engine = new PermissionEngine({ emitApproval() {}, emitEvent() {} });
      await assert.rejects(engine.setMode("allow"));
      assert.equal(engine.status().mode, "ask");
      assert.equal(engine.revision, 0);
      assert.equal(fs.readFileSync(configPath, "utf8"), "{malformed");
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
});

test("project-scoped IPC rejects unknown and prefix-confusable directories", () => {
  const known = ["D:\\work\\PFSAA"];
  assert.equal(
    assertKnownProjectCwd("d:\\WORK\\pfsaa", known, "win32"),
    path.resolve(known[0]),
  );
  assert.throws(
    () => assertKnownProjectCwd("D:\\work\\PFSAA-secret", known, "win32"),
    /not an open desktop project/,
  );
  assert.throws(
    () => assertKnownProjectCwd("D:\\work\\PFSAA\\..\\secret", known, "win32"),
    /not an open desktop project/,
  );
});

test("package manifest validation rejects developer state and source trees", async () => {
  const verifierUrl = pathToFileURL(path.join(__dirname, "../../../scripts/verify-package-contents.mjs")).href;
  const { validatePackagePaths } = await import(verifierUrl);
  const runtimePaths = [
    "/apps/desktop/dist/main/index.js",
    "/apps/desktop/dist/preload/index.js",
    "/packages/contracts/dist/index.js",
    "/packages/pfsaa-host/dist/index.js",
    "/dist-renderer/index.html",
    "/LICENSE",
    "/THIRD_PARTY_NOTICES.txt",
    "/node_modules/react/index.js",
  ];

  assert.deepEqual(validatePackagePaths(runtimePaths), { fileCount: 8, requiredCount: 7 });
  assert.throws(() => validatePackagePaths([...runtimePaths, "/.codex/session.json"]), /Forbidden development files/);
  assert.throws(() => validatePackagePaths([...runtimePaths, "/apps/desktop/src/main/index.ts"]), /Forbidden development files/);
  assert.throws(() => validatePackagePaths([...runtimePaths, "/node_modules/@pfsaa/agentcore-adapter/src/index.ts"]), /Forbidden development files/);
  assert.throws(() => validatePackagePaths([...runtimePaths, "/node_modules/@rolldown/binding-darwin-arm64/package.json"]), /Forbidden development files/);
});

test("packaged SBOM reports the lockfile-pinned Electron runtime as a framework", async () => {
  const generatorUrl = pathToFileURL(path.join(__dirname, "../../../scripts/generate-packaged-sbom.mjs")).href;
  const { electronRuntimeComponent, packageManifestEntries } = await import(generatorUrl);
  const root = path.join(__dirname, "../../..");
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const component = electronRuntimeComponent(root);

  assert.equal(component.type, "framework");
  assert.equal(component.name, "electron");
  assert.equal(component.version, lock.packages["node_modules/electron"].version);
  assert.equal(component.purl, `pkg:npm/electron@${component.version}`);
  assert.deepEqual(packageManifestEntries([
    "/package.json",
    "/node_modules/react/package.json",
    "\\node_modules\\zod\\package.json",
    "\\node_modules\\zod\\index.js",
  ]), [
    { extractPath: "package.json", normalizedPath: "package.json" },
    { extractPath: "node_modules/react/package.json", normalizedPath: "node_modules/react/package.json" },
    { extractPath: "node_modules\\zod\\package.json", normalizedPath: "node_modules/zod/package.json" },
  ]);
});

test("native window colors follow the Renderer theme contract", () => {
  assert.deepEqual(windowThemeColors("dark"), { background: "#1f1e1b", symbol: "#f3f0e8" });
  assert.deepEqual(windowThemeColors("light"), { background: "#f7f6f1", symbol: "#27251f" });
  const main = readText(path.join(__dirname, "../src/main/index.ts"));
  const theme = readText(path.join(__dirname, "../src/main/window-theme.ts"));
  assert.match(theme, /transparentTitleBarOverlay = "rgba\(0, 0, 0, 0\)"/);
  assert.match(main, /titleBarOverlay: \{ color: transparentTitleBarOverlay/);
  assert.match(main, /setTitleBarOverlay\(\{ color: transparentTitleBarOverlay/);
});

test("each platform package target inherits the runtime whitelist", () => {
  const config = require("../../../electron-builder.config.cjs");
  assert.equal(config.afterExtract, copyElectronRuntimeLicenses);
  for (const target of [config.win.files, config.mac.files]) {
    assert.ok(target.includes("apps/desktop/dist/**/*"));
    assert.ok(target.includes("packages/contracts/dist/**/*"));
    assert.ok(target.includes("packages/pfsaa-host/dist/**/*"));
    assert.ok(target.includes("LICENSE"));
    assert.ok(target.includes("THIRD_PARTY_NOTICES.txt"));
    assert.ok(target.includes("!apps/desktop/src/**/*"));
    assert.equal(target.includes("node_modules/**/*"), false);
  }
});

test("Electron runtime licenses are copied from the extracted distribution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-electron-licenses-"));
  try {
    const macOutDir = path.join(root, "mac");
    fs.mkdirSync(path.join(macOutDir, "Electron.app", "Contents", "Resources"), { recursive: true });
    fs.writeFileSync(path.join(macOutDir, "LICENSE"), "electron-mac-license");
    fs.writeFileSync(path.join(macOutDir, "LICENSES.chromium.html"), "chromium-mac-licenses");
    await copyElectronRuntimeLicenses({
      appOutDir: macOutDir,
      electronPlatformName: "darwin",
      packager: { info: { framework: { distMacOsAppName: "Electron.app" } } },
    });
    assert.equal(
      fs.readFileSync(path.join(macOutDir, "Electron.app", "Contents", "Resources", "LICENSE.electron.txt"), "utf8"),
      "electron-mac-license",
    );
    assert.equal(
      fs.readFileSync(path.join(macOutDir, "Electron.app", "Contents", "Resources", "LICENSES.chromium.html"), "utf8"),
      "chromium-mac-licenses",
    );

    const winOutDir = path.join(root, "win");
    fs.mkdirSync(path.join(winOutDir, "resources"), { recursive: true });
    fs.writeFileSync(path.join(winOutDir, "LICENSE.electron.txt"), "electron-win-license");
    fs.writeFileSync(path.join(winOutDir, "LICENSES.chromium.html"), "chromium-win-licenses");
    await copyElectronRuntimeLicenses({ appOutDir: winOutDir, electronPlatformName: "win32" });
    assert.equal(
      fs.readFileSync(path.join(winOutDir, "resources", "LICENSE.electron.txt"), "utf8"),
      "electron-win-license",
    );
    assert.equal(
      fs.readFileSync(path.join(winOutDir, "resources", "LICENSES.chromium.html"), "utf8"),
      "chromium-win-licenses",
    );

    const incompleteOutDir = path.join(root, "incomplete");
    fs.mkdirSync(path.join(incompleteOutDir, "resources"), { recursive: true });
    await assert.rejects(
      copyElectronRuntimeLicenses({ appOutDir: incompleteOutDir, electronPlatformName: "win32" }),
      /Missing Electron runtime license after extraction/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release package names identify the operating system and architecture", () => {
  const config = require("../../../electron-builder.config.cjs");
  assert.equal(config.win.artifactName, "${productName}-${version}-windows-${arch}-setup.${ext}");
  assert.equal(config.mac.artifactName, "${productName}-${version}-macos-${arch}.${ext}");
  assert.equal(config.mac.identity, null, "unsigned builds must not discover a local signing identity");
  assert.equal(config.mac.hardenedRuntime, false);
});

test("release workflow builds both macOS architectures and Windows x64", () => {
  const workflow = readText(path.join(__dirname, "../../../.github/workflows/release.yml"));

  assert.match(workflow, /runner: macos-15\n\s+arch: arm64/);
  assert.match(workflow, /runner: macos-15-intel\n\s+arch: x64/);
  assert.match(workflow, /runs-on: windows-2025/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /gh release create[\s\S]*?--draft/);
  assert.match(workflow, /ref: refs\/tags\//);
  assert.match(workflow, /git merge-base --is-ancestor/);
  assert.match(workflow, /environment: release-signing/);
  assert.match(workflow, /npm run sbom:package/);
  assert.match(workflow, /pfsaa-sbom-macos-arm64\.cdx\.json/);
  assert.match(workflow, /pfsaa-sbom-macos-x64\.cdx\.json/);
  assert.match(workflow, /pfsaa-sbom-windows-x64\.cdx\.json/);
  assert.match(workflow, /Smoke packaged PfsaaHost and bundled AgentCore SDK/);
  assert.match(
    workflow,
    /- name: Attest release artifacts\n\s+if: github\.event\.repository\.private == false\n\s+uses: actions\/attest-build-provenance@[0-9a-f]{40}/,
  );
  assert.match(workflow, /artifact-metadata: write/);
  assert.equal(workflow.match(/--publish never/g)?.length, 2);
  assert.doesNotMatch(workflow, /\n[ ]{4}env:\n[ ]{6}CSC_LINK:/, "signing secrets must not be job-scoped");
  assert.match(workflow, /- name: Build installer\n[\s\S]*?env:\n\s+CSC_LINK:/);
  assert.doesNotMatch(workflow, /uses: actions\/(?:checkout|setup-node|upload-artifact|download-artifact)@v\d/);
});

test("all GitHub workflows pin third-party actions and limit default permissions", () => {
  const workflowDirectory = path.join(__dirname, "../../../.github/workflows");
  for (const filename of fs.readdirSync(workflowDirectory).filter((entry) => entry.endsWith(".yml"))) {
    const workflow = readText(path.join(workflowDirectory, filename));
    for (const match of workflow.matchAll(/uses:\s+([^\s@]+)@([^\s#]+)/g)) {
      if (match[1].startsWith("./")) continue;
      assert.match(match[2], /^[0-9a-f]{40}$/, `${filename} must pin ${match[1]} to a full commit SHA`);
    }
    assert.match(workflow, /^permissions:\n\s+contents: read/m, `${filename} must declare read-only default permissions`);
  }
});

test("signed macOS packages allow AgentCore's external native modules", () => {
  const entitlements = fs.readFileSync(
    path.join(__dirname, "../entitlements.mac.plist"),
    "utf8",
  );

  assert.match(entitlements, /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\/>/);
});

test("AgentCore model summaries omit thinking levels explicitly disabled by the SDK", () => {
  const summary = modelSummary(
    { id: "provider", name: "Provider" },
    {
      id: "model",
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        xhigh: "high",
        max: null,
      },
    },
    true,
  );

  assert.deepEqual(summary.thinkingLevels, ["off", "low", "medium", "high", "xhigh"]);
});

test("AgentCore 0.85.1 applies project defaultTools including PowerShell when creating an AgentSession", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pfsaa-agentcore-settings-"));
  const projectDir = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ defaultTools: ["read", "bash"] }),
  );
  fs.writeFileSync(
    path.join(projectDir, ".pi", "settings.json"),
    JSON.stringify({ defaultTools: ["read", "grep", "powershell"] }),
  );

  try {
    const sdkUrl = pathToFileURL(path.join(
      __dirname,
      "../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    )).href;
    const { ModelRuntime, SessionManager, SettingsManager, createAgentSession } = await import(sdkUrl);
    const settings = SettingsManager.create(projectDir, agentDir);
    assert.deepEqual(settings.getDefaultTools(), ["read", "grep", "powershell"]);
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const { session } = await createAgentSession({
      cwd: projectDir,
      agentDir,
      modelRuntime,
      sessionManager: SessionManager.inMemory(projectDir),
    });
    assert.deepEqual(session.getActiveToolNames(), ["read", "grep", "powershell"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
