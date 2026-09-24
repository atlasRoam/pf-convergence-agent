import { useEffect, useRef } from "react";
import type { SentImageMessage } from "./types";
import { readSentImagesCache, writeSentImagesCache, type SentImagesSnapshot } from "./image-cache";
import { writePfsaaStorage } from "./pfsaa-storage";

export function useSentImagesCache(sentImagesByTask: SentImagesSnapshot, setSentImagesByTask: React.Dispatch<React.SetStateAction<Record<string, SentImageMessage[]>>>) {
  const persistTimerRef = useRef<number | null>(null);
  const latestSnapshotRef = useRef(sentImagesByTask);
  const modeRef = useRef<"unknown" | "indexeddb" | "localStorage">("unknown");
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  function persist() {
    const write = writeQueueRef.current.then(async () => {
      const snapshot = latestSnapshotRef.current;
      if (modeRef.current !== "localStorage") {
        if (await writeSentImagesCache(snapshot)) {
          modeRef.current = "indexeddb";
          return;
        }
      }
      modeRef.current = "localStorage";
      try { writePfsaaStorage("sent-images.v1", JSON.stringify(snapshot)); }
      catch { /* Image history is a UI fallback; AgentCore remains the authoritative session store. */ }
    });
    writeQueueRef.current = write.then(() => undefined, () => undefined);
    return write;
  }

  useEffect(() => {
    latestSnapshotRef.current = sentImagesByTask;
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => { persistTimerRef.current = null; void persist(); }, 250);
    return () => {
      if (persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [sentImagesByTask]);

  useEffect(() => {
    let cancelled = false;
    void readSentImagesCache().then((cached) => {
      if (cancelled || !cached) return;
      setSentImagesByTask((current) => Object.keys(current).length ? current : cached);
    });
    return () => { cancelled = true; };
  }, [setSentImagesByTask]);

  useEffect(() => () => {
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    void persist();
  }, []);
}
