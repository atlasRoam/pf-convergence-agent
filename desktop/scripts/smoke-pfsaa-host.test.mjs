import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { pfsaaHostEnvironment, pfsaaPaths } from "../apps/desktop/src/main/pfsaa-runtime.ts";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostEntry = process.env.PFSAA_HOST_ENTRY || path.join(desktop, "packages/pfsaa-host/dist/index.js");

function isolatedProject(t, { includeSkills = true, useSourceDirectory = Boolean(process.env.PFSAA_SOURCE_DIR), createRuntime = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pfsaa-desktop-smoke-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = pfsaaPaths(root, root);
  if (createRuntime) mkdirSync(paths.runtime, { recursive: true });
  if (process.env.PFSAA_SOURCE_DIR && useSourceDirectory) {
    symlinkSync(path.resolve(process.env.PFSAA_SOURCE_DIR), path.join(root, "source"), process.platform === "win32" ? "junction" : "dir");
  } else {
    const sdk = path.join(desktop, "node_modules/@earendil-works/pi-coding-agent/dist");
    mkdirSync(path.dirname(path.dirname(paths.sdk)), { recursive: true });
    symlinkSync(sdk, path.dirname(paths.sdk), process.platform === "win32" ? "junction" : "dir");
    const fixtures = [
      [paths.tsconfig, "{}\n"],
      [paths.guard, "export default function () {}\n"],
    ];
    if (includeSkills) {
      fixtures.push(
        [paths.router, "---\nname: compute-engine\ndescription: Test router\n---\n"],
        [paths.adjustment, "---\nname: powerflow-manual-adjustment\ndescription: Test adjustment\n---\n"],
      );
    }
    for (const [file, content] of fixtures) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  return paths;
}

async function startHost(t, paths) {
  const environment = pfsaaHostEnvironment(desktop, { ...process.env, PFSAA_PROJECT_ROOT: paths.root, PFSAA_USE_SYSTEM_PROXY: "0" });
  const child = fork(hostEntry, [], { cwd: paths.runtime, env: environment, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  child.stderr.on("data", (data) => { output += data.toString(); });
  const waitForReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host did not start: ${output}`)), 20_000);
    child.on("message", (message) => {
      if (message.type === "runtime.status" && message.payload === "connected") {
        clearTimeout(timer);
        resolve();
      }
      if (message.type === "runtime.error") {
        clearTimeout(timer);
        reject(new Error(String(message.payload?.message)));
      }
    });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Host exited (${code}): ${output}`)); });
  });
  await waitForReady;
  let id = 0;
  return {
    child,
    request(command, payload) {
      return new Promise((resolve, reject) => {
        const requestId = `smoke-${++id}`;
        const timer = setTimeout(() => reject(new Error(`${command} timed out: ${output}`)), 20_000);
        const onMessage = (message) => {
          if (message.id !== requestId) return;
          child.off("message", onMessage);
          clearTimeout(timer);
          if (message.ok) resolve(message.result);
          else reject(new Error(String(message.error)));
        };
        child.on("message", onMessage);
        child.send({ id: requestId, command, payload });
      });
    },
    async stop() {
      await this.request("runtime.shutdown");
      child.kill();
    },
  };
}

test("Host restores the same isolated PFSAA session without scanning another workspace", async (t) => {
  const paths = isolatedProject(t);
  const sdk = await import(pathToFileURL(paths.sdk).href);
  const persisted = sdk.SessionManager.create(paths.runtime, paths.sessionDir);
  persisted.appendSessionInfo("PFSAA saved offline check");
  persisted.appendMessage({ role: "user", content: "offline check", timestamp: Date.now() });
  persisted.appendMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now(), api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const first = await startHost(t, paths);
  const projects = await first.request("projects.list", { knownCwds: [path.dirname(paths.runtime)] });
  assert.deepEqual(projects.map(({ cwd }) => cwd), [paths.runtime]);
  assert.equal(projects[0].taskCount, 1);
  assert.equal((await first.request("workspace.snapshot", { cwd: paths.runtime })).files.length, 0);
  await assert.rejects(first.request("sessions.list", { cwd: path.dirname(paths.runtime) }), /configured runtime workspace/);

  const created = await first.request("sessions.create", { cwd: paths.runtime, name: "PFSAA offline check" });
  assert.ok(created.id);
  const capabilities = await first.request("sessions.capabilities", { taskId: created.id, cwd: paths.runtime });
  assert.equal(capabilities.changeReviewEnabled, false);
  const skills = capabilities.skills;
  assert.ok(skills.some(({ name }) => name === "skill:compute-engine"));
  assert.ok(skills.some(({ name }) => name === "skill:powerflow-manual-adjustment"));
  assert.ok((await first.request("sessions.list", { cwd: paths.runtime })).some(({ id }) => id === persisted.getSessionId()));
  await first.stop();

  const second = await startHost(t, paths);
  assert.ok((await second.request("sessions.list", { cwd: paths.runtime })).some(({ id }) => id === persisted.getSessionId()));
  assert.equal((await second.request("sessions.stats", { taskId: persisted.getSessionId(), cwd: paths.runtime })).userMessages, 1);
  assert.ok((await second.request("sessions.messages", { taskId: persisted.getSessionId(), cwd: paths.runtime })).length > 0);
  await second.stop();
});

