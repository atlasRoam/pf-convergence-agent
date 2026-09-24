import path from "node:path";

interface IpcSenderLike {
  sender: unknown;
  senderFrame: unknown;
}

interface TrustedWindowLike {
  isDestroyed(): boolean;
  webContents: {
    mainFrame: unknown;
  };
}

function cwdKey(cwd: string, platform: NodeJS.Platform): string {
  const normalized = path.resolve(cwd);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function assertTrustedIpcSender(event: IpcSenderLike, window: TrustedWindowLike | undefined): void {
  if (
    !window
    || window.isDestroyed()
    || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error("Rejected IPC request from an untrusted renderer");
  }
}

export function assertKnownProjectCwd(
  cwd: string | undefined,
  knownCwds: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (cwd === undefined) return undefined;
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("A project directory is required");
  const key = cwdKey(cwd, platform);
  const known = knownCwds.find((candidate) => cwdKey(candidate, platform) === key);
  if (!known) throw new Error("The requested directory is not an open desktop project");
  return path.resolve(known);
}
