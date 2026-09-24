import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const entry = path.join(root, "packages", "pfsaa-host", "dist", "cli.js");
const agentCoreModule = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const expectedVersion = packageJson.dependencies["@earendil-works/pi-coding-agent"];

function run(args, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: root,
      env: { ...process.env, PI_OFFLINE: "1", PFSAA_RUNTIME_MODULE: agentCoreModule },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PFSAA CLI smoke timed out: ${args.join(" ")}`));
    }, 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });
}

const version = await run(["--version"]);
assert.equal(version.code, 0, version.stderr);
assert.equal(version.stdout.trim(), expectedVersion);

const help = await run(["--help"]);
assert.equal(help.code, 0, help.stderr);
for (const capability of ["--print, -p", "--mode <mode>", "text (default), json, or rpc", "pi auth <command>"]) {
  assert.match(help.stdout, new RegExp(capability.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

const authHelp = await run(["auth", "print-api-key", "--help"]);
assert.equal(authHelp.code, 0, authHelp.stderr);
assert.match(authHelp.stdout, /auth print-api-key/);
assert.match(authHelp.stdout, /auth print-bearer-token/);

const rpc = await run([
  "--mode", "rpc", "--no-session", "--offline", "--no-extensions",
  "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
], `${JSON.stringify({ id: "smoke", type: "get_state" })}\n`);
assert.equal(rpc.code, 0, rpc.stderr);
const response = rpc.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).find((message) => message.id === "smoke");
assert.equal(response?.type, "response");
assert.equal(response?.command, "get_state");
assert.equal(response?.success, true);

process.stdout.write(`PFSAA CLI compatibility smoke passed with runtime ${expectedVersion}.\n`);