test("Host starts without private project Skills and creates its local runtime", async (t) => {
  const paths = isolatedProject(t, { includeSkills: false, useSourceDirectory: false, createRuntime: false });
  const host = await startHost(t, paths);
  assert.equal(existsSync(paths.runtime), true);
  const created = await host.request("sessions.create", { cwd: paths.runtime, name: "PFSAA without private Skills" });
  const capabilities = await host.request("sessions.capabilities", { taskId: created.id, cwd: paths.runtime });
  assert.ok(!capabilities.skills.some(({ name }) => name === "skill:compute-engine"));
  assert.ok(!capabilities.skills.some(({ name }) => name === "skill:powerflow-manual-adjustment"));
  await host.stop();
});

test("Host manages, probes, and edits PFSAA Providers through AgentCore and an isolated local endpoint", async (t) => {
  const paths = isolatedProject(t);
  const host = await startHost(t, paths);
  const initialProviders = await host.request("providers.list", {});
  const external = initialProviders.find((provider) => !provider.isCustom);
  assert.ok(external, "the AgentCore runtime should expose at least one built-in Provider");

  const hidden = await host.request("providers.remove", { providerId: external.id });
  assert.deepEqual(hidden, { providerId: external.id, action: "hidden" });
  assert.ok(!(await host.request("providers.list", {})).some((provider) => provider.id === external.id));
  assert.ok((await host.request("providers.listHidden", {})).some((provider) => provider.id === external.id));
  await host.request("providers.restore", { providerId: external.id });
  assert.ok((await host.request("providers.list", {})).some((provider) => provider.id === external.id));

  const created = await host.request("providers.create", {
    name: "Offline gateway",
    baseUrl: "https://models.example.test/v1/",
    models: [{ id: "offline-model", name: "Offline model" }, { id: "offline-model-2", name: "Second offline model" }],
    apiKey: "offline-key",
  });
  assert.equal(created.id, "pfsaa-offline-gateway");
  assert.equal(created.isCustom, true);
  assert.equal(created.authState, "configured");
  const models = JSON.parse(readFileSync(path.join(paths.agentDir, "models.json"), "utf8"));
  assert.equal(models.providers[created.id].baseUrl, "https://models.example.test/v1");
  assert.deepEqual(models.providers[created.id].models, [
    { id: "offline-model", name: "Offline model" },
    { id: "offline-model-2", name: "Second offline model" },
  ]);

  const discoveryRequests = [];
  const discoveryServer = createServer((request, response) => {
    discoveryRequests.push({ authorization: request.headers.authorization, url: request.url });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "discovered-a", name: "Discovered A" }, { id: "discovered-b" }] }));
  });
  await new Promise((resolve) => discoveryServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => discoveryServer.close(resolve)));
  const discoveryUrl = `http://127.0.0.1:${discoveryServer.address().port}/v1`;
  const discovered = await host.request("providers.discoverModels", { providerId: created.id, baseUrl: discoveryUrl });
  assert.deepEqual(discovered, [{ id: "discovered-a", name: "Discovered A" }, { id: "discovered-b", name: "discovered-b" }]);
  assert.deepEqual(discoveryRequests, [{ authorization: "Bearer offline-key", url: "/v1/models" }]);

  const updated = await host.request("providers.update", {
    providerId: created.id,
    name: "Updated offline gateway",
    baseUrl: discoveryUrl,
    models: [{ id: "discovered-a", name: "Discovered A" }, { id: "discovered-b", name: "Discovered B" }],
  });
  assert.equal(updated.name, "Updated offline gateway");
  assert.equal(updated.modelCount, 2);
  assert.deepEqual(updated.models, [{ id: "discovered-a", name: "Discovered A" }, { id: "discovered-b", name: "Discovered B" }]);
  assert.equal(JSON.parse(readFileSync(path.join(paths.agentDir, "models.json"), "utf8")).providers[created.id].baseUrl, discoveryUrl);

  const removed = await host.request("providers.remove", { providerId: created.id });
  assert.deepEqual(removed, { providerId: created.id, action: "removed" });
  assert.ok(!(await host.request("providers.list", {})).some((provider) => provider.id === created.id));
  assert.equal(JSON.parse(readFileSync(path.join(paths.agentDir, "models.json"), "utf8")).providers?.[created.id], undefined);
  await host.stop();
});
