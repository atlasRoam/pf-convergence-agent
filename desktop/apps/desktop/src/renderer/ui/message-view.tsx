import { memo, useEffect, useId, useState } from "react";
import { parseSkillInvocation } from "@pfsaa/domain";
import { copy, type Language } from "@pfsaa/i18n";
import { copyText, Icon } from "@pfsaa/ui-system";
import type { PreviewImage } from "../types";
import { bashExecutionDetails, formatMessageTime, messageErrorText, textFromMessage } from "../message-utils";
import { MarkdownContent } from "./markdown";
import { ShellOutput } from "./shell-output";

const LONG_SHELL_OUTPUT_LINES = 8;
const LONG_SHELL_OUTPUT_CHARS = 1_200;

function BashExecutionMessage({ message, language }: { message: any; language: Language }) {
  const execution = bashExecutionDetails(message)!;
  const t = copy[language];
  const outputId = useId();
  // Keep the raw value for copying, but normalize terminal line endings and
  // discard trailing blank rows in the visual presentation. Windows commands
  // commonly end in CRLF, which otherwise creates an unexplained empty line
  // at the bottom of every result card.
  const displayOutput = execution.output.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  const hasDisplayOutput = displayOutput.length > 0;
  const lineCount = hasDisplayOutput ? displayOutput.split("\n").length : 0;
  const longOutput = lineCount > LONG_SHELL_OUTPUT_LINES || displayOutput.length > LONG_SHELL_OUTPUT_CHARS;
  const [expanded, setExpanded] = useState(!longOutput);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const prefix = execution.excludeFromContext ? "!!" : "!";

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1_800);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  async function copyOutput() {
    setCopyState(await copyText(execution.output) ? "copied" : "failed");
  }

  const copyLabel = copyState === "copied" ? t.copiedShellOutput : copyState === "failed" ? t.copyShellOutputFailed : t.copyShellOutput;
  return <section className={`shell-command-message ${execution.failed ? "failed" : ""}`} aria-label={`${prefix}${execution.command}`}>
    <header className="shell-command-header">
      <span className="shell-command-icon"><Icon name={execution.failed ? "alert" : "terminal"} size={14} /></span>
      <div className="shell-command-title">
        <code title={`${prefix}${execution.command}`}><span>{prefix}</span>{execution.command}</code>
        <div className="shell-command-meta">
          <span>{t.shellExitCode} <strong>{execution.exitCode ?? "—"}</strong></span>
          {execution.excludeFromContext && <span className="shell-command-context-badge">{t.shellExcludedFromContext}</span>}
        </div>
      </div>
      <span className={`shell-command-status ${execution.failed ? "failed" : "completed"}`}><Icon name={execution.failed ? "alert" : "check"} size={12} />{execution.failed ? t.sessionState.failed : t.sessionState.completed}</span>
      <button type="button" className="shell-command-copy" disabled={!execution.output} onClick={() => void copyOutput()} aria-label={copyLabel} title={copyLabel}><Icon name={copyState === "copied" ? "check" : "copy"} size={13} /><span aria-live="polite">{copyLabel}</span></button>
    </header>
    <div className={`shell-command-output-wrap ${longOutput && !expanded ? "collapsed" : ""}`}>
      {hasDisplayOutput
        ? <ShellOutput output={displayOutput} lineCount={lineCount} collapsed={longOutput && !expanded} outputId={outputId} label={t.shellOutput} focusable={longOutput} />
        : <div id={outputId} className="shell-command-empty">{t.shellNoOutput}</div>}
    </div>
    {longOutput && <footer className="shell-command-footer"><button type="button" aria-expanded={expanded} aria-controls={outputId} onClick={() => setExpanded((current) => !current)}><span>{expanded ? t.collapseShellOutput : t.expandShellOutput}</span><Icon name="chevron" size={12} /></button></footer>}
  </section>;
}

function MessageView({ message, language, onPreviewImage, onContextMenuImage }: { message: any; language: Language; onPreviewImage: (image: PreviewImage) => void; onContextMenuImage: (event: React.MouseEvent, image: PreviewImage) => void }) {
  const text = textFromMessage(message);
  const images = Array.isArray(message?.content) ? message.content.filter((part: any) => part?.type === "image" && part.data && part.mimeType) : [];
  const t = copy[language];
  const bashExecution = bashExecutionDetails(message);
  if (bashExecution) return <BashExecutionMessage message={message} language={language} />;
  const role = message?.role === "user" ? "user" : message?.role === "toolResult" ? "tool" : "assistant";
  const skillInvocation = role === "user" ? parseSkillInvocation(text) : null;
  const visibleText = skillInvocation ? skillInvocation.userMessage ?? "" : text;
  const errorText = messageErrorText(message);
  if (!visibleText && !skillInvocation && !images.length && !errorText && message?.role !== "toolResult") return null;
  if (role === "tool") {
    const toolName = message?.toolName ?? message?.name ?? t.toolResult;
    const failed = Boolean(message?.isError);
    return <div className={`tool-message ${failed ? "failed" : ""}`}><div className="tool-message-heading"><span className="tool-icon"><Icon name={failed ? "alert" : "terminal"} size={14} /></span><strong>{toolName}</strong><span>{failed ? t.sessionState.failed : t.sessionState.completed}</span></div><pre>{text || t.toolResult}</pre></div>;
  }
  const messageTime = formatMessageTime(message.timestamp, language);
  return <article className={`message ${role === "user" ? "user-message" : "assistant-message"}`} tabIndex={0}><div className="message-bubble"><div className="message-content">{skillInvocation && <div className="message-invocations"><code className="message-invocation">/skill:{skillInvocation.name}</code></div>}{images.length > 0 && <div className="message-images">{images.map((image: any, index: number) => <button type="button" className="image-preview-trigger" key={`${message.id ?? "image"}-${index}`} aria-label={t.imagePreview} onClick={() => onPreviewImage({ src: `data:${image.mimeType};base64,${image.data}`, alt: t.imageAttached })} onContextMenu={(event) => onContextMenuImage(event, { src: `data:${image.mimeType};base64,${image.data}`, alt: t.imageAttached })}><img src={`data:${image.mimeType};base64,${image.data}`} alt={t.imageAttached} /></button>)}</div>}{visibleText && <MarkdownContent text={visibleText} language={language} />}{errorText && <div className="message-error" role="alert"><span className="message-error-heading"><Icon name="alert" size={13} /><strong>{t.assistantResponseFailed}</strong></span><code>{errorText}</code></div>}</div></div>{messageTime && <div className="message-hover-meta"><time dateTime={new Date(message.timestamp).toISOString()}>{messageTime}</time></div>}</article>;
}

const MemoMessageView = memo(MessageView, (previous, next) => previous.message === next.message && previous.language === next.language && previous.onPreviewImage === next.onPreviewImage && previous.onContextMenuImage === next.onContextMenuImage);

export { MemoMessageView };
