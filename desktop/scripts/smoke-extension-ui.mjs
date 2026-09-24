import { fork } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostPath = path.join(root, "packages", "pfsaa-host", "dist", "index.js");
const agentCoreModulePath = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
const runModelPrompt = process.argv.includes("--model");
const projectDir = mkdtempSync(path.join(os.tmpdir(), "pfsaa-extension-ui-smoke-"));
const isolatedAgentDir = runModelPrompt ? undefined : mkdtempSync(path.join(os.tmpdir(), "pfsaa-extension-ui-agent-"));
const extensionDir = path.join(projectDir, ".pi", "extensions");
mkdirSync(extensionDir, { recursive: true });
copyFileSync(
  path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "examples", "extensions", "rpc-demo.ts"),
  path.join(extensionDir, "rpc-demo.ts"),
);

let sequence = 0;
let taskId;
let stderr = "";
let extensionRequest;
let extensionNotification;
let extensionSettled = false;
let modelSettled = false;
const pending = new Map();
const presentationEvents = [];

const child = fork(hostPath, [], {
  cwd: root,
  env: {
    ...process.env,
    ...(isolatedAgentDir ? { PI_CODING_AGENT_DIR: isolatedAgentDir } : {}),
    PFSAA_HOST_PROCESS: "1",
    PFSAA_RUNTIME_MODULE: agentCoreModulePath,
  },
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});

child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
child.on("message", (message) => {
  if (message?.type === "runtime.status" && message.payload === "connected") resolveConnected();
  if (message?.type === "extension.ui.request" && message.event?.kind === "input") {
    extensionRequest = message.event;
    void request("extension.ui.resolve", { requestId: message.requestId, value: "PFSAA UI smoke" });
  }
  if (message?.type === "agent.event" && message.event?.type === "extension.ui.notify") {
    extensionNotification = message.event.message;
  }
  if (message?.type === "agent.event" && message.event?.type === "extension.ui.presentation") {
    presentationEvents.push(message.event);
  }
  if (message?.type === "agent.event" && message.event?.type === "agent_settled") {
    if (!extensionNotification) extensionSettled = true;
    else modelSettled = true;
  }
  const waiter = pending.get(message?.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(message.result);
  else waiter.reject(new Error(message.error ?? "PfsaaHost request failed"));
});

let resolveConnected;
const connected = new Promise((resolve) => { resolveConnected = resolve; });

function request(command, payload) {
  const id = `extension-ui-smoke-${++sequence}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.send({ id, command, payload });
  });
}

async function withTimeout(promise, label, milliseconds = 60_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  await withTimeout(connected, "PfsaaHost startup", 30_000);
  await request("projects.setTrust", { cwd: projectDir, trusted: true });
  const created = await request("sessions.create", { cwd: projectDir, name: "Extension UI smoke" });
  taskId = created.id;
  const capabilities = await request("sessions.capabilities", { taskId, cwd: projectDir });
  if (!capabilities.slashCommands?.some((command) => command.name === "rpc-input")) {
    throw new Error("rpc-input extension command was not loaded");
  }

  const extensionPromptResult = await withTimeout(request("agent.prompt", { taskId, cwd: projectDir, text: "/rpc-input", delivery: "followUp" }), "rpc-input prompt");
  if (!extensionRequest) throw new Error("rpc-input did not emit an input request");
  if (extensionNotification !== "You entered: PFSAA UI smoke") {
    throw new Error(`Unexpected extension notification: ${JSON.stringify(extensionNotification)}`);
  }
  if (extensionPromptResult?.disposition !== "extension-command") {
    throw new Error(`Unexpected extension prompt disposition: ${JSON.stringify(extensionPromptResult)}`);
  }
  process.stdout.write(`Extension UI prompt/resolve/notify passed; agent_settled=${extensionSettled}.\n`);

  rmSync(path.join(extensionDir, "rpc-demo.ts"), { force: true });
  presentationEvents.length = 0;
  const reloaded = await request("sessions.reload", { taskId, cwd: projectDir });
  if (reloaded.slashCommands?.some((command) => command.name === "rpc-input")) {
    throw new Error("rpc-input command remained after deleting the extension and reloading");
  }
  const resetIndex = presentationEvents.findIndex((event) => event.action === "reset");
  if (resetIndex < 0) {
    throw new Error(`Extension UI presentation was not reset during reload: ${JSON.stringify(presentationEvents)}`);
  }
  const presentationAfterReset = presentationEvents.slice(resetIndex + 1);
  if (presentationAfterReset.some((event) => event.action === "widget" || event.action === "title" && event.title === "RPC Extension UI Demo")) {
    throw new Error(`Deleted extension re-published presentation after reload: ${JSON.stringify(presentationAfterReset)}`);
  }
  process.stdout.write("Extension unload/reload presentation reset passed.\n");

  if (runModelPrompt) {
    const models = await request("models.list");
    const model = models.find((item) => item.providerId === "openai-codex" && item.id === "gpt-5.6-sol" && item.authConfigured)
      ?? models.find((item) => item.providerId === "openai-codex" && item.authConfigured && /5\.6/i.test(`${item.id} ${item.name}`));
    if (!model) throw new Error("No configured OpenAI Codex GPT-5.6 model was found");
    await request("agent.setModel", { taskId, cwd: projectDir, providerId: model.providerId, modelId: model.id });
    await withTimeout(request("agent.prompt", { taskId, cwd: projectDir, text: "Reply with exactly: PFSAA_SMOKE_OK", delivery: "followUp" }), "OpenAI model prompt", 180_000);
    const messages = await request("sessions.messages", { taskId, cwd: projectDir });
    const serialized = JSON.stringify(messages);
    if (!serialized.includes("PFSAA_SMOKE_OK")) throw new Error("OpenAI model response did not contain PFSAA_SMOKE_OK");
    process.stdout.write(`OpenAI model prompt passed with ${model.providerId}/${model.id}; agent_settled=${modelSettled}.\n`);
  }
} finally {
  if (taskId) {
    try { await withTimeout(request("sessions.delete", { taskId, cwd: projectDir }), "Smoke session cleanup", 10_000); } catch { /* Best-effort smoke cleanup. */ }
  }
  child.kill();
  rmSync(projectDir, { recursive: true, force: true });
  if (isolatedAgentDir) rmSync(isolatedAgentDir, { recursive: true, force: true });
  if (stderr.trim()) process.stderr.write(stderr);
}
