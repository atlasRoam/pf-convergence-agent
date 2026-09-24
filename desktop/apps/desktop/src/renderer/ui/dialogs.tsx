import { useEffect, useRef, useState } from "react";
import type { ExtensionUiRequest, ModelSummary, ProjectTrustStatus, ScopedModelSelection } from "@pfsaa/contracts";
import type { ProjectSummary, TaskSummary } from "@pfsaa/domain";
import { isDefaultSessionTitle } from "@pfsaa/domain";
import { copy, type Language } from "@pfsaa/i18n";
import { Icon, useDialogFocus } from "@pfsaa/ui-system";
import type { PreviewImage } from "../types";
import { handleRovingMenuKeyDown } from "./shared";
import { SelectControl } from "./select-control";

function ImagePreview({ image, language, onClose, onContextMenuImage }: { image: PreviewImage; language: Language; onClose: () => void; onContextMenuImage: (event: React.MouseEvent, image: PreviewImage) => void }) {
  const t = copy[language];
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);
  return <div className="image-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={dialogRef} className="image-preview-dialog" role="dialog" aria-modal="true" aria-label={t.imagePreview}><button type="button" className="icon-button image-preview-close" onClick={onClose} aria-label={t.closeImagePreview} title={t.closeImagePreview}><Icon name="x" /></button><img src={image.src} alt={image.alt} onContextMenu={(event) => onContextMenuImage(event, image)} /></div></div>;
}

function CommandResultDialog({ language, title, body, onClose }: { language: Language; title: string; body: string; onClose: () => void }) {
  const t = copy[language];
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={dialogRef} className="extension-ui-dialog" role="dialog" aria-modal="true" aria-labelledby="command-result-title"><span className="eyebrow">{t.brandShortName}</span><h2 id="command-result-title">{title}</h2><p>{body}</p><div className="dialog-actions"><button type="button" className="button primary" onClick={onClose}>{t.commandResultClose}</button></div></div></div>;
}

function RenameSessionDialog({ language, currentName, onSave, onClose }: { language: Language; currentName: string; onSave: (name: string) => void; onClose: () => void }) {
  const t = copy[language];
  const dialogRef = useRef<HTMLFormElement>(null);
  const [value, setValue] = useState(currentName);
  const [invalid, setInvalid] = useState(false);
  useDialogFocus(dialogRef, onClose);
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form ref={dialogRef} className="extension-ui-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-session-title" onSubmit={(event) => { event.preventDefault(); const next = value.trim(); if (!next) { setInvalid(true); return; } onSave(next); }}><span className="eyebrow">{t.brandShortName}</span><h2 id="rename-session-title">{t.sessionNamePrompt}</h2><label className="session-name-field"><span>{t.sessionNamePrompt}</span><input autoFocus type="text" value={value} onChange={(event) => { setValue(event.target.value); setInvalid(false); }} /></label>{invalid && <div className="field-error" role="alert">{t.sessionNameRequired}</div>}<div className="dialog-actions"><button type="button" className="button ghost" onClick={onClose}>{t.cancel}</button><button type="submit" className="button primary">{t.save}</button></div></form></div>;
}

function ResumeSessionDialog({ language, project, tasks, activeTaskId, onSelect, onClose }: { language: Language; project: ProjectSummary | null; tasks: TaskSummary[]; activeTaskId?: string; onSelect: (task: TaskSummary) => void; onClose: () => void }) {
  const t = copy[language];
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);
  const displayTitle = (title: string) => isDefaultSessionTitle(title) ? t.newTaskName : title;
  const displayModel = (model: string) => model && model !== "No model selected" ? model : t.noModelSelected;
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={dialogRef} className="extension-ui-dialog" role="dialog" aria-modal="true" aria-labelledby="resume-title"><span className="eyebrow">{t.brandShortName}</span><h2 id="resume-title">{t.resumeTitle}</h2><p>{t.resumeDescription}</p>{!project || tasks.length === 0 ? <p>{t.noSessions}</p> : <div className="resume-list">{tasks.map((task) => <button type="button" className={`resume-row${task.id === activeTaskId ? " selected" : ""}`} key={task.id} onClick={() => onSelect(task)}><strong>{displayTitle(task.title)}</strong><small>{displayModel(task.model)}</small></button>)}</div>}<div className="dialog-actions"><button type="button" className="button ghost" onClick={onClose}>{t.cancel}</button></div></div></div>;
}

