import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Command } from "cmdk";
import Editor from "react-simple-code-editor";
import type { AgentQueuedMessage, AgentQueueState, ContextUsage, ModelSummary, QueueDelivery, QueueMode } from "@pfsaa/contracts";
import { copy, type Language } from "@pfsaa/i18n";
import { Icon } from "@pfsaa/ui-system";
import type { ImageAttachment, PreviewImage, SuggestionMode } from "../types";
import { ContextRingPopover } from "./context-ring";
import { handleRovingMenuKeyDown } from "./shared";

export function highlightComposerText(value: string, commandNames: string[]): ReactNode[] {
  const commands = new Set(commandNames.map((name) => name.replace(/^\//, "").toLowerCase()));
  const result: ReactNode[] = [];
  const pattern = /(^|\s)(\/(?:skill:)?[A-Za-z][\w:-]*|@[\w./\\-]+)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    const prefix = match[1] ?? "";
    const token = match[2] ?? "";
    const isCommand = token.startsWith("/skill:") || commands.has(token.slice(1).toLowerCase());
    if (!isCommand && token.startsWith("/")) continue;
    if (start > cursor) result.push(<span key={`text-${cursor}`}>{value.slice(cursor, start)}</span>);
    if (prefix) result.push(<span key={`space-${start}`}>{prefix}</span>);
    const isSkill = token.startsWith("/skill:");
    const isMention = token.startsWith("@");
    result.push(<mark className={`composer-token ${isSkill ? "skill-token" : isMention ? "mention-token" : "command-token"}`} key={`token-${start}`}>{token}</mark>);
    cursor = start + match[0].length;
  }
  if (cursor < value.length) result.push(<span key={`text-${cursor}`}>{value.slice(cursor)}</span>);
  return result;
}

export type ComposerProps = { sessionKey: string; value: string; onChange: (value: string) => void; onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void; onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void; onDropImages: (files: File[]) => void; onExternalEdit: () => void; externalEditing: boolean; externalEditorShortcut?: string; onSend: () => void; onStop: () => void; isSending: boolean; language: Language; activeModel: ModelSummary | null; modelOptions: ModelSummary[]; thinkingLevel: string; thinkingLevels: string[]; thinkingMenuOpen: boolean; modelMenuOpen: boolean; suggestionMode: SuggestionMode; suggestions: any[]; suggestionIndex: number; contextUsage?: ContextUsage; commandNames: string[]; attachments: ImageAttachment[]; onRemoveAttachment: (id: string) => void; onPreviewImage: (image: PreviewImage) => void; onContextMenuImage: (event: React.MouseEvent, image: PreviewImage) => void; onThinkingMenu: () => void; onModelMenu: () => void; onThinking: (level: string) => void; onModel: (model: ModelSummary) => void; onSuggestion: (item: any) => void; queueDelivery: QueueDelivery; queueState: AgentQueueState | null; queueMutationBusy: boolean; queueEdit: { messageId: string; delivery: QueueDelivery } | null; onQueueDelivery: (delivery: QueueDelivery) => void; onQueueModes: (modes: { steeringMode?: QueueMode; followUpMode?: QueueMode }) => Promise<boolean>; onClearQueue: () => void; onPromoteQueue: (followUpIndex: number) => void; onEditQueue: (message: AgentQueuedMessage, delivery: QueueDelivery) => void; onDeleteQueue: (message: AgentQueuedMessage) => void; onCancelQueueEdit: () => void };

type ExtensionComposerProps = {
  customEditorLines?: string[];
  customEditorActive?: boolean;
  onCustomEditorPaste?: (text: string) => void;
};

function Composer(props: ComposerProps & ExtensionComposerProps) {
  const t = copy[props.language];
  const suggestionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const queueMenuRef = useRef<HTMLDivElement>(null);
  const editorRootRef = useRef<HTMLDivElement>(null);
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const queueEditMessageId = props.queueEdit?.messageId;
  const [modelQuery, setModelQuery] = useState("");
  const [queueMenuOpen, setQueueMenuOpen] = useState(false);
  const [pendingQueueBatchMode, setPendingQueueBatchMode] = useState<QueueMode | null>(null);
  const [dragActive, setDragActive] = useState(false);
  useEffect(() => { suggestionRefs.current[props.suggestionIndex]?.scrollIntoView({ block: "nearest" }); }, [props.suggestionIndex, props.suggestions.length, props.suggestionMode]);
  useEffect(() => { if (!props.modelMenuOpen) setModelQuery(""); }, [props.modelMenuOpen]);
  useEffect(() => {
    setQueueMenuOpen(false);
    setPendingQueueBatchMode(null);
  }, [props.sessionKey]);
  useEffect(() => {
    if (!queueMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !queueMenuRef.current?.contains(event.target)) setQueueMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [queueMenuOpen]);
  useLayoutEffect(() => {
    const root = editorRootRef.current;
    const textarea = root?.querySelector<HTMLTextAreaElement>("textarea");
    const highlight = root?.querySelector<HTMLElement>("pre");
    if (!textarea || !highlight) return;
    const syncScroll = () => {
      // The highlight layer is not the editable viewport. Translate it with
      // the textarea instead of giving it an independent scroll position.
      highlight.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
    };
    const selection = pendingSelectionRef.current;
    if (selection && textarea.value === props.value) {
      textarea.setSelectionRange(
        Math.min(selection.start, props.value.length),
        Math.min(selection.end, props.value.length),
      );
      pendingSelectionRef.current = null;
    }
    if (queueEditMessageId) {
      textarea.focus();
      if (!selection) textarea.setSelectionRange(props.value.length, props.value.length);
    }
    syncScroll();
    const frame = window.requestAnimationFrame(syncScroll);
    textarea.addEventListener("scroll", syncScroll, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      textarea.removeEventListener("scroll", syncScroll);
    };
  }, [props.value, queueEditMessageId]);
  const handleEditorValueChange = (value: string) => {
    const textarea = editorRootRef.current?.querySelector<HTMLTextAreaElement>("textarea");
    if (textarea) pendingSelectionRef.current = { start: textarea.selectionStart, end: textarea.selectionEnd };
    props.onChange(value);
  };
  const queuedMessages = [
    ...(props.queueState?.steering ?? []).map((message, queueIndex) => ({ message, delivery: "steer" as const, kind: "steering" as const, queueIndex })),
    ...(props.queueState?.followUp ?? []).map((message, queueIndex) => ({ message, delivery: "followUp" as const, kind: "followUp" as const, queueIndex })),
  ];
  const hasDraft = props.value.trim().length > 0 || props.attachments.length > 0;
  const stopOnly = props.isSending && !hasDraft && !props.queueEdit;
  const queueBatchMode = props.queueState && props.queueState.steeringMode === props.queueState.followUpMode
    ? props.queueState.steeringMode
    : null;
  const queueModesLocked = props.queueMutationBusy || Boolean(props.queueEdit) || pendingQueueBatchMode !== null;
  const applyQueueBatchMode = async (mode: QueueMode) => {
    if (queueModesLocked) return;
    setPendingQueueBatchMode(mode);
    try {
      const applied = await props.onQueueModes({ steeringMode: mode, followUpMode: mode });
      if (applied) setQueueMenuOpen(false);
    } finally {
      setPendingQueueBatchMode(null);
    }
  };
  const handleEditorPaste: React.ClipboardEventHandler<HTMLElement> = (event) => props.onPaste(event as unknown as React.ClipboardEvent<HTMLTextAreaElement>);
  const handleEditorKeyDown: React.KeyboardEventHandler<HTMLElement> = (event) => props.onKeyDown(event as unknown as React.KeyboardEvent<HTMLTextAreaElement>);
  return <div className={`composer-wrap ${dragActive ? "is-dragging-images" : ""}`} onDragEnter={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragActive(true); } }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }} onDrop={(event) => { event.preventDefault(); setDragActive(false); props.onDropImages(Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"))); }}><div className="composer-shell">
    {dragActive && <div className="composer-drop-overlay" aria-hidden="true"><Icon name="file" size={16} />{t.dropImages}</div>}
    {queuedMessages.length > 0 && <section className="composer-queue" aria-live="polite" aria-label={t.queuedMessages}>
      <div className="composer-queue-header"><Icon name="queue" size={14} /><strong>{t.queuedMessages}</strong><span>{queuedMessages.length}</span></div>
      <div className="composer-queue-list">{queuedMessages.map((item, index) => {
        const editing = props.queueEdit?.messageId === item.message.id;
        const queueLocked = props.queueMutationBusy || Boolean(props.queueEdit);
        return <article className={`composer-queue-item ${editing ? "is-editing" : ""}`} key={item.message.id}>
          <span className="composer-queue-index">{index + 1}</span>
          {item.message.images.length > 0 && <div className="composer-queue-thumbnails">
            {item.message.images.slice(0, 3).map((image, imageIndex) => <button type="button" className="composer-queue-thumbnail" key={`${item.message.id}-image-${imageIndex}`} aria-label={t.imagePreview} title={t.imagePreview} onClick={() => props.onPreviewImage({ src: `data:${image.mimeType};base64,${image.data}`, alt: t.imageAttached })} onContextMenu={(event) => props.onContextMenuImage(event, { src: `data:${image.mimeType};base64,${image.data}`, alt: t.imageAttached })}><img src={`data:${image.mimeType};base64,${image.data}`} alt={t.imageAttached} /></button>)}
            {item.message.images.length > 3 && <span className="composer-queue-image-overflow">+{item.message.images.length - 3}</span>}
            {item.message.images.length > 1 && <span className="composer-queue-image-mobile-count">+{item.message.images.length - 1}</span>}
          </div>}
          <div className="composer-queue-copy"><p title={item.message.text}>{item.message.text || t.imageAttached}</p><small>{item.kind === "steering" ? t.queueSteeringStatus : t.followUp}{item.message.images.length > 0 ? ` · ${t.queueImageCount(item.message.images.length)}` : ""}</small></div>
          <div className="composer-queue-actions">
            {editing ? <span className="composer-queue-status editing" role="status">{t.queueEditing}</span> : <button type="button" className="composer-queue-edit" disabled={queueLocked} aria-label={t.queueEdit} title={t.queueEdit} onClick={() => props.onEditQueue(item.message, item.delivery)}><Icon name="edit" size={13} /></button>}
            {!editing && <button type="button" className="composer-queue-delete" disabled={queueLocked} aria-label={t.queueDelete} title={t.queueDelete} onClick={() => props.onDeleteQueue(item.message)}><Icon name="trash" size={13} /></button>}
            {item.kind === "followUp" ? <button type="button" className="composer-queue-promote" disabled={queueLocked} onClick={() => props.onPromoteQueue(item.queueIndex)}>{props.queueMutationBusy ? t.loading : t.queuePromote}</button> : !editing && <span className="composer-queue-status" role="status">{t.queueSteeringStatus}</span>}
          </div>
        </article>;
      })}</div>
    </section>}
    {props.suggestionMode && props.suggestions.length > 0 && <div className="suggestion-popover" role="listbox" id="composer-suggestions" aria-label={props.suggestionMode === "mention" ? t.files : t.command}>{props.suggestions.map((item, index) => <button id={`composer-suggestion-${index}`} ref={(element) => { suggestionRefs.current[index] = element; }} key={item.name ?? item.path ?? `${item.value}-${index}`} type="button" role="option" aria-selected={index === props.suggestionIndex} className={index === props.suggestionIndex ? "selected" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => props.onSuggestion(item)}><span className="suggestion-symbol">{props.suggestionMode === "mention" ? "@" : props.suggestionMode === "extension" ? "⌁" : "/"}</span><span><strong>{item.name ?? item.path ?? item.label}</strong><small>{item.description ?? item.path ?? item.value}</small></span></button>)}</div>}
    <div className={`composer ${props.queueEdit ? "is-editing-queue" : ""}`}>
      {props.queueEdit && <div className="composer-queue-edit-banner"><span><Icon name="edit" size={13} /><strong>{t.queueEditing}</strong><small>{t.queueEditHint}</small></span><button type="button" disabled={props.queueMutationBusy} onClick={props.onCancelQueueEdit}>{t.queueEditCancel}</button></div>}
      {props.attachments.length > 0 && <div className="composer-attachments">{props.attachments.map((image) => <div className="composer-attachment" key={image.id}><button type="button" className="composer-image-preview" aria-label={t.imagePreview} title={t.imagePreview} onClick={() => props.onPreviewImage({ src: `data:${image.mimeType};base64,${image.data}`, alt: image.name || t.imageAttached })} onContextMenu={(event) => props.onContextMenuImage(event, { src: `data:${image.mimeType};base64,${image.data}`, alt: image.name || t.imageAttached })}><img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name || t.imageAttached} /></button><button type="button" className="composer-remove-image" aria-label={t.removeImage} title={t.removeImage} onClick={() => props.onRemoveAttachment(image.id)}><Icon name="x" size={11} /></button></div>)}</div>}{props.customEditorActive ? <pre className="composer-extension-editor" tabIndex={0} role="textbox" aria-label={t.ask} aria-multiline="true" onKeyDown={handleEditorKeyDown} onPaste={(event) => { event.preventDefault(); const text = event.clipboardData.getData("text/plain"); if (text) props.onCustomEditorPaste?.(text); }}>{props.customEditorLines?.join("\n") ?? ""}</pre> : <div ref={editorRootRef} className="composer-editor"><Editor className="composer-editor-surface" style={{ display: "block", width: "100%" }} value={props.value} onValueChange={handleEditorValueChange} highlight={(code) => <>{code ? highlightComposerText(code, props.commandNames) : <span className="composer-placeholder">{t.ask}</span>}</>} textareaClassName="composer-editor-input" preClassName="composer-highlight" padding={0} onPaste={handleEditorPaste} onKeyDown={handleEditorKeyDown} autoFocus placeholder="" aria-label={t.ask} aria-controls="composer-suggestions" aria-activedescendant={props.suggestionMode && props.suggestions.length ? `composer-suggestion-${props.suggestionIndex}` : undefined} aria-expanded={Boolean(props.suggestionMode && props.suggestions.length)} /></div>}<div className="composer-footer"><div className="composer-tools">
      <div className="menu-anchor composer-thinking-control"><button className="chip" title={t.chooseThinking} aria-haspopup="menu" aria-controls="thinking-menu" aria-expanded={props.thinkingMenuOpen} onClick={props.onThinkingMenu}><Icon name="spark" size={14} /><span>{props.thinkingLevel}</span><Icon name="chevron" size={13} /></button>{props.thinkingMenuOpen && <div className="inline-menu" id="thinking-menu" role="menu" aria-label={t.chooseThinking} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); props.onThinkingMenu(); } else handleRovingMenuKeyDown(event); }}><strong>{t.chooseThinking}</strong>{props.thinkingLevels.map((level, index) => <button role="menuitemradio" aria-checked={level === props.thinkingLevel} tabIndex={level === props.thinkingLevel || (!props.thinkingLevels.includes(props.thinkingLevel) && index === 0) ? 0 : -1} autoFocus={level === props.thinkingLevel || (!props.thinkingLevels.includes(props.thinkingLevel) && index === 0)} key={level} className={level === props.thinkingLevel ? "active" : ""} onClick={() => props.onThinking(level)}>{level}</button>)}</div>}</div>
      <div className="menu-anchor composer-model-control"><button className="model-chip" title={t.chooseModel} aria-haspopup="listbox" aria-controls="model-menu" aria-expanded={props.modelMenuOpen} onClick={props.onModelMenu}><Icon name="model" size={14} /><span className="model-provider">{props.activeModel?.providerName ?? t.provider}</span><span>{props.activeModel?.name ?? (props.modelOptions.length ? t.chooseModel : t.models)}</span><ContextRingPopover usage={props.contextUsage} language={props.language} /><Icon name="chevron" size={13} /></button>{props.modelMenuOpen && <Command id="model-menu" className="inline-menu model-menu" data-conversation-scroll-island="true" label={t.models} loop defaultValue={props.activeModel ? `${props.activeModel.providerId}/${props.activeModel.id}` : undefined} filter={(value, search, keywords = []) => `${value} ${keywords.join(" ")}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()) ? 1 : 0} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); props.onModelMenu(); } }} onWheelCapture={(event) => event.stopPropagation()}><label className="model-search"><Icon name="search" size={13} /><Command.Input autoFocus value={modelQuery} onValueChange={setModelQuery} placeholder={t.searchModels} aria-label={t.searchModels} /></label><Command.List className="model-menu-list"><Command.Empty className="menu-empty">{props.modelOptions.length ? t.noMatchingCommands : t.configureProvider}</Command.Empty>{props.modelOptions.map((model) => { const active = model.id === props.activeModel?.id && model.providerId === props.activeModel?.providerId; return <Command.Item value={`${model.providerId}/${model.id}`} keywords={[model.name, model.providerName]} key={`${model.providerId}/${model.id}`} className={active ? "active" : ""} onSelect={() => props.onModel(model)}><span><strong>{model.name}</strong><small>{model.providerName}</small></span><Icon name="check" size={12} /></Command.Item>; })}</Command.List></Command>}</div>
      <button className="chip subtle composer-mention" aria-label={t.mentionLabel} title={t.mentionLabel} onClick={() => props.onChange(`${props.value}${props.value ? " " : ""}@`)}><Icon name="plus" size={14} />@</button>
      <div ref={queueMenuRef} className="menu-anchor composer-queue-control">
        <button type="button" className="chip subtle" disabled={Boolean(props.queueEdit)} title={t.queueMode} aria-haspopup="menu" aria-controls="queue-menu" aria-expanded={queueMenuOpen} onClick={() => setQueueMenuOpen((current) => !current)}><Icon name="queue" size={13} /><span>{props.queueDelivery === "steer" ? t.steering : t.followUp}</span>{props.queueState && (props.queueState.steering.length + props.queueState.followUp.length) > 0 && <small>{props.queueState.steering.length + props.queueState.followUp.length}</small>}<Icon name="chevron" size={13} /></button>
        {queueMenuOpen && <div className="inline-menu" id="queue-menu" role="menu" aria-label={t.queueMode} aria-busy={pendingQueueBatchMode !== null} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setQueueMenuOpen(false); } else handleRovingMenuKeyDown(event); }}>
          <strong>{t.queueDelivery}</strong>
          <button type="button" role="menuitemradio" aria-checked={props.queueDelivery === "steer"} className={props.queueDelivery === "steer" ? "active" : ""} onClick={() => { props.onQueueDelivery("steer"); setQueueMenuOpen(false); }}>{t.steering}</button>
          <button type="button" role="menuitemradio" aria-checked={props.queueDelivery === "followUp"} className={props.queueDelivery === "followUp" ? "active" : ""} onClick={() => { props.onQueueDelivery("followUp"); setQueueMenuOpen(false); }}>{t.followUp}</button>
          {props.queueState && <>
            <strong>{t.queueBatchMode}</strong>
            <button type="button" role="menuitemradio" aria-checked={queueBatchMode === "all"} aria-label={pendingQueueBatchMode === "all" ? `${t.queueAll} · ${t.loading}` : t.queueAll} className={`queue-mode-option ${queueBatchMode === "all" ? "active" : ""}`} disabled={queueModesLocked} onClick={() => void applyQueueBatchMode("all")}><span>{t.queueAll}</span>{pendingQueueBatchMode === "all" ? <span className="queue-mode-pending" aria-hidden="true" /> : <Icon name="check" size={12} />}</button>
            <button type="button" role="menuitemradio" aria-checked={queueBatchMode === "one-at-a-time"} aria-label={pendingQueueBatchMode === "one-at-a-time" ? `${t.queueOneAtATime} · ${t.loading}` : t.queueOneAtATime} className={`queue-mode-option ${queueBatchMode === "one-at-a-time" ? "active" : ""}`} disabled={queueModesLocked} onClick={() => void applyQueueBatchMode("one-at-a-time")}><span>{t.queueOneAtATime}</span>{pendingQueueBatchMode === "one-at-a-time" ? <span className="queue-mode-pending" aria-hidden="true" /> : <Icon name="check" size={12} />}</button>
            {(props.queueState.steering.length + props.queueState.followUp.length) > 0 && <button type="button" role="menuitem" disabled={props.queueMutationBusy || Boolean(props.queueEdit)} onClick={() => { props.onClearQueue(); setQueueMenuOpen(false); }}>{t.clearQueue}</button>}
          </>}
        </div>}
      </div>
    </div><button type="button" className="composer-external-editor" disabled={props.externalEditing} aria-label={t.externalEditor} title={`${t.externalEditor}${props.externalEditorShortcut ? ` (${props.externalEditorShortcut})` : ""}`} onClick={props.onExternalEdit}><Icon name="edit" size={13} /></button><span className="composer-hint">{props.externalEditing ? t.externalEditorOpening : t.shiftEnter}</span><button className="send-button" disabled={props.queueMutationBusy || props.externalEditing || (props.queueEdit ? !hasDraft : !props.isSending && !hasDraft)} aria-label={props.queueEdit ? t.queueEditSave : stopOnly ? t.stop : t.send} title={props.queueEdit ? t.queueEditSave : stopOnly ? t.stop : t.send} onClick={stopOnly ? props.onStop : props.onSend}><Icon name={props.queueEdit ? "check" : stopOnly ? "stop" : "send"} size={16} /></button></div></div>
  </div></div>;
}

const MemoComposer = memo(Composer, (previous, next) =>
  previous.sessionKey === next.sessionKey
  && previous.value === next.value
  && previous.isSending === next.isSending
  && previous.language === next.language
  && previous.activeModel === next.activeModel
  && previous.modelOptions === next.modelOptions
  && previous.thinkingLevel === next.thinkingLevel
  && previous.thinkingLevels === next.thinkingLevels
  && previous.thinkingMenuOpen === next.thinkingMenuOpen
  && previous.modelMenuOpen === next.modelMenuOpen
  && previous.suggestionMode === next.suggestionMode
  && previous.suggestions === next.suggestions
  && previous.suggestionIndex === next.suggestionIndex
  && previous.contextUsage === next.contextUsage
  && previous.commandNames === next.commandNames
  && previous.attachments === next.attachments
  && previous.queueDelivery === next.queueDelivery
  && previous.queueState === next.queueState
  && previous.queueMutationBusy === next.queueMutationBusy
  && previous.queueEdit?.messageId === next.queueEdit?.messageId
  && previous.externalEditing === next.externalEditing
  && previous.externalEditorShortcut === next.externalEditorShortcut
  && previous.customEditorActive === next.customEditorActive
  && previous.customEditorLines === next.customEditorLines
  && previous.onCustomEditorPaste === next.onCustomEditorPaste
  );

export { MemoComposer };
