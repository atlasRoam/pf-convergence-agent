const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const React = require("react");
const { Window } = require("happy-dom");

function installDom() {
  const dom = new Window({ url: "http://localhost/" });
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "KeyboardEvent", "MouseEvent", "MutationObserver", "ResizeObserver", "getComputedStyle", "CSS"]) {
    if (key in dom) global[key] = dom[key];
  }
  global.requestAnimationFrame = dom.requestAnimationFrame.bind(dom);
  global.cancelAnimationFrame = dom.cancelAnimationFrame.bind(dom);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  return dom;
}

test("Session Tree dialog filters technical entries and supports keyboard node selection", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { SessionBranchDialog } = require("../dist/renderer/ui/session-branch-dialog.js");
  const navigations = [];
  const snapshot = {
    leafId: "a1",
    truncated: false,
    entries: [
      { id: "u1", parentId: null, type: "message", role: "user", preview: "Build it", depth: 0, childCount: 1, active: true, current: false, forkable: true },
      { id: "tool1", parentId: "u1", type: "message", role: "tool", preview: "tool output", depth: 1, childCount: 1, active: true, current: false, forkable: false },
      { id: "a1", parentId: "tool1", type: "message", role: "assistant", preview: "Done", depth: 2, childCount: 0, active: true, current: true, forkable: false },
    ],
  };
  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(SessionBranchDialog, {
    language: "en", mode: "tree", snapshot, loading: false, busy: false, error: null,
    onRetry() {}, onClose() {}, onAbort() {}, onFork() {}, onClone() {}, onNavigate: (...args) => navigations.push(args),
  })); await flushReact(); });
  assert.equal(dom.document.querySelectorAll('[role="treeitem"]').length, 2);
  const current = dom.document.querySelector('[aria-current="true"]');
  assert.equal(current.textContent.includes("Done"), true);
  assert.equal(dom.document.querySelector(".session-branch-footer .primary").disabled, true);
  const allEntries = [...dom.document.querySelectorAll(".session-branch-filter button")].find(button => button.textContent === "All events");
  await act(async () => allEntries.click());
  assert.equal(dom.document.querySelectorAll('[role="treeitem"]').length, 3);
  const first = dom.document.querySelector('[data-session-entry-id="u1"]');
  await act(async () => first.click());
  assert.equal(dom.document.querySelector(".session-branch-footer .primary").disabled, false);
  await act(async () => dom.document.querySelector(".session-branch-footer .primary").click());
  assert.deepEqual(navigations, [["u1", { summarize: false }]]);
  await act(async () => root.unmount());
  dom.close();
});

test("Session Tree honors AgentCore branchSummary.skipPrompt and navigates without a summary", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { SessionBranchDialog } = require("../dist/renderer/ui/session-branch-dialog.js");
  const navigations = [];
  const snapshot = {
    leafId: "current",
    truncated: false,
    entries: [
      { id: "target", parentId: null, type: "message", role: "user", preview: "Target", depth: 0, childCount: 1, active: false, current: false, forkable: true },
      { id: "current", parentId: "target", type: "message", role: "assistant", preview: "Current", depth: 1, childCount: 0, active: true, current: true, forkable: false },
    ],
  };
  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(SessionBranchDialog, {
    language: "en", mode: "tree", snapshot, skipSummaryPrompt: true, loading: false, busy: false, error: null,
    onRetry() {}, onClose() {}, onAbort() {}, onFork() {}, onClone() {}, onNavigate: (...args) => navigations.push(args),
  })); await flushReact(); });
  await act(async () => dom.document.querySelector('[data-session-entry-id="target"]').click());
  assert.equal(dom.document.querySelector('[data-summary-prompt-skipped="true"]')?.textContent.includes("skip the summary prompt"), true);
  assert.equal(dom.document.querySelector('.session-branch-summary-options'), null);
  await act(async () => dom.document.querySelector(".session-branch-footer .primary").click());
  assert.deepEqual(navigations, [["target", { summarize: false }]]);
  await act(async () => root.unmount());
  dom.close();
});

test("Session Tree keeps long linear conversations left-aligned and bounds mounted rows", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { SessionBranchDialog } = require("../dist/renderer/ui/session-branch-dialog.js");
  const entries = Array.from({ length: 401 }, (_, index) => ({
    id: `entry-${index}`,
    parentId: index ? `entry-${index - 1}` : null,
    type: "message",
    role: index % 2 ? "assistant" : "user",
    preview: `Message ${index}`,
    depth: index,
    childCount: index === 400 ? 0 : 1,
    active: true,
    current: index === 400,
    forkable: index % 2 === 0,
  }));
  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(SessionBranchDialog, {
    language: "en", mode: "tree", snapshot: { leafId: "entry-400", truncated: false, entries }, loading: false, busy: false, error: null,
    onRetry() {}, onClose() {}, onAbort() {}, onFork() {}, onClone() {}, onNavigate() {},
  })); await flushReact(); });
  const rows = [...dom.document.querySelectorAll(".session-branch-row")];
  assert.equal(rows.length, 81);
  assert.equal(rows.every(row => row.dataset.treeLane === "0" && row.getAttribute("aria-level") === "1"), true);
  assert.equal(dom.document.querySelector(".session-branch-pagination span").textContent, "321-401 / 401");
  const previous = dom.document.querySelector(".session-branch-pagination button:first-child");
  await act(async () => { previous.click(); await flushReact(); });
  assert.equal(dom.document.querySelectorAll(".session-branch-row").length, 160);
  assert.equal(dom.document.querySelector(".session-branch-pagination span").textContent, "161-320 / 401");
  await act(async () => root.unmount());
  dom.close();
});