function TrustDialog({ language, project, status, busy, onResolve, onClose }: { language: Language; project: ProjectSummary; status: ProjectTrustStatus; busy: boolean; onResolve: (trusted: boolean) => void; onClose: () => void }) {
  const t = copy[language];
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);
  const state = status.source === "not-required" ? "not-required" : status.trusted ? "trusted" : "untrusted";
  const stateLabel = state === "not-required" ? t.trustStatusNotRequired : state === "trusted" ? t.trustStatusTrusted : t.trustStatusUntrusted;
  const sourceLabel = status.source === "saved"
    ? t.trustSourceSaved
    : status.source === "inherited"
      ? t.trustSourceInherited(status.sourcePath ?? "")
      : status.source === "default"
        ? t.trustSourceDefault(status.defaultPolicy)
        : t.trustSourceNotRequired;
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><div ref={dialogRef} className="extension-ui-dialog trust-dialog" role="dialog" aria-modal="true" aria-labelledby="trust-title" aria-busy={busy}><span className="eyebrow">{t.brandShortName}</span><h2 id="trust-title">{t.trustProjectTitle(project.name)}</h2><p>{t.trustDescription}</p><div className={`trust-status-card ${state}`} data-trust-status={state} role="status"><span>{t.trustCurrentStatus}</span><strong>{stateLabel}</strong><small>{sourceLabel}</small></div>{status.hasTrustRequiringResources ? <p className="trust-safety-note">{t.trustSafetyNote}</p> : <p>{t.trustNoResources}</p>}<div className="dialog-actions"><button type="button" className="button ghost" data-trust-action="deny" disabled={busy} onClick={() => onResolve(false)}>{t.untrustProject}</button><button type="button" className="button primary" data-trust-action="allow" disabled={busy} onClick={() => onResolve(true)}>{busy ? t.loading : t.trustProject}</button></div></div></div>;
}

