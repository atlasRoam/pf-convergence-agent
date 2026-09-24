import { fork } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedAgentCoreVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).dependencies["@earendil-works/pi-coding-agent"];

function findAsarFiles(directory) {
  if (!existsSync(directory)) return [];
  const results = [];
  for (const entry of readdirSync(directory)) {
    const candidate = path.join(directory, entry);
    const stat = statSync(candidate);
    if (stat.isDirectory()) results.push(...findAsarFiles(candidate));
    else if (entry === "app.asar") results.push(candidate);
  }
  return results;
}

function packagedExecutable(asarPath) {
  const normalized = asarPath.replaceAll("\\", "/");
  const macMarker = ".app/Contents/Resources/app.asar";
  const macIndex = normalized.indexOf(macMarker);
  if (macIndex >= 0) {
    const appPath = normalized.slice(0, macIndex + ".app".length);
    return path.join(appPath, "Contents", "MacOS", "PFSAA");
  }
  const resourcesDir = path.dirname(asarPath);
  return path.join(path.dirname(resourcesDir), "PFSAA.exe");
}

function smokeOne(asarPath) {
  const executable = packagedExecutable(asarPath);
  if (!existsSync(executable)) throw new Error(`Could not locate packaged executable for ${asarPath}`);
  const hostPath = path.join(asarPath, "packages", "pfsaa-host", "dist", "index.js");
  const childEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: "1", PFSAA_HOST_PROCESS: "1" };
  delete childEnvironment.PFSAA_RUNTIME_MODULE;
  delete childEnvironment.PIDECK_PI_GLOBAL_ROOT;

  return new Promise((resolve, reject) => {
    let stderr = "";
    let requested = false;
    let settled = false;
    const child = fork(hostPath, [], {
      execPath: executable,
      env: childEnvironment,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      child.kill();
      if (error) reject(new Error(`${error.message}${stderr ? `\n${stderr.trim()}` : ""}`));
      else resolve();
    };
    const timer = globalThis.setTimeout(() => finish(new Error(`Packaged PfsaaHost smoke timed out: ${asarPath}`)), 30_000);
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, signal) => {
      if (!settled) finish(new Error(`Packaged PfsaaHost exited before completing smoke (code ${code ?? "null"}, signal ${signal ?? "none"})`));
    });
    child.on("message", (message) => {
      if (message?.type === "runtime.status" && message.payload === "connected" && !requested) {
        requested = true;
        child.send({ id: "runtime-status", command: "runtime.status" });
        return;
      }
      if (message?.id === "runtime-status") {
        if (!message.ok || message.result !== "connected") {
          finish(new Error(`Unexpected runtime.status response: ${JSON.stringify(message)}`));
          return;
        }
        child.send({ id: "app-info", command: "app.info" });
        return;
      }
      if (message?.id === "app-info") {
        if (!message.ok || message.result?.version !== expectedAgentCoreVersion) {
          finish(new Error(`Packaged AgentCore SDK mismatch: expected ${expectedAgentCoreVersion}, received ${JSON.stringify(message)}`));
          return;
        }
        finish();
      }
    });
  });
}

const releaseRoot = path.resolve(process.argv[2] ?? "release");
const asarFiles = findAsarFiles(releaseRoot);
if (!asarFiles.length) throw new Error(`No app.asar found under ${releaseRoot}`);
for (const asarPath of asarFiles) {
  await smokeOne(asarPath);
  process.stdout.write(`Packaged PfsaaHost smoke passed: ${asarPath}\n`);
}
