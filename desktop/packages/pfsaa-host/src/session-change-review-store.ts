import type { SessionChangeFile, SessionChangeReview } from "@pfsaa/contracts";
import { randomUUID } from "node:crypto";
import { copyFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MAX_REVIEW_FILES,
  MAX_REVIEW_PATCH_BYTES,
  MAX_REVIEW_TOTAL_PATCH_BYTES,
} from "./session-change-review.js";

const LEGACY_METADATA_TYPES = new Set(["pfsaa.change-review", "pideck.change-review"]);
const STORE_ANCHOR_TYPE = "pfsaa.change-review-store";
const STORE_SUFFIX = ".pfsaa-change-reviews.json";
const LEGACY_STORE_SUFFIX = ".pideck-change-reviews.json";
const STORE_SCHEMA_VERSION = 2;
const MAX_REVIEW_HISTORY = 20;
const MAX_REVIEW_HISTORY_BYTES = 12_000_000;
const MAX_STORE_FILE_BYTES = MAX_REVIEW_HISTORY_BYTES + 512_000;
const MAX_PATH_CHARS = 4096;
const MAX_ID_CHARS = 512;
const MAX_COUNT = 10_000_000;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_HUNK_RESOLUTIONS = 2_000;

type StoredReviewDocument = { schemaVersion: 2; reviews: SessionChangeReview[] };
type ReviewLoadResult = { reviews: SessionChangeReview[]; invalid: boolean };

const inMemoryReviews = new WeakMap<object, SessionChangeReview[]>();
const inMemoryReviewInvalid = new WeakMap<object, boolean>();
const storeMutationLocks = new WeakMap<object, Promise<void>>();
const storeAnchors = new WeakSet<object>();
const dirtyReviewStores = new WeakSet<object>();
const reviewStoreSignatures = new WeakMap<object, string>();

async function withStoreMutationLock<T>(manager: object, operation: () => Promise<T>): Promise<T> {
  const previous = storeMutationLocks.get(manager) ?? Promise.resolve();
  let resolveCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => { resolveCurrent = resolve; });
  storeMutationLocks.set(manager, previous.catch(() => undefined).then(() => current));
  await previous.catch(() => undefined);
  try { return await operation(); }
  finally { resolveCurrent?.(); }
}

function sessionManagerOf(session: any): any {
  return session?.sessionManager ?? session;
}

export function sessionChangeReviewStorePath(session: any): string | undefined {
  const sessionFile = sessionManagerOf(session)?.getSessionFile?.();
  return typeof sessionFile === "string" && sessionFile ? `${sessionFile}${STORE_SUFFIX}` : undefined;
}

function legacySessionChangeReviewStorePath(session: any): string | undefined {
  const sessionFile = sessionManagerOf(session)?.getSessionFile?.();
  return typeof sessionFile === "string" && sessionFile ? `${sessionFile}${LEGACY_STORE_SUFFIX}` : undefined;
}

function boundedInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Math.min(Number(value), MAX_COUNT) : 0;
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_PATH_CHARS || value.includes("\0")) return false;
  const normalized = value.replaceAll("\\", "/");
  return !path.posix.isAbsolute(normalized)
    && !/^[A-Za-z]:\//.test(normalized)
    && !normalized.split("/").some((part) => part === "..");
}

function sanitizeMode(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:100644|100755|120000)$/.test(value) ? value : undefined;
}