async function flushReact() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("Provider settings distinguish external auth and retain a logout failure in its confirmation dialog", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { ProviderSettings } = require("../dist/renderer/ui/provider-settings.js");
  const externalProvider = {
    id: "external-provider", name: "External Provider", authState: "configured", authSource: "environment",
    hasStoredCredential: false, authMethods: ["api-key"], modelCount: 1,
  };
  const storedProvider = {
    id: "stored-provider", name: "Stored Provider", authState: "configured", authSource: "stored",
    hasStoredCredential: true, authMethods: ["api-key"], modelCount: 1,
  };
  let logoutCalls = 0;
  dom.window.pfsaa = {
    events: { subscribe: () => () => undefined },
    providers: {
      list: async () => [externalProvider, storedProvider],
      logout: async () => { logoutCalls += 1; throw new Error("Credential storage is unavailable"); },
      cancelLogin: async () => undefined,
      resolveAuth: async () => undefined,
      setApiKey: async () => undefined,
      login: async () => undefined,
      openAuthUrl: async () => undefined,
    },
  };
  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(ProviderSettings, {
    language: "en", focusProviderId: null, onClose() {}, onModelsRefresh: async () => undefined,
  })); await flushReact(); await flushReact(); });
  const externalRow = dom.document.querySelector('[data-provider-id="external-provider"]');
  const storedRow = dom.document.querySelector('[data-provider-id="stored-provider"]');
  assert.match(externalRow.textContent, /Provided by environment/);
  assert.equal([...externalRow.querySelectorAll("button")].some((button) => button.textContent === "Remove auth"), false);
  assert.match(storedRow.textContent, /Locally stored credential/);
  const remove = [...storedRow.querySelectorAll("button")].find((button) => button.textContent === "Remove auth");
  await act(async () => { remove.click(); await flushReact(); });
  const prompt = dom.document.querySelector(".provider-logout-prompt");
  const confirm = [...prompt.querySelectorAll("button")].find((button) => button.textContent === "Remove auth");
  await act(async () => { confirm.click(); await flushReact(); await flushReact(); });
  assert.equal(logoutCalls, 1);
  assert.ok(dom.document.querySelector(".provider-logout-prompt"));
  assert.match(dom.document.querySelector(".provider-logout-prompt .inline-error").textContent, /Credential storage is unavailable/);
  await act(async () => root.unmount());
  dom.close();
});

test("Provider settings expose add and remove controls", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { ProviderSettings } = require("../dist/renderer/ui/provider-settings.js");
  const provider = {
    id: "built-in-provider", name: "Built-in Provider", authState: "missing", authSource: "none",
    hasStoredCredential: false, authMethods: ["api-key"], modelCount: 1, isCustom: false, isEditable: false,
  };
  dom.window.pfsaa = {
    events: { subscribe: () => () => undefined },
    providers: {
      list: async () => [provider],
      listHidden: async () => [],
      create: async () => provider,
      remove: async () => ({ providerId: provider.id, action: "hidden" }),
      restore: async () => undefined,
      logout: async () => undefined,
      cancelLogin: async () => undefined,
      resolveAuth: async () => undefined,
      setApiKey: async () => undefined,
      login: async () => undefined,
      openAuthUrl: async () => undefined,
    },
  };
  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(ProviderSettings, {
    language: "en", focusProviderId: null, onClose() {}, onModelsRefresh: async () => undefined,
  })); await flushReact(); await flushReact(); });
  const add = dom.document.querySelector(".provider-add-button");
  assert.equal(add.textContent, "Add provider");
  assert.ok(dom.document.querySelector('[aria-label="Remove provider"]'));
  assert.equal(dom.document.querySelector(".provider-edit-logo"), null);
  assert.equal(dom.document.querySelector(".provider-edit-name"), null);
  assert.equal(dom.document.querySelector(".provider-card .provider-logo").tagName, "DIV");
  assert.equal(dom.document.querySelector(".provider-card .provider-copy strong").textContent, provider.name);
  await act(async () => root.unmount());
  dom.close();
});

test("Provider form uses the same control font size for model ID and provider fields", () => {
  const css = fs.readFileSync(path.join(__dirname, "../src/renderer/styles.css"), "utf8");
  assert.match(css, /\.provider-create-prompt > label input, \.provider-model-entry input \{ font-size: var\(--font-size-label\); \}/);
});

test("custom Provider management discovers, selects, and saves multiple models", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { ProviderSettings } = require("../dist/renderer/ui/provider-settings.js");
  const provider = {
    id: "pfsaa-custom-gateway", name: "Custom gateway", authState: "configured", authSource: "stored",
    hasStoredCredential: true, authMethods: ["api-key"], modelCount: 1, isCustom: true, isEditable: true,
    baseUrl: "https://models.example.test/v1", models: [{ id: "old-model", name: "Old model" }],
  };
  let currentProvider = provider;
  let savedInput;
  let discoveryInput;
  dom.window.pfsaa = {
    events: { subscribe: () => () => undefined },
    providers: {
      list: async () => [currentProvider],
      listHidden: async () => [],
      discoverModels: async (input) => {
        discoveryInput = input;
        return [{ id: "old-model", name: "Old model" }, { id: "discovered-a", name: "Discovered A" }, { id: "discovered-b", name: "Discovered B" }];
      },
      create: async () => provider,
      update: async (input) => { savedInput = input; currentProvider = { ...currentProvider, name: input.name, models: input.models, modelCount: input.models.length }; return currentProvider; },
      remove: async () => ({ providerId: provider.id, action: "removed" }),
      restore: async () => undefined,
      logout: async () => undefined,
      cancelLogin: async () => undefined,
      resolveAuth: async () => undefined,
      setApiKey: async () => undefined,
      login: async () => undefined,
      openAuthUrl: async () => undefined,
    },
  };
  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(ProviderSettings, {
    language: "en", focusProviderId: null, onClose() {}, onModelsRefresh: async () => undefined,
  })); await flushReact(); await flushReact(); });
  const edit = [...dom.document.querySelectorAll(".provider-card button")].find((button) => button.textContent === "Edit");
  assert.ok(edit);
  const logo = dom.document.querySelector(".provider-edit-logo");
  const name = dom.document.querySelector(".provider-edit-name");
  assert.equal(logo.tagName, "BUTTON");
  assert.equal(name.tagName, "BUTTON");
  assert.equal(logo.getAttribute("aria-label"), "Edit provider Custom gateway");
  await act(async () => { logo.focus(); logo.click(); await flushReact(); });
  assert.equal(dom.document.querySelector(".provider-model-row small").textContent, "old-model");
  assert.equal(dom.document.querySelector("#provider-create-api-key").value, "");
  await act(async () => { dom.document.querySelector(".provider-editor-actions button[type=button]").click(); await flushReact(); });
  assert.equal(dom.document.activeElement === logo, true, "closing from the logo restores its focus");
  await act(async () => { name.focus(); name.click(); await flushReact(); });
  assert.ok(dom.document.querySelector(".provider-create-prompt"));
  await act(async () => { dom.document.querySelector(".provider-editor-actions button[type=button]").click(); await flushReact(); });
  assert.equal(dom.document.activeElement === name, true, "closing from the name restores its focus");
  await act(async () => { edit.focus(); edit.click(); await flushReact(); });
  const refresh = dom.document.querySelector(".provider-create-prompt .provider-model-editor-heading button");
  assert.equal(refresh.textContent, "Refresh model list");
  assert.equal(refresh.disabled, false);
  await act(async () => { refresh.click(); await flushReact(); });
  assert.equal(discoveryInput.providerId, provider.id);
  assert.equal(discoveryInput.baseUrl, provider.baseUrl);
  assert.equal(discoveryInput.apiKey, undefined);
  const discovered = [...dom.document.querySelectorAll(".provider-model-candidate")];
  assert.equal(discovered.length, 3);
  assert.equal(discovered[0].querySelector("input").disabled, true);
  assert.equal(discovered[0].textContent.includes("Configured"), true);
  await act(async () => { discovered[1].querySelector("input").click(); await flushReact(); });
  await act(async () => { dom.document.querySelector(".provider-discovery-results > button").click(); await flushReact(); });
  await act(async () => {
    const modelInput = dom.document.querySelector(".provider-model-entry input");
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(modelInput, "manual-model");
    modelInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await flushReact();
    dom.document.querySelector(".provider-model-entry button").click();
    await flushReact();
  });
  await act(async () => { dom.document.querySelector(".provider-editor-actions button[type=submit]").click(); await flushReact(); await flushReact(); });
  assert.equal(savedInput.providerId, provider.id);
  assert.deepEqual(savedInput.models.map((model) => model.id), ["old-model", "discovered-a", "manual-model"]);
  assert.equal(dom.document.querySelector(".provider-create-prompt"), null, "saving closes the editor");
  assert.equal(dom.document.activeElement === edit, true, "saving from Edit restores its focus");
  await act(async () => { name.focus(); name.click(); await flushReact(); });
  assert.deepEqual([...dom.document.querySelectorAll(".provider-model-row small")].map((row) => row.textContent), ["old-model", "discovered-a", "manual-model"]);
  await act(async () => { dom.document.querySelector(".provider-editor-actions button[type=button]").click(); await flushReact(); });
  await act(async () => root.unmount());
  dom.close();
});

