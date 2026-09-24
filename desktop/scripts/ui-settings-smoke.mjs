import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const target = targets.find((item) => item.type === "page" && item.url.startsWith("http://localhost:5173")) ?? targets.find((item) => item.type === "page");
if (!target) throw new Error("No PFSAA CDP page target found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.description ?? result.exceptionDetails.text ?? "Runtime evaluation failed");
  if (result.result?.subtype === "error") throw new Error(result.result.description ?? "Runtime evaluation failed");
  return result.result?.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(expression, timeoutMs = 8_000, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function click(selector) {
  const ok = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; element.click(); return true; })()`);
  if (!ok) throw new Error(`Element not found: ${selector}`);
}

async function clickText(text) {
  const ok = await evaluate(`(() => { const expected = ${JSON.stringify(text)}; const element = Array.from(document.querySelectorAll('button')).find((item) => item.innerText.trim() === expected || item.innerText.trim().startsWith(expected)); if (!element) return false; element.click(); return true; })()`);
  if (!ok) throw new Error(`Button not found: ${text}`);
}

async function selectValue(testId, value) {
  console.log(`select ${testId} -> ${value}`);
  await click(`[data-testid=${JSON.stringify(testId)}]`);
  await waitFor(`Boolean(document.querySelector('.select-control-menu[role="listbox"]'))`);
  const ok = await evaluate(`(() => { const option = document.querySelector('.select-control-menu[role="listbox"] [role="option"][data-value=${JSON.stringify(value)}]'); if (!option) return false; option.click(); return true; })()`);
  if (!ok) throw new Error(`Select option not found: ${testId}=${value}`);
  await waitFor(`!document.querySelector('.select-control-menu[role="listbox"]')`);
}

async function fill(testId, value) {
  const ok = await evaluate(`(() => { const element = document.querySelector('[data-testid="${testId}"]'); if (!element) return false; const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value'); descriptor?.set?.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  if (!ok) throw new Error(`Input not found: ${testId}`);
}

async function setChecked(testId, checked) {
  const ok = await evaluate(`(() => { const element = document.querySelector('[data-testid="${testId}"]'); if (!element) return false; if (element.checked !== ${checked}) element.click(); return true; })()`);
  if (!ok) throw new Error(`Checkbox not found: ${testId}`);
}

async function setCompaction(checked) {
  const ok = await evaluate(`(() => { const label = Array.from(document.querySelectorAll('.agentcore-settings-fields > label')).find((item) => item.innerText.includes('自动上下文压缩')); const element = label?.querySelector('input[type="checkbox"]'); if (!element) return false; if (element.checked !== ${checked}) element.click(); return true; })()`);
  if (!ok) throw new Error("Compaction checkbox not found");
}

async function openSettings() {
  if (await evaluate(`Boolean(document.querySelector('[data-testid="agentcore-settings-dialog"]'))`)) return;
  await click('[aria-label="快捷设置"]');
  await waitFor(`Boolean(Array.from(document.querySelectorAll('button')).find((item) => item.innerText.trim().startsWith('设置')))`);
  await clickText("设置");
  await waitFor(`Boolean(document.querySelector('[data-testid="agentcore-settings-dialog"]'))`);
  await waitFor(`Boolean(document.querySelector('[data-testid="agentcore-defaultThinking"]')) || Boolean(document.querySelector('[data-testid="agentcore-settings-dialog"] [role="alert"]'))`, 12_000);
  const error = await evaluate(`document.querySelector('[data-testid="agentcore-settings-dialog"] [role="alert"]')?.innerText ?? ''`);
  if (error) throw new Error(`AgentCore Settings could not load through the UI: ${error}`);
}

async function openAdvanced() {
  await openSettings();
  const open = await evaluate(`Boolean(document.querySelector('[data-testid="agentcore-advanced-settings"]')?.open)`);
  if (!open) await click('[data-testid="agentcore-advanced-settings"] > summary');
  await waitFor(`Boolean(document.querySelector('[data-testid="agentcore-shellPath"]'))`);
}

async function saveSettings() {
  console.log("click save");
  await click('[data-testid="agentcore-settings-save"]');
  console.log("waiting save close");
  await waitFor(`!document.querySelector('[data-testid="agentcore-settings-dialog"]')`, 12_000);
  console.log("save closed");
}

async function readControl(testId) {
  return evaluate(`(() => { const element = document.querySelector('[data-testid="${testId}"]'); if (!element) return null; if (element.type === 'checkbox') return element.checked; if (element instanceof HTMLButtonElement) return element.textContent?.trim() ?? ''; return element.value ?? element.textContent?.trim() ?? ''; })()`);
}

async function applyCase(name, prepare, read, expected) {
  console.log(`BEGIN ${name}`);
  await openSettings();
  console.log(`prepare ${name}`);
  await prepare();
  await saveSettings();
  await openSettings();
  const actual = await read();
  const pass = expected(actual);
  console.log(`${pass ? "PASS" : "FAIL"} UI save ${name}: ${JSON.stringify(actual)}`);
  if (!pass) throw new Error(`UI save verification failed for ${name}: ${JSON.stringify(actual)}`);
  console.log(`END ${name}`);
}

async function newTask() {
  if (await evaluate(`Boolean(document.querySelector('[data-testid="agentcore-settings-dialog"]'))`)) await click('[aria-label="关闭设置"]');
  await waitFor(`!document.querySelector('[data-testid="agentcore-settings-dialog"]')`);
  await click('[aria-label="新建任务"]');
  await waitFor(`Boolean(document.querySelector('.composer-editor-input'))`, 12_000);
  await sleep(500);
}

async function sendPrompt(text, timeoutMs = 120_000) {
  const before = await evaluate(`document.querySelectorAll('.assistant-message').length`);
  await typeComposerText(text);
  await click('[aria-label="发送"]');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluate(`(() => { const items = Array.from(document.querySelectorAll('.assistant-message')); const fresh = items.slice(${before}); const error = fresh.map((item) => item.querySelector('.message-error')?.textContent ?? '').find(Boolean) ?? ''; const last = items.at(-1); return { count: items.length, sending: Boolean(document.querySelector('[aria-label*="停止"], [title*="停止"]')), last: last?.querySelector('.message-content')?.textContent?.trim() ?? '', error }; })()`);
    if (state.error) throw new Error(`Provider returned an assistant error: ${state.error}`);
    if (state.count > before && !state.sending) return state.last;
    await sleep(1_000);
  }
  throw new Error(`Timed out waiting for provider response to ${text}`);
}

async function typeComposerText(text) {
  const focused = await evaluate(`(() => { const element = document.querySelector('.composer-editor-input'); element?.focus(); return document.activeElement === element; })()`);
  if (!focused) throw new Error("Composer editor could not receive focus");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 });
  await call("Input.insertText", { text });
  await waitFor(`document.querySelector('.composer-editor-input')?.value === ${JSON.stringify(text)}`, 4_000);
}

