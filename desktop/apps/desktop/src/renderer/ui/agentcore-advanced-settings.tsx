import type { AgentCoreSettingsSummary, AgentCoreSettingsUpdate, AgentCoreThinkingBudgets } from "@pfsaa/contracts";
import { copy, type Language } from "@pfsaa/i18n";
import { SelectControl } from "./select-control";

export function AgentCoreAdvancedSettings({ language, settings, onChange }: {
  language: Language; settings: AgentCoreSettingsSummary; onChange: (patch: Omit<AgentCoreSettingsUpdate, "modelThinkingLevels">) => void;
}) {
  const t = copy[language];
  const numbers = [
    ["providerRetryTimeoutMs", t.agentCoreProviderRetryTimeoutMs, 0, 2147483647, false],
    ["providerRetryMaxRetries", t.agentCoreProviderRetryMaxRetries, 0, 100, false],
    ["providerRetryMaxRetryDelayMs", t.agentCoreProviderRetryMaxRetryDelayMs, 0, 2147483647, false],
    ["retryMaxRetries", t.agentCoreRetryMaxRetries, 0, 100, true],
    ["retryBaseDelayMs", t.agentCoreRetryBaseDelayMs, 0, 2147483647, true],
    ["compactionReserveTokens", t.agentCoreCompactionReserveTokens, 1, 100000000, true],
    ["compactionKeepRecentTokens", t.agentCoreCompactionKeepRecentTokens, 0, 100000000, true],
    ["httpIdleTimeoutMs", t.agentCoreHttpIdleTimeoutMs, 0, 2147483647, true],
    ["websocketConnectTimeoutMs", t.agentCoreWebsocketConnectTimeoutMs, 0, 2147483647, false],
  ] as const;
  const thinkingBudgetRows = [
    ["minimal", t.agentCoreThinkingBudgetMinimal],
    ["low", t.agentCoreThinkingBudgetLow],
    ["medium", t.agentCoreThinkingBudgetMedium],
    ["high", t.agentCoreThinkingBudgetHigh],
  ] as const;
  const npmCommand = settings.npmCommand?.join("\n") ?? "";
  function updateThinkingBudget(level: keyof AgentCoreThinkingBudgets, value: number) {
    if (!Number.isFinite(value) || value <= 0) return;
    const next = { ...(settings.thinkingBudgets ?? {}), [level]: value };
    onChange({ thinkingBudgets: next });
  }
  return <details className="agentcore-settings-advanced" data-testid="agentcore-advanced-settings">
    <summary>{t.agentCoreAdvancedSettings}</summary>
    <div className="agentcore-settings-fields">
      <label className="agentcore-settings-check"><input type="checkbox" checked={settings.retryEnabled ?? true} onChange={(event) => onChange({ retryEnabled: event.target.checked })} /><span>{t.agentCoreRetryEnabled}</span></label>
      <p className="agentcore-settings-hint">{t.agentCoreRetryAndCompactionHint}</p>
      {numbers.map(([key, label, min, max, required]) => <label key={key}><span>{label}</span><input type="number" data-testid={`agentcore-${key}`} min={min} max={max} step={1} required={required} defaultValue={settings[key]} onChange={(event) => { if (Number.isFinite(event.target.valueAsNumber)) onChange({ [key]: event.target.valueAsNumber }); }} /></label>)}
      <label><span>{t.agentCoreHttpProxy}</span><input type="url" data-testid="agentcore-httpProxy" defaultValue={settings.httpProxy ?? ""} autoComplete="off" spellCheck={false} maxLength={4096} placeholder={t.agentCoreHttpProxyPlaceholder} onChange={(event) => onChange({ httpProxy: event.target.value })} /><small>{t.agentCoreHttpProxyHint}</small>{settings.httpProxyHasCredentials && <small>{t.agentCoreHttpProxyCredentialsHint}</small>}</label>
      <label className="agentcore-settings-check"><input type="checkbox" checked={settings.defaultTools == null} onChange={(event) => onChange({ defaultTools: event.target.checked ? null : [] })} /><span>{t.agentCoreDefaultToolsAutomatic}</span></label>
      {settings.defaultTools != null && <label><span>{t.agentCoreDefaultTools}</span><input type="text" data-testid="agentcore-defaultTools" defaultValue={settings.defaultTools.join(", ")} autoComplete="off" spellCheck={false} onChange={(event) => onChange({ defaultTools: event.target.value.split(/[\s,]+/).filter(Boolean) })} /><small>{t.agentCoreDefaultToolsHint}</small></label>}
      <fieldset className="agentcore-settings-subsection">
        <legend>{t.agentCoreThinkingAndImages}</legend>
        <p className="agentcore-settings-hint">{t.agentCoreThinkingAndImagesHint}</p>
        <label className="agentcore-settings-check"><input type="checkbox" data-testid="agentcore-imageAutoResize" checked={settings.imageAutoResize ?? true} onChange={(event) => onChange({ imageAutoResize: event.target.checked })} /><span>{t.agentCoreImageAutoResize}</span></label>
        <label className="agentcore-settings-check"><input type="checkbox" data-testid="agentcore-blockImages" checked={settings.blockImages ?? false} onChange={(event) => onChange({ blockImages: event.target.checked })} /><span>{t.agentCoreBlockImages}</span></label>
        <div className="agentcore-settings-budget-grid">
          <span>{t.agentCoreThinkingBudgets}</span>
          <small>{t.agentCoreThinkingBudgetsHint}</small>
          {thinkingBudgetRows.map(([level, label]) => <label key={level}><span>{label}</span><input type="number" data-testid={`agentcore-thinking-budget-${level}`} min={1} max={100000000} step={1} value={settings.thinkingBudgets?.[level] ?? ""} onChange={(event) => updateThinkingBudget(level, event.target.valueAsNumber)} /></label>)}
          <button type="button" className="button ghost" onClick={() => onChange({ thinkingBudgets: null })}>{t.agentCoreClearThinkingBudgets}</button>
        </div>
      </fieldset>
      <fieldset className="agentcore-settings-subsection">
        <legend>{t.agentCoreBranchSummary}</legend>
        <p className="agentcore-settings-hint">{t.agentCoreBranchSummaryHint}</p>
        <label><span>{t.agentCoreBranchSummaryReserveTokens}</span><input type="number" data-testid="agentcore-branchSummaryReserveTokens" min={1} max={100000000} step={1} required defaultValue={settings.branchSummaryReserveTokens} onChange={(event) => { if (Number.isFinite(event.target.valueAsNumber)) onChange({ branchSummaryReserveTokens: event.target.valueAsNumber }); }} /></label>
        <label className="agentcore-settings-check"><input type="checkbox" data-testid="agentcore-branchSummarySkipPrompt" checked={settings.branchSummarySkipPrompt ?? false} onChange={(event) => onChange({ branchSummarySkipPrompt: event.target.checked })} /><span>{t.agentCoreBranchSummarySkipPrompt}</span></label>
        <small className="agentcore-settings-hint">{t.agentCoreBranchSummarySkipPromptHint}</small>
      </fieldset>
      <fieldset className="agentcore-settings-subsection">
        <legend>{t.agentCoreProjectTrustAndResources}</legend>
        <p className="agentcore-settings-hint">{t.agentCoreProjectTrustAndResourcesHint}</p>
        <label><span>{t.agentCoreDefaultProjectTrust}</span><SelectControl testId="agentcore-defaultProjectTrust" aria-label={t.agentCoreDefaultProjectTrust} value={settings.defaultProjectTrust ?? "ask"} options={[{ value: "ask", label: t.agentCoreProjectTrustAsk }, { value: "always", label: t.agentCoreProjectTrustAlways }, { value: "never", label: t.agentCoreProjectTrustNever }]} onChange={(value) => onChange({ defaultProjectTrust: value as AgentCoreSettingsSummary["defaultProjectTrust"] })} /><small>{t.agentCoreDefaultProjectTrustHint}</small></label>
        <label className="agentcore-settings-check"><input type="checkbox" data-testid="agentcore-enableSkillCommands" checked={settings.enableSkillCommands ?? true} onChange={(event) => onChange({ enableSkillCommands: event.target.checked })} /><span>{t.agentCoreEnableSkillCommands}</span></label>
      </fieldset>
      <fieldset className="agentcore-settings-subsection">
        <legend>{t.agentCoreShellAndSession}</legend>
        <p className="agentcore-settings-hint">{t.agentCoreShellAndSessionHint}</p>
        <label><span>{t.agentCoreShellPath}</span><input type="text" data-testid="agentcore-shellPath" defaultValue={settings.shellPath ?? ""} autoComplete="off" spellCheck={false} maxLength={4096} onChange={(event) => onChange({ shellPath: event.target.value })} /><small>{t.agentCoreShellPathHint}</small></label>
        <label><span>{t.agentCoreShellCommandPrefix}</span><input type="text" data-testid="agentcore-shellCommandPrefix" defaultValue={settings.shellCommandPrefix ?? ""} autoComplete="off" spellCheck={false} maxLength={4096} onChange={(event) => onChange({ shellCommandPrefix: event.target.value })} /><small>{t.agentCoreShellCommandPrefixHint}</small></label>
        <label><span>{t.agentCoreNpmCommand}</span><textarea data-testid="agentcore-npmCommand" rows={3} defaultValue={npmCommand} autoComplete="off" spellCheck={false} maxLength={4096} onChange={(event) => { const parts = event.target.value.split(/\r?\n/).map((part) => part.trim()).filter(Boolean); onChange({ npmCommand: parts.length ? parts : null }); }} /><small>{t.agentCoreNpmCommandHint}</small></label>
        <label><span>{t.agentCoreSessionDir}</span><input type="text" data-testid="agentcore-sessionDir" defaultValue={settings.sessionDir ?? ""} autoComplete="off" spellCheck={false} maxLength={4096} onChange={(event) => onChange({ sessionDir: event.target.value })} /><small>{t.agentCoreSessionDirHint}</small></label>
      </fieldset>
      <fieldset className="agentcore-settings-subsection">
        <legend>{t.agentCorePrivacyAndTelemetry}</legend>
        <p className="agentcore-settings-hint">{t.agentCorePrivacyAndTelemetryHint}</p>
        <label className="agentcore-settings-check"><input type="checkbox" data-testid="agentcore-enableInstallTelemetry" checked={settings.enableInstallTelemetry ?? true} onChange={(event) => onChange({ enableInstallTelemetry: event.target.checked })} /><span>{t.agentCoreEnableInstallTelemetry}</span></label>
      </fieldset>
      <p className="agentcore-settings-hint">{t.agentCoreAdvancedSettingsHint}</p>
    </div>
  </details>;
}