function sanitizeFile(value: unknown, remainingPatchBytes: number): { file?: SessionChangeFile; patchBytes: number } {
  if (!value || typeof value !== "object") return { patchBytes: 0 };
  const record = value as Record<string, unknown>;
  if (!validRelativePath(record.path)) return { patchBytes: 0 };
  const statuses = new Set(["added", "modified", "deleted", "renamed"]);
  const status = statuses.has(String(record.status)) ? record.status as SessionChangeFile["status"] : undefined;
  if (!status) return { patchBytes: 0 };
  const previousPath = validRelativePath(record.previousPath) ? record.previousPath : undefined;
  if (status === "renamed" && (!previousPath || previousPath === record.path)) return { patchBytes: 0 };
  let patch = typeof record.patch === "string" ? record.patch : undefined;
  let patchBytes = 0;
  let truncated = record.truncated === true;
  const patchAvailable = record.patchAvailable === true || Boolean(patch);
  if (patch) {
    if (patch.length > MAX_REVIEW_PATCH_BYTES || Buffer.byteLength(patch, "utf8") > Math.min(MAX_REVIEW_PATCH_BYTES, remainingPatchBytes)) {
      patch = undefined;
      truncated = true;
    } else patchBytes = Buffer.byteLength(patch, "utf8");
  }
  const oldMode = sanitizeMode(record.oldMode);
  const newMode = sanitizeMode(record.newMode);
  const hunkResolutions = new Map<number, NonNullable<SessionChangeFile["hunkResolutions"]>[number]>();
  if (Array.isArray(record.hunkResolutions)) {
    for (const value of record.hunkResolutions.slice(0, MAX_HUNK_RESOLUTIONS)) {
      if (!value || typeof value !== "object") continue;
      const resolution = value as Record<string, unknown>;
      if (!Number.isSafeInteger(resolution.hunkIndex) || Number(resolution.hunkIndex) < 0 || Number(resolution.hunkIndex) > MAX_COUNT) continue;
      if (resolution.action !== "accepted" && resolution.action !== "reverted" && resolution.action !== "merged") continue;
      if (!Number.isFinite(resolution.resolvedAt) || Number(resolution.resolvedAt) < 0 || Number(resolution.resolvedAt) > MAX_DATE_MS) continue;
      hunkResolutions.set(Number(resolution.hunkIndex), {
        hunkIndex: Number(resolution.hunkIndex),
        action: resolution.action,
        resolvedAt: Number(resolution.resolvedAt),
      });
    }
  }
  return {
    file: {
      path: record.path,
      ...(status === "renamed" && previousPath ? { previousPath } : {}),
      status,
      additions: boundedInteger(record.additions),
      deletions: boundedInteger(record.deletions),
      ...(patch ? { patch } : {}),
      patchAvailable,
      binary: record.binary === true,
      truncated,
      ...(oldMode ? { oldMode } : {}),
      ...(newMode ? { newMode } : {}),
      ...(hunkResolutions.size ? { hunkResolutions: [...hunkResolutions.values()].sort((left, right) => left.hunkIndex - right.hunkIndex) } : {}),
    },
    patchBytes,
  };
}

export function sanitizeSessionChangeReview(value: unknown, allowRunning = false): SessionChangeReview | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id || record.id.length > MAX_ID_CHARS) return null;
  if (record.state !== "completed" && !(allowRunning && record.state === "running")) return null;
  if (!Number.isFinite(record.startedAt) || !Number.isFinite(record.endedAt)) return null;
  const startedAt = Math.max(0, Number(record.startedAt));
  const endedAt = Math.max(startedAt, Number(record.endedAt));
  if (startedAt > MAX_DATE_MS || endedAt > MAX_DATE_MS) return null;
  if (!Array.isArray(record.files)) return null;
  const files: SessionChangeFile[] = [];
  const retainedPaths = new Set<string>();
  let patchBytes = 0;
  for (const rawFile of record.files.slice(0, MAX_REVIEW_FILES)) {
    const sanitized = sanitizeFile(rawFile, MAX_REVIEW_TOTAL_PATCH_BYTES - patchBytes);
    if (!sanitized.file || retainedPaths.has(sanitized.file.path)) continue;
    retainedPaths.add(sanitized.file.path);
    files.push(sanitized.file);
    patchBytes += sanitized.patchBytes;
  }
  const fileCountTruncated = record.fileCountTruncated === true
    || record.files.length > MAX_REVIEW_FILES
    || files.length !== Math.min(record.files.length, MAX_REVIEW_FILES);
  const omittedFiles = Number.isSafeInteger(record.omittedFiles) && Number(record.omittedFiles) > 0
    ? Math.min(Number(record.omittedFiles), MAX_COUNT)
    : undefined;
  return {
    schemaVersion: 2,
    id: record.id,
    state: record.state as SessionChangeReview["state"],
    ...(record.outcome === "succeeded" || record.outcome === "failed" || record.outcome === "aborted" ? { outcome: record.outcome } : {}),
    startedAt,
    endedAt,
    files,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    truncated: record.truncated === true || fileCountTruncated || files.some((file) => file.truncated),
    fileCountTruncated,
    ...(omittedFiles ? { omittedFiles } : {}),
  };
}