test("existing models.json Provider edits through its name without acquiring deletion ownership", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { ProviderSettings } = require("../dist/renderer/ui/provider-settings.js");
  let current = {
    id: "local-gateway-a", name: "Local gateway A", authState: "configured", authSource: "models-json",
    hasStoredCredential: false, authMethods: ["api-key"], modelCount: 1,
    isCustom: false, isEditable: true, baseUrl: "https://local.example/v1", models: [{ id: "old-model", name: "Old model" }],
  };
  const second = { ...current, id: "local-gateway-b", name: "Local gateway B" };
  let saved;
  let probed;
  dom.window.pfsaa = {
    events: { subscribe: () => () => undefined },
    providers: {
      list: async () => [current, second], listHidden: async () => [],
      discoverModels: async (input) => { probed = input; return [{ id: "new-model", name: "New model" }]; },
      update: async (input) => { saved = input; current = { ...current, models: input.models, modelCount: input.models.length }; return current; },
      remove: async () => ({ providerId: current.id, action: "hidden" }),
    },
  };
  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(ProviderSettings, {
    language: "en", focusProviderId: null, onClose() {}, onModelsRefresh: async () => undefined,
  })); await flushReact(); await flushReact(); });
  const name = dom.document.querySelector(".provider-edit-name");
  assert.equal(name.textContent, "Local gateway A");
  await act(async () => { name.click(); await flushReact(); });
  const refresh = dom.document.querySelector(".provider-model-editor-heading button");
  await act(async () => { refresh.click(); await flushReact(); });
  assert.equal(probed.providerId, "local-gateway-a");
  await act(async () => { dom.document.querySelector(".provider-model-candidate input").click(); await flushReact(); });
  await act(async () => { dom.document.querySelector(".provider-discovery-results > button").click(); await flushReact(); });
  await act(async () => { dom.document.querySelector(".provider-editor-actions button[type=submit]").click(); await flushReact(); await flushReact(); });
  assert.deepEqual(saved.models.map((model) => model.id), ["old-model", "new-model"]);
  assert.equal(dom.document.querySelector(".provider-create-prompt"), null);
  assert.equal(dom.document.querySelector(".provider-edit-name")?.textContent, "Local gateway A");
  assert.equal(current.isCustom, false);
  const secondName = dom.document.querySelector('[data-provider-id="local-gateway-b"] .provider-edit-name');
  assert.equal(secondName?.textContent, "Local gateway B");
  await act(async () => { secondName.click(); await flushReact(); });
  assert.equal(dom.document.querySelector("#provider-create-title")?.textContent, "Edit provider");
  await act(async () => { dom.document.querySelector(".provider-editor-actions button[type=button]").click(); await flushReact(); });
  await act(async () => root.unmount());
  dom.close();
});

test("Provider removal keeps its focus trap valid while the operation is pending", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { ProviderSettings } = require("../dist/renderer/ui/provider-settings.js");
  const provider = {
    id: "external-provider", name: "External Provider", authState: "missing", authSource: "none",
    hasStoredCredential: false, authMethods: [], modelCount: 1, isCustom: false,
  };
  let visible = true;
  let completeRemoval;
  dom.window.pfsaa = {
    events: { subscribe: () => () => undefined },
    providers: {
      list: async () => visible ? [provider] : [],
      listHidden: async () => [],
      create: async () => provider,
      remove: () => new Promise((resolve) => { completeRemoval = () => { visible = false; resolve({ providerId: provider.id, action: "hidden" }); }; }),
      restore: async () => undefined,
      logout: async () => undefined,
      cancelLogin: async () => undefined,
      resolveAuth: async () => undefined,
      setApiKey: async () => undefined,
      login: async () => undefined,
      openAuthUrl: async () => undefined,
    },
  };
  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(ProviderSettings, {
    language: "en", focusProviderId: null, onClose() {}, onModelsRefresh: async () => undefined,
  })); await flushReact(); await flushReact(); });
  const removeButton = dom.document.querySelector('[aria-label="Remove provider"]');
  await act(async () => { removeButton.click(); await flushReact(); });
  const prompt = dom.document.querySelector(".provider-logout-prompt");
  const confirm = [...prompt.querySelectorAll("button")].find((button) => button.textContent === "Remove provider");
  await act(async () => { confirm.click(); await flushReact(); });
  assert.equal([...prompt.querySelectorAll("button")].every((button) => button.disabled), true);
  await act(async () => { completeRemoval(); await flushReact(); await flushReact(); });
  assert.equal(dom.document.querySelector(".provider-logout-prompt"), null);
  await act(async () => root.unmount());
  dom.close();
});

test("composer highlights recalled Skill and every registered slash command as command tokens", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { highlightComposerText } = require("../dist/renderer/ui/composer.js");
  const root = createRoot(dom.document.body);
  await act(async () => root.render(React.createElement("div", null,
    ...highlightComposerText("/skill:review fix /compact now /permission-system strict", ["compact", "permission-system"]),
  )));
  assert.deepEqual([...dom.document.querySelectorAll("mark")].map((mark) => [mark.textContent, mark.className]), [
    ["/skill:review", "composer-token skill-token"],
    ["/compact", "composer-token command-token"],
    ["/permission-system", "composer-token command-token"],
  ]);
  await act(async () => root.unmount());
  dom.close();
});


