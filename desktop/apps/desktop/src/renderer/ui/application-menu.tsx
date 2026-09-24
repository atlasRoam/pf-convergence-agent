import { useEffect, useRef, useState } from "react";
import type { ApplicationMenuRequest } from "@pfsaa/contracts";
import { appMenuCopy, type Language } from "@pfsaa/i18n";
import { Icon } from "@pfsaa/ui-system";

const menuIds = ["edit", "view", "help"] as const;

export function ApplicationMenu({ language, onError }: { language: Language; onError: (message: string) => void }) {
  const t = appMenuCopy[language];
  const rootRef = useRef<HTMLDivElement>(null);
  const contentFocusRef = useRef<HTMLElement | null>(null);
  const busyRef = useRef(false);
  const [openMenu, setOpenMenu] = useState<ApplicationMenuRequest["menu"] | null>(null);
  const [tabIndex, setTabIndex] = useState(0);
  useEffect(() => {
    const rememberFocus = () => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body && !rootRef.current?.contains(active)) contentFocusRef.current = active;
    };
    rememberFocus();
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, []);

  async function open(menu: ApplicationMenuRequest["menu"], trigger: HTMLButtonElement, keyboard: boolean) {
    if (busyRef.current) return;
    busyRef.current = true;
    setOpenMenu(menu);
    const { left, bottom } = trigger.getBoundingClientRect();
    // Native edit roles must still target the text control/selection, not this button.
    if (rootRef.current?.contains(document.activeElement) && contentFocusRef.current?.isConnected) contentFocusRef.current.focus({ preventScroll: true });
    try { await window.pfsaa.app.popupMenu({ menu, x: Math.max(0, left), y: Math.max(0, bottom) }); }
    catch { onError(t.menuOpenFailed); }
    finally {
      busyRef.current = false;
      setOpenMenu(null);
      if (keyboard && trigger.isConnected && !trigger.closest("[inert]")) trigger.focus({ preventScroll: true });
    }
  }

  return <div ref={rootRef} className="application-menu">
    <div className="application-menu-items" role="menubar" aria-label={t.applicationMenu} onKeyDown={(event) => {
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      } else if (event.key === "ArrowDown" && index >= 0) {
        event.preventDefault();
        void open(menuIds[index], buttons[index], true);
      } else if (event.key === "Escape") contentFocusRef.current?.focus({ preventScroll: true });
    }}>
      {menuIds.map((id, index) => <button type="button" role="menuitem" key={id} title={t[id]} aria-haspopup="menu" aria-expanded={openMenu === id} tabIndex={tabIndex === index ? 0 : -1} onFocus={() => setTabIndex(index)} onMouseDown={(event) => event.preventDefault()} onClick={(event) => void open(id, event.currentTarget, event.detail === 0)}>{t[id]}</button>)}
    </div>
    <button type="button" className="application-menu-compact" title={t.applicationMenu} aria-label={t.applicationMenu} aria-haspopup="menu" aria-expanded={openMenu === "all"} onMouseDown={(event) => event.preventDefault()} onClick={(event) => void open("all", event.currentTarget, event.detail === 0)}><span>{t.menu}</span><Icon name="chevron" size={12} /></button>
  </div>;
}
