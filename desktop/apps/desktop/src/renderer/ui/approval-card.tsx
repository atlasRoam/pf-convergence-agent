import { useState } from "react";
import { copy, type Language } from "@pfsaa/i18n";
import { Icon } from "@pfsaa/ui-system";

function ApprovalCard({ approval, language, onResolve }: { approval: { toolName: string; args?: unknown }; language: Language; onResolve: (decision: "allow-once" | "deny") => Promise<void> }) {
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = copy[language];
  async function resolve(decision: "allow-once" | "deny") {
    setResolving(true); setError(null);
    try { await onResolve(decision); }
    catch (nextError) { setError(nextError instanceof Error ? nextError.message : String(nextError)); setResolving(false); }
  }
  return <div className="approval-card" role="alert"><div className="approval-top"><div className="approval-title"><span className="approval-icon"><Icon name="terminal" size={15} /></span><div><strong>{t.approval}</strong><small>{t.approvalRequest(approval.toolName)}</small></div></div><span className="approval-tool-label">{t.toolCall}</span></div><div className="command-preview"><span className="prompt-symbol">$</span><code>{JSON.stringify(approval.args ?? {}, null, 2)}</code></div>{error && <div className="inline-error" role="alert">{error}</div>}<div className="approval-actions"><button className="button primary" disabled={resolving} onClick={() => void resolve("allow-once")}><Icon name="check" size={14} />{t.approve}</button><button className="button ghost" disabled={resolving} onClick={() => void resolve("deny")}><Icon name="x" size={14} />{t.reject}</button><span className="approval-scope">{resolving ? t.loading : t.approvalScope}</span></div></div>;
}

export { ApprovalCard };
