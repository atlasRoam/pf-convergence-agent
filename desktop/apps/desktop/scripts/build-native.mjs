import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") process.exit(0);

const packageRoot = resolve(import.meta.dirname, "..");
const source = resolve(packageRoot, "native/miniwindow.mm");
const output = resolve(packageRoot, "assets/pfsaa-miniwindow.node");
const nodeInclude = resolve(dirname(process.execPath), "../include/node");

if (!existsSync(resolve(nodeInclude, "node_api.h"))) {
  throw new Error(`Node headers were not found at ${nodeInclude}`);
}

mkdirSync(dirname(output), { recursive: true });
const result = spawnSync("clang++", [
  "-std=c++17",
  "-fobjc-arc",
  "-mmacosx-version-min=12.0",
  "-bundle",
  "-undefined",
  "dynamic_lookup",
  "-framework",
  "AppKit",
  "-framework",
  "Foundation",
  "-framework",
  "CoreGraphics",
  `-I${nodeInclude}`,
  source,
  "-o",
  output,
], { stdio: "inherit" });

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
