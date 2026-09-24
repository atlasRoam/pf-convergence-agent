import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { EditorState } from "@codemirror/state";
import { getChunks, unifiedMergeView } from "@codemirror/merge";
import { EditorView, minimalSetup } from "codemirror";
import type { SessionChangeReviewMergeSource } from "@pfsaa/contracts";
import { copy, type Language } from "@pfsaa/i18n";
import { Icon, useDialogFocus } from "@pfsaa/ui-system";

export function ChangeReviewMergeEditor({
  source,
  language,
  busy,
  error,
  returnFocusRef,
  onSave,
  onCancel,
}: {
  source: SessionChangeReviewMergeSource;
  language: Language;
  busy: boolean;
  error?: string;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onSave: (content: string, revision: string) => Promise<void>;
  onCancel: () => void;
}) {
  const t = copy[language];
  const dialogRef = useRef<HTMLDivElement>(null);
  const editorHostRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef(source.currentContent);
  const [remaining, setRemaining] = useState(source.unresolvedHunks.length);
  useDialogFocus(dialogRef, onCancel, true, returnFocusRef);

  useEffect(() => {
    const parent = editorHostRef.current;
    if (!parent) return;
    const editor: { view?: EditorView } = {};
    const refreshCount = () => {
      if (editor.view) setRemaining(getChunks(editor.view.state)?.chunks.length ?? 0);
    };
    const mergeControls = (type: "reject" | "accept", action: (event: MouseEvent) => void) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `cm-merge-action ${type}`;
      button.textContent = type === "accept" ? t.changeReviewMergeAccept : t.changeReviewMergeReject;
      button.title = button.textContent;
      button.setAttribute("aria-label", button.textContent);
      button.addEventListener("click", (event) => {
        action(event);
        window.requestAnimationFrame(refreshCount);
      });
      return button;
    };
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: source.currentContent,
        extensions: [
          minimalSetup,
          EditorState.lineSeparator.of(source.lineEnding === "crlf" ? "\r\n" : "\n"),
          unifiedMergeView({
            original: source.originalContent,
            allowInlineDiffs: true,
            collapseUnchanged: { margin: 3, minSize: 8 },
            diffConfig: { scanLimit: 500, timeout: 1_000 },
            mergeControls,
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) contentRef.current = update.state.doc.toString();
            refreshCount();
          }),
          EditorView.theme({
            "&": { height: "100%", backgroundColor: "var(--canvas)", color: "var(--text)" },
            ".cm-scroller": { fontFamily: "var(--font-mono)", fontSize: "12px", lineHeight: "1.6" },
            ".cm-content": { caretColor: "var(--accent)" },
            ".cm-gutters": { backgroundColor: "var(--surface)", color: "var(--faint)", borderRight: "1px solid var(--line)" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--surface-muted)" },
            ".cm-selectionBackground, ::selection": { backgroundColor: "var(--selection-bg) !important" },
            ".cm-changedLine": { backgroundColor: "color-mix(in srgb, var(--accent) 7%, transparent)" },
            ".cm-deletedChunk": { backgroundColor: "color-mix(in srgb, var(--red) 10%, var(--canvas))" },
            ".cm-deletedChunk .cm-merge-action": { color: "var(--green)", backgroundColor: "color-mix(in srgb, var(--green) 14%, var(--surface))", border: "1px solid color-mix(in srgb, var(--green) 38%, var(--line))" },
            ".cm-deletedChunk .cm-merge-action.reject": { color: "var(--red)", backgroundColor: "color-mix(in srgb, var(--red) 12%, var(--surface))", borderColor: "color-mix(in srgb, var(--red) 34%, var(--line))" },
          }),
        ],
      }),
    });
    editor.view = view;
    contentRef.current = view.state.doc.toString();
    refreshCount();
    return () => view.destroy();
  }, [source, t.changeReviewMergeAccept, t.changeReviewMergeReject]);

  const save = async () => {
    const content = source.lineEnding === "crlf"
      ? contentRef.current.replace(/\r?\n/g, "\r\n")
      : contentRef.current.replace(/\r\n/g, "\n");
    await onSave(content, source.currentRevision);
  };

  const portalTarget = document.querySelector<HTMLElement>(".overlay-root") ?? document.body;
  return createPortal(<div className="change-review-merge-backdrop">
    <div ref={dialogRef} className="change-review-merge-dialog" role="dialog" aria-modal="true" aria-labelledby="change-review-merge-title">
      <header>
        <div>
          <strong id="change-review-merge-title" title={source.filePath}>{t.changeReviewMergeTitle(source.filePath)}</strong>
          <small>{t.changeReviewMergeDescription}</small>
        </div>
        <button type="button" className="icon-button" disabled={busy} title={t.changeReviewMergeClose} aria-label={t.changeReviewMergeClose} onClick={onCancel}><Icon name="x" size={13} /></button>
      </header>
      <div ref={editorHostRef} className="change-review-merge-editor" />
      <footer>
        <span role="status">{remaining ? t.changeReviewMergeRemaining(remaining) : t.changeReviewMergeResolved}</span>
        {error && <strong role="alert"><Icon name="alert" size={13} />{error}</strong>}
        <button type="button" className="button ghost" disabled={busy} onClick={onCancel}>{t.changeReviewCancel}</button>
        <button type="button" className="button primary" disabled={busy} onClick={() => void save()}>{busy ? t.changeReviewMergeSaving : t.changeReviewMergeSave}</button>
      </footer>
    </div>
  </div>, portalTarget);
}
