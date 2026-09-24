import path from "node:path";

function quotePath(filePath: string): string {
  if (/[\r\n\0]/.test(filePath)) throw new Error("External editor paths cannot contain control characters");
  if (!filePath.includes('"')) return `"${filePath}"`;
  if (!filePath.includes("'")) return `'${filePath}'`;
  throw new Error("External editor paths cannot contain both quote characters");
}

export function externalEditorCommandForPath(filePath: string, platform: NodeJS.Platform = process.platform): string {
  const quotedPath = quotePath(filePath);
  return platform === "darwin" && path.extname(filePath).toLowerCase() === ".app"
    ? `open -W -a ${quotedPath}`
    : quotedPath;
}