function ScopedModelsDialog({ language, models, selectedModels, onSave, onClose }: { language: Language; models: ModelSummary[]; selectedModels: ScopedModelSelection[]; onSave: (models: ScopedModelSelection[] | null, persist: boolean) => void; onClose: () => void }) {
  const t = copy[language];
  const dialogRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<ScopedModelSelection[]>(selectedModels);
  const [persist, setPersist] = useState(false);
  const [query, setQuery] = useState("");
  useDialogFocus(dialogRef, onClose);
  const keyOf = (value: { providerId: string; modelId?: string; id?: string }) => `${value.providerId}/${value.modelId ?? value.id}`;
  const selectedKeys = new Set(selected.map(keyOf));
  const modelByKey = new Map(models.map((model) => [keyOf(model), model]));
  const providers = Array.from(new Map(models.map((model) => [model.providerId, model.providerName])).entries());
  const normalizedQuery = query.trim().toLowerCase();
  const filteredModels = normalizedQuery
    ? models.filter((model) => `${model.name} ${model.providerName} ${model.providerId}/${model.id}`.toLowerCase().includes(normalizedQuery))
    : models;
  function toggle(model: ModelSummary) {
    const key = keyOf(model);
    setSelected((current) => current.some((item) => keyOf(item) === key)
      ? current.filter((item) => keyOf(item) !== key)
      : [...current, { providerId: model.providerId, modelId: model.id }]);
  }
  function toggleProvider(providerId: string) {
    const providerModels = models.filter((model) => model.providerId === providerId);
    const allSelected = providerModels.every((model) => selectedKeys.has(keyOf(model)));
    setSelected((current) => allSelected
      ? current.filter((item) => item.providerId !== providerId)
      : [...current, ...providerModels.filter((model) => !selectedKeys.has(keyOf(model))).map((model) => ({ providerId: model.providerId, modelId: model.id }))]);
  }
  function move(index: number, direction: -1 | 1) {
    setSelected((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }
  function setThinking(index: number, thinkingLevel: string) {
    setSelected((current) => current.map((item, itemIndex) => itemIndex === index
      ? { ...item, thinkingLevel: thinkingLevel || undefined }
      : item));
  }
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={dialogRef} className="extension-ui-dialog scoped-models-dialog" role="dialog" aria-modal="true" aria-labelledby="scoped-models-title"><span className="eyebrow">{t.brandShortName}</span><h2 id="scoped-models-title">{t.scopedModelsTitle}</h2><p>{t.scopedModelsDescription}</p>
    <label className="model-scope-search"><Icon name="search" size={14} /><input autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.searchModels} aria-label={t.searchModels} /></label>
    <section className="model-scope-selected" aria-label={t.scopedModelsOrder}>{selected.length === 0 ? <p className="model-scope-empty">{t.scopedModelsUseAll}</p> : selected.map((item, index) => { const model = modelByKey.get(keyOf(item)); if (!model) return null; return <div className="model-scope-selected-row" key={keyOf(item)}><span className="model-scope-order">{index + 1}</span><span><strong>{model.name}</strong><small>{keyOf(item)}</small></span><SelectControl aria-label={t.scopedModelsThinking(model.name)} value={item.thinkingLevel ?? ""} options={[{ value: "", label: t.scopedModelsInheritThinking }, ...model.thinkingLevels.map((level) => ({ value: level, label: level }))]} onChange={(value) => setThinking(index, value)} /><span className="model-scope-move"><button type="button" className="icon-button" disabled={index === 0} title={t.moveUp} aria-label={t.moveUp} onClick={() => move(index, -1)}><Icon name="down" size={12} /></button><button type="button" className="icon-button" disabled={index === selected.length - 1} title={t.moveDown} aria-label={t.moveDown} onClick={() => move(index, 1)}><Icon name="down" size={12} /></button></span></div>; })}</section>
    <div className="model-scope-list">{providers.map(([providerId, providerName]) => { const providerModels = filteredModels.filter((model) => model.providerId === providerId); if (!providerModels.length) return null; const allProviderSelected = models.filter((model) => model.providerId === providerId).every((model) => selectedKeys.has(keyOf(model))); return <section className="model-scope-provider" key={providerId}><div className="model-scope-provider-heading"><strong>{providerName}</strong><button type="button" className="button ghost" aria-pressed={allProviderSelected} onClick={() => toggleProvider(providerId)}>{allProviderSelected ? t.scopedModelsClearProvider : t.scopedModelsSelectProvider}</button></div>{providerModels.map((model) => { const id = keyOf(model); return <label key={id} className="model-scope-row"><input type="checkbox" checked={selectedKeys.has(id)} onChange={() => toggle(model)} /><span><strong>{model.name}</strong><small>{id}</small></span></label>; })}</section>; })}</div>
    <label className="model-scope-persist"><input type="checkbox" checked={persist} onChange={(event) => setPersist(event.target.checked)} />{t.scopedModelsPersist}</label><div className="dialog-actions"><button type="button" className="button ghost" onClick={onClose}>{t.cancel}</button><button type="button" className="button primary" disabled={models.length === 0} onClick={() => onSave(selected.length > 0 ? selected : null, persist)}>{t.scopedModelsSave}</button></div></div></div>;
}

function ExtensionUiDialog({ language, request, onResolve }: { language: Language; request: ExtensionUiRequest; onResolve: (value: string | boolean | undefined) => void }) {
  const t = copy[language];
  const dialogRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  const [remainingMs, setRemainingMs] = useState<number | undefined>(request.timeoutMs);
  useEffect(() => setValue(request.prefill ?? ""), [request.requestId, request.prefill]);
  useEffect(() => {
    if (!request.timeoutMs) { setRemainingMs(undefined); return; }
    const deadline = Date.now() + request.timeoutMs;
    const update = () => setRemainingMs(Math.max(0, deadline - Date.now()));
    update();
    const timer = window.setInterval(update, 250);
    return () => window.clearInterval(timer);
  }, [request.requestId, request.timeoutMs]);
  useDialogFocus(dialogRef, () => onResolve(request.kind === "confirm" ? false : undefined));
  const titleParts = request.title.split(/\r?\n/);
  return <div className="dialog-backdrop"><div ref={dialogRef} className="extension-ui-dialog" role="dialog" aria-modal="true" aria-labelledby="extension-ui-title"><span className="eyebrow">{t.extensionUiTitle}</span><h2 id="extension-ui-title">{titleParts[0]}</h2>{titleParts.slice(1).map((line, index) => <p key={index}>{line}</p>)}{request.message && <p>{request.message}</p>}{remainingMs !== undefined && <p className="extension-ui-timeout" role="status">{t.extensionUiTimeRemaining(Math.ceil(remainingMs / 1000))}</p>}{request.kind === "select" && <div className="extension-ui-options">{(request.options ?? []).map((option) => <button type="button" className="button ghost" key={option} onClick={() => onResolve(option)}>{option}</button>)}</div>}{request.kind === "confirm" && <div className="dialog-actions"><button type="button" className="button ghost" onClick={() => onResolve(false)}>{t.reject}</button><button type="button" className="button primary" onClick={() => onResolve(true)}>{t.approve}</button></div>}{(request.kind === "input" || request.kind === "editor") && <><textarea autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder={request.placeholder} rows={request.kind === "editor" ? 8 : 3} /><div className="dialog-actions"><button type="button" className="button ghost" onClick={() => onResolve(undefined)}>{t.cancel}</button><button type="button" className="button primary" onClick={() => onResolve(value)}>{t.submit}</button></div></>}</div></div>;
}

function domKeyToAgentCoreInput(event: KeyboardEvent): string | undefined {
  if (event.isComposing || event.metaKey) return undefined;
  const specialKeys: Record<string, string> = {
    ArrowUp: "\x1b[A",
    ArrowDown: "\x1b[B",
    ArrowLeft: "\x1b[D",
    ArrowRight: "\x1b[C",
    Enter: "\r",
    Escape: "\x1b",
    Backspace: "\x7f",
    Delete: "\x1b[3~",
    Home: "\x1b[H",
    End: "\x1b[F",
    PageUp: "\x1b[5~",
    PageDown: "\x1b[6~",
  };
  if (specialKeys[event.key]) {
    const sequence = specialKeys[event.key]!;
    return event.altKey && event.key === "Enter" ? "\x1b\r" : sequence;
  }
  if (event.key === "Tab") return undefined;
  if (event.ctrlKey && event.key.length === 1) {
    const code = event.key.toLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  }
  if (event.altKey && event.key.length === 1) return `\x1b${event.key}`;
  return event.key.length === 1 ? event.key : undefined;
}

function ExtensionCustomUiDialog({ language, request, onInput }: { language: Language; request: ExtensionUiRequest; onInput: (data: string) => void }) {
  const t = copy[language];
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, () => onInput("\x1b"));
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLButtonElement && (event.key === "Enter" || event.key === " ")) return;
    const data = domKeyToAgentCoreInput(event.nativeEvent);
    if (!data) return;
    event.preventDefault();
    event.stopPropagation();
    onInput(data);
  };
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onInput("\x1b"); }}><div ref={dialogRef} tabIndex={-1} className="extension-ui-dialog extension-custom-ui-dialog" role="dialog" aria-modal="true" aria-labelledby="extension-custom-ui-title" onKeyDown={handleKeyDown}><div className="extension-ui-custom-header"><span className="eyebrow" id="extension-custom-ui-title">{t.extensionUiTitle}</span><button type="button" className="icon-button" onClick={() => onInput("\x1b")} aria-label={t.cancel} title={t.cancel}><Icon name="x" size={14} /></button></div><pre className="extension-ui-custom-screen" aria-live="polite">{request.lines?.join("\n") ?? t.loading}</pre></div></div>;
}

