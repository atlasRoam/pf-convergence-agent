import type { SentImageMessage } from "./types";

export type SentImagesSnapshot = Record<string, SentImageMessage[]>;

const DATABASE_NAME = "pfsaa-cache";
const LEGACY_DATABASE_NAME = "pideck-cache";
const STORE_NAME = "snapshots";
const SNAPSHOT_KEY = "sent-images.v1";

type StoredSnapshot = { key: string; value: SentImagesSnapshot };

async function openDatabase(name: string) {
  if (typeof indexedDB === "undefined") return null;
  const { openDB } = await import("idb");
  return openDB(name, 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: "key" });
    },
  });
}

async function readDatabase(name: string): Promise<SentImagesSnapshot | null> {
  try {
    const database = await openDatabase(name);
    if (!database) return null;
    try {
      const stored = await database.get(STORE_NAME, SNAPSHOT_KEY) as StoredSnapshot | undefined;
      return stored?.value && typeof stored.value === "object" ? stored.value : null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

export async function readSentImagesCache(): Promise<SentImagesSnapshot | null> {
  const current = await readDatabase(DATABASE_NAME);
  if (current) return current;
  const legacy = await readDatabase(LEGACY_DATABASE_NAME);
  if (legacy) await writeSentImagesCache(legacy);
  return legacy;
}

export async function writeSentImagesCache(value: SentImagesSnapshot): Promise<boolean> {
  try {
    const database = await openDatabase(DATABASE_NAME);
    if (!database) return false;
    try {
      await database.put(STORE_NAME, { key: SNAPSHOT_KEY, value } satisfies StoredSnapshot);
      return true;
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
}
