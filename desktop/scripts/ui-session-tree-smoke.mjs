import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const profileDir = process.env.PFSAA_UI_PROFILE ?? process.env.PIDECK_UI_PROFILE;
if (!profileDir) throw new Error("PFSAA_UI_PROFILE is required");
mkdirSync(profileDir, { recursive: true });
writeFileSync(path.join(profileDir, "projects.json"), `${JSON.stringify({ cwds: [root], hiddenCwds: [] }, null, 2)}\n`, "utf8");

const sdk = await import("@earendil-works/pi-coding-agent");
const manager = sdk.SessionManager.create(root);
manager.appendSessionInfo("Session Tree UI Smoke");
const stressEntries = Math.max(0, Math.min(4_000, Number.parseInt(process.env.PFSAA_UI_STRESS_ENTRIES ?? process.env.PIDECK_UI_STRESS_ENTRIES ?? "0", 10) || 0));
for (let index = 0; index < stressEntries; index += 1) {
  manager.appendMessage(index % 2 === 0
    ? { role: "user", content: `Stress request ${index}`, timestamp: Date.now() - 20_000 - stressEntries + index }
    : { role: "assistant", content: [{ type: "text", text: `Stress reply ${index}` }], timestamp: Date.now() - 20_000 - stressEntries + index, api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
}
const skillInstructions = "# Fixture skill instructions\nInspect every file before responding.\n".repeat(120).trimEnd();
const user1 = manager.appendMessage({ role: "user", content: `<skill name="review" location="/fixture/review/SKILL.md">\n${skillInstructions}\n</skill>\n\nShared baseline request`, timestamp: Date.now() - 6_000 });
const assistant1 = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Shared baseline reply" }], timestamp: Date.now() - 5_000, api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
manager.appendMessage({ role: "user", content: "Original branch request", timestamp: Date.now() - 4_000 });
manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Original branch reply" }], timestamp: Date.now() - 3_000, api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
manager.branch(assistant1);
manager.appendMessage({ role: "user", content: "Alternative branch request", timestamp: Date.now() - 2_000 });
manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Alternative branch reply" }], timestamp: Date.now() - 1_000, api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
manager.appendLabelChange(user1, "Shared start");

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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.description ?? result.exceptionDetails.text ?? "Runtime evaluation failed");
  return result.result?.value;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(expression, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await sleep(120);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}
async function click(selector) {
  const clicked = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return false; element.click(); return true; })()`);
  if (!clicked) throw new Error(`Element not found: ${selector}`);
}
async function clickRow(text) {
  const clicked = await evaluate(`(() => { const text = ${JSON.stringify(text)}; const element = Array.from(document.querySelectorAll('.session-branch-row')).find((row) => row.innerText.includes(text)); if (!element) return false; element.click(); return true; })()`);
  if (!clicked) throw new Error(`Session Tree row not found: ${text}`);
}
async function typeCommand(command) {
  const focused = await evaluate(`(() => { const element = document.querySelector('.composer-editor-input'); element?.focus(); return document.activeElement === element; })()`);
  if (!focused) throw new Error("Composer is not focusable");
  await evaluate(`(() => {
    const element = document.querySelector('.composer-editor-input');
    if (!(element instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(element, ${JSON.stringify(command)});
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(command)} }));
    return true;
  })()`);
  await waitFor(`document.querySelector('.composer-editor-input')?.value === ${JSON.stringify(command)}`);
  await click(".send-button");
  await sleep(120);
  if (!await evaluate(`Boolean(document.querySelector('.session-branch-dialog'))`)) await click(".send-button");
  await waitFor(`Boolean(document.querySelector('.session-branch-dialog'))`);
  await waitFor(`!document.querySelector('.session-branch-state')`);
}
async function taskIds() {
  return evaluate(`window.pfsaa.sessions.list(${JSON.stringify(root)}).then((tasks) => tasks.map((task) => task.id))`);
}
async function screenshot(name) {
  const outputPath = path.join(root, "output", "playwright", name);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const image = await call("Page.captureScreenshot", { format: "png" });
  writeFileSync(outputPath, Buffer.from(image.data, "base64"));
  return outputPath;
}

try {
  await evaluate(`window.pfsaa.projects.setTrust(${JSON.stringify(root)}, true)`);
  await call("Page.reload", { ignoreCache: true });
  await waitFor(`Boolean(document.querySelector('.composer-editor-input'))`, 20_000);
  await waitFor(`(document.body?.textContent ?? '').includes('Session Tree UI Smoke')`, 20_000);

  const treeStartedAt = Date.now();
  await typeCommand("/tree");
  const treeOpenMs = Date.now() - treeStartedAt;
  const treeState = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('.session-branch-row'));
    const browser = document.querySelector('.session-branch-browser')?.getBoundingClientRect();
    const copyLefts = rows.map((row) => row.querySelector('.session-branch-row-copy')?.getBoundingClientRect().left ?? 0);
    const dialogText = document.querySelector('.session-branch-dialog')?.textContent ?? '';
    return { rows: rows.length, branches: rows.some((row) => Array.from(row.querySelectorAll('em')).some((item) => /2|branch|分支/i.test(item.textContent ?? ''))), current: Boolean(document.querySelector('.session-branch-row[aria-current="true"]')), skillCompact: rows.some((row) => row.innerText.includes('/skill:review Shared baseline request')), skillBodyHidden: !dialogText.includes('Fixture skill instructions'), dialog: document.querySelector('.session-branch-dialog')?.getBoundingClientRect().toJSON(), browserWidth: browser?.width ?? 0, maxRowWidth: Math.max(0, ...rows.map((row) => row.getBoundingClientRect().width)), copyLeftSpread: Math.max(0, ...copyLefts) - Math.min(...copyLefts) };
  })()`);
  if (treeState.rows < 6 || treeState.rows > 160 || !treeState.branches || !treeState.current || !treeState.skillCompact || !treeState.skillBodyHidden || treeState.maxRowWidth > treeState.browserWidth || treeState.copyLeftSpread > 1) throw new Error(`Tree browser is incomplete or unbounded: ${JSON.stringify({ treeOpenMs, ...treeState })}`);
  await clickRow("Shared baseline reply");
  await waitFor(`Boolean(document.querySelector('.session-branch-preview.primary'))`);
  const detailTypography = await evaluate(`(() => { const element = document.querySelector('.session-branch-preview.primary'); const style = getComputedStyle(element); return { tag: element?.tagName, fontSize: style.fontSize, fontWeight: style.fontWeight, fontFamily: style.fontFamily }; })()`);
  if (detailTypography.tag !== "P" || detailTypography.fontSize !== "13px" || detailTypography.fontWeight !== "400" || /Iowan|Baskerville|Songti|STSong|Noto Serif|Times New Roman/i.test(detailTypography.fontFamily)) throw new Error(`Session Tree detail typography is too heavy: ${JSON.stringify(detailTypography)}`);
  const treeScreenshot = await screenshot("session-tree-open.png");
  if (stressEntries > 160) {
    await click(".session-branch-pagination button:first-child");
    await waitFor(`document.querySelectorAll('.session-branch-row').length === 160`);
    await click(".session-branch-pagination button:last-child");
    const finalPageRange = `${Math.floor((stressEntries + 6) / 160) * 160 + 1}-${stressEntries + 7}`;
    await waitFor(`(document.querySelector('.session-branch-pagination')?.textContent ?? '').includes(${JSON.stringify(finalPageRange)})`);
  }
  await clickRow("Original branch reply");
  await click(".session-branch-footer .button.primary");
  await waitFor(`!document.querySelector('.session-branch-dialog')`);
  await waitFor(`(document.body?.textContent ?? '').includes('Original branch reply')`);

  const beforeFork = await taskIds();
  await typeCommand("/fork");
  const forkRows = await evaluate(`Array.from(document.querySelectorAll('.session-branch-row')).map((row) => row.innerText)`);
  if (!forkRows.every((row) => row.includes("request"))) throw new Error(`Fork picker exposed a non-user entry: ${JSON.stringify(forkRows)}`);
  await clickRow("Original branch request");
  await click(".session-branch-footer .button.primary");
  await waitFor(`!document.querySelector('.session-branch-dialog')`);
  await waitFor(`document.querySelector('.composer-editor-input')?.value === 'Original branch request'`);
  const afterFork = await taskIds();
  if (afterFork.length !== beforeFork.length + 1) throw new Error(`Fork did not create a task: ${JSON.stringify({ beforeFork, afterFork })}`);

  const beforeClone = afterFork;
  await typeCommand("/clone");
  const cloneImpactVisible = await evaluate(`document.querySelector('.session-branch-detail')?.innerText.includes(${JSON.stringify("original task")}) || document.querySelector('.session-branch-detail')?.innerText.includes(${JSON.stringify("原任务")})`);
  if (!cloneImpactVisible) throw new Error("Clone impact explanation is missing");
  await click(".session-branch-footer .button.primary");
  await waitFor(`!document.querySelector('.session-branch-dialog')`);
  await waitFor(`document.querySelector('.composer-editor-input')?.value === ''`);
  const afterClone = await taskIds();
  if (afterClone.length !== beforeClone.length + 1) throw new Error(`Clone did not create a task: ${JSON.stringify({ beforeClone, afterClone })}`);
  const dismissibleNotice = await evaluate(`(() => {
    const notices = Array.from(document.querySelectorAll('.toast:not(.toast-error)'));
    const notice = notices.at(-1);
    return notice ? { text: notice.textContent ?? '', close: Boolean(notice.querySelector('.toast-close')) } : null;
  })()`);
  if (!dismissibleNotice?.close) throw new Error(`Non-error notice is not manually dismissible: ${JSON.stringify(dismissibleNotice)}`);
  await sleep(4_000);
  await waitFor(`Array.from(document.querySelectorAll('.toast')).some((notice) => (notice.textContent ?? '') === ${JSON.stringify(dismissibleNotice.text)})`);
  const dismissed = await evaluate(`(() => { const text = ${JSON.stringify(dismissibleNotice.text)}; const notice = Array.from(document.querySelectorAll('.toast')).find((item) => (item.textContent ?? '') === text); const close = notice?.querySelector('.toast-close'); if (!(close instanceof HTMLButtonElement)) return false; close.click(); return true; })()`);
  if (!dismissed) throw new Error("Notice close button could not be activated");
  await waitFor(`!Array.from(document.querySelectorAll('.toast')).some((notice) => (notice.textContent ?? '') === ${JSON.stringify(dismissibleNotice.text)})`);
  const finalScreenshot = await screenshot("session-tree-complete.png");
  let darkScreenshot = "";
  if (stressEntries > 0) {
    for (let attempt = 0; attempt < 3 && !await evaluate(`document.querySelector('.app-shell')?.classList.contains('dark')`); attempt += 1) {
      await evaluate(`(() => { const button = Array.from(document.querySelectorAll('.titlebar-actions button')).find((item) => /主题|theme/i.test(item.getAttribute('aria-label') ?? '')); if (!button) return false; button.click(); return true; })()`);
      await sleep(100);
    }
    await waitFor(`document.querySelector('.app-shell')?.classList.contains('dark')`);
    await typeCommand("/tree");
    darkScreenshot = await screenshot("session-tree-open-dark.png");
    await click(".session-branch-header .icon-button");
  }
  process.stdout.write(`UI_SESSION_TREE_SMOKE_PASS ${treeOpenMs}ms ${stressEntries} stress entries\n${treeScreenshot}\n${finalScreenshot}${darkScreenshot ? `\n${darkScreenshot}` : ""}\n`);
} finally {
  socket.close();
}