test("Windows menu buttons retain edit selection, support keyboard navigation, and recover after errors", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { ApplicationMenu } = require("../dist/renderer/ui/application-menu.js");
  const errors = [];
  const calls = [];
  let closeMenu;
  dom.window.pfsaa = { app: { popupMenu: (request) => { calls.push(request); return new Promise((resolve) => { closeMenu = resolve; }); } } };
  const root = createRoot(dom.document.body);
  await act(async () => root.render(React.createElement(React.Fragment, null,
    React.createElement("textarea", { defaultValue: "keep this selection" }),
    React.createElement(ApplicationMenu, { language: "zh", onError: (error) => errors.push(error) }))));
  const input = dom.document.querySelector("textarea");
  const buttons = [...dom.document.querySelectorAll('[role="menuitem"]')];
  assert.deepEqual(buttons.map((button) => button.textContent), ["编辑", "查看", "帮助"]);
  input.focus();
  input.setSelectionRange(0, 4);
  const down = new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, detail: 1 });
  buttons[0].dispatchEvent(down);
  assert.equal(down.defaultPrevented, true);
  await act(async () => buttons[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 })));
  assert.equal(calls[0].menu, "edit");
  assert.equal(dom.document.activeElement, input);
  assert.equal(input.selectionEnd, 4);
  assert.equal(buttons[0].getAttribute("aria-expanded"), "true");
  await act(async () => buttons[0].click());
  assert.equal(calls.length, 1);
  await act(async () => closeMenu());
  await act(async () => buttons[0].focus());
  await act(async () => buttons[0].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
  assert.equal(dom.document.activeElement, buttons[1]);
  await act(async () => buttons[1].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  assert.equal(dom.document.activeElement, input);
  assert.equal(calls[1].menu, "view");
  await act(async () => closeMenu());
  assert.equal(dom.document.activeElement, buttons[1]);
  assert.equal(buttons[1].getAttribute("aria-expanded"), "false");
  const compact = dom.document.querySelector(".application-menu-compact");
  await act(async () => compact.click());
  assert.equal(calls[2].menu, "all");
  await act(async () => closeMenu());
  dom.window.pfsaa.app.popupMenu = async () => { throw new Error("unavailable"); };
  await act(async () => buttons[0].click());
  assert.match(errors[0], /请重试/);
  assert.equal(buttons[0].getAttribute("aria-expanded"), "false");
  await act(async () => root.unmount());
  dom.close();
});

test("AgentCore Settings modal blocks global shortcuts while it is open", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { useGlobalShortcuts } = require("../dist/renderer/use-global-shortcuts.js");
  let commandCalls = 0;
  let createCalls = 0;
  let settingsCalls = 0;
  function Probe({ agentCoreSettingsOpen = false, quickSettingsOpen = false, packagesOpen = false, extensionUiOpen = false }) {
    useGlobalShortcuts({
      searchInputRef: { current: null },
      settingsOpen: false,
      agentCoreSettingsOpen,
      quickSettingsOpen,
      packagesOpen,
      extensionUiOpen,
      commandDialogOpen: false,
      renameOpen: false,
      resumeOpen: false,
      trustOpen: false,
      scopedModelsOpen: false,
      pendingDelete: false,
      pendingProjectRemove: false,
      previewImage: false,
      thinkingMenuOpen: false,
      modelMenuOpen: false,
      suggestionMode: null,
      contextMenu: false,
      projectContextMenu: false,
      imageContextMenu: false,
      onAgentCoreCommands: () => { commandCalls += 1; },
      onQuickSettings: () => { settingsCalls += 1; },
      onCreateTask: () => { createCalls += 1; },
      onCloseMenus: () => undefined,
    });
    return React.createElement("button", { type: "button" }, "probe");
  }
  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(Probe, { agentCoreSettingsOpen: true })); });
  dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
  dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "n", ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(commandCalls, 0);
  assert.equal(createCalls, 0);
  for (const overlay of ["quickSettingsOpen", "packagesOpen", "extensionUiOpen"]) {
    await act(async () => { root.render(React.createElement(Probe, { [overlay]: true })); });
    for (const key of ["k", "n", ","]) dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(createCalls, 0);
    assert.equal(commandCalls, 0);
    assert.equal(settingsCalls, 0);
  }
  await act(async () => { root.render(React.createElement(Probe, { agentCoreSettingsOpen: false })); });
  dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(commandCalls, 1);
  dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(settingsCalls, 1);
  await act(async () => { root.unmount(); });
  dom.close();
});

test("AgentCore Settings can save non-model defaults before a model is configured", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { AgentCoreSettings } = require("../dist/renderer/ui/agentcore-settings.js");
  const saved = [];
  let chooseCalls = 0;
  const initialSettings = { defaultThinkingLevel: "medium", transport: "auto", compactionEnabled: true, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", effectiveExternalEditor: "notepad", externalEditorSource: "default" };
  global.window.pfsaa = {
    settings: {
      get: async () => initialSettings,
      update: async (value) => { saved.push(value); return { ...initialSettings, ...value }; },
      chooseExternalEditor: async () => { chooseCalls += 1; return '"C:\\Program Files\\Editor\\Editor.exe"'; },
    },
  };
  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(AgentCoreSettings, { language: "en", cwd: "", models: [], onClose: () => undefined, onNotice: () => undefined })); });
  await act(flushReact);
  const save = dom.document.querySelector('[data-testid="agentcore-settings-save"]');
  assert.ok(save);
  assert.equal(save.disabled, false);
  assert.equal(dom.document.querySelector('[data-testid="agentcore-external-editor"]'), null);
  const customMode = dom.document.querySelector('[data-testid="agentcore-external-editor-custom"]');
  assert.ok(customMode);
  await act(async () => { customMode.click(); });
  const editor = dom.document.querySelector('[data-testid="agentcore-external-editor"]');
  const choose = dom.document.querySelector('[data-testid="agentcore-external-editor-choose"]');
  assert.ok(editor);
  assert.ok(choose);
  assert.equal(save.disabled, true);
  assert.match(dom.document.querySelector("#agentcore-external-editor-status").textContent, /notepad/i);
  await act(async () => { choose.click(); await flushReact(); });
  assert.equal(chooseCalls, 1);
  assert.equal(editor.value, '"C:\\Program Files\\Editor\\Editor.exe"');
  assert.equal(save.disabled, false);
  await act(async () => { save.click(); await flushReact(); });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].externalEditor, '"C:\\Program Files\\Editor\\Editor.exe"');
  assert.equal("effectiveExternalEditor" in saved[0], false);
  assert.equal("externalEditorSource" in saved[0], false);
  await act(async () => { root.unmount(); });
  dom.close();
});

