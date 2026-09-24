import { useCallback, useEffect, useRef, useState } from "react";

const NOTICE_VISIBLE_MS = 8_000;
const NOTICE_EXIT_MS = 220;
const NOTICE_MAX = 4;

export type NoticeKind = "info" | "warning" | "error";

interface NoticeItem {
  id: number;
  message: string;
  kind: NoticeKind;
  closing: boolean;
}

export function useNotice() {
  const [notices, setNotices] = useState<NoticeItem[]>([]);
  const counterRef = useRef(0);
  const timersRef = useRef<Map<number, number>>(new Map());

  const dismiss = useCallback((id: number) => {
    const existing = timersRef.current.get(id);
    if (existing) window.clearTimeout(existing);
    setNotices((current) => current.map((item) => item.id === id ? { ...item, closing: true } : item));
    const exitTimer = window.setTimeout(() => {
      timersRef.current.delete(id);
      setNotices((current) => current.filter((item) => item.id !== id));
    }, NOTICE_EXIT_MS);
    timersRef.current.set(id, exitTimer);
  }, []);

  // Errors stay until dismissed so the user can read and act on them; info
  // and warning notices remain long enough to scan before auto-dismissing.
  const showNotice = useCallback((message: string, kind: NoticeKind = "info") => {
    const id = ++counterRef.current;
    setNotices((current) => [...current, { id, message, kind, closing: false }].slice(-NOTICE_MAX));
    if (kind !== "error") {
      const visibleTimer = window.setTimeout(() => dismiss(id), NOTICE_VISIBLE_MS);
      timersRef.current.set(id, visibleTimer);
    }
  }, [dismiss]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => { timers.forEach((timer) => window.clearTimeout(timer)); timers.clear(); };
  }, []);

  return { notices, showNotice, dismissNotice: dismiss };
}
