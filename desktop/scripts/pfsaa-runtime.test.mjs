import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mergeWslPathEnvironment, pfsaaHostEnvironment, pfsaaPaths } from "../apps/desktop/src/main/pfsaa-runtime.ts";
import { assertPfsaaCwd, pfsaaResourceOptions, pfsaaRuntime } from "../packages/pfsaa-host/src/pfsaa-runtime.ts";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pfsaa-desktop-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = pfsaaPaths(root, root);
  for (const file of [paths.sdk, paths.guard, paths.router, paths.adjustment, paths.tsconfig, paths.python]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "");
  }
  mkdirSync(paths.runtime, { recursive: true });
  return paths;
}

test("desktop uses only the PFSAA runtime, resources and existing flat session directory", (t) => {
  const paths = fixture(t);
  assert.equal(pfsaaPaths(path.join(paths.root, "desktop/apps/desktop/dist/main")).root, paths.root);
  const env = pfsaaHostEnvironment(paths.root, { PFSAA_PROJECT_ROOT: paths.root, PIDECK_PI_MODULE: "wrong" });
  const runtime = pfsaaRuntime(env);
  assert.ok(runtime);
  assert.equal(env.PFSAA_PROJECT_ROOT, paths.root);
  assert.equal(env.PFSAA_RUNTIME_MODULE, paths.sdk);
  assert.equal(env.PFSAA_WORKSPACE_CWD, paths.runtime);
  assert.equal(env.PIDECK_PI_MODULE, "wrong");
  assert.equal(env.AGENTCORE_AGENT_DIR, paths.agentDir);
  assert.equal(env.AGENTCORE_SESSION_DIR, paths.sessionDir);
  assert.equal(env.PI_CODING_AGENT_DIR, paths.agentDir);
  assert.equal(env.AGENTCORE_OFFLINE, "1");
  assert.equal(env.TSX_TSCONFIG_PATH, paths.tsconfig);
  assert.equal(env.PFSAA_PYTHON, paths.python);
  assert.equal(runtime.sessionDir, paths.sessionDir);
  const resources = pfsaaResourceOptions(runtime, paths.runtime, paths.agentDir, {});
  assert.deepEqual(resources.additionalExtensionPaths, [paths.guard]);
  assert.deepEqual(resources.additionalSkillPaths, [paths.router, paths.adjustment]);
  assert.equal(resources.noExtensions, true);
  assert.equal(resources.noSkills, true);
  assert.equal(resources.noPromptTemplates, true);
  assert.equal(resources.noContextFiles, true);
  assert.deepEqual(resources.extensionFactories, []);
});

test("desktop starts without bundled Skills and forwards only Skills supplied locally", (t) => {
  const paths = fixture(t);
  rmSync(paths.router);

  const partialEnvironment = pfsaaHostEnvironment(paths.root, { PFSAA_PROJECT_ROOT: paths.root });
  const partialRuntime = pfsaaRuntime(partialEnvironment);
  assert.deepEqual(partialRuntime.skills, [paths.adjustment]);
  assert.deepEqual(pfsaaResourceOptions(partialRuntime, paths.runtime, paths.agentDir, {}).additionalSkillPaths, [paths.adjustment]);

  rmSync(paths.adjustment);
  rmSync(paths.runtime, { recursive: true, force: true });
  const environment = pfsaaHostEnvironment(paths.root, { PFSAA_PROJECT_ROOT: paths.root });
  const runtime = pfsaaRuntime(environment);
  assert.deepEqual(runtime.skills, []);
  assert.deepEqual(pfsaaResourceOptions(runtime, paths.runtime, paths.agentDir, {}).additionalSkillPaths, []);
  assert.equal(existsSync(paths.runtime), true);
});

test("WSL path propagation preserves unrelated variables and replaces stale product paths", () => {
  const environment = mergeWslPathEnvironment({
    WSLENV: "EXISTING/u:agentcore_runtime_cwd/u:KEEP/p",
    AGENTCORE_RUNTIME_CWD: "C:\\project\\runtime",
    PFSAA_PYTHON: "C:\\project\\runtime\\python.exe",
  }, ["AGENTCORE_RUNTIME_CWD", "PFSAA_PYTHON"]);
  assert.equal(
    environment.WSLENV,
    "EXISTING/u:KEEP/p:AGENTCORE_RUNTIME_CWD/p:PFSAA_PYTHON/p",
  );
});

test("Windows passes PFSAA paths to the system WSL Bash", { skip: process.platform !== "win32" }, (t) => {
  const bash = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "bash.exe");
  if (!existsSync(bash)) return t.skip("system WSL Bash is unavailable");

  const environment = mergeWslPathEnvironment({
    ...process.env,
    AGENTCORE_RUNTIME_CWD: "D:\\pfsaa-wsl-test\\runtime",
    PFSAA_PYTHON: "D:\\pfsaa-wsl-test\\runtime\\python.exe",
  }, ["AGENTCORE_RUNTIME_CWD", "PFSAA_PYTHON"]);
  const result = spawnSync(
    bash,
    ["-s"],
    {
      encoding: "utf8",
      env: environment,
      input: "printf '%s\\n%s\\n' \"$AGENTCORE_RUNTIME_CWD\" \"$PFSAA_PYTHON\"",
      windowsHide: true,
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
    "/mnt/d/pfsaa-wsl-test/runtime",
    "/mnt/d/pfsaa-wsl-test/runtime/python.exe",
  ]);
});

test("desktop keeps legacy project-root input readable while emitting PFSAA configuration", (t) => {
  const paths = fixture(t);
  const runtime = pfsaaRuntime({ PFCA_PROJECT_ROOT: paths.root });
  const environment = pfsaaHostEnvironment(paths.root, { PFCA_PROJECT_ROOT: paths.root });
  assert.equal(runtime.runtime, paths.runtime);
  assert.equal(environment.PFSAA_PROJECT_ROOT, paths.root);
  assert.equal(environment.PFSAA_RUNTIME_MODULE, paths.sdk);
  assert.equal(environment.PFSAA_WORKSPACE_CWD, paths.runtime);
});

test("desktop refuses another workspace and an unbuilt PFSAA runtime", (t) => {
  const paths = fixture(t);
  const runtime = pfsaaRuntime({ PFSAA_PROJECT_ROOT: paths.root });
  assert.throws(() => assertPfsaaCwd(path.dirname(paths.runtime), runtime), /configured runtime workspace/);
  assert.throws(() => pfsaaResourceOptions(runtime, path.dirname(paths.runtime), paths.agentDir, {}), /configured runtime workspace/);
  rmSync(paths.sdk);
  assert.throws(() => pfsaaHostEnvironment(paths.root, { PFSAA_PROJECT_ROOT: paths.root }), /PFSAA 运行组件缺失：sdk/);
});