test("AgentCore Settings exposes non-display AgentCore runtime settings and round-trips them", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { AgentCoreSettings } = require("../dist/renderer/ui/agentcore-settings.js");
  const saved = [];
  const initialSettings = {
    defaultThinkingLevel: "medium", transport: "auto", compactionEnabled: true,
    steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", effectiveExternalEditor: "notepad", externalEditorSource: "default",
    retryEnabled: true, retryMaxRetries: 3, retryBaseDelayMs: 2000, compactionReserveTokens: 16384,
    compactionKeepRecentTokens: 20000, httpIdleTimeoutMs: 300000, branchSummaryReserveTokens: 16384, branchSummarySkipPrompt: false,
    providerRetryMaxRetries: 0, providerRetryMaxRetryDelayMs: 60000, websocketConnectTimeoutMs: 15000,
    defaultProjectTrust: "ask", enableSkillCommands: true, imageAutoResize: true, blockImages: false,
    enableInstallTelemetry: true,
  };
  global.window.pfsaa = { settings: {
    get: async () => initialSettings,
    update: async (value) => { saved.push(value); return { ...initialSettings, ...value }; },
    chooseExternalEditor: async () => null,
  } };
  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(AgentCoreSettings, { language: "en", cwd: "", models: [], onClose: () => undefined, onNotice: () => undefined })); });
  await act(flushReact);
  assert.equal(dom.document.querySelectorAll("select").length, 0);
  assert.equal(dom.document.querySelector('[data-testid="agentcore-defaultModel"] span').textContent, "Choose model");
  assert.ok(dom.document.querySelector('[data-testid="agentcore-defaultThinking"]')?.closest("label")?.querySelector("small"));
  assert.ok(dom.document.querySelector('[data-testid="agentcore-advanced-settings"] .agentcore-settings-hint'));
  const transport = dom.document.querySelector('[data-testid="agentcore-transport"]');
  assert.ok(transport);
  await act(async () => {
    transport.click();
    await flushReact();
    const menu = dom.document.getElementById(transport.getAttribute("aria-controls"));
    assert.ok(menu);
    menu.querySelector('[role="option"][data-value="websocket-cached"]').click();
    for (const id of ["agentcore-blockImages", "agentcore-enableSkillCommands"]) dom.document.querySelector(`[data-testid="${id}"]`).click();
    dom.document.querySelector('[data-testid="agentcore-branchSummarySkipPrompt"]').click();
    assert.ok(dom.document.querySelector('[data-testid="agentcore-providerRetryTimeoutMs"]'));
    assert.ok(dom.document.querySelector('[data-testid="agentcore-npmCommand"]'));
    await flushReact();
  });
  await act(async () => { dom.document.querySelector('[data-testid="agentcore-settings-save"]').click(); await flushReact(); });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].transport, "websocket-cached");
  assert.equal(saved[0].blockImages, true);
  assert.equal(saved[0].enableSkillCommands, false);
  assert.equal(saved[0].branchSummarySkipPrompt, true);
  for (const id of ["agentcore-hideThinkingBlock", "agentcore-showCacheMissNotices", "agentcore-warningsAnthropicExtraUsage", "agentcore-enableAnalytics"]) {
    assert.equal(dom.document.querySelector(`[data-testid="${id}"]`), null);
  }
  await act(async () => { root.unmount(); });
  dom.close();
});

test("AgentCore Settings derives default thinking options from the selected AgentCore model", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { AgentCoreSettings } = require("../dist/renderer/ui/agentcore-settings.js");
  const settings = { defaultProvider: "openai", defaultModel: "gpt-test", defaultThinkingLevel: "high", transport: "auto", compactionEnabled: true, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", effectiveExternalEditor: "notepad", externalEditorSource: "default" };
  global.window.pfsaa = { settings: {
    get: async () => settings,
    update: async (value) => ({ ...settings, ...value }),
    chooseExternalEditor: async () => null,
  } };
  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(AgentCoreSettings, {
    language: "en",
    cwd: "",
    models: [{ id: "gpt-test", providerId: "openai", providerName: "OpenAI", name: "GPT Test", reasoning: true, thinkingLevels: ["off", "high", "max"], authConfigured: true }],
    onClose: () => undefined,
    onNotice: () => undefined,
  })); });
  await act(flushReact);
  const thinking = dom.document.querySelector('[data-testid="agentcore-defaultThinking"]');
  assert.ok(thinking);
  await act(async () => { thinking.click(); await flushReact(); });
  const thinkingMenu = dom.document.getElementById(thinking.getAttribute("aria-controls"));
  assert.ok(thinkingMenu);
  assert.deepEqual([...thinkingMenu.querySelectorAll('[role="option"]')].map((option) => option.dataset.value), ["off", "high", "max"]);
  await act(async () => { root.unmount(); });
  dom.close();
});

test("AgentCore Settings keeps a portaled select inside the dialog focus boundary", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { AgentCoreSettings } = require("../dist/renderer/ui/agentcore-settings.js");
  const settings = { defaultProvider: "openai", defaultModel: "gpt-test", defaultThinkingLevel: "medium", transport: "auto", compactionEnabled: true, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", effectiveExternalEditor: "notepad", externalEditorSource: "default" };
  global.window.pfsaa = { settings: { get: async () => settings, update: async (value) => ({ ...settings, ...value }), chooseExternalEditor: async () => null } };
  const root = createRoot(dom.document.body);
  await act(async () => root.render(React.createElement("div", { className: "overlay-root" }, React.createElement(AgentCoreSettings, {
    language: "en", cwd: "", models: [{ id: "gpt-test", providerId: "openai", providerName: "OpenAI", name: "GPT Test", reasoning: true, thinkingLevels: ["off", "medium", "high"], authConfigured: true }], onClose: () => undefined, onNotice: () => undefined,
  }))));
  await act(flushReact);
  const thinking = dom.document.querySelector('[data-testid="agentcore-defaultThinking"]');
  await act(async () => { thinking.click(); await flushReact(); });
  const menu = dom.document.getElementById(thinking.getAttribute("aria-controls"));
  assert.ok(menu);
  assert.equal(menu.closest('[role="dialog"]')?.classList.contains("agentcore-settings"), true);
  assert.equal(dom.document.activeElement?.getAttribute("role"), "option");
  await act(async () => root.unmount());
  dom.close();
});

