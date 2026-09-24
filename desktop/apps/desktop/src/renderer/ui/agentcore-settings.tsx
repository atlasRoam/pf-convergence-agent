import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelSummary, AgentCoreSettingsSummary, AgentCoreSettingsUpdate } from "@pfsaa/contracts";
import { copy, type Language } from "@pfsaa/i18n";
import { Icon, useDialogFocus } from "@pfsaa/ui-system";
import { AgentCoreAdvancedSettings } from "./agentcore-advanced-settings";
import { SelectControl } from "./select-control";

export function AgentCoreSettings({ language, cwd, models, onClose, onNotice }: {
  language: Language;
  cwd: string;
  models: ModelSummary[];
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const t = copy[language];
  const dialogRef = useRef<HTMLElement>(null);
  const [settings, setSettings] = useState<AgentCoreSettingsSummary | null>(null);
  const [editorMode, setEditorMode] = useState<"automatic" | "custom">("automatic");
  const [busy, setBusy] = useState(false);
  const [editorPicking, setEditorPicking] = useState(false);
  const [editorPickerError, setEditorPickerError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [advancedUpdate, setAdvancedUpdate] = useState<AgentCoreSettingsUpdate>({});
  const [modelThinkingLevelChanges, setModelThinkingLevelChanges] = useState<Record<string, string | null>>({});
  useDialogFocus(dialogRef, onClose);

  function applySettings(value: AgentCoreSettingsSummary) {
    setSettings(value);
    setAdvancedUpdate({});
    setModelThinkingLevelChanges({});
    setEditorMode(value.externalEditor ? "custom" : "automatic");
  }

  async function loadSettings() {
    setError(null);
    try {
      const value = await window.pfsaa.settings.get(cwd || undefined);
      applySettings(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  useEffect(() => {
    let active = true;
    setError(null);
    void window.pfsaa.settings.get(cwd || undefined)
      .then((value) => { if (active) applySettings(value); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [cwd]);

  async function save() {
    if (!settings) return;
    const invalid = dialogRef.current?.querySelector<HTMLInputElement>("input:invalid");
    if (invalid) { invalid.closest("details")?.setAttribute("open", ""); invalid.reportValidity(); invalid.focus(); return; }
    setBusy(true); setError(null);
    try {
      const update: AgentCoreSettingsUpdate = {
        ...advancedUpdate,
        defaultProvider: settings.defaultProvider,
        defaultModel: settings.defaultModel,
        defaultThinkingLevel: settings.defaultThinkingLevel,
        transport: settings.transport,
        compactionEnabled: settings.compactionEnabled,
        steeringMode: settings.steeringMode,
        followUpMode: settings.followUpMode,
        externalEditor: editorMode === "automatic" ? "" : settings.externalEditor,
        ...(Object.keys(modelThinkingLevelChanges).length ? { modelThinkingLevels: modelThinkingLevelChanges } : {}),
      };
      const next = await window.pfsaa.settings.update(update, cwd || undefined);
      setSettings(next);
      onNotice(t.agentCoreSettingsSaved);
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function chooseExternalEditor() {
    setEditorPicking(true); setEditorPickerError(null);
    try {
      const command = await window.pfsaa.settings.chooseExternalEditor();
      if (command) setSettings((current) => current ? { ...current, externalEditor: command } : current);
    } catch (reason) { setEditorPickerError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setEditorPicking(false); }
  }

  const modelValue = settings?.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : "";
  const defaultThinkingLevels = useMemo(() => {
    if (!settings) return [];
    const selectedModel = models.find((model) => model.providerId === settings.defaultProvider && model.id === settings.defaultModel);
    const levels = selectedModel?.thinkingLevels.length
      ? selectedModel.thinkingLevels
      : [...new Set(models.flatMap((model) => model.thinkingLevels))];
    return levels.includes(settings.defaultThinkingLevel) ? levels : [settings.defaultThinkingLevel, ...levels];
  }, [models, settings]);
  const configuredModelThinkingLevels = settings?.modelThinkingLevels;
  const modelThinkingLevels = useMemo(() => configuredModelThinkingLevels ?? {}, [configuredModelThinkingLevels]);
  const modelThinkingRows = useMemo(() => {
    const known = new Set(models.map((model) => `${model.providerId}/${model.id}`));
    const configuredOnly = Object.entries(modelThinkingLevels).flatMap(([reference, level]) => {
      if (known.has(reference)) return [];
      const separator = reference.indexOf("/");
      if (separator <= 0 || separator === reference.length - 1) return [];
      const providerId = reference.slice(0, separator);
      const id = reference.slice(separator + 1);
      return [{ id, providerId, providerName: providerId, name: id, reasoning: true, thinkingLevels: [level], authConfigured: false } satisfies ModelSummary];
    });
    return [...models, ...configuredOnly];
  }, [modelThinkingLevels, models]);

  function updateModelThinkingLevel(model: ModelSummary, value: string) {
    const key = `${model.providerId}/${model.id}`;
    const level = value || null;
    setModelThinkingLevelChanges((current) => ({ ...current, [key]: level }));
    setSettings((current) => {
      if (!current) return current;
      const next = { ...(current.modelThinkingLevels ?? {}) };
      if (level === null) delete next[key];
      else next[key] = level;
      return { ...current, modelThinkingLevels: next };
    });
  }

  const editorCommandMissing = editorMode === "custom" && !settings?.externalEditor?.trim();
  return <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="settings-sheet agentcore-settings" role="dialog" aria-modal="true" aria-labelledby="agentcore-settings-title" data-testid="agentcore-settings-dialog">
      <div className="settings-header"><div><span className="eyebrow">{t.brandShortName}</span><h2 id="agentcore-settings-title">{t.agentCoreSettingsTitle}</h2><p>{t.agentCoreSettingsDescription}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label={t.closeSettings}><Icon name="x" /></button></div>
      {!settings && !error && <div className="provider-list-empty">{t.loading}</div>}
      {error && <div className="auth-error" role="alert"><span>{error}</span><button type="button" className="button ghost" onClick={() => void loadSettings()}>{t.retry}</button></div>}
      {settings && <div className="agentcore-settings-fields">
        <label><span>{t.agentCoreDefaultModel}</span><SelectControl testId="agentcore-defaultModel" aria-label={t.agentCoreDefaultModel} value={modelValue} disabled={models.length === 0} options={[{ value: "", label: t.chooseModel, disabled: true }, ...models.map((model) => ({ value: `${model.providerId}/${model.id}`, label: `${model.providerName} · ${model.name}` }))]} onChange={(value) => { const [defaultProvider, ...parts] = value.split("/"); setSettings((current) => current ? { ...current, defaultProvider, defaultModel: parts.join("/") } : current); }} /></label>
        <label><span>{t.agentCoreDefaultThinking}</span><SelectControl testId="agentcore-defaultThinking" aria-label={t.agentCoreDefaultThinking} value={settings.defaultThinkingLevel} options={defaultThinkingLevels.map((level) => ({ value: level, label: level }))} onChange={(value) => setSettings({ ...settings, defaultThinkingLevel: value })} /><small>{t.agentCoreDefaultThinkingHint}</small></label>
        <fieldset className="agentcore-settings-model-thinking">
          <legend>{t.agentCoreModelThinkingDefaults}</legend>
          <p className="agentcore-settings-hint">{t.agentCoreModelThinkingHint}</p>
          {modelThinkingRows.length === 0 && <p className="agentcore-settings-hint">{t.agentCoreModelThinkingNoModels}</p>}
          {modelThinkingRows.length > 0 && <div className="agentcore-settings-model-thinking-list">
            {modelThinkingRows.map((model) => {
              const key = `${model.providerId}/${model.id}`;
              const configuredLevel = modelThinkingLevels[key];
              const levels = configuredLevel && !model.thinkingLevels.includes(configuredLevel)
                ? [configuredLevel, ...model.thinkingLevels]
                : model.thinkingLevels;
              return <label className="agentcore-settings-model-thinking-row" key={key}>
                <span><strong>{model.name}</strong><small>{model.providerName}</small></span>
                <SelectControl testId={`agentcore-model-thinking-${model.providerId}-${model.id}`} aria-label={t.agentCoreModelThinking(model.name)} value={configuredLevel ?? ""} options={[{ value: "", label: t.agentCoreModelThinkingInherit(settings.defaultThinkingLevel) }, ...levels.map((level) => ({ value: level, label: level }))]} onChange={(value) => updateModelThinkingLevel(model, value)} />
              </label>;
            })}
          </div>}
        </fieldset>
        <label><span>{t.agentCoreTransport}</span><SelectControl testId="agentcore-transport" aria-label={t.agentCoreTransport} value={settings.transport} options={[{ value: "auto", label: t.agentCoreTransportAuto }, { value: "sse", label: t.agentCoreTransportSse }, { value: "websocket", label: t.agentCoreTransportWebsocket }, { value: "websocket-cached", label: t.agentCoreTransportWebsocketCached }]} onChange={(value) => setSettings({ ...settings, transport: value as AgentCoreSettingsSummary["transport"] })} /><small>{t.agentCoreTransportHint}</small></label>
        <label><span>{t.agentCoreSteeringMode}</span><SelectControl testId="agentcore-steeringMode" aria-label={t.agentCoreSteeringMode} value={settings.steeringMode} options={[{ value: "one-at-a-time", label: t.agentCoreQueueModeOneAtATime }, { value: "all", label: t.agentCoreQueueModeAll }]} onChange={(value) => setSettings({ ...settings, steeringMode: value as AgentCoreSettingsSummary["steeringMode"] })} /><small>{t.agentCoreSteeringModeHint}</small></label>
        <label><span>{t.agentCoreFollowUpMode}</span><SelectControl testId="agentcore-followUpMode" aria-label={t.agentCoreFollowUpMode} value={settings.followUpMode} options={[{ value: "one-at-a-time", label: t.agentCoreQueueModeOneAtATime }, { value: "all", label: t.agentCoreQueueModeAll }]} onChange={(value) => setSettings({ ...settings, followUpMode: value as AgentCoreSettingsSummary["followUpMode"] })} /><small>{t.agentCoreFollowUpModeHint}</small></label>
        <fieldset className="agentcore-settings-editor">
          <legend>{t.agentCoreExternalEditor}</legend>
          <div className="agentcore-settings-editor-modes">
            <label className={`agentcore-settings-editor-mode${editorMode === "automatic" ? " selected" : ""}`}>
              <input type="radio" name="external-editor-mode" value="automatic" data-testid="agentcore-external-editor-automatic" checked={editorMode === "automatic"} onChange={() => setEditorMode("automatic")} />
              <span><strong>{t.agentCoreExternalEditorAutomatic}</strong><small>{t.agentCoreExternalEditorAutomaticDescription}</small></span>
            </label>
            <label className={`agentcore-settings-editor-mode${editorMode === "custom" ? " selected" : ""}`}>
              <input type="radio" name="external-editor-mode" value="custom" data-testid="agentcore-external-editor-custom" checked={editorMode === "custom"} onChange={() => setEditorMode("custom")} />
              <span><strong>{t.agentCoreExternalEditorCustom}</strong><small>{t.agentCoreExternalEditorCustomDescription}</small></span>
            </label>
          </div>
          {editorMode === "custom" && <div className="agentcore-settings-editor-control">
            <label htmlFor="agentcore-external-editor-command">{t.agentCoreExternalEditorCommand}</label>
            <div className="agentcore-settings-editor-command-row">
              <input id="agentcore-external-editor-command" type="text" data-testid="agentcore-external-editor" value={settings.externalEditor ?? ""} maxLength={1000} autoComplete="off" spellCheck={false} placeholder={t.agentCoreExternalEditorPlaceholder} aria-invalid={editorCommandMissing} aria-describedby={`agentcore-external-editor-status agentcore-external-editor-hint${editorCommandMissing ? " agentcore-external-editor-required" : ""}`} onChange={(event) => setSettings({ ...settings, externalEditor: event.target.value })} />
              <button type="button" className="button ghost" data-testid="agentcore-external-editor-choose" disabled={editorPicking} onClick={() => void chooseExternalEditor()}>{editorPicking ? t.agentCoreExternalEditorChoosing : t.agentCoreExternalEditorChoose}</button>
            </div>
            {editorPickerError && <div className="agentcore-settings-editor-error" role="alert"><span>{editorPickerError}</span><button type="button" className="button ghost" onClick={() => void chooseExternalEditor()}>{t.retry}</button></div>}
            {editorCommandMissing && <small id="agentcore-external-editor-required" className="agentcore-settings-field-error" role="alert">{t.agentCoreExternalEditorRequired}</small>}
            <small id="agentcore-external-editor-hint">{t.agentCoreExternalEditorHint}</small>
          </div>}
          <small id="agentcore-external-editor-status" className="agentcore-settings-effective">{t.agentCoreExternalEditorEffective(settings.effectiveExternalEditor, settings.externalEditorSource)}</small>
        </fieldset>
        <label className="agentcore-settings-check"><input type="checkbox" checked={settings.compactionEnabled} onChange={(event) => setSettings({ ...settings, compactionEnabled: event.target.checked })} /><span>{t.agentCoreAutoCompaction}</span></label>
        <AgentCoreAdvancedSettings language={language} settings={settings} onChange={(patch) => { setAdvancedUpdate((current) => ({ ...current, ...patch })); setSettings((current) => current ? { ...current, ...patch } : current); }} />
        <p className="agentcore-settings-hint">{t.agentCoreSettingsReloadHint}</p>
      </div>}
      <div className="settings-footer"><button type="button" className="button ghost" onClick={onClose}>{t.cancel}</button><button type="button" className="button primary" data-testid="agentcore-settings-save" disabled={busy || editorPicking || !settings || editorCommandMissing} onClick={() => void save()}>{busy ? t.saving : t.save}</button></div>
    </section>
  </div>;
}
