import { createFocusTrap, type FocusTrap } from "focus-trap";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export const icons: Record<string, string> = {
  plus: "M8 3v10M3 8h10",
  search: "m12 12-2.8-2.8M6.8 10.2a3.4 3.4 0 1 1 4.8-4.8 3.4 3.4 0 0 1-4.8 4.8Z",
  chevron: "m5 6 3 3 3-3",
  panel: "M3 3h10v10H3zM3 6h10M6 6v7",
  terminal: "m4 5 3 3-3 3M8 11h4",
  file: "M4 2.5h5l3 3V13H4zM9 2.5v3h3",
  diff: "M5 2.5v8M3 4.5l2-2 2 2M11 13.5v-8M9 11.5l2 2 2-2",
  send: "m3 8 10-5-3 10-2-4-5-1Z",
  stop: "M4 4h8v8H4z",
  settings: "M7 3.3V1.8h2v1.5l1.6.7 1.1-1.1 1.4 1.4L12 5.4l.7 1.6h1.5v2h-1.5l-.7 1.6 1.1 1.1-1.4 1.4-1.1-1.1-1.6.7v1.5H7v-1.5L5.4 12l-1.1 1.1-1.4-1.4L4 10.6 3.3 9H1.8V7h1.5L4 5.4 2.9 4.3l1.4-1.4L5.4 4 7 3.3ZM5.75 8a2.25 2.25 0 1 0 4.5 0 2.25 2.25 0 1 0-4.5 0Z",
  key: "M9.5 8.5a3.5 3.5 0 1 0-2-2L2 12v2h2v-2h2v-2l1.5-1.5M11 5h.01",
  brain: "M8 3.5c0-2-3-2.4-3.7-.5C2.2 2.8 1.1 5.2 2.4 6.8c-1.6 1.5-.8 4 1.2 4.4-.2 2.3 3 3.5 4.4 1.5 1.4 2 4.6.8 4.4-1.5 2-.4 2.8-2.9 1.2-4.4C14.9 5.2 13.8 2.8 11.7 3 11 1.1 8 1.5 8 3.5Zm0 0v9.2M4.3 3c-.2 1 .3 1.8 1.2 2.2M11.7 3c.2 1-.3 1.8-1.2 2.2M2.4 6.8c.8-.2 1.6.1 2 1M13.6 6.8c-.8-.2-1.6.1-2 1M3.6 11.2c.1-1 .8-1.5 1.8-1.5M12.4 11.2c-.1-1-.8-1.5-1.8-1.5",
  shield: "M8 2.5 13 4v3.7c0 2.7-1.8 4.8-5 5.8-3.2-1-5-3.1-5-5.8V4zM5.5 8l1.6 1.6L10.7 6",
  moon: "M11.5 10.5A4.5 4.5 0 0 1 5.5 4.1 5 5 0 1 0 11.5 10.5Z",
  sun: "M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM8 1.5v1M8 13.5v1M1.5 8h1M13.5 8h1M3.4 3.4l.7.7M11.9 11.9l.7.7M12.6 3.4l-.7.7M4.1 11.9l-.7.7",
  auto: "M8 2a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 1.8a4.2 4.2 0 0 1 0 8.4Z",
  command: "M4 4h8v8H4zM6 8h4M8 6v4",
  model: "M3 5.2 8 2.5l5 2.7v5.6L8 13.5l-5-2.7zM3 5.2l5 2.7 5-2.7M8 7.9v5.6",
  spark: "m8 2 .8 3.2L12 6l-3.2.8L8 10l-.8-3.2L4 6l3.2-.8z",
  queue: "M3 4h10M3 8h10M3 12h6",
  branch: "M5 3v7a3 3 0 0 0 3 3h3M11 10l2 3-2 3M5 3a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  package: "M3 5 8 2.5 13 5v6L8 13.5 3 11zM3 5l5 2.5L13 5M8 7.5v6",
  check: "m3 8 3 3 5-6",
  x: "m4 4 8 8M12 4l-8 8",
  folder: "M2.5 4.5h4l1.3 1.5h5.7v6.5h-11z",
  folderOpen: "M2.5 5V4h4l1.3 1.5H13M2.5 6.5h11l-1.4 6H2.5z",
  more: "M4 8h.01M8 8h.01M12 8h.01",
  copy: "M5 5h7v8H5zM3 11H2.5V3h7v.5",
  edit: "m3 11.8.7-2.8 6.7-6.7 2.3 2.3L6 11.3zM9.7 3l2.3 2.3",
  trash: "M3.5 4.5h9M6 4.5v-2h4v2M5 6v6.5h6V6M7 7.5v3M9 7.5v3",
  alert: "M8 2.5 14 13H2zM8 6v3.5M8 11.5h.01",
  info: "M8 7.5v4M8 4.5h.01",
  down: "m4 6 4 4 4-4",
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round"><path d={icons[name] ?? icons.file} /></svg>;
}

const dialogFocusStack: FocusTrap[] = [];
// A palette/launcher can disappear while opening another dialog. Keep the
// workspace focus origin available when that intermediate trigger is detached.
export const DialogFocusReturnContext = createContext<RefObject<HTMLElement | null> | null>(null);

export function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  onEscape: () => void,
  enabled = true,
  returnFocusRef?: RefObject<HTMLElement | null>,
) {
  const workspaceFocusRef = useContext(DialogFocusReturnContext);
  const escapeRef = useRef(onEscape);
  useEffect(() => { escapeRef.current = onEscape; }, [onEscape]);
  useLayoutEffect(() => {
    if (!enabled) return;
    const previous = returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const root = ref.current;
    if (!root) return;
    const addedFallbackTabIndex = !root.hasAttribute("tabindex");
    if (addedFallbackTabIndex) root.tabIndex = -1;
    const trap = createFocusTrap(root, {
      allowOutsideClick: true,
      delayInitialFocus: false,
      // Confirmation controls can all be disabled while an operation is pending.
      // Keep the dialog itself focusable so focus-trap remains valid in that state.
      fallbackFocus: root,
      escapeDeactivates(event) {
        if (event.target instanceof Element && event.target.closest("[data-dialog-escape-boundary]")) return false;
        event.preventDefault();
        event.stopPropagation();
        escapeRef.current();
        return false;
      },
      setReturnFocus: () => {
        const target = returnFocusRef?.current ?? previous;
        return target?.isConnected && target !== document.body ? target : workspaceFocusRef?.current ?? false;
      },
      trapStack: dialogFocusStack,
    });
    trap.activate();
    return () => {
      trap.deactivate({ returnFocus: true });
      if (addedFallbackTabIndex) root.removeAttribute("tabindex");
    };
  }, [enabled, ref, returnFocusRef, workspaceFocusRef]);
}

export async function copyText(value: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