test("AgentCore Settings edits per-model Thinking overrides and sends null to inherit", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { AgentCoreSettings } = require("../dist/renderer/ui/agentcore-settings.js");
  const saved = [];
  const settings = {
    defaultProvider: "openai",
    defaultModel: "gpt-test",
    defaultThinkingLevel: "medium",
    modelThinkingLevels: { "openai/gpt-test": "high" },
    transport: "auto",
    compactionEnabled: true,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    effectiveExternalEditor: "notepad",
    externalEditorSource: "default",
  };
  global.window.pfsaa = { settings: {
    get: async () => settings,
    update: async (value) => { saved.push(value); return { ...settings, ...value }; },
    chooseExternalEditor: async () => null,
  } };
  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(AgentCoreSettings, {
    language: "en",
    cwd: "",
    models: [{ id: "gpt-test", providerId: "openai", providerName: "OpenAI", name: "GPT Test", reasoning: true, thinkingLevels: ["off", "medium", "high", "max"], authConfigured: true }],
    onClose: () => undefined,
    onNotice: () => undefined,
  })); });
  await act(flushReact);
  const modelThinking = dom.document.querySelector('[data-testid="agentcore-model-thinking-openai-gpt-test"]');
  assert.ok(modelThinking);
  assert.equal(modelThinking.querySelector("span")?.textContent, "high");
  await act(async () => {
    modelThinking.click();
    await flushReact();
    const menu = dom.document.getElementById(modelThinking.getAttribute("aria-controls"));
    assert.ok(menu);
    menu.querySelector('[role="option"][data-value=""]').click();
    await flushReact();
  });
  assert.equal(modelThinking.querySelector("span")?.textContent, "Use global default (medium)");
  const save = dom.document.querySelector('[data-testid="agentcore-settings-save"]');
  await act(async () => { save.click(); await flushReact(); });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].modelThinkingLevels["openai/gpt-test"], null);
  await act(async () => { root.unmount(); });
  dom.close();
});

test("AgentCore Settings automatic editor mode clears the user override", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { AgentCoreSettings } = require("../dist/renderer/ui/agentcore-settings.js");
  const saved = [];
  const current = { defaultThinkingLevel: "medium", transport: "auto", compactionEnabled: true, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", externalEditor: "code --wait", effectiveExternalEditor: "code --wait", externalEditorSource: "user" };
  global.window.pfsaa = { settings: {
    get: async () => current,
    update: async (value) => { saved.push(value); return { ...current, ...value }; },
    chooseExternalEditor: async () => null,
  } };
  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(AgentCoreSettings, { language: "en", cwd: "", models: [], onClose: () => undefined, onNotice: () => undefined })); });
  await act(flushReact);
  const automaticMode = dom.document.querySelector('[data-testid="agentcore-external-editor-automatic"]');
  const save = dom.document.querySelector('[data-testid="agentcore-settings-save"]');
  assert.ok(automaticMode);
  assert.ok(save);
  await act(async () => { automaticMode.click(); });
  assert.equal(dom.document.querySelector('[data-testid="agentcore-external-editor"]'), null);
  await act(async () => { save.click(); await flushReact(); });
  assert.equal(saved[0].externalEditor, "");
  await act(async () => { root.unmount(); });
  dom.close();
});

test("project trust dialog explains resource access and exposes the effective decision", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { TrustDialog } = require("../dist/renderer/ui/dialogs.js");
  const decisions = [];
  const root = createRoot(dom.document.body);
  const project = { id: "D:/workspace", cwd: "D:/workspace", name: "workspace", taskCount: 0 };
  const status = { cwd: project.cwd, hasTrustRequiringResources: true, trusted: false, source: "default", defaultPolicy: "ask" };
  await act(async () => root.render(React.createElement(TrustDialog, { language: "en", project, status, busy: false, onResolve: (value) => decisions.push(value), onClose: () => undefined })));
  assert.equal(dom.document.querySelector("[data-trust-status]").dataset.trustStatus, "untrusted");
  assert.equal(dom.document.querySelectorAll("[data-trust-action]").length, 2);
  await act(async () => dom.document.querySelector('[data-trust-action="deny"]').click());
  await act(async () => dom.document.querySelector('[data-trust-action="allow"]').click());
  assert.deepEqual(decisions, [false, true]);
  await act(async () => root.render(React.createElement(TrustDialog, { language: "en", project, status: { ...status, hasTrustRequiringResources: false, trusted: true, source: "not-required" }, busy: false, onResolve: (value) => decisions.push(value), onClose: () => undefined })));
  assert.equal(dom.document.querySelector("[data-trust-status]").dataset.trustStatus, "not-required");
  assert.equal(dom.document.querySelectorAll("[data-trust-action]").length, 2);
  await act(async () => root.unmount());
  dom.close();
});

test("Quick settings keeps a compact root and drills into actions and commands", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { QuickSettings } = require("../dist/renderer/ui/quick-settings.js");
  const { activatePaletteCommand } = require("../dist/renderer/palette-command.js");
  const commands = [
    { name: "settings", description: "Open AgentCore settings" },
    { name: "reload", description: "Reload AgentCore resources" },
    { name: "review", description: "Review this change", source: "skill" },
  ];
  const executed = [];
  const inserted = [];
  const root = createRoot(dom.document.body);
  const noop = () => undefined;
  const actions = {
    executeBuiltin: async (text) => { executed.push(text); return true; },
    insertTemplate: (text) => inserted.push(text),
    executeExtension: async () => assert.fail("not an extension"),
    unsupported: () => assert.fail("supported command"),
  };
  const props = {
    language: "en", commands, shortcut: (key) => key, hasProject: false, hasSession: false,
    onClose: noop, onNewTask: noop, onProviders: noop, onPackages: noop, onCompact: noop, onExport: noop,
    onCommand: (command) => activatePaletteCommand(command, actions),
  };
  await act(async () => root.render(React.createElement(QuickSettings, props)));
  assert.equal(dom.document.querySelectorAll(".quick-settings-menu > button").length, 6);
  assert.equal(dom.document.querySelectorAll('[data-entry="settings"]').length, 1);
  assert.equal(dom.document.querySelector('[data-entry="packages"]'), null);
  assert.equal(dom.document.querySelector('[data-entry="command:settings"]'), null);
  assert.equal(dom.document.querySelector('[data-entry="command:reload"]'), null);
  assert.equal(dom.document.querySelector('[data-entry="scoped-models"]').disabled, true);
  assert.equal(dom.document.querySelector('[data-entry="trust"]'), null);
  await act(async () => dom.document.querySelector('[data-entry="settings"]').click());
  assert.deepEqual(executed, ["/settings"]);
  await act(async () => dom.document.querySelector('[data-entry="task-actions"]').click());
  assert.equal(dom.document.querySelectorAll(".quick-settings-menu > button").length, 4);
  for (const id of ["new-task", "compact", "export-jsonl", "export-html"]) assert.equal(dom.document.querySelector(`[data-entry="${id}"]`).disabled, true);
  await act(async () => dom.document.querySelector(".quick-settings-back").click());
  await act(async () => dom.document.querySelector('[data-entry="agentcore-commands"]').click());
  assert.equal(dom.document.querySelectorAll(".quick-settings-group [cmdk-item]").length, 2);
  const input = dom.document.querySelector("input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "/reload");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(dom.document.querySelectorAll(".quick-settings-group [cmdk-item]:not([hidden])").length, 1);
  await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  assert.deepEqual(executed, ["/settings", "/reload"]);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "review");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => dom.document.querySelector('[data-entry="command:review"]').click());
  assert.deepEqual(inserted, ["/review "]);
  await act(async () => dom.document.querySelector(".quick-settings-back").click());
  assert.equal(dom.document.querySelector("input"), null);
  await act(async () => root.render(React.createElement(QuickSettings, { ...props, key: "direct-commands", initialPage: "commands" })));
  assert.ok(dom.document.querySelector("input"));
  await act(async () => root.unmount());
  dom.close();
});

