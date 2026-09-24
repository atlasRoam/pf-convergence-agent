import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentCorePackageResourceSummary, AgentCorePackageSummary } from "@pfsaa/contracts";
import { copy, type Language } from "@pfsaa/i18n";
import { Icon, useDialogFocus } from "@pfsaa/ui-system";

function PackageSettings({ language, cwd, onClose, onNotice, onPackagesChanged, onModelsRefresh }: { language: Language; cwd: string; onClose: () => void; onNotice: (message: string) => void; onPackagesChanged?: () => void; onModelsRefresh?: () => Promise<void> }) {
  const t = copy[language];
  const dialogRef = useRef<HTMLElement>(null);
  const [packages, setPackages] = useState<AgentCorePackageSummary[]>([]);
  const [source, setSource] = useState("");
  const [local, setLocal] = useState(Boolean(cwd));
  const [busy, setBusy] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateSources, setUpdateSources] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const loadVersionRef = useRef(0);
  useDialogFocus(dialogRef, onClose);

  const load = useCallback(async () => {
    const loadVersion = ++loadVersionRef.current;
    setError(null);
    try {
      const next = await window.pfsaa.packages.list(cwd || undefined);
      if (loadVersion === loadVersionRef.current) setPackages(next);
    } catch (reason) {
      if (loadVersion === loadVersionRef.current) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [cwd]);

  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<void>, successMessage: string = t.packageManager) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onPackagesChanged?.();
      await load();
      setSource("");
      onNotice(successMessage);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function checkUpdates() {
    setCheckingUpdates(true);
    setError(null);
    try {
      const updates = await window.pfsaa.packages.checkUpdates(cwd || undefined);
      setUpdateSources(new Set(updates));
      onNotice(updates.length ? t.packageUpdatesFound(updates.length) : t.packageNoUpdates);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function refreshModels() {
    await run(async () => { await window.pfsaa.models.refresh(); await onModelsRefresh?.(); }, t.modelCatalogRefreshed);
  }

  function resourceLabel(resource: AgentCorePackageResourceSummary): string {
    if (resource.type === "extension") return t.packageResourceExtension;
    if (resource.type === "skill") return t.packageResourceSkill;
    if (resource.type === "prompt") return t.packageResourcePrompt;
    return t.packageResourceTheme;
  }

  return <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="settings-sheet package-settings" role="dialog" aria-modal="true" aria-labelledby="package-title">
      <div className="settings-header"><div><span className="eyebrow">{t.brandShortName}</span><h2 id="package-title">{t.packageManager}</h2><p>{t.packageManagerDescription}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label={t.closeSettings} title={t.closeSettings}><Icon name="x" /></button></div>
      <form className="package-install-form" onSubmit={(event) => { event.preventDefault(); if (source.trim()) void run(() => window.pfsaa.packages.install(source.trim(), local, cwd || undefined), `${t.packageInstalled} · ${local ? t.packageLocal : t.packageUser}`); }}>
        <div className="package-install-row">
          <input type="text" value={source} onChange={(event) => setSource(event.target.value)} placeholder={t.packageSource} aria-label={t.packageSource} />
          <button type="submit" className="button primary" disabled={busy || !source.trim()}>{busy ? t.packageBusy : t.packageInstall}</button>
        </div>
        <fieldset className="package-install-scope">
          <legend>{t.packageInstallScope}</legend>
          <div className="package-install-scope-options">
            <label className={`package-install-scope-option${local ? " selected" : ""}`}>
              <input type="radio" name="package-install-scope" value="project" checked={local} disabled={!cwd} onChange={() => setLocal(true)} />
              <span><strong>{t.packageProjectScopeTitle}</strong><small>{t.packageProjectScopeDescription}</small></span>
            </label>
            <label className={`package-install-scope-option${local ? "" : " selected"}`}>
              <input type="radio" name="package-install-scope" value="user" checked={!local} onChange={() => setLocal(false)} />
              <span><strong>{t.packageUserScopeTitle}</strong><small>{t.packageUserScopeDescription}</small></span>
            </label>
          </div>
        </fieldset>
      </form>
      {error && <div className="auth-error" role="alert"><span>{error}</span><button type="button" className="button ghost" onClick={() => void load()}>{t.retry}</button></div>}
      <div className="package-list">{packages.length === 0 ? <div className="provider-list-empty">{t.noPackages}</div> : packages.map((item) => {
        const localPackage = item.scope === "project";
        const hasUpdate = updateSources.has(item.source);
        return <article className="package-row package-card" key={`${item.scope}:${item.source}`}>
          <div className="package-summary"><div><strong>{item.source}</strong><small>{localPackage ? t.packageLocal : t.packageUser}{item.installedPath ? ` · ${item.installedPath}` : ""}</small></div>{hasUpdate && <span className="package-update-badge">{t.packageUpdateAvailable}</span>}</div>
          {item.resources.length > 0 && <details className="package-resources"><summary>{t.packageResources(item.resources.length)}</summary><div>{item.resources.map((resource) => <label className="package-resource-row" key={`${resource.type}:${resource.path}`}><input type="checkbox" checked={resource.enabled} disabled={busy} onChange={(event) => void run(() => window.pfsaa.packages.configureResource(item.source, resource.type, resource.path, event.target.checked, localPackage, cwd || undefined), event.target.checked ? t.packageResourceEnabled : t.packageResourceDisabled)} /><span><strong>{resourceLabel(resource)}</strong><small>{resource.path}</small></span></label>)}</div></details>}
          <div className="package-actions"><button type="button" className="button ghost" data-package-action="toggle-enabled" data-package-enabled={!item.disabled} disabled={busy} onClick={() => void run(() => window.pfsaa.packages.configure(item.source, item.disabled, localPackage, cwd || undefined), item.disabled ? t.packageEnabled : t.packageDisabled)}>{item.disabled ? t.packageConfigure : t.packageDisable}</button><button type="button" className="button ghost" disabled={busy} onClick={() => void run(() => window.pfsaa.packages.update(item.source, cwd || undefined), t.packageUpdated)}>{t.packageUpdateOne}</button><button type="button" className="button danger-subtle" disabled={busy} onClick={() => void run(() => window.pfsaa.packages.remove(item.source, localPackage, cwd || undefined), t.packageRemoved)}>{t.packageRemove}</button></div>
        </article>;
      })}</div>
      <p className="package-runtime-note">{t.agentCoreRuntimeManagedByPfsaa}</p>
      <div className="settings-footer package-settings-footer"><button type="button" className="button ghost" disabled={busy || checkingUpdates} onClick={() => void checkUpdates()}>{checkingUpdates ? t.packageCheckingUpdates : t.packageCheckUpdates}</button><button type="button" className="button ghost" disabled={busy} onClick={() => void run(() => window.pfsaa.packages.update(undefined, cwd || undefined), t.packageUpdated)}>{t.packageUpdate}</button><button type="button" className="button ghost" disabled={busy} onClick={() => void refreshModels()}>{t.modelCatalogRefresh}</button><button type="button" className="button ghost" onClick={onClose}>{t.done}</button></div>
    </section>
  </div>;
}

export { PackageSettings };
