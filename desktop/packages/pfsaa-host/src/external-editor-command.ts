import { existsSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type PathAlias = (targetPath: string) => string | undefined;

export function replaceQuotedAbsolutePaths(command: string, platform: NodeJS.Platform, aliasPath: PathAlias): string {
  if (platform === "win32") return command;
  return command.replace(/(["'])(.*?)\1/g, (token, _quote: string, candidate: string) => {
    if (!path.posix.isAbsolute(candidate)) return token;
    return aliasPath(candidate) ?? token;
  });
}

export async function withExternalEditorPathAliases<T>(command: string, run: (adaptedCommand: string) => Promise<T>): Promise<T> {
  if (process.platform === "win32" || !/["']/.test(command)) return run(command);
  const tempRoot = existsSync("/tmp") ? "/tmp" : os.tmpdir();
  if (/\s/.test(tempRoot)) throw new Error("Cannot safely launch an editor from a temporary directory containing spaces");
  let aliasDirectory: string | undefined;
  let aliasIndex = 0;
  const adaptedCommand = replaceQuotedAbsolutePaths(command, process.platform, (targetPath) => {
    if (!existsSync(targetPath)) return undefined;
    aliasDirectory ??= mkdtempSync(path.join(tempRoot, "pfsaa-editor-"));
    const extension = path.extname(targetPath).toLowerCase() === ".app" ? ".app" : "";
    const alias = path.join(aliasDirectory, `target-${aliasIndex++}${extension}`);
    symlinkSync(targetPath, alias, statSync(targetPath).isDirectory() ? "dir" : "file");
    return alias;
  });
  try {
    return await run(adaptedCommand);
  } finally {
    if (aliasDirectory) rmSync(aliasDirectory, { recursive: true, force: true });
  }
}