export function summarizeSessionChangeReview(review: SessionChangeReview): SessionChangeReview {
  return {
    ...review,
    files: review.files.map(({ patch: _patch, ...file }) => file),
  };
}

function boundedHistory(reviews: SessionChangeReview[]): SessionChangeReview[] {
  const seenIds = new Set<string>();
  const unique: SessionChangeReview[] = [];
  for (let index = reviews.length - 1; index >= 0; index -= 1) {
    const review = reviews[index];
    if (!review || seenIds.has(review.id)) continue;
    seenIds.add(review.id);
    unique.unshift(review);
  }
  const retained = unique.slice(-MAX_REVIEW_HISTORY);
  while (retained.length > 1 && Buffer.byteLength(JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, reviews: retained }), "utf8") > MAX_REVIEW_HISTORY_BYTES) {
    retained.shift();
  }
  return retained;
}

function legacyReviews(session: any): ReviewLoadResult {
  const manager = sessionManagerOf(session);
  const entries = manager?.getBranch?.() ?? manager?.getEntries?.() ?? [];
  if (!Array.isArray(entries)) return { reviews: [], invalid: false };
  const reviews: SessionChangeReview[] = [];
  let invalid = false;
  for (let index = entries.length - 1; index >= 0 && reviews.length < MAX_REVIEW_HISTORY; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "custom" || !LEGACY_METADATA_TYPES.has(entry.customType)) continue;
    const review = sanitizeSessionChangeReview(entry.data);
    if (!review) { invalid = true; continue; }
    const rawFiles = Array.isArray(entry.data?.files) ? entry.data.files : [];
    if (review.files.length !== Math.min(rawFiles.length, MAX_REVIEW_FILES)) invalid = true;
    reviews.unshift(review);
  }
  const bounded = boundedHistory(reviews);
  return { reviews: bounded, invalid: invalid || bounded.length !== reviews.length };
}

function ensureStoreAnchor(session: any): void {
  const manager = sessionManagerOf(session);
  if (!manager || typeof manager !== "object" || storeAnchors.has(manager)) return;
  const entries = manager.getEntries?.() ?? [];
  if (Array.isArray(entries) && entries.some((entry: any) => entry?.type === "custom" && entry.customType === STORE_ANCHOR_TYPE)) {
    storeAnchors.add(manager);
    return;
  }
  if (typeof manager.appendCustomEntry !== "function") return;
  try {
    manager.appendCustomEntry(STORE_ANCHOR_TYPE, { schemaVersion: STORE_SCHEMA_VERSION, storage: "bounded-sidecar" });
    storeAnchors.add(manager);
  } catch {
    // The sidecar remains discoverable from the Session filename even when an
    // in-memory/read-only Session manager cannot append the auxiliary anchor.
  }
}

function fileSignature(fileStat: Awaited<ReturnType<typeof stat>>): string {
  return `${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs}`;
}

