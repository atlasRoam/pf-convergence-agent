import { useEffect, useState } from "react";
import type { PermissionMode, PermissionStatus } from "@pfsaa/contracts";
import { copy, type Language } from "@pfsaa/i18n";
import { Icon } from "@pfsaa/ui-system";
import { handleRovingMenuKeyDown } from "./shared";

function PermissionLevelControl({ language, status, onStatus }: { language: Language; status: PermissionStatus | null; onStatus: (status: PermissionStatus) => void }) {
  const t = copy[language];
  const modes: Array<{ id: PermissionMode; label: string; description: string }> = [
    { id: "ask", label: t.permissionModeAsk, description: t.permissionModeAskDescription },
    { id: "allow", label: t.permissionModeAllow, description: t.permissionModeAllowDescription },
    { id: "deny", label: t.permissionModeDeny, description: t.permissionModeDenyDescription },
    { id: "yolo", label: t.permissionModeYolo, description: t.permissionModeYoloDescription },
  ];
  const current = modes.find((mode) => mode.id === status?.mode) ?? modes[0];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function changeMode(mode: PermissionMode) {
    setBusy(true); setError(null);
    try { onStatus(await window.pfsaa.permissions.setMode(mode)); setOpen(false); }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (event.target instanceof Element && !event.target.closest(".permission-level-wrap")) setOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);
  return <div className="permission-level-wrap"><button type="button" className="permission-level-button" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen((value) => !value)}><span className={`permission-mode-dot ${current.id}`} /><span>{current.label}</span><Icon name="chevron" size={13} /></button>{open && <div className="permission-level-menu" role="menu" aria-label={current.label} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); } else handleRovingMenuKeyDown(event); }}>{modes.map((mode) => <button type="button" role="menuitemradio" aria-checked={mode.id === current.id} tabIndex={mode.id === current.id ? 0 : -1} autoFocus={mode.id === current.id} key={mode.id} className={mode.id === current.id ? "selected" : ""} onClick={() => void changeMode(mode.id)}><span className={`permission-mode-dot ${mode.id}`} /><span><strong>{mode.label}</strong><small>{mode.description}</small></span><Icon name="check" size={13} /></button>)}</div>}{error && <span className="permission-level-error" role="alert">{error}</span>}</div>;
}

export { PermissionLevelControl };