function ImageContextMenu({ language, x, y, onCopy }: { language: Language; x: number; y: number; onCopy: () => void }) {
  const t = copy[language];
  return <div className="image-context-menu" role="menu" aria-label={t.copyImage} style={{ left: x, top: y }} onKeyDown={handleRovingMenuKeyDown} onClick={(event) => event.stopPropagation()}><button type="button" role="menuitem" autoFocus onClick={onCopy}><Icon name="copy" size={13} />{t.copyImage}</button></div>;
}

function ConfirmDialog({ language, task, busy, onCancel, onConfirm }: { language: Language; task: TaskSummary; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const t = copy[language];
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, () => { if (!busy) onCancel(); });
  return <div className="dialog-backdrop"><div ref={dialogRef} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description"><span className="confirm-icon"><Icon name="alert" /></span><h2 id="delete-title">{t.deleteSessionTitle}</h2><p id="delete-description">{t.deleteSessionBody(task.title)}</p><div><button className="button ghost" disabled={busy} onClick={onCancel}>{t.cancel}</button><button className="button danger" disabled={busy} onClick={onConfirm}>{busy ? t.deleting : t.deleteSession}</button></div></div></div>;
}

function ProjectRemoveDialog({ language, project, busy, onCancel, onConfirm }: { language: Language; project: ProjectSummary; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const t = copy[language];
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, () => { if (!busy) onCancel(); });
  return <div className="dialog-backdrop"><div ref={dialogRef} className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="project-remove-title" aria-describedby="project-remove-description"><span className="confirm-icon"><Icon name="alert" /></span><h2 id="project-remove-title">{t.removeProjectTitle}</h2><p id="project-remove-description">{t.removeProjectBody(project.name)}</p><div><button className="button ghost" disabled={busy} onClick={onCancel}>{t.cancel}</button><button className="button danger" disabled={busy} onClick={onConfirm}>{busy ? t.removingProject : t.removeProject}</button></div></div></div>;
}

export { ImagePreview, CommandResultDialog, RenameSessionDialog, ResumeSessionDialog, TrustDialog, ScopedModelsDialog, ExtensionUiDialog, ExtensionCustomUiDialog, ImageContextMenu, ConfirmDialog, ProjectRemoveDialog };