async function writeDocument(storePath: string, reviews: SessionChangeReview[]): Promise<string> {
  const document: StoredReviewDocument = { schemaVersion: STORE_SCHEMA_VERSION, reviews: boundedHistory(reviews) };
  const serialized = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STORE_FILE_BYTES) throw new Error("Review history exceeds its storage limit");
  const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
  try {
    await rename(temporaryPath, storePath);
    return fileSignature(await stat(storePath));
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function quarantineInvalidStore(storePath: string): Promise<void> {
  const invalidPath = `${storePath}.invalid`;
  try {
    await rm(invalidPath, { force: true });
    await rename(storePath, invalidPath);
  } catch { await rm(storePath, { force: true }); }
}

async function loadSidecar(storePath: string, quarantine = true): Promise<ReviewLoadResult | null> {
  try {
    const fileStat = await stat(storePath);
    if (!fileStat.isFile() || fileStat.size > MAX_STORE_FILE_BYTES) {
      if (quarantine) await quarantineInvalidStore(storePath);
      return { reviews: [], invalid: true };
    }
    const parsed = JSON.parse(await readFile(storePath, "utf8")) as Record<string, unknown>;
    if (parsed?.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(parsed.reviews)) throw new Error("Invalid review store schema");
    if (parsed.reviews.some((review) => !review || typeof review !== "object" || (review as Record<string, unknown>).schemaVersion !== STORE_SCHEMA_VERSION)) {
      throw new Error("Invalid review store record version");
    }
    const reviews = parsed.reviews
      .map((review) => sanitizeSessionChangeReview(review))
      .filter((review): review is SessionChangeReview => Boolean(review));
    const bounded = boundedHistory(reviews);
    if (reviews.length !== parsed.reviews.length || bounded.length !== reviews.length || reviews.length > MAX_REVIEW_HISTORY) {
      throw new Error("Invalid review store record");
    }
    return { reviews: bounded, invalid: false, signature: fileSignature(fileStat) } as ReviewLoadResult & { signature: string };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    if (quarantine) await quarantineInvalidStore(storePath);
    return { reviews: [], invalid: true };
  }
}

export async function loadSessionChangeReviews(session: any): Promise<ReviewLoadResult> {
  const manager = sessionManagerOf(session);
  if (!manager || typeof manager !== "object") return { reviews: [], invalid: false };
  const storePath = sessionChangeReviewStorePath(manager);
  if (!storePath) {
    const cached = inMemoryReviews.get(manager);
    if (cached) return { reviews: [...cached], invalid: inMemoryReviewInvalid.get(manager) === true };
    const legacy = legacyReviews(manager);
    inMemoryReviews.set(manager, legacy.reviews);
    inMemoryReviewInvalid.set(manager, legacy.invalid);
    return legacy;
  }
  if (!dirtyReviewStores.has(manager)) {
    try {
      const signature = fileSignature(await stat(storePath));
      if (reviewStoreSignatures.get(manager) === signature) {
        return { reviews: [...(inMemoryReviews.get(manager) ?? [])], invalid: false };
      }
    } catch { /* Missing/invalid stores are handled by the validated load below. */ }
  }
  const stored = await loadSidecar(storePath) as (ReviewLoadResult & { signature?: string }) | null;
  if (stored) {
    const pending = dirtyReviewStores.has(manager) ? inMemoryReviews.get(manager) ?? [] : [];
    const reviews = pending.length ? boundedHistory([...stored.reviews, ...pending]) : stored.reviews;
    inMemoryReviews.set(manager, reviews);
    if (!stored.invalid && stored.signature) reviewStoreSignatures.set(manager, stored.signature);
    else reviewStoreSignatures.delete(manager);
    return { reviews, invalid: stored.invalid };
  }
  const legacyStorePath = legacySessionChangeReviewStorePath(manager);
  if (legacyStorePath) {
    const legacyStored = await loadSidecar(legacyStorePath, false) as (ReviewLoadResult & { signature?: string }) | null;
    if (legacyStored) {
      inMemoryReviews.set(manager, legacyStored.reviews);
      inMemoryReviewInvalid.set(manager, legacyStored.invalid);
      // Reading an existing session must not rewrite it. A later review
      // mutation writes the PFSAA sidecar and anchor through the normal path.
      return { reviews: legacyStored.reviews, invalid: legacyStored.invalid };
    }
  }
  if (dirtyReviewStores.has(manager)) {
    return { reviews: [...(inMemoryReviews.get(manager) ?? [])], invalid: false };
  }
  const legacy = legacyReviews(manager);
  inMemoryReviews.set(manager, legacy.reviews);
  inMemoryReviewInvalid.set(manager, legacy.invalid);
  return legacy;
}

export async function persistSessionChangeReview(session: any, value: SessionChangeReview): Promise<SessionChangeReview> {
  const review = sanitizeSessionChangeReview(value);
  if (!review) throw new Error("Invalid change review record");
  const manager = sessionManagerOf(session);
  if (!manager || typeof manager !== "object") throw new Error("Session manager is unavailable");
  return withStoreMutationLock(manager, async () => {
    const loaded = await loadSessionChangeReviews(manager);
    const reviews = boundedHistory([...loaded.reviews.filter((item) => item.id !== review.id), review].sort((left, right) => left.startedAt - right.startedAt));
    const storePath = sessionChangeReviewStorePath(manager);
    inMemoryReviews.set(manager, reviews);
    inMemoryReviewInvalid.set(manager, false);
    dirtyReviewStores.add(manager);
    if (storePath) {
      reviewStoreSignatures.set(manager, await writeDocument(storePath, reviews));
      ensureStoreAnchor(manager);
    }
    dirtyReviewStores.delete(manager);
    return review;
  });
}

export async function flushSessionChangeReviewStore(session: any): Promise<boolean> {
  const manager = sessionManagerOf(session);
  if (!manager || typeof manager !== "object" || !dirtyReviewStores.has(manager)) return false;
  return withStoreMutationLock(manager, async () => {
    if (!dirtyReviewStores.has(manager)) return false;
    const reviews = inMemoryReviews.get(manager) ?? [];
    const storePath = sessionChangeReviewStorePath(manager);
    if (storePath) {
      reviewStoreSignatures.set(manager, await writeDocument(storePath, reviews));
      ensureStoreAnchor(manager);
    }
    dirtyReviewStores.delete(manager);
    return true;
  });
}

export async function deleteSessionChangeReviewStore(sessionOrPath: any): Promise<void> {
  const sessionPath = typeof sessionOrPath === "string" ? sessionOrPath : sessionManagerOf(sessionOrPath)?.getSessionFile?.();
  if (typeof sessionPath === "string" && sessionPath) {
    const storePaths = [`${sessionPath}${STORE_SUFFIX}`, `${sessionPath}${LEGACY_STORE_SUFFIX}`];
    await Promise.all(storePaths.flatMap((storePath) => [rm(storePath, { force: true }), rm(`${storePath}.invalid`, { force: true })]));
  }
  const manager = typeof sessionOrPath === "object" ? sessionManagerOf(sessionOrPath) : undefined;
  if (manager && typeof manager === "object") {
    inMemoryReviews.delete(manager);
    inMemoryReviewInvalid.delete(manager);
    storeAnchors.delete(manager);
    dirtyReviewStores.delete(manager);
    reviewStoreSignatures.delete(manager);
  }
}

export async function copySessionChangeReviewStore(sourceSessionOrPath: any, destinationSessionPath: string): Promise<boolean> {
  const sourceSessionPath = typeof sourceSessionOrPath === "string" ? sourceSessionOrPath : sessionManagerOf(sourceSessionOrPath)?.getSessionFile?.();
  if (typeof sourceSessionPath !== "string" || !sourceSessionPath) return false;
  for (const sourcePath of [`${sourceSessionPath}${STORE_SUFFIX}`, `${sourceSessionPath}${LEGACY_STORE_SUFFIX}`]) {
    try {
      const loaded = await loadSidecar(sourcePath, false);
      if (!loaded || loaded.invalid) continue;
      await copyFile(sourcePath, `${destinationSessionPath}${STORE_SUFFIX}`);
      return true;
    } catch {
      // Try the legacy sidecar before reporting that no review store exists.
    }
  }
  return false;
}