test("model selector delegates filtering and keyboard selection to cmdk", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { MemoComposer } = require("../dist/renderer/ui/composer.js");
  const selected = [];
  const noop = () => undefined;
  const models = [
    { id: "alpha", providerId: "one", providerName: "First Provider", name: "Alpha", thinkingLevels: ["off"] },
    { id: "beta", providerId: "two", providerName: "Second Provider", name: "Beta", thinkingLevels: ["off"] },
  ];
  const root = createRoot(dom.document.body);
  await act(async () => root.render(React.createElement(MemoComposer, {
    sessionKey: "cmdk-models", value: "", onChange: noop, onKeyDown: noop, onPaste: noop, onDropImages: noop,
    onExternalEdit: noop, externalEditing: false, onSend: noop, onStop: noop, isSending: false,
    language: "en", activeModel: models[0], modelOptions: models, thinkingLevel: "off", thinkingLevels: ["off"],
    thinkingMenuOpen: false, modelMenuOpen: true, suggestionMode: null, suggestions: [], suggestionIndex: 0,
    commandNames: [], attachments: [], onRemoveAttachment: noop, onPreviewImage: noop, onContextMenuImage: noop,
    onThinkingMenu: noop, onModelMenu: noop, onThinking: noop, onModel: (model) => selected.push(model.id), onSuggestion: noop,
    queueDelivery: "steer", queueState: null, queueMutationBusy: false, queueEdit: null, onQueueDelivery: noop,
    onQueueModes: async () => true, onClearQueue: noop, onPromoteQueue: noop, onEditQueue: noop, onDeleteQueue: noop,
    onCancelQueueEdit: noop,
  })));
  const input = dom.document.querySelector(".model-search input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "Second Provider");
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(dom.document.querySelectorAll(".model-menu-list [cmdk-item]:not([hidden])").length, 1);
  await act(async () => input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  assert.deepEqual(selected, ["beta"]);
  await act(async () => root.unmount());
  dom.close();
});

test("model selector wheel stays inside the model list", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { MemoComposer } = require("../dist/renderer/ui/composer.js");
  const noop = () => undefined;
  const models = [
    { id: "alpha", providerId: "one", providerName: "First Provider", name: "Alpha", thinkingLevels: ["off"] },
    { id: "beta", providerId: "two", providerName: "Second Provider", name: "Beta", thinkingLevels: ["off"] },
  ];
  const host = dom.document.createElement("div");
  let bubbledWheels = 0;
  host.addEventListener("wheel", () => { bubbledWheels += 1; });
  dom.document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(MemoComposer, {
    sessionKey: "wheel-models", value: "", onChange: noop, onKeyDown: noop, onPaste: noop, onDropImages: noop,
    onExternalEdit: noop, externalEditing: false, onSend: noop, onStop: noop, isSending: false,
    language: "en", activeModel: models[0], modelOptions: models, thinkingLevel: "off", thinkingLevels: ["off"],
    thinkingMenuOpen: false, modelMenuOpen: true, suggestionMode: null, suggestions: [], suggestionIndex: 0,
    commandNames: [], attachments: [], onRemoveAttachment: noop, onPreviewImage: noop, onContextMenuImage: noop,
    onThinkingMenu: noop, onModelMenu: noop, onThinking: noop, onModel: noop, onSuggestion: noop,
    queueDelivery: "steer", queueState: null, queueMutationBusy: false, queueEdit: null, onQueueDelivery: noop,
    onQueueModes: async () => true, onClearQueue: noop, onPromoteQueue: noop, onEditQueue: noop, onDeleteQueue: noop,
    onCancelQueueEdit: noop,
  })));
  const list = dom.document.querySelector(".model-menu-list");
  assert.ok(list);
  const wheel = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
  list.dispatchEvent(wheel);
  assert.equal(bubbledWheels, 0);
  assert.equal(wheel.defaultPrevented, false);
  await act(async () => root.unmount());
  dom.close();
});

test("package install scope is explicit and controls the next install target", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { PackageSettings } = require("../dist/renderer/ui/package-settings.js");
  const installs = [];
  const notices = [];
  dom.window.pfsaa = {
    packages: {
      list: async () => [],
      install: async (...args) => { installs.push(args); },
    },
  };
  const root = createRoot(dom.document.body);
  await act(async () => {
    root.render(React.createElement(PackageSettings, {
      language: "en",
      cwd: "D:\\workspace",
      onClose: () => undefined,
      onNotice: (message) => notices.push(message),
    }));
    await flushReact();
  });
  const projectScope = dom.document.querySelector('input[name="package-install-scope"][value="project"]');
  const userScope = dom.document.querySelector('input[name="package-install-scope"][value="user"]');
  const source = dom.document.querySelector('.package-install-row input[type="text"]');
  assert.equal(projectScope.checked, true);
  assert.equal(userScope.checked, false);
  assert.equal(projectScope.closest("label").classList.contains("selected"), true);
  assert.equal(dom.document.querySelectorAll(".package-install-scope-option small").length, 2);
  assert.match(projectScope.closest("label").textContent, /project settings directory/);
  assert.doesNotMatch(projectScope.closest("label").textContent, /\.pi\/settings\.json/);
  await act(async () => {
    userScope.click();
  });
  assert.equal(installs.length, 0);
  assert.equal(projectScope.checked, false);
  assert.equal(userScope.checked, true);
  assert.equal(userScope.closest("label").classList.contains("selected"), true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(source, "npm:demo-package");
    source.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    dom.document.querySelector(".package-install-form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await flushReact();
  });
  assert.deepEqual(installs, [["npm:demo-package", false, "D:\\workspace"]]);
  assert.match(notices[0], /User-wide/);
  await act(async () => root.unmount());
  dom.close();
});

