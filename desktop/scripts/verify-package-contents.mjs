import { listPackage } from "@electron/asar";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REQUIRED_PATHS = [
  "apps/desktop/dist/main/index.js",
  "apps/desktop/dist/preload/index.js",
  "packages/contracts/dist/index.js",
  "packages/pfsaa-host/dist/index.js",
  "dist-renderer/index.html",
  "LICENSE",
  "LICENSE.upstream-MIT",
  "NOTICE",
  "THIRD_PARTY_NOTICES.txt",
];

const FORBIDDEN_PATHS = [
  /^\.(?:claude|codex|pi|playwright-cli|workbuddy)(?:\/|$)/,
  /^apps\/desktop\/(?:src|scripts|native|public)(?:\/|$)/,
  /^packages\/[^/]+\/src(?:\/|$)/,
  /^node_modules\/@pfsaa\/[^/]+\/(?:src|tsconfig\.json)(?:\/|$)/,
  /^node_modules\/(?:@oxc-project|@rolldown|@vitejs|electron|lightningcss(?:-[^/]+)?|rolldown|vite)(?:\/|$)/,
  /^(?:docs|rules)(?:\/|$)/,
  /^(?:AGENTS|CLAUDE|CONTRIBUTING|SECURITY)\.md$/i,
  /^README(?:\.[^.]+)?\.md$/i,
];

function normalizeAsarPath(value) {
  return value.replace(/^[/\\]+/, "").replaceAll("\\", "/");
}

export function validatePackagePaths(rawPaths) {
  const paths = rawPaths.map(normalizeAsarPath);
  const missing = REQUIRED_PATHS.filter((required) => !paths.includes(required));
  const forbidden = paths.filter((candidate) => FORBIDDEN_PATHS.some((pattern) => pattern.test(candidate)));
  if (missing.length || forbidden.length) {
    const details = [
      missing.length ? `Missing runtime files:\n- ${missing.join("\n- ")}` : "",
      forbidden.length ? `Forbidden development files:\n- ${forbidden.slice(0, 30).join("\n- ")}` : "",
    ].filter(Boolean).join("\n");
    throw new Error(details);
  }
  return { fileCount: paths.length, requiredCount: REQUIRED_PATHS.length };
}

function findAsarFiles(root) {
  if (!existsSync(root)) return [];
  const results = [];
  for (const entry of readdirSync(root)) {
    const candidate = path.join(root, entry);
    const stat = statSync(candidate);
    if (stat.isDirectory()) results.push(...findAsarFiles(candidate));
    else if (entry === "app.asar") results.push(candidate);
  }
  return results;
}

export function verifyPackagedApplication(releaseRoot) {
  const candidates = findAsarFiles(releaseRoot);
  if (!candidates.length) throw new Error(`No app.asar found under ${releaseRoot}`);
  return candidates.map((asarPath) => {
    const resourcesDirectory = path.dirname(asarPath);
    const missingRuntimeLicenses = ["LICENSE.electron.txt", "LICENSES.chromium.html"]
      .filter((filename) => !existsSync(path.join(resourcesDirectory, filename)));
    if (missingRuntimeLicenses.length) {
      throw new Error(`Missing Electron runtime licenses beside app.asar:\n- ${missingRuntimeLicenses.join("\n- ")}`);
    }
    return {
      asarPath,
      ...validatePackagePaths(listPackage(asarPath)),
    };
  });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const releaseRoot = path.resolve(process.argv[2] ?? "release");
  for (const result of verifyPackagedApplication(releaseRoot)) {
    process.stdout.write(`Verified ${result.fileCount} packaged paths in ${result.asarPath}\n`);
  }
}
