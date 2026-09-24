import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Real-provider acceptance matrix for AgentCore's network transports.
 *
 * The runner deliberately uses a copy of the configured AgentCore agent directory so
 * each cell can select its transport without touching the user's settings.
 * Set PFSAA_ACCEPTANCE_MODEL to an exact provider/model when more than one
 * GPT-5.5 model is configured.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostPath = path.join(root, "packages", "pfsaa-host", "dist", "index.js");
const agentCoreModulePath = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
const timeoutMs = Math.max(30_000, Number.parseInt(process.env.PFSAA_ACCEPTANCE_TIMEOUT_MS ?? process.env.PIDECK_ACCEPTANCE_TIMEOUT_MS ?? "180000", 10) || 180_000);
const transports = ["auto", "sse", "websocket", "websocket-cached"];

if (!existsSync(hostPath)) throw new Error("PfsaaHost build is missing. Run npm run build before network acceptance.");

const sdk = await import("@earendil-works/pi-coding-agent");
const sourceAgentDir = sdk.getAgentDir?.();
if (!sourceAgentDir || !existsSync(sourceAgentDir)) throw new Error("Configured AgentCore agent directory is unavailable");

function cloneAgentDir(transport) {
  const target = mkdtempSync(path.join(os.tmpdir(), `pfsaa-network-${transport}-`));
  cpSync(sourceAgentDir, target, { recursive: true });
  const settingsPath = path.join(target, "settings.json");
  const settings = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""))
    : {};
  settings.transport = transport;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  return target;
}

function configuredModel(modelList) {
  const exact = (process.env.PFSAA_ACCEPTANCE_MODEL ?? process.env.PIDECK_ACCEPTANCE_MODEL)?.trim();
  const candidates = modelList.filter((model) => model?.authConfigured === true && typeof model?.providerId === "string" && typeof model?.id === "string");
  if (exact) {
    const separator = exact.indexOf("/");
    const providerId = separator > 0 ? exact.slice(0, separator) : "";
    const modelId = separator > 0 ? exact.slice(separator + 1) : exact;
    const match = candidates.find((model) => model.providerId === providerId && model.id === modelId);
    if (!match) throw new Error(`Configured acceptance model ${exact} was not found or is not authenticated`);
    return match;
  }
  const matches = candidates.filter((model) => /gpt[- ]?5\.5/i.test(`${model.providerId}/${model.id} ${model.name ?? ""}`));
  if (matches.length === 0) {
    const visible = candidates.map((model) => `${model.providerId}/${model.id}`).slice(0, 20);
    throw new Error(`No authenticated GPT-5.5 model was found. Set PFSAA_ACCEPTANCE_MODEL=provider/model if needed. Available authenticated models: ${visible.join(", ") || "none"}`);
  }
  if (matches.length > 1) {
    throw new Error(`More than one authenticated GPT-5.5 model was found. Set PFSAA_ACCEPTANCE_MODEL explicitly: ${matches.map((model) => `${model.providerId}/${model.id}`).join(", ")}`);
  }
  return matches[0];
}