test("package enable action reloads state and becomes a disable action", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { PackageSettings } = require("../dist/renderer/ui/package-settings.js");
  const configureCalls = [];
  let disabled = true;
  dom.window.pfsaa = {
    packages: {
      list: async () => [{ source: "demo-package", scope: "project", filtered: true, disabled, resources: [] }],
      configure: async (_source, enabled) => {
        configureCalls.push(enabled);
        disabled = !enabled;
      },
    },
  };
  const root = createRoot(dom.document.body);
  await act(async () => {
    root.render(React.createElement(PackageSettings, {
      language: "en",
      cwd: "D:\\workspace",
      onClose: () => undefined,
      onNotice: () => undefined,
    }));
    await flushReact();
  });
  const toggle = dom.document.querySelector('[data-package-action="toggle-enabled"]');
  assert.equal(toggle.dataset.packageEnabled, "false");
  await act(async () => { toggle.click(); await flushReact(); });
  assert.deepEqual(configureCalls, [true]);
  assert.equal(toggle.dataset.packageEnabled, "true");
  await act(async () => { toggle.click(); await flushReact(); });
  assert.deepEqual(configureCalls, [true, false]);
  assert.equal(toggle.dataset.packageEnabled, "false");
  await act(async () => root.unmount());
  dom.close();
});

test("palette routing preserves template sources and never sends unknown built-ins to a model", async () => {
  const { activatePaletteCommand } = require("../dist/renderer/palette-command.js");
  const calls = [];
  const actions = {
    insertTemplate: (text) => calls.push(["template", text]),
    executeBuiltin: async (text) => { calls.push(["builtin", text]); return false; },
    executeExtension: async (text) => calls.push(["extension", text]),
    unsupported: () => calls.push(["unsupported"]),
  };
  await activatePaletteCommand({ name: "settings", source: "prompt" }, actions);
  await activatePaletteCommand({ name: "skill:review", source: "skill" }, actions);
  await activatePaletteCommand({ name: "permission-system", source: "extension" }, actions);
  await activatePaletteCommand({ name: "future-command" }, actions);
  assert.deepEqual(calls, [["template", "/settings "], ["template", "/skill:review "], ["extension", "/permission-system"], ["builtin", "/future-command"], ["unsupported"]]);
  await assert.rejects(activatePaletteCommand({ name: "broken", source: "extension" }, { ...actions, executeExtension: async () => { throw new Error("runtime disconnected"); } }), /runtime disconnected/);
});

test("a dialog opened from a disappearing launcher restores workspace focus", async () => {
  const dom = installDom();
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const { DialogFocusReturnContext, useDialogFocus } = require("@pfsaa/ui-system");
  function Dialog({ onClose, onNext }) {
    const ref = React.useRef(null);
    useDialogFocus(ref, onClose);
    return React.createElement("section", { ref, role: "dialog" },
      React.createElement("button", { onClick: onNext ?? onClose }, onNext ? "Next" : "Close"));
  }
  function Probe() {
    const [step, setStep] = React.useState(0);
    const origin = React.useRef(null);
    return React.createElement(DialogFocusReturnContext.Provider, { value: origin },
      React.createElement("button", { ref: origin, id: "origin", onClick: () => setStep(1) }, "Settings"),
      step ? React.createElement(Dialog, { key: step, onClose: () => setStep(0), onNext: step === 1 ? () => setStep(2) : undefined }) : null);
  }
  const root = createRoot(dom.document.body);
  await act(async () => root.render(React.createElement(Probe)));
  const origin = dom.document.getElementById("origin");
  origin.focus();
  await act(async () => origin.click());
  const launcherButton = dom.document.querySelector('[role="dialog"] button');
  launcherButton.focus();
  await act(async () => { launcherButton.click(); await flushReact(); });
  assert.equal(launcherButton.isConnected, false);
  await act(async () => { dom.document.querySelector('[role="dialog"] button').click(); await flushReact(); });
  assert.equal(dom.document.activeElement, origin);
  await act(async () => root.unmount());
  dom.close();
});

test("typing the first transcript-search character does not create a render feedback loop", async (context) => {
  const dom = installDom();
  const originalWarn = console.warn;
  console.warn = (message, ...details) => {
    if (!String(message).startsWith("Warning: KaTeX doesn't work in quirks mode")) originalWarn(message, ...details);
  };
  context.after(() => { console.warn = originalWarn; });
  const { createRoot } = require("react-dom/client");
  const { act } = React;
  const previousCssLoader = require.extensions[".css"];
  require.extensions[".css"] = () => undefined;
  const { MemoMessageTimeline } = require("../dist/renderer/ui/message-timeline.js");
  if (previousCssLoader) require.extensions[".css"] = previousCssLoader;
  else delete require.extensions[".css"];
  dom.window.HTMLElement.prototype.scrollIntoView = () => undefined;
  const reports = [];
  const messages = [{
    role: "bashExecution",
    command: "echo UI_SEARCH_ALPHA",
    output: "UI_SEARCH_ALPHA\n",
    exitCode: 0,
    cancelled: false,
    timestamp: 1,
    excludeFromContext: false,
  }];

  function Probe() {
    const [query, setQuery] = React.useState("");
    const [request, setRequest] = React.useState({ serial: 0, direction: "forward", reset: true });
    const [result, setResult] = React.useState({ current: 0, total: 0 });
    const conversationRef = React.useRef(null);
    const scrollPositionsRef = React.useRef({});
    const scrollHandleRef = React.useRef(null);
    React.useEffect(() => {
      setQuery("U");
      setRequest({ serial: 1, direction: "forward", reset: true });
    }, []);
    const report = React.useCallback((next) => {
      reports.push(next);
      setResult({ ...next });
    }, []);
    return React.createElement("div", { ref: conversationRef },
      React.createElement(MemoMessageTimeline, {
        messages,
        language: "en",
        running: false,
        activeActivity: [],
        streamText: "",
        workingPhase: null,
        completedActivity: [],
        steeringMessageKeys: [],
        taskId: "search-task",
        scrollKey: "search-project\u0000search-task",
        active: true,
        messageReady: true,
        conversationRef,
        scrollPositionsRef,
        scrollHandleRef,
        onAtEndChange: () => undefined,
        onPreviewImage: () => undefined,
        onContextMenuImage: () => undefined,
        searchQuery: query,
        searchRequest: request,
        onSearchResult: report,
      }),
      React.createElement("output", null, `${result.current}/${result.total}`));
  }

  const root = createRoot(dom.document.body);
  await act(async () => { root.render(React.createElement(Probe)); await flushReact(); });
  await act(flushReact);
  assert.equal(dom.document.querySelector("output").textContent, "1/1");
  assert.deepEqual(reports, [{ current: 1, total: 1 }]);
  await act(async () => root.unmount());
  dom.close();
});