async function sendShellCommand(text, timeoutMs = 20_000) {
  const before = await evaluate(`document.querySelectorAll('.shell-command-message').length`);
  await typeComposerText(text);
  await click('[aria-label="发送"]');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluate(`(() => { const items = Array.from(document.querySelectorAll('.shell-command-message')); const item = items.find((candidate) => candidate.querySelector('code')?.textContent?.includes('pfsaa-shell-check')) ?? items.at(-1); return { count: items.length, sending: Boolean(document.querySelector('[aria-label*="停止"], [title*="停止"]')), last: item ? { label: item.getAttribute('aria-label') ?? '', text: item.textContent ?? '', status: item.querySelector('.shell-command-status')?.textContent ?? '', output: item.querySelector('.xterm-rows')?.textContent ?? '' } : null }; })()`);
    if (state.count > before && !state.sending && state.last && /pfsaa-shell-check/i.test(state.last.label)) return state.last;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for shell command ${text}`);
}

async function testModelListWheel() {
  await click('[title="选择模型"]');
  await waitFor(`Boolean(document.querySelector('.model-menu-list'))`);
  const before = await evaluate(`(() => { const list = document.querySelector('.model-menu-list'); const pane = document.querySelector('.message-timeline'); return { listTop: list?.scrollTop ?? 0, paneTop: pane?.scrollTop ?? 0, rect: list?.getBoundingClientRect().toJSON?.() ?? null }; })()`);
  const rect = before.rect;
  if (rect) await call("Input.dispatchMouseEvent", { type: "mouseWheel", x: rect.left + Math.max(8, rect.width / 2), y: rect.top + Math.min(80, rect.height / 2), deltaX: 0, deltaY: 260 });
  await sleep(250);
  const after = await evaluate(`(() => { const list = document.querySelector('.model-menu-list'); const pane = document.querySelector('.message-timeline'); return { listTop: list?.scrollTop ?? 0, paneTop: pane?.scrollTop ?? 0 }; })()`);
  const pass = after.listTop > before.listTop && after.paneTop === before.paneTop;
  console.log(`${pass ? "PASS" : "FAIL"} model list wheel isolation: ${JSON.stringify({ before, after })}`);
  await evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  if (!pass) throw new Error("Model-list wheel changed the conversation scroll position");
}

async function configuredGpt55Model() {
  const models = await evaluate("window.pfsaa.models.list()");
  const matches = (Array.isArray(models) ? models : []).filter((model) => model?.authConfigured === true && /gpt[- ]?5\\.5/i.test(`${model.providerId}/${model.id} ${model.name ?? ""}`));
  if (matches.length !== 1) throw new Error(`Expected exactly one authenticated GPT-5.5 model, found ${matches.map((model) => `${model.providerId}/${model.id}`).join(", ") || "none"}`);
  return matches[0];
}

const sdk = await import("@earendil-works/pi-coding-agent");
const agentDir = sdk.getAgentDir?.();
if (!agentDir) throw new Error("AgentCore agent directory is unavailable");
const settingsPath = path.join(agentDir, "settings.json");
const projectSettingsPath = path.join(root, ".pi", "settings.json");
const snapshot = new Map();
for (const file of [settingsPath, projectSettingsPath]) if (existsSync(file)) snapshot.set(file, readFileSync(file));
const temporarySessionDir = path.join(os.tmpdir(), `pfsaa-ui-session-${Date.now()}`);
mkdirSync(temporarySessionDir, { recursive: true });

let screenshotPath;
try {
  // Close stale menus/dialogs from a previous inspection, then enter AgentCore Settings through the visible UI.
  await evaluate(`document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await openSettings();
  await sleep(500);
  screenshotPath = path.join(root, "output", "playwright", "agentcore-settings-open.png");
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  const screenshot = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(`UI opened AgentCore Settings; screenshot: ${screenshotPath}`);

  const acceptanceModel = await configuredGpt55Model();
  const acceptanceModelReference = `${acceptanceModel.providerId}/${acceptanceModel.id}`;
  console.log(`Using configured GPT-5.5 model ${acceptanceModelReference}`);
  const acceptanceModelPattern = new RegExp(acceptanceModel.id.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"), "i");
  await applyCase("default model", () => selectValue("agentcore-defaultModel", acceptanceModelReference), () => readControl("agentcore-defaultModel"), (value) => acceptanceModelPattern.test(value));
  await applyCase("default thinking", () => selectValue("agentcore-defaultThinking", "low"), () => readControl("agentcore-defaultThinking"), (value) => value === "low");
  const modelThinkingTestId = `agentcore-model-thinking-${acceptanceModel.providerId}-${acceptanceModel.id}`;
  await applyCase("per-model thinking", () => selectValue(modelThinkingTestId, "medium"), () => readControl(modelThinkingTestId), (value) => value === "medium");
  for (const transport of ["auto", "sse", "websocket", "websocket-cached"]) {
    const display = transport === "sse" ? "SSE" : transport === "websocket" ? "WebSocket" : transport === "websocket-cached" ? "WebSocket (cached)" : "auto";
    await applyCase(`transport ${transport}`, () => selectValue("agentcore-transport", transport), () => readControl("agentcore-transport"), (value) => value === display);
  }
  await applyCase("steering mode", () => selectValue("agentcore-steeringMode", "one-at-a-time"), () => readControl("agentcore-steeringMode"), (value) => value === "one-at-a-time");
  await applyCase("follow-up mode", () => selectValue("agentcore-followUpMode", "one-at-a-time"), () => readControl("agentcore-followUpMode"), (value) => value === "one-at-a-time");
  await applyCase("auto compaction", () => setCompaction(false), () => evaluate(`Boolean(Array.from(document.querySelectorAll('.agentcore-settings-fields > label')).find((item) => item.innerText.includes('自动上下文压缩'))?.querySelector('input')?.checked)`), (value) => value === false);
  await applyCase("external editor", async () => { await click('[data-testid="agentcore-external-editor-custom"]'); await fill("agentcore-external-editor", "notepad"); }, () => evaluate(`document.querySelector('[data-testid="agentcore-external-editor"]')?.value ?? ''`), (value) => value === "notepad");

  const advancedCases = [
    ["retry enabled", () => evaluate(`(() => { const label = Array.from(document.querySelectorAll('.agentcore-settings-fields > label')).find((item) => item.innerText.includes('自动重试') || item.innerText.includes('Retry')); const element = label?.querySelector('input[type="checkbox"]'); if (!element) throw new Error('Retry checkbox not found'); if (element.checked) element.click(); return true; })()`), () => evaluate(`(() => { const label = Array.from(document.querySelectorAll('.agentcore-settings-fields > label')).find((item) => item.innerText.includes('自动重试') || item.innerText.includes('Retry')); return Boolean(label?.querySelector('input[type="checkbox"]')?.checked); })()`), (value) => value === false],
    ["provider retry timeout", () => fill("agentcore-providerRetryTimeoutMs", "30000"), () => readControl("agentcore-providerRetryTimeoutMs"), (value) => value === "30000"],
    ["provider retry max retries", () => fill("agentcore-providerRetryMaxRetries", "1"), () => readControl("agentcore-providerRetryMaxRetries"), (value) => value === "1"],
    ["provider retry max delay", () => fill("agentcore-providerRetryMaxRetryDelayMs", "5000"), () => readControl("agentcore-providerRetryMaxRetryDelayMs"), (value) => value === "5000"],
    ["retry max retries", () => fill("agentcore-retryMaxRetries", "2"), () => readControl("agentcore-retryMaxRetries"), (value) => value === "2"],
    ["retry base delay", () => fill("agentcore-retryBaseDelayMs", "100"), () => readControl("agentcore-retryBaseDelayMs"), (value) => value === "100"],
    ["compaction reserve", () => fill("agentcore-compactionReserveTokens", "8192"), () => readControl("agentcore-compactionReserveTokens"), (value) => value === "8192"],
    ["compaction keep recent", () => fill("agentcore-compactionKeepRecentTokens", "10000"), () => readControl("agentcore-compactionKeepRecentTokens"), (value) => value === "10000"],
    ["HTTP idle timeout", () => fill("agentcore-httpIdleTimeoutMs", "120000"), () => readControl("agentcore-httpIdleTimeoutMs"), (value) => value === "120000"],
    ["WebSocket connect timeout", () => fill("agentcore-websocketConnectTimeoutMs", "10000"), () => readControl("agentcore-websocketConnectTimeoutMs"), (value) => value === "10000"],
    ["branch summary reserve", () => fill("agentcore-branchSummaryReserveTokens", "8192"), () => readControl("agentcore-branchSummaryReserveTokens"), (value) => value === "8192"],
    ["branch summary skip prompt", () => setChecked("agentcore-branchSummarySkipPrompt", true), () => readControl("agentcore-branchSummarySkipPrompt"), (value) => value === true],
    ["HTTP proxy", () => fill("agentcore-httpProxy", "http://127.0.0.1:9"), () => readControl("agentcore-httpProxy"), (value) => value === "http://127.0.0.1:9/"],
    ["default tools", async () => { await evaluate(`(() => { const label = Array.from(document.querySelectorAll('.agentcore-settings-fields > label')).find((item) => item.innerText.includes('使用默认工具') || item.innerText.includes('Use default tools')); const element = label?.querySelector('input[type="checkbox"]'); if (!element) throw new Error('Default-tools automatic checkbox not found'); if (element.checked) element.click(); return true; })()`); await fill("agentcore-defaultTools", "read bash"); }, () => readControl("agentcore-defaultTools"), (value) => value === "read, bash"],
    ["image auto resize", () => setChecked("agentcore-imageAutoResize", false), () => readControl("agentcore-imageAutoResize"), (value) => value === false],
    ["block images", () => setChecked("agentcore-blockImages", true), () => readControl("agentcore-blockImages"), (value) => value === true],
    ["thinking budget low", () => fill("agentcore-thinking-budget-low", "2048"), () => readControl("agentcore-thinking-budget-low"), (value) => value === "2048"],
    ["default project trust", () => selectValue("agentcore-defaultProjectTrust", "always"), () => readControl("agentcore-defaultProjectTrust"), (value) => value === "always"],
    ["skill commands", () => setChecked("agentcore-enableSkillCommands", false), () => readControl("agentcore-enableSkillCommands"), (value) => value === false],
    ["shell path", () => fill("agentcore-shellPath", path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")), () => readControl("agentcore-shellPath"), (value) => value.toLowerCase().endsWith("powershell.exe")],
    ["shell command prefix", () => fill("agentcore-shellCommandPrefix", "Write-Output pfsaa-prefix"), () => readControl("agentcore-shellCommandPrefix"), (value) => value === "Write-Output pfsaa-prefix"],
    ["npm command", () => fill("agentcore-npmCommand", "npm\n--version"), () => readControl("agentcore-npmCommand"), (value) => value === "npm\n--version"],
    ["session directory", () => fill("agentcore-sessionDir", temporarySessionDir), () => readControl("agentcore-sessionDir"), (value) => value === temporarySessionDir],
    ["install telemetry", () => setChecked("agentcore-enableInstallTelemetry", false), () => readControl("agentcore-enableInstallTelemetry"), (value) => value === false],
  ];
  for (const [name, prepare, read, expected] of advancedCases) {
    await openAdvanced();
    await applyCase(name, prepare, read, expected);
  }
  // The proxy case is a UI round-trip check only; clear the intentionally unreachable endpoint before real model calls.
  await openAdvanced();
  await applyCase("HTTP proxy reset", () => fill("agentcore-httpProxy", ""), () => readControl("agentcore-httpProxy"), (value) => value === "");

  // Actual post-save behavior: a fresh session consumes the saved model/thinking defaults.
  await newTask();
  const composerDefaults = await evaluate(`({model: document.querySelector('[title="选择模型"]')?.innerText ?? '', thinking: document.querySelector('[title="选择思考等级"]')?.innerText.trim() ?? ''})`);
  console.log(`UI new-session defaults: ${JSON.stringify(composerDefaults)}`);
  if (!acceptanceModelPattern.test(composerDefaults.model)) throw new Error(`New session did not expose the saved model default: ${JSON.stringify(composerDefaults)}`);
  if (!composerDefaults.thinking || !/medium|low/i.test(composerDefaults.thinking)) throw new Error(`New session did not expose saved thinking defaults: ${JSON.stringify(composerDefaults)}`);

  // The shell settings are exercised through PFSAA's visible !! command path, not only read back from the form.
  const shellResult = await sendShellCommand("!!Write-Output pfsaa-shell-check");
  console.log(`PASS shell settings runtime UI: ${JSON.stringify({ label: shellResult.label, status: shellResult.status, outputVisibleInDom: shellResult.output.includes("pfsaa-shell-check") })}`);
  if (!/Write-Output pfsaa-shell-check/i.test(shellResult.label) || !/完成|completed/i.test(shellResult.status)) throw new Error(`Shell command did not complete through the UI: ${JSON.stringify(shellResult)}`);

  // Exercise each transport with a new session and a real authenticated model request.
  const transportFailures = [];
  for (const transport of ["auto", "sse", "websocket", "websocket-cached"]) {
    try {
      await openSettings();
      await selectValue("agentcore-transport", transport);
      await saveSettings();
      await newTask();
      const response = await sendPrompt("只回复 OK，不要调用工具。", 150_000);
      console.log(`PASS real model request transport=${transport}: ${JSON.stringify(response.slice(-160))}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      transportFailures.push({ transport, message });
      console.log(`FAIL real model request transport=${transport}: ${message}`);
    }
  }
  if (transportFailures.length) throw new Error(`Transport runtime verification failed: ${JSON.stringify(transportFailures)}`);

  await openSettings();
  const finalScreenshot = path.join(root, "output", "playwright", "agentcore-settings-tested.png");
  const finalCapture = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(finalScreenshot, Buffer.from(finalCapture.data, "base64"));
  console.log(`UI settings verification screenshot: ${finalScreenshot}`);
  await click('[aria-label="关闭设置"]');
  await waitFor(`!document.querySelector('[data-testid="agentcore-settings-dialog"]')`);
  await testModelListWheel();
  console.log("UI_SETTINGS_SMOKE_PASS");
} finally {
  // Settings tests intentionally mutate the real AgentCore settings through the UI. Restore the exact files and close this CDP app.
  for (const [file, content] of snapshot) writeFileSync(file, content);
  for (const file of [settingsPath, projectSettingsPath]) if (!snapshot.has(file) && existsSync(file)) rmSync(file, { force: true });
  rmSync(temporarySessionDir, { recursive: true, force: true });
  // Keep the Electron window alive for post-run inspection; the test process only detaches from CDP.
  socket.close();
}
