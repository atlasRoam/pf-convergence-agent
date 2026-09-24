import type {
  SessionChangeFile,
  SessionChangeHunkResolutionAction,
  SessionChangeReview,
  SessionChangeReviewMergeSource,
  SessionChangeReviewUnavailableReason,
} from "@pfsaa/contracts";
import { applyPatch, parsePatch, reversePatch, type StructuredPatch } from "diff";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, open, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const MAX_REVIEW_FILES = 200;
export const MAX_REVIEW_CAPTURE_PATHS = 400;
export const MAX_REVIEW_FILE_BYTES = 750_000;
export const MAX_REVIEW_BASELINE_CONTENT_BYTES = 20_000_000;
export const MAX_REVIEW_PATCH_BYTES = 250_000;
export const MAX_REVIEW_TOTAL_PATCH_BYTES = 1_000_000;
const GIT_TIMEOUT_MS = 15_000;
const SNAPSHOT_CONCURRENCY = 8;

type WorkspaceTextSnapshot = {
  absolutePath: string;
  exists: boolean;
  content: string;
  revision: string;
  mode: number;
};

export type WorkspaceReviewMutation = {
  action: SessionChangeHunkResolutionAction;
  hunkIndexes: number[];
  rollback: () => Promise<void>;
};

type FileSnapshot = {
  exists: boolean;
  content?: Buffer;
  digest?: string;
  binary: boolean;
  truncated: boolean;
  mode?: string;
};

export interface WorkspaceChangeState {
  cwd: string;
  repoRoot: string;
  scopePrefix: string;
  head?: string;
  dirtyFiles: Map<string, FileSnapshot>;
  renames: Map<string, string>;
  captureTruncated: boolean;
}

export type WorkspaceChangeInspection =
  | { status: "available"; state: WorkspaceChangeState }
  | { status: "not-git" }
  | { status: "error"; reason: SessionChangeReviewUnavailableReason };

type GenerateUnifiedPatch = (filePath: string, oldContent: string, newContent: string, contextLines?: number) => string;
type GitNameState = { paths: string[]; renames: Map<string, string>; modes: Map<string, string>; truncated: boolean };

type CommandError = Error & { code?: string | number; killed?: boolean; stderr?: string | Buffer };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Review capture aborted");
}

function execFileBuffer(file: string, args: string[], maxBuffer = 4 * 1024 * 1024, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      encoding: "buffer",
      maxBuffer,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      signal,
    }, (error, stdout, stderr) => {
      if (error) {
        const commandError = error as CommandError;
        commandError.stderr = stderr;
        reject(commandError);
      } else resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
    });
  });
}

async function git(repoRoot: string, args: string[], maxBuffer?: number, signal?: AbortSignal): Promise<Buffer> {
  return execFileBuffer("git", ["-C", repoRoot, ...args], maxBuffer, signal);
}

function inspectionFailure(error: unknown): Exclude<WorkspaceChangeInspection, { status: "available" }> {
  const commandError = error as CommandError;
  const stderr = Buffer.isBuffer(commandError?.stderr) ? commandError.stderr.toString("utf8") : String(commandError?.stderr ?? "");
  const message = `${commandError?.message ?? ""}\n${stderr}`;
  if (/not a git repository/i.test(message)) return { status: "not-git" };
  if (commandError?.code === "ENOENT") return { status: "error", reason: "git-not-found" };
  if (commandError?.killed || /timed out|timeout/i.test(message)) return { status: "error", reason: "git-timeout" };
  return { status: "error", reason: "git-inspection-failed" };
}

export async function inspectGitWorkspaceAvailability(
  cwd: string,
  signal?: AbortSignal,
): Promise<{ status: "available" } | { status: "not-git" } | { status: "error"; reason: SessionChangeReviewUnavailableReason }> {
  try {
    await execFileBuffer("git", ["-C", path.resolve(cwd), "rev-parse", "--show-toplevel"], 256 * 1024, signal);
    return { status: "available" };
  } catch (error) {
    if (signal?.aborted && signal.reason instanceof Error) {
      if (signal.reason.name === "TimeoutError") return { status: "error", reason: "git-timeout" };
      throw error;
    }
    return inspectionFailure(error);
  }
}

function posixPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function parseNulPaths(output: Buffer): string[] {
  return output.toString("utf8").split("\0").filter(Boolean).map(posixPath);
}

function scopedPath(repoPathValue: string, scopePrefix: string): string | undefined {
  const normalized = posixPath(repoPathValue);
  if (!scopePrefix) return normalized;
  const prefix = `${scopePrefix}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : undefined;
}

function repoPath(relativePath: string, scopePrefix: string): string {
  return scopePrefix ? `${scopePrefix}/${relativePath}` : relativePath;
}

function safeRelativePath(value: string): boolean {
  if (!value || value.includes("\0") || path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) return false;
  return !value.split("/").some((part) => part === "..");
}

function contentRevision(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function workspaceTextSnapshot(cwd: string, relativePath: string): Promise<WorkspaceTextSnapshot> {
  if (!safeRelativePath(relativePath)) throw new Error("Invalid review file path");
  const projectRoot = await realpath(path.resolve(cwd));
  const lexicalPath = path.resolve(projectRoot, relativePath);
  const relativeCheck = path.relative(projectRoot, lexicalPath);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) throw new Error("Review file is outside the project");
  const resolvedParent = await realpath(path.dirname(lexicalPath));
  const parentCheck = path.relative(projectRoot, resolvedParent);
  if (parentCheck.startsWith("..") || path.isAbsolute(parentCheck)) throw new Error("Review file resolves outside the project");
  const absolutePath = path.join(resolvedParent, path.basename(lexicalPath));
  try {
    const fileStat = await lstat(absolutePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error("Review merge only supports regular files");
    if (fileStat.size > MAX_REVIEW_FILE_BYTES) throw new Error("Review file is too large to merge");
    const buffer = await readFile(absolutePath);
    if (buffer.includes(0)) throw new Error("Binary files cannot be merged");
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
    catch { throw new Error("Review file is not valid UTF-8 text"); }
    return { absolutePath, exists: true, content, revision: contentRevision(buffer), mode: Number(fileStat.mode) & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    return { absolutePath, exists: false, content: "", revision: "missing", mode: 0o644 };
  }
}

function parsedReviewPatch(file: SessionChangeFile): StructuredPatch {
  if (file.binary || file.truncated || !file.patch) throw new Error("This review file has no complete text patch");
  const patches = parsePatch(file.patch);
  if (patches.length !== 1 || !patches[0]) throw new Error("The review patch is invalid");
  return patches[0];
}

function resolutionIndexes(file: SessionChangeFile): Set<number> {
  return new Set((file.hunkResolutions ?? []).map((resolution) => resolution.hunkIndex));
}

function unresolvedHunkIndexes(file: SessionChangeFile, patch: StructuredPatch): number[] {
  const resolved = resolutionIndexes(file);
  return patch.hunks.map((_, index) => index).filter((index) => !resolved.has(index));
}

function patchWithHunks(patch: StructuredPatch, indexes: number[]): StructuredPatch {
  return { ...patch, hunks: indexes.map((index) => patch.hunks[index]).filter((hunk): hunk is StructuredPatch["hunks"][number] => Boolean(hunk)) };
}

function reverseReviewHunks(content: string, patch: StructuredPatch, indexes: number[]): string {
  const reversed = reversePatch(patchWithHunks(patch, indexes));
  const result = applyPatch(content, reversed, { fuzzFactor: 0, autoConvertLineEndings: true });
  if (result === false) throw new Error("The file changed after this review. Reload the review before merging.");
  return result;
}

async function writeWorkspaceText(snapshot: WorkspaceTextSnapshot, content: string | null, mode: number): Promise<void> {
  if (content === null) {
    if (snapshot.exists) await rm(snapshot.absolutePath);
    return;
  }
  if (Buffer.byteLength(content, "utf8") > MAX_REVIEW_FILE_BYTES || content.includes("\0")) throw new Error("Merged file exceeds the text-file limit");
  const temporaryPath = `${snapshot.absolutePath}.${process.pid}.${randomUUID()}.pfsaa-merge`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode });
  try {
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, snapshot.absolutePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function fileMode(file: SessionChangeFile, snapshot: WorkspaceTextSnapshot): number {
  const mode = file.newMode ?? file.oldMode;
  if (mode === "100755") return 0o755;
  if (mode === "100644") return 0o644;
  return snapshot.mode;
}

function rollbackWorkspaceText(snapshot: WorkspaceTextSnapshot, file: SessionChangeFile, writtenContent?: string | null): () => Promise<void> {
  if (writtenContent === undefined) return async () => {};
  const writtenRevision = writtenContent === null ? "missing" : contentRevision(Buffer.from(writtenContent, "utf8"));
  const writtenMode = fileMode(file, snapshot);
  return async () => {
    const current = await workspaceTextSnapshot(path.dirname(snapshot.absolutePath), path.basename(snapshot.absolutePath));
    if (current.revision !== writtenRevision || (current.exists && current.mode !== writtenMode)) return;
    await writeWorkspaceText(snapshot, snapshot.exists ? snapshot.content : null, fileMode(file, snapshot));
  };
}

export function withResolvedReviewHunks(
  file: SessionChangeFile,
  hunkIndexes: number[],
  action: SessionChangeHunkResolutionAction,
  resolvedAt = Date.now(),
): SessionChangeFile {
  const resolutions = new Map((file.hunkResolutions ?? []).map((resolution) => [resolution.hunkIndex, resolution]));
  for (const hunkIndex of hunkIndexes) resolutions.set(hunkIndex, { hunkIndex, action, resolvedAt });
  return { ...file, hunkResolutions: [...resolutions.values()].sort((left, right) => left.hunkIndex - right.hunkIndex) };
}

export function acceptChangeReviewHunk(file: SessionChangeFile, hunkIndex: number): SessionChangeFile {
  const patch = parsedReviewPatch(file);
  if (!unresolvedHunkIndexes(file, patch).includes(hunkIndex)) throw new Error("This change block is already resolved");
  return withResolvedReviewHunks(file, [hunkIndex], "accepted");
}

export async function loadChangeReviewMergeSource(
  reviewId: string,
  cwd: string,
  file: SessionChangeFile,
): Promise<SessionChangeReviewMergeSource> {
  const patch = parsedReviewPatch(file);
  const unresolvedHunks = unresolvedHunkIndexes(file, patch);
  if (!unresolvedHunks.length) throw new Error("All changes in this file are already resolved");
  const current = await workspaceTextSnapshot(cwd, file.path);
  const originalContent = reverseReviewHunks(current.content, patch, unresolvedHunks);
  const lineEnding = /\r\n/.test(current.content || originalContent) ? "crlf" : "lf";
  return {
    reviewId,
    filePath: file.path,
    originalContent,
    currentContent: current.content,
    currentRevision: current.revision,
    unresolvedHunks,
    originalExists: file.status !== "added",
    currentExists: current.exists,
    lineEnding,
  };
}

export async function revertChangeReviewHunk(
  cwd: string,
  file: SessionChangeFile,
  hunkIndex: number,
): Promise<WorkspaceReviewMutation> {
  const patch = parsedReviewPatch(file);
  const unresolved = unresolvedHunkIndexes(file, patch);
  if (!unresolved.includes(hunkIndex)) throw new Error("This change block is already resolved");
  const current = await workspaceTextSnapshot(cwd, file.path);
  const content = reverseReviewHunks(current.content, patch, [hunkIndex]);
  const lastUnresolved = unresolved.length === 1;
  const writtenContent = file.status === "added" && lastUnresolved && content === "" ? null : content;
  await writeWorkspaceText(current, writtenContent, fileMode(file, current));
  return { action: "reverted", hunkIndexes: [hunkIndex], rollback: rollbackWorkspaceText(current, file, writtenContent) };
}

export async function applyChangeReviewMerge(
  reviewId: string,
  cwd: string,
  file: SessionChangeFile,
  content: string,
  expectedRevision: string,
): Promise<WorkspaceReviewMutation> {
  if (Buffer.byteLength(content, "utf8") > MAX_REVIEW_FILE_BYTES || content.includes("\0")) throw new Error("Merged file exceeds the text-file limit");
  const source = await loadChangeReviewMergeSource(reviewId, cwd, file);
  if (source.currentRevision !== expectedRevision) throw new Error("The file changed while the merge editor was open. Reload it and try again.");
  const current = await workspaceTextSnapshot(cwd, file.path);
  if (current.revision !== expectedRevision) throw new Error("The file changed while the merge editor was open. Reload it and try again.");
  const action: SessionChangeHunkResolutionAction = content === source.currentContent
    ? "accepted"
    : content === source.originalContent ? "reverted" : "merged";
  const nextContent = action === "reverted" && !source.originalExists && content === "" ? null : content;
  const wroteWorkspace = nextContent !== current.content || (nextContent === null) !== !current.exists;
  if (wroteWorkspace) {
    await writeWorkspaceText(current, nextContent, fileMode(file, current));
  }
  return { action, hunkIndexes: source.unresolvedHunks, rollback: rollbackWorkspaceText(current, file, wroteWorkspace ? nextContent : undefined) };
}

function parseNameStatus(output: Buffer, scopePrefix: string): { paths: string[]; renames: Map<string, string> } {
  const tokens = output.toString("utf8").split("\0").filter(Boolean);
  const paths: string[] = [];
  const renames = new Map<string, string>();
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] ?? "";
    const first = tokens[index++];
    if (!first) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = tokens[index++];
      if (!second) break;
      const previousPath = scopedPath(first, scopePrefix);
      const nextPath = scopedPath(second, scopePrefix);
      if (previousPath && nextPath && safeRelativePath(previousPath) && safeRelativePath(nextPath)) {
        paths.push(previousPath, nextPath);
        if (status.startsWith("R")) renames.set(nextPath, previousPath);
      }
    } else {
      const relativePath = scopedPath(first, scopePrefix);
      if (relativePath && safeRelativePath(relativePath)) paths.push(relativePath);
    }
  }
  return { paths, renames };
}

function parseRawModes(output: Buffer, scopePrefix: string): Map<string, string> {
  const tokens = output.toString("utf8").split("\0").filter(Boolean);
  const modes = new Map<string, string>();
  for (let index = 0; index < tokens.length;) {
    const metadata = tokens[index++] ?? "";
    const first = tokens[index++];
    const match = /^:(\d+)\s+(\d+)\s+[a-f\d]+\s+[a-f\d]+\s+([A-Z])/.exec(metadata);
    if (!match || !first) break;
    const nextPathValue = match[3] === "R" || match[3] === "C" ? tokens[index++] : first;
    const nextPath = nextPathValue ? scopedPath(nextPathValue, scopePrefix) : undefined;
    if (nextPath && match[2] !== "000000" && safeRelativePath(nextPath)) modes.set(nextPath, match[2]);
  }
  return modes;
}

function capNameState(paths: string[], renames: Map<string, string>, modes = new Map<string, string>()): GitNameState {
  const unique = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  const retained = new Set(unique.slice(0, MAX_REVIEW_CAPTURE_PATHS));
  // A retained rename is useful only when both endpoints are available.
  for (const [nextPath, previousPath] of renames) {
    if (retained.has(nextPath) !== retained.has(previousPath)) {
      retained.delete(nextPath);
      retained.delete(previousPath);
    }
  }
  return {
    paths: [...retained].sort((left, right) => left.localeCompare(right)),
    renames: new Map([...renames].filter(([nextPath, previousPath]) => retained.has(nextPath) && retained.has(previousPath))),
    modes: new Map([...modes].filter(([filePath]) => retained.has(filePath))),
    truncated: unique.length > retained.size,
  };
}

async function sampledFileDigest(filePath: string, size: number, modifiedAt: number, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  const sampleBytes = 64 * 1024;
  const first = Buffer.alloc(Math.min(sampleBytes, size));
  const last = Buffer.alloc(Math.min(sampleBytes, Math.max(0, size - first.length)));
  const handle = await open(filePath, "r");
  try {
    if (first.length) await handle.read(first, 0, first.length, 0);
    throwIfAborted(signal);
    if (last.length) await handle.read(last, 0, last.length, Math.max(0, size - last.length));
    throwIfAborted(signal);
  } finally {
    await handle.close();
  }
  const hash = createHash("sha256").update(String(size)).update("\0").update(String(modifiedAt)).update("\0").update(first).update(last);
  return `sample:${hash.digest("hex")}`;
}

function snapshotFromContent(content: Buffer, mode?: string): FileSnapshot {
  return {
    exists: true,
    content,
    digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    binary: content.includes(0),
    truncated: false,
    mode,
  };
}

function workspaceMode(fileStat: Awaited<ReturnType<typeof lstat>>): string | undefined {
  if (fileStat.isSymbolicLink()) return "120000";
  if (!fileStat.isFile()) return undefined;
  return (Number(fileStat.mode) & 0o111) !== 0 ? "100755" : "100644";
}

async function snapshotWorkspaceFile(cwd: string, relativePath: string, signal?: AbortSignal): Promise<FileSnapshot> {
  throwIfAborted(signal);
  const absolutePath = path.resolve(cwd, relativePath);
  const relativeCheck = path.relative(path.resolve(cwd), absolutePath);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) return { exists: false, binary: false, truncated: false };
  try {
    const fileStat = await lstat(absolutePath);
    const mode = workspaceMode(fileStat);
    if (fileStat.isSymbolicLink()) return snapshotFromContent(Buffer.from(await readlink(absolutePath), "utf8"), mode);
    if (!fileStat.isFile()) return { exists: false, binary: false, truncated: false };
    if (fileStat.size > MAX_REVIEW_FILE_BYTES) {
      return { exists: true, digest: await sampledFileDigest(absolutePath, Number(fileStat.size), Number(fileStat.mtimeMs), signal), binary: false, truncated: true, mode };
    }
    return snapshotFromContent(await readFile(absolutePath, { signal }), mode);
  } catch (error) {
    if (signal?.aborted) throw error;
    return { exists: false, binary: false, truncated: false };
  }
}

function parseLsTree(output: Buffer): { objectId: string; mode: string } | undefined {
  const record = output.toString("utf8").split("\0").find(Boolean);
  if (!record) return undefined;
  const match = /^(\d+)\s+\S+\s+([a-f\d]+)\t/.exec(record);
  return match ? { mode: match[1], objectId: match[2] } : undefined;
}

async function snapshotGitFile(state: WorkspaceChangeState, relativePath: string, signal?: AbortSignal): Promise<FileSnapshot> {
  if (!state.head) return { exists: false, binary: false, truncated: false };
  const filePath = repoPath(relativePath, state.scopePrefix);
  try {
    const treeEntry = parseLsTree(await git(state.repoRoot, ["ls-tree", "-z", state.head, "--", filePath], 256 * 1024, signal));
    if (!treeEntry) return { exists: false, binary: false, truncated: false };
    try {
      // Recreate the checked-out representation (including core.autocrlf and
      // configured smudge filters), not the raw Git blob.
      const content = await git(
        state.repoRoot,
        ["cat-file", "--filters", `--path=${filePath}`, `${state.head}:${filePath}`],
        MAX_REVIEW_FILE_BYTES + 64 * 1024,
        signal,
      );
      return snapshotFromContent(content, treeEntry.mode);
    } catch (error) {
      if (signal?.aborted) throw error;
      return { exists: true, digest: `git:${treeEntry.objectId}`, binary: false, truncated: true, mode: treeEntry.mode };
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return { exists: false, binary: false, truncated: false };
  }
}

async function dirtyNameState(repoRoot: string, head: string | undefined, pathspec: string, scopePrefix: string, signal?: AbortSignal): Promise<GitNameState> {
  const [trackedOutput, untrackedOutput, rawOutput] = await Promise.all([
    head
      ? git(repoRoot, ["diff", "--name-status", "-z", "-M", head, "--", pathspec], undefined, signal)
      : git(repoRoot, ["ls-files", "--cached", "-z", "--", pathspec], undefined, signal),
    git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec], undefined, signal),
    head ? git(repoRoot, ["diff", "--raw", "-z", "-M", head, "--", pathspec], undefined, signal) : Promise.resolve(Buffer.alloc(0)),
  ]);
  const tracked = head
    ? parseNameStatus(trackedOutput, scopePrefix)
    : { paths: parseNulPaths(trackedOutput).map((entry) => scopedPath(entry, scopePrefix)).filter((entry): entry is string => Boolean(entry)), renames: new Map<string, string>() };
  const untracked = parseNulPaths(untrackedOutput)
    .map((entry) => scopedPath(entry, scopePrefix))
    .filter((entry): entry is string => typeof entry === "string" && safeRelativePath(entry));
  return capNameState([...tracked.paths, ...untracked], tracked.renames, parseRawModes(rawOutput, scopePrefix));
}

export async function inspectWorkspaceChangeState(cwd: string, signal?: AbortSignal): Promise<WorkspaceChangeInspection> {
  let resolvedCwd: string;
  try {
    resolvedCwd = await realpath(path.resolve(cwd));
  } catch (error) {
    if (signal?.aborted) throw error;
    return inspectionFailure(error);
  }
  let repoRoot: string;
  try {
    repoRoot = await realpath(path.resolve((await execFileBuffer("git", ["-C", resolvedCwd, "rev-parse", "--show-toplevel"], 256 * 1024, signal)).toString("utf8").trim()));
  } catch (error) {
    if (signal?.aborted) throw error;
    return inspectionFailure(error);
  }
  try {
    const relativeScope = path.relative(repoRoot, resolvedCwd);
    if (relativeScope.startsWith("..") || path.isAbsolute(relativeScope)) return { status: "error", reason: "git-inspection-failed" };
    const scopePrefix = posixPath(relativeScope === "." ? "" : relativeScope);
    const pathspec = scopePrefix || ".";
    let head: string | undefined;
    try { head = (await git(repoRoot, ["rev-parse", "--verify", "HEAD"], 256 * 1024, signal)).toString("utf8").trim() || undefined; }
    catch (error) {
      if (signal?.aborted) throw error;
      head = undefined;
    }
    const nameState = await dirtyNameState(repoRoot, head, pathspec, scopePrefix, signal);
    const dirtyFiles = new Map<string, FileSnapshot>();
    let retainedContentBytes = 0;
    for (let offset = 0; offset < nameState.paths.length; offset += 16) {
      throwIfAborted(signal);
      const batchPaths = nameState.paths.slice(offset, offset + 16);
      const snapshots = await Promise.all(batchPaths.map((relativePath) => snapshotWorkspaceFile(resolvedCwd, relativePath, signal)));
      for (const [index, snapshot] of snapshots.entries()) {
        if (snapshot.content && retainedContentBytes + snapshot.content.length > MAX_REVIEW_BASELINE_CONTENT_BYTES) {
          snapshot.content = undefined;
          snapshot.truncated = true;
        } else if (snapshot.content) retainedContentBytes += snapshot.content.length;
        const relativePath = batchPaths[index];
        if (!relativePath) continue;
        const gitMode = nameState.modes.get(relativePath);
        if (snapshot.exists && gitMode) snapshot.mode = gitMode;
        dirtyFiles.set(relativePath, snapshot);
      }
    }
    return {
      status: "available",
      state: { cwd: resolvedCwd, repoRoot, scopePrefix, head, dirtyFiles, renames: nameState.renames, captureTruncated: nameState.truncated },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return inspectionFailure(error);
  }
}

// Compatibility helper used by behavior tests and callers that only need an
// optional state. PfsaaHost uses the richer inspection result for actionable UI.
export async function captureWorkspaceChangeState(cwd: string, signal?: AbortSignal): Promise<WorkspaceChangeState | null> {
  const inspection = await inspectWorkspaceChangeState(cwd, signal);
  return inspection.status === "available" ? inspection.state : null;
}

async function headNameState(before: WorkspaceChangeState, after: WorkspaceChangeState, signal?: AbortSignal): Promise<GitNameState> {
  if (!before.head || !after.head || before.head === after.head || before.repoRoot !== after.repoRoot) {
    return { paths: [], renames: new Map(), modes: new Map(), truncated: false };
  }
  try {
    const [nameOutput, rawOutput] = await Promise.all([
      git(
        before.repoRoot,
        ["diff", "--name-status", "-z", "-M", before.head, after.head, "--", before.scopePrefix || "."],
        undefined,
        signal,
      ),
      git(
        before.repoRoot,
        ["diff", "--raw", "-z", "-M", before.head, after.head, "--", before.scopePrefix || "."],
        undefined,
        signal,
      ),
    ]);
    const parsed = parseNameStatus(nameOutput, before.scopePrefix);
    return capNameState(parsed.paths, parsed.renames, parseRawModes(rawOutput, before.scopePrefix));
  } catch (error) {
    if (signal?.aborted) throw error;
    return { paths: [], renames: new Map(), modes: new Map(), truncated: true };
  }
}

function snapshotsEqual(before: FileSnapshot, after: FileSnapshot): boolean {
  if (before.exists !== after.exists) return false;
  if (!before.exists) return true;
  const contentEqual = before.content && after.content
    ? before.content.equals(after.content)
    : Boolean(before.digest && after.digest && before.digest === after.digest);
  return contentEqual && before.mode === after.mode;
}

function decodeText(content: Buffer | undefined): string | undefined {
  if (!content || content.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch { return undefined; }
}

function patchCounts(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function truncatePatch(patch: string, limit: number): string {
  const buffer = Buffer.from(patch, "utf8");
  if (buffer.length <= limit) return patch;
  const prefix = buffer.subarray(0, Math.max(0, limit)).toString("utf8");
  const newline = prefix.lastIndexOf("\n");
  return `${newline >= 0 ? prefix.slice(0, newline + 1) : prefix}\n`;
}

async function stateSnapshot(
  state: WorkspaceChangeState,
  relativePath: string,
  baseline: boolean,
  retainedBytes: { value: number },
  signal?: AbortSignal,
): Promise<FileSnapshot> {
  const captured = state.dirtyFiles.get(relativePath);
  if (captured) return captured;
  const snapshot = baseline
    ? await snapshotGitFile(state, relativePath, signal)
    : await snapshotWorkspaceFile(state.cwd, relativePath, signal);
  if (snapshot.content) {
    if (retainedBytes.value + snapshot.content.length > MAX_REVIEW_BASELINE_CONTENT_BYTES) {
      snapshot.content = undefined;
      snapshot.truncated = true;
    } else retainedBytes.value += snapshot.content.length;
  }
  return snapshot;
}

function renameTransitions(before: WorkspaceChangeState, after: WorkspaceChangeState, headState: GitNameState): Map<string, string> {
  const transitions = new Map<string, string>();
  const beforeByOrigin = new Map([...before.renames].map(([currentPath, originPath]) => [originPath, currentPath]));
  const afterByOrigin = new Map([...after.renames].map(([currentPath, originPath]) => [originPath, currentPath]));
  for (const originPath of new Set([...beforeByOrigin.keys(), ...afterByOrigin.keys()])) {
    const previousPath = beforeByOrigin.get(originPath) ?? originPath;
    const nextPath = afterByOrigin.get(originPath) ?? originPath;
    if (previousPath !== nextPath) transitions.set(nextPath, previousPath);
  }
  for (const [nextPath, previousPath] of headState.renames) transitions.set(nextPath, previousPath);
  return transitions;
}

function createChangeFile(
  relativePath: string,
  previousPath: string | undefined,
  previous: FileSnapshot,
  current: FileSnapshot,
  generateUnifiedPatch: GenerateUnifiedPatch,
  remainingPatchBytes: number,
): { file: SessionChangeFile; patchBytes: number } {
  const oldText = previous.exists ? decodeText(previous.content) : "";
  const newText = current.exists ? decodeText(current.content) : "";
  const binary = previous.binary || current.binary
    || (previous.exists && !previous.truncated && oldText === undefined)
    || (current.exists && !current.truncated && newText === undefined);
  let patch: string | undefined;
  let additions = 0;
  let deletions = 0;
  let truncated = previous.truncated || current.truncated;
  let patchAvailable = false;
  if (!binary && oldText !== undefined && newText !== undefined) {
    const normalizedOldText = oldText.replace(/\r\n?/g, "\n");
    const normalizedNewText = newText.replace(/\r\n?/g, "\n");
    const fullPatch = generateUnifiedPatch(relativePath, normalizedOldText, normalizedNewText, 3);
    patchAvailable = fullPatch.length > 0;
    ({ additions, deletions } = patchCounts(fullPatch));
    const limit = Math.min(MAX_REVIEW_PATCH_BYTES, Math.max(0, remainingPatchBytes));
    if (Buffer.byteLength(fullPatch, "utf8") > limit) truncated = true;
    if (limit > 0 && fullPatch) patch = truncatePatch(fullPatch, limit);
  }
  const oldMode = previous.mode;
  const newMode = current.mode;
  return {
    file: {
      path: relativePath,
      ...(previousPath && previousPath !== relativePath ? { previousPath } : {}),
      status: previousPath && previousPath !== relativePath
        ? "renamed"
        : !previous.exists ? "added" : !current.exists ? "deleted" : "modified",
      additions,
      deletions,
      ...(patch ? { patch } : {}),
      patchAvailable,
      binary,
      truncated,
      ...(oldMode && oldMode !== newMode ? { oldMode } : {}),
      ...(newMode && oldMode !== newMode ? { newMode } : {}),
    },
    patchBytes: patch ? Buffer.byteLength(patch, "utf8") : 0,
  };
}

export async function buildSessionChangeReview(
  taskId: string,
  startedAt: number,
  endedAt: number,
  before: WorkspaceChangeState | null,
  after: WorkspaceChangeState | null,
  generateUnifiedPatch: GenerateUnifiedPatch,
  state: SessionChangeReview["state"] = "completed",
  signal?: AbortSignal,
): Promise<SessionChangeReview | null> {
  if (!before || !after || before.repoRoot !== after.repoRoot || before.cwd !== after.cwd) return null;
  const headState = await headNameState(before, after, signal);
  const allCandidates = [...new Set([
    ...before.dirtyFiles.keys(),
    ...after.dirtyFiles.keys(),
    ...headState.paths,
  ])].sort((left, right) => left.localeCompare(right));
  const candidatePaths = allCandidates.slice(0, MAX_REVIEW_CAPTURE_PATHS);
  const candidateTruncated = allCandidates.length > candidatePaths.length;
  const transitions = renameTransitions(before, after, headState);
  const consumed = new Set<string>();
  const onDemandContentBytes = { value: 0 };
  const files: SessionChangeFile[] = [];
  let patchBytes = 0;
  let omittedChangedFiles = 0;

  const appendIfChanged = (relativePath: string, previousPath: string | undefined, previous: FileSnapshot, current: FileSnapshot) => {
    if (snapshotsEqual(previous, current) && (!previousPath || previousPath === relativePath)) return;
    if (files.length >= MAX_REVIEW_FILES) {
      omittedChangedFiles += 1;
      return;
    }
    const created = createChangeFile(relativePath, previousPath, previous, current, generateUnifiedPatch, MAX_REVIEW_TOTAL_PATCH_BYTES - patchBytes);
    files.push(created.file);
    patchBytes += created.patchBytes;
  };

  for (const [nextPath, previousPath] of [...transitions].sort(([left], [right]) => left.localeCompare(right))) {
    throwIfAborted(signal);
    const [previous, current] = await Promise.all([
      stateSnapshot(before, previousPath, true, onDemandContentBytes, signal),
      stateSnapshot(after, nextPath, false, onDemandContentBytes, signal),
    ]);
    const committedMode = headState.modes.get(nextPath);
    if (current.exists && committedMode) current.mode = committedMode;
    appendIfChanged(nextPath, previousPath, previous, current);
    consumed.add(previousPath);
    consumed.add(nextPath);
  }

  const remainingPaths = candidatePaths.filter((relativePath) => !consumed.has(relativePath));
  for (let offset = 0; offset < remainingPaths.length; offset += SNAPSHOT_CONCURRENCY) {
    throwIfAborted(signal);
    const batch = remainingPaths.slice(offset, offset + SNAPSHOT_CONCURRENCY);
    const snapshots = await Promise.all(batch.map(async (relativePath) => ({
      relativePath,
      previous: await stateSnapshot(before, relativePath, true, onDemandContentBytes, signal),
      current: await stateSnapshot(after, relativePath, false, onDemandContentBytes, signal),
    })));
    for (const { relativePath, previous, current } of snapshots) {
      const committedMode = headState.modes.get(relativePath);
      if (current.exists && committedMode) current.mode = committedMode;
      appendIfChanged(relativePath, undefined, previous, current);
    }
  }

  const fileCountTruncated = before.captureTruncated || after.captureTruncated || headState.truncated || candidateTruncated || omittedChangedFiles > 0;
  return {
    schemaVersion: 2,
    id: `${taskId}:${startedAt}`,
    state,
    startedAt,
    endedAt,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    truncated: fileCountTruncated || files.some((file) => file.truncated),
    fileCountTruncated,
    ...(candidateTruncated || before.captureTruncated || after.captureTruncated || headState.truncated
      ? {}
      : omittedChangedFiles > 0 ? { omittedFiles: omittedChangedFiles } : {}),
  };
}
