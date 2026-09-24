import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(root, "package-lock.json");
const noticePath = path.join(root, "THIRD_PARTY_NOTICES.txt");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const packages = new Map();

function packageNameFromLockPath(lockEntryPath) {
  const marker = "node_modules/";
  const index = lockEntryPath.lastIndexOf(marker);
  return index < 0 ? "" : lockEntryPath.slice(index + marker.length);
}

function installedLicense(name) {
  const packagePath = path.join(root, "node_modules", ...name.split("/"), "package.json");
  if (!existsSync(packagePath)) return undefined;
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
    return typeof packageJson.license === "string" ? packageJson.license : undefined;
  } catch {
    return undefined;
  }
}

for (const [lockEntryPath, entry] of Object.entries(lock.packages ?? {})) {
  const packagedFramework = lockEntryPath === "node_modules/electron";
  if (!entry || typeof entry !== "object" || entry.link || (entry.dev === true && !packagedFramework) || typeof entry.version !== "string") continue;
  const name = packageNameFromLockPath(lockEntryPath);
  if (!name) continue;
  const license = typeof entry.license === "string" ? entry.license : installedLicense(name) ?? "SEE PACKAGE";
  packages.set(`${name}@${entry.version}`, { name, version: entry.version, license });
}

const rows = [...packages.values()]
  .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))
  .map(({ name, version, license }) => `${name}@${version} — ${license}\n  https://www.npmjs.com/package/${encodeURIComponent(name)}/v/${version}`);

const output = [
  "PFSAA Third-Party Notices",
  "==========================",
  "",
  "PFSAA additions are licensed under Apache-2.0; see LICENSE.",
  "The original desktop MIT copyright and license remain in LICENSE.upstream-MIT.",
  "The AgentCore source retains its original MIT copyright and license in ../source/LICENSE.",
  "The following bundled packages remain subject to their own licenses.",
  "This deterministic inventory is generated from package-lock.json.",
  "",
  ...rows,
  "",
].join("\n");

if (process.argv.includes("--check")) {
  // Git may check the file out with CRLF on Windows. Notices are stale only
  // when their content differs, not when the working-tree newline policy does.
  const current = existsSync(noticePath) ? readFileSync(noticePath, "utf8").replace(/\r\n?/g, "\n") : "";
  if (current !== output) {
    process.stderr.write("THIRD_PARTY_NOTICES.txt is stale. Run npm run notices:generate.\n");
    process.exitCode = 1;
  }
} else {
  writeFileSync(noticePath, output);
  process.stdout.write(`Wrote ${packages.size} package notices to ${path.relative(root, noticePath)}\n`);
}