function createHost(agentDir) {
  const child = fork(hostPath, [], {
    cwd: root,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PFSAA_HOST_PROCESS: "1", PFSAA_RUNTIME_MODULE: agentCoreModulePath },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let sequence = 0;
  let stderr = "";
  let settled = false;
  const pending = new Map();
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let connectedResolve;
  let connectedReject;
  const connected = new Promise((resolve, reject) => { connectedResolve = resolve; connectedReject = reject; });
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  child.on("message", (message) => {
    if (message?.type === "runtime.status" && message.payload === "connected") connectedResolve();
    const waiter = pending.get(message?.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error ?? "PfsaaHost request failed"));
  });
  child.on("error", (error) => {
    connectedReject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  child.on("exit", (code, signal) => {
    const error = new Error(`PfsaaHost exited (code ${code ?? "null"}, signal ${signal ?? "none"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    if (!settled) connectedReject(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });

  async function request(command, payload, requestTimeoutMs = timeoutMs) {
    const id = `network-acceptance-${++sequence}`;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${command} timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      if (!child.connected) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new Error(`PfsaaHost is not connected while sending ${command}`));
        return;
      }
      child.send({ id, command, payload }, (error) => {
        if (!error) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      });
    });
  }

  return {
    async start() { await Promise.race([connected, new Promise((_, reject) => setTimeout(() => reject(new Error("PfsaaHost startup timed out")), 30_000))]); },
    request,
    async stop() {
      settled = true;
      if (!child.killed) child.kill();
      await exited;
    },
  };
}

async function runCell(transport) {
  const agentDir = cloneAgentDir(transport);
  const workspace = mkdtempSync(path.join(os.tmpdir(), `pfsaa-network-workspace-${transport}-`));
  const host = createHost(agentDir);
  let taskId;
  const startedAt = Date.now();
  try {
    await host.start();
    const settings = await host.request("settings.get", { cwd: workspace });
    assert.equal(settings.transport, transport, `PfsaaHost did not load ${transport} transport`);
    const models = await host.request("models.list");
    const model = configuredModel(models);
    await host.request("projects.setTrust", { cwd: workspace, trusted: true });
    const session = await host.request("sessions.create", { cwd: workspace, name: `Network acceptance ${transport}` });
    taskId = session.id;
    const selected = await host.request("agent.setModel", { taskId, cwd: workspace, providerId: model.providerId, modelId: model.id });
    assert.equal(selected.providerId, model.providerId);
    assert.equal(selected.modelId, model.id);
    const token = `PFSAA_NETWORK_${transport.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_OK`;
    const prompt = `Reply with exactly ${token}. Do not call tools, change files, or add any other text.`;
    const response = await host.request("agent.prompt", { taskId, cwd: workspace, text: prompt }, timeoutMs);
    assert.equal(response.disposition, "completed");
    const messages = await host.request("sessions.messages", { taskId, cwd: workspace });
    const serialized = JSON.stringify(messages);
    assert.match(serialized, new RegExp(token));
    if (transport === "websocket" && serialized.includes("provider_transport_failure")) {
      throw new Error("Explicit websocket transport fell back to SSE (provider_transport_failure diagnostic)");
    }
    if (transport === "websocket-cached") {
      const secondToken = `${token}_SECOND`;
      const secondResponse = await host.request("agent.prompt", { taskId, cwd: workspace, text: `Reply with exactly ${secondToken}. Do not call tools.` }, timeoutMs);
      assert.equal(secondResponse.disposition, "completed");
      const secondMessages = await host.request("sessions.messages", { taskId, cwd: workspace });
      const secondSerialized = JSON.stringify(secondMessages);
      assert.match(secondSerialized, new RegExp(secondToken));
      if (secondSerialized.includes("provider_transport_failure")) {
        throw new Error("Explicit websocket-cached transport fell back to SSE (provider_transport_failure diagnostic)");
      }
    }
    return { transport, status: "PASS", model: `${model.providerId}/${model.id}`, durationMs: Date.now() - startedAt };
  } finally {
    if (taskId) {
      try { await host.request("sessions.delete", { taskId, cwd: workspace }, 15_000); } catch { /* Best-effort cleanup. */ }
    }
    await host.stop();
    rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const results = [];
for (const transport of transports) {
  process.stdout.write(`BEGIN network transport=${transport}\n`);
  try {
    const result = await runCell(transport);
    results.push(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const result = { transport, status: "FAIL", error: error instanceof Error ? error.message : String(error) };
    results.push(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}

process.stdout.write(`NETWORK_ACCEPTANCE_MATRIX ${JSON.stringify(results)}\n`);
if (results.some((result) => result.status !== "PASS")) process.exitCode = 1;
