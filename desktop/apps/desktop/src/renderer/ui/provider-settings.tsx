import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthMethod, ProviderModelDefinition, ProviderSummary } from "@pfsaa/contracts";
import { copy, type Language } from "@pfsaa/i18n";
import { Icon, useDialogFocus } from "@pfsaa/ui-system";
import type { AuthPromptState, ProviderFilter } from "../types";

type ProviderDraft = { name: string; baseUrl: string; apiKey: string; models: ProviderModelDefinition[]; modelIdInput: string };

const emptyProviderDraft: ProviderDraft = {
  name: "",
  baseUrl: "",
  apiKey: "",
  models: [],
  modelIdInput: "",
};

function ProviderSettings({ language, focusProviderId, onClose, onModelsRefresh }: { language: Language; focusProviderId: string | null; onClose: () => void; onModelsRefresh: (providerId?: string) => Promise<void> | void }) {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [providerStates, setProviderStates] = useState<Record<string, ProviderSummary["authState"]>>({});
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [, setAuthMethod] = useState<AuthMethod | null>(null);
  const [apiKeyProvider, setApiKeyProvider] = useState<string | null>(null);
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [manualAuthVisible, setManualAuthVisible] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [authPrompt, setAuthPrompt] = useState<AuthPromptState | null>(null);
  const [providerQuery, setProviderQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [pendingLogout, setPendingLogout] = useState<ProviderSummary | null>(null);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [pendingProviderRemoval, setPendingProviderRemoval] = useState<ProviderSummary | null>(null);
  const [providerRemovalError, setProviderRemovalError] = useState<string | null>(null);
  const [createProviderOpen, setCreateProviderOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderSummary | null>(null);
  const [providerDraft, setProviderDraft] = useState<ProviderDraft>(emptyProviderDraft);
  const [providerDraftErrors, setProviderDraftErrors] = useState<Partial<Record<"name" | "baseUrl" | "apiKey" | "models", string>>>({});
  const [providerCreateError, setProviderCreateError] = useState<string | null>(null);
  const [creatingProvider, setCreatingProvider] = useState(false);
  const [discoveringProviderModels, setDiscoveringProviderModels] = useState(false);
  const [providerModelCandidates, setProviderModelCandidates] = useState<ProviderModelDefinition[]>([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [providerDiscoveryError, setProviderDiscoveryError] = useState<string | null>(null);
  const [hiddenProviders, setHiddenProviders] = useState<ProviderSummary[]>([]);
  const [hiddenProvidersError, setHiddenProvidersError] = useState<string | null>(null);
  const [hiddenProvidersLoading, setHiddenProvidersLoading] = useState(false);
  const [restoringProvider, setRestoringProvider] = useState<string | null>(null);
  const [managementNotice, setManagementNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const dialogRef = useRef<HTMLElement>(null);
  const authPromptRef = useRef<HTMLFormElement>(null);
  const logoutPromptRef = useRef<HTMLDivElement>(null);
  const providerRemovalPromptRef = useRef<HTMLDivElement>(null);
  const providerCreatePromptRef = useRef<HTMLFormElement>(null);
  const providerAddButtonRef = useRef<HTMLButtonElement>(null);
  const activeOAuthLoginIdsRef = useRef(new Set<string>());
  const t = copy[language];
  const authPromptVisible = Boolean(authPrompt && (authPrompt.type !== "manual_code" || manualAuthVisible));
  const normalizedProviderQuery = providerQuery.trim().toLocaleLowerCase();
  const isBusy = Boolean(busyProvider || creatingProvider || discoveringProviderModels || restoringProvider);
  const providerDraftModelIds = new Set(providerDraft.models.map((model) => model.id));
  const providerDiscoveryRequirementsMissing = !providerDraft.baseUrl.trim() || (!editingProvider && !providerDraft.apiKey.trim());
  const filteredProviders = useMemo(() => providers.filter((provider) => {
    const state = providerStates[provider.id] ?? provider.authState;
    const matchesQuery = !normalizedProviderQuery || `${provider.name} ${provider.id}`.toLocaleLowerCase().includes(normalizedProviderQuery);
    const matchesFilter = providerFilter === "all" || (providerFilter === "missing" ? state === "missing" || state === "available" : state === providerFilter);
    return matchesQuery && matchesFilter;
  }), [normalizedProviderQuery, providerFilter, providerStates, providers]);

  function closeApiKeyForm() {
    setApiKeyProvider(null);
    setApiKeyValue("");
  }

  function closeCreateProvider() {
    if (creatingProvider || discoveringProviderModels || restoringProvider) return;
    setCreateProviderOpen(false);
    setEditingProvider(null);
    setProviderDraft(emptyProviderDraft);
    setProviderDraftErrors({});
    setProviderCreateError(null);
    setProviderDiscoveryError(null);
    setProviderModelCandidates([]);
    setSelectedCandidateIds([]);
    setHiddenProvidersError(null);
  }

  function authErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("PFSAA_OAUTH_CALLBACK_UNAVAILABLE") ? t.oauthCallbackUnavailable : message;
  }

  const providerErrorMessage = useCallback((error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("PFSAA_PROVIDER_IN_USE")) return t.providerInUse;
    if (message.includes("PFSAA_PROVIDER_AUTH_IN_PROGRESS")) return t.providerAuthInProgress;
    if (message.includes("PFSAA_PROVIDER_CONFIGURATION_INVALID")) return t.providerConfigurationInvalid;
    return message;
  }, [t]);

  function providerAuthSourceLabel(source: ProviderSummary["authSource"]): string | null {
    switch (source) {
      case "stored": return t.providerAuthSourceStored;
      case "environment": return t.providerAuthSourceEnvironment;
      case "models-json": return t.providerAuthSourceModelsJson;
      case "runtime": return t.providerAuthSourceRuntime;
      case "external": return t.providerAuthSourceExternal;
      case "none": return null;
    }
  }

  async function resolvePrompt(value: string) {
    if (!authPrompt) return;
    const requestId = authPrompt.requestId;
    try {
      await window.pfsaa.providers.resolveAuth(requestId, value);
    } catch (error) {
      setAuthError(authErrorMessage(error));
      return;
    }
    setAuthPrompt(null);
    setManualAuthVisible(false);
    setAuthError(null);
  }

  async function cancelAuthPrompt() {
    if (!authPrompt) return;
    const requestId = authPrompt.requestId;
    try {
      await window.pfsaa.providers.resolveAuth(requestId, "", true);
    } catch {
      // The login request will surface its cancellation result.
    }
    setAuthPrompt(null);
    setManualAuthVisible(false);
    setAuthError(null);
    setAuthMethod(null);
  }

  useDialogFocus(dialogRef, () => {
    if (apiKeyProvider) {
      closeApiKeyForm();
      return;
    }
    if (!isBusy) onClose();
  }, !authPromptVisible && !pendingLogout && !pendingProviderRemoval && !createProviderOpen);
  useDialogFocus(authPromptRef, () => void cancelAuthPrompt(), authPromptVisible);
  useDialogFocus(logoutPromptRef, () => {
    if (!busyProvider) {
      setPendingLogout(null);
      setLogoutError(null);
    }
  }, Boolean(pendingLogout));
  useDialogFocus(providerRemovalPromptRef, () => {
    if (!busyProvider) {
      setPendingProviderRemoval(null);
      setProviderRemovalError(null);
    }
  }, Boolean(pendingProviderRemoval));
  useDialogFocus(providerCreatePromptRef, closeCreateProvider, createProviderOpen, providerAddButtonRef);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const next = await window.pfsaa.providers.list();
      setProviders([...next].sort((a, b) => Number(b.authState === "configured") - Number(a.authState === "configured") || a.name.localeCompare(b.name)));
      setProviderStates(Object.fromEntries(next.map((provider) => [provider.id, provider.authState])));
    } catch (error) {
      setListError(`${t.providerLoadFailed}: ${providerErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [providerErrorMessage, t.providerLoadFailed]);

  const loadHiddenProviders = useCallback(async () => {
    setHiddenProvidersLoading(true);
    setHiddenProvidersError(null);
    try {
      const next = await window.pfsaa.providers.listHidden();
      setHiddenProviders([...next].sort((a, b) => a.name.localeCompare(b.name)));
    } catch (error) {
      setHiddenProvidersError(providerErrorMessage(error));
    } finally {
      setHiddenProvidersLoading(false);
    }
  }, [providerErrorMessage]);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);
  useEffect(() => () => {
    const activeLoginIds = [...activeOAuthLoginIdsRef.current];
    activeOAuthLoginIdsRef.current.clear();
    for (const authOperationId of activeLoginIds) {
      void window.pfsaa.providers.cancelLogin(authOperationId).catch(() => {
        // PfsaaHost may already have completed the login.
      });
    }
  }, []);
  useEffect(() => {
    if (!focusProviderId || !providers.length) return;
    setProviderQuery("");
    setProviderFilter("all");
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-provider-id="${CSS.escape(focusProviderId)}"]`)?.scrollIntoView({ block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [focusProviderId, providers]);
  useEffect(() => window.pfsaa.events.subscribe((runtimeEvent) => {
    if (runtimeEvent.type !== "auth.event" || !runtimeEvent.requestId) return;
    const event = runtimeEvent.event as any;
    if (event?.type === "prompt") {
      setAuthError(null);
      const promptType = event.prompt?.type === "select" || event.prompt?.type === "secret" || event.prompt?.type === "manual_code" ? event.prompt.type : "text";
      setManualAuthVisible(false);
      if (promptType === "manual_code") setAuthNotice((current) => current ?? t.oauthWaiting);
      else {
        setAuthNotice(null);
        setAuthUrl(null);
      }
      const options = Array.isArray(event.prompt?.options)
        ? event.prompt.options.filter((option: any) => typeof option?.id === "string" && typeof option?.label === "string").map((option: any) => ({ id: option.id, label: option.label, description: typeof option.description === "string" ? option.description : undefined }))
        : undefined;
      setAuthPrompt({ requestId: runtimeEvent.requestId, type: promptType, message: event.prompt?.message ?? t.authPromptFallback, placeholder: event.prompt?.placeholder ?? "", value: "", options });
    } else if (event?.type === "notify" && event.event?.type === "auth_url") {
      setAuthUrl(null);
      setAuthNotice(t.oauthWaiting);
      setManualAuthVisible(false);
      if (event.event.url) {
        const url = String(event.event.url);
        setAuthUrl(url);
        void window.pfsaa.providers.openAuthUrl(url).catch((error) => {
          setAuthNotice(`${t.authUrlAutoOpenFailed}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } else if (event?.type === "notify" && event.event?.type === "device_code") {
      setAuthUrl(null);
      setAuthNotice(event.event.userCode ? t.authDeviceCode(String(event.event.userCode)) : t.oauthWaiting);
      setManualAuthVisible(false);
      if (event.event.verificationUri) {
        const url = String(event.event.verificationUri);
        setAuthUrl(url);
        void window.pfsaa.providers.openAuthUrl(url).catch((error) => {
          setAuthNotice(`${t.authUrlAutoOpenFailed}: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  }), [t]);

  async function auth(providerId: string, method: AuthMethod, secret?: string) {
    if (method === "api-key" && !secret?.trim()) {
      setFieldErrors((current) => ({ ...current, [providerId]: t.apiKeyRequired }));
      return;
    }
    const authOperationId = method === "oauth" ? crypto.randomUUID() : undefined;
    if (authOperationId) activeOAuthLoginIdsRef.current.add(authOperationId);
    setBusyProvider(providerId);
    setAuthMethod(method);
    setAuthError(null);
    setAuthNotice(null);
    setAuthUrl(null);
    setAuthPrompt(null);
    setManualAuthVisible(false);
    setManagementNotice(null);
    setFieldErrors((current) => ({ ...current, [providerId]: undefined }));
    try {
      if (method === "api-key") await window.pfsaa.providers.setApiKey(providerId, secret!.trim());
      else await window.pfsaa.providers.login(providerId, method, undefined, authOperationId);
      closeApiKeyForm();
      setAuthPrompt(null);
      setManualAuthVisible(false);
      setAuthNotice(null);
      setAuthError(null);
      setAuthMethod(null);
      await loadProviders();
      await onModelsRefresh(providerId);
    } catch (error) {
      const message = providerErrorMessage(error);
      if (method === "api-key") setFieldErrors((current) => ({ ...current, [providerId]: message }));
      else {
        setAuthPrompt(null);
        setManualAuthVisible(false);
        setAuthError(authErrorMessage(error));
      }
    } finally {
      if (authOperationId) activeOAuthLoginIdsRef.current.delete(authOperationId);
      setBusyProvider(null);
      setAuthMethod(null);
    }
  }

  async function logout(providerId: string) {
    setBusyProvider(providerId);
    setAuthError(null);
    setLogoutError(null);
    setManagementNotice(null);
    try {
      await window.pfsaa.providers.logout(providerId);
      setPendingLogout(null);
      await loadProviders();
      await onModelsRefresh(providerId);
    } catch (error) {
      setLogoutError(providerErrorMessage(error));
    } finally {
      setBusyProvider(null);
    }
  }

  function openCreateProvider() {
    setManagementNotice(null);
    setProviderCreateError(null);
    setProviderDraftErrors({});
    setProviderDiscoveryError(null);
    setProviderModelCandidates([]);
    setSelectedCandidateIds([]);
    setEditingProvider(null);
    setProviderDraft(emptyProviderDraft);
    setCreateProviderOpen(true);
    void loadHiddenProviders();
  }

  function openEditProvider(provider: ProviderSummary) {
    if (!provider.isCustom) return;
    setManagementNotice(null);
    setProviderCreateError(null);
    setProviderDraftErrors({});
    setProviderDiscoveryError(null);
    setProviderModelCandidates([]);
    setSelectedCandidateIds([]);
    setEditingProvider(provider);
    setProviderDraft({
      name: provider.name,
      baseUrl: provider.baseUrl ?? "",
      apiKey: "",
      models: provider.models ?? [],
      modelIdInput: "",
    });
    setCreateProviderOpen(true);
  }

  function updateProviderDraft(field: "name" | "baseUrl" | "apiKey" | "modelIdInput", value: string) {
    setProviderDraft((current) => ({ ...current, [field]: value }));
    if (field !== "modelIdInput") setProviderDraftErrors((current) => ({ ...current, [field]: undefined }));
    setProviderCreateError(null);
    setProviderDiscoveryError(null);
  }

  function addProviderModel(model: ProviderModelDefinition) {
    if (providerDraft.models.some((existing) => existing.id === model.id)) {
      setProviderDraftErrors((current) => ({ ...current, models: t.providerDuplicateModel }));
      return false;
    }
    setProviderDraft((current) => ({ ...current, models: [...current.models, model] }));
    setProviderDraftErrors((current) => ({ ...current, models: undefined }));
    return true;
  }

  function addManualProviderModel() {
    const id = providerDraft.modelIdInput.trim();
    if (!id) return;
    if (addProviderModel({ id, name: id })) updateProviderDraft("modelIdInput", "");
  }

  function toggleCandidate(id: string) {
    setSelectedCandidateIds((current) => current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id]);
  }

  function addDiscoveredModels() {
    const selected = new Set(selectedCandidateIds);
    const selectedModels = providerModelCandidates.filter((model) => selected.has(model.id));
    if (selectedModels.length === 0) return;
    const existingIds = new Set(providerDraft.models.map((model) => model.id));
    const additions = selectedModels.filter((model) => !existingIds.has(model.id));
    setProviderDraft((current) => ({ ...current, models: [...current.models, ...additions] }));
    setSelectedCandidateIds([]);
    setProviderDraftErrors((current) => ({ ...current, models: additions.length !== selectedModels.length ? t.providerDuplicateModel : undefined }));
  }

  async function discoverProviderModels() {
    setDiscoveringProviderModels(true);
    setProviderDiscoveryError(null);
    setProviderCreateError(null);
    try {
      const models = await window.pfsaa.providers.discoverModels({
        baseUrl: providerDraft.baseUrl.trim(),
        providerId: editingProvider?.id,
        apiKey: providerDraft.apiKey.trim() || undefined,
      });
      setProviderModelCandidates(models);
      setSelectedCandidateIds([]);
      if (models.length === 0) setProviderDiscoveryError(t.providerNoModelsFound);
    } catch (error) {
      setProviderDiscoveryError(providerErrorMessage(error));
    } finally {
      setDiscoveringProviderModels(false);
    }
  }

  async function saveProvider() {
    const requiredErrors: Partial<Record<"name" | "baseUrl" | "apiKey" | "models", string>> = {};
    if (!providerDraft.name.trim()) requiredErrors.name = t.providerFieldRequired(t.providerName);
    if (!providerDraft.baseUrl.trim()) requiredErrors.baseUrl = t.providerFieldRequired(t.providerServiceUrl);
    if (providerDraft.models.length === 0) requiredErrors.models = t.providerFieldRequired(t.providerModelsLabel);
    if (!editingProvider && !providerDraft.apiKey.trim()) requiredErrors.apiKey = t.providerFieldRequired(t.apiKey);
    if (Object.keys(requiredErrors).length > 0) {
      setProviderDraftErrors(requiredErrors);
      return;
    }
    setCreatingProvider(true);
    setProviderCreateError(null);
    setManagementNotice(null);
    try {
      let saved: ProviderSummary;
      if (editingProvider) {
        saved = await window.pfsaa.providers.update({
          providerId: editingProvider.id,
          name: providerDraft.name.trim(),
          baseUrl: providerDraft.baseUrl.trim(),
          models: providerDraft.models,
        });
        if (providerDraft.apiKey.trim()) {
          try {
            await window.pfsaa.providers.setApiKey(saved.id, providerDraft.apiKey.trim());
          } catch (error) {
            await Promise.all([loadProviders(), onModelsRefresh(saved.id)]);
            setProviderCreateError(t.providerSavedKeyUpdateFailed(providerErrorMessage(error)));
            return;
          }
        }
      } else {
        saved = await window.pfsaa.providers.create({
          name: providerDraft.name.trim(),
          baseUrl: providerDraft.baseUrl.trim(),
          models: providerDraft.models,
          apiKey: providerDraft.apiKey.trim(),
        });
      }
      await loadProviders();
      await onModelsRefresh(saved.id);
      setManagementNotice(editingProvider ? t.providerUpdated(saved.name) : t.providerAdded(saved.name));
      closeCreateProvider();
      setProviderQuery("");
      setProviderFilter("all");
    } catch (error) {
      setProviderCreateError(providerErrorMessage(error));
    } finally {
      setCreatingProvider(false);
    }
  }

  async function removeProvider(provider: ProviderSummary) {
    setBusyProvider(provider.id);
    setProviderRemovalError(null);
    setManagementNotice(null);
    try {
      const result = await window.pfsaa.providers.remove(provider.id);
      setPendingProviderRemoval(null);
      await loadProviders();
      if (result.action === "removed") await onModelsRefresh(provider.id);
      setManagementNotice(result.action === "removed" ? t.providerRemoved(provider.name) : t.providerHidden(provider.name));
    } catch (error) {
      setProviderRemovalError(providerErrorMessage(error));
    } finally {
      setBusyProvider(null);
    }
  }

  async function restoreHiddenProvider(provider: ProviderSummary) {
    setRestoringProvider(provider.id);
    setHiddenProvidersError(null);
    setManagementNotice(null);
    try {
      await window.pfsaa.providers.restore(provider.id);
      await Promise.all([loadProviders(), loadHiddenProviders()]);
    } catch (error) {
      setHiddenProvidersError(providerErrorMessage(error));
    } finally {
      setRestoringProvider(null);
    }
  }

  return <div className="settings-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !isBusy) onClose(); }}>
    <section ref={dialogRef} className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby="provider-title">
      <div className="settings-header">
        <div>
          <span className="eyebrow">{t.localRuntime}</span>
          <h2 id="provider-title">{t.providerAuthTitle}</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label={t.closeSettings} title={t.closeSettings} disabled={isBusy}><Icon name="x" /></button>
      </div>
      <div className="locality-note"><span className="status-dot" /><span>{t.localCredentials}</span></div>
      {!authPromptVisible && managementNotice && <div className="auth-notice" role="status"><div>{managementNotice}</div></div>}
      {!authPromptVisible && authNotice && <div className="auth-notice" role="status"><div>{authNotice}</div><div className="auth-notice-actions">{authUrl && <button className="button primary" onClick={() => void window.pfsaa.providers.openAuthUrl(authUrl)}>{t.openBrowser}</button>}{authPrompt?.type === "manual_code" && <button className="button ghost" onClick={() => setManualAuthVisible(true)}>{t.enterAuthCodeManually}</button>}</div></div>}
      {!authPromptVisible && authError && <div className="auth-error" role="alert"><div className="auth-error-copy">{authError}</div><div className="auth-error-actions">{authUrl && <button className="button primary" onClick={() => void window.pfsaa.providers.openAuthUrl(authUrl)}>{t.openBrowser}</button>}<button className="button ghost" onClick={() => { setAuthError(null); void loadProviders(); }}>{t.retry}</button></div></div>}
      {!loading && !listError && <div className="provider-tools">
        <label className="provider-search"><Icon name="search" size={14} /><input type="search" value={providerQuery} onChange={(event) => setProviderQuery(event.target.value)} placeholder={t.providerSearch} aria-label={t.providerSearch} /></label>
        <div className="provider-filter-row">
          <div className="provider-filters" role="group" aria-label={t.providerAuthTitle}>{(["all", "configured", "expired", "missing"] as ProviderFilter[]).map((filter) => <button type="button" key={filter} aria-pressed={providerFilter === filter} onClick={() => setProviderFilter(filter)}>{filter === "all" ? t.providerFilterAll : filter === "configured" ? t.providerFilterConfigured : filter === "expired" ? t.providerFilterExpired : t.providerFilterMissing}</button>)}</div>
          <button ref={providerAddButtonRef} type="button" className="button ghost provider-add-button" onClick={openCreateProvider} disabled={isBusy}><Icon name="plus" size={14} />{t.addProvider}</button>
        </div>
      </div>}
      <div className="provider-list">
        {loading ? <div className="provider-loading" role="status"><i /><i /><i /></div> : listError ? <div className="provider-list-error" role="alert"><span>{listError}</span><button className="button ghost" onClick={() => void loadProviders()}>{t.retry}</button></div> : providers.length === 0 ? <div className="provider-list-error"><span>{t.noProviders}</span></div> : filteredProviders.length === 0 ? <div className="provider-list-empty"><Icon name="search" size={17} /><span>{t.providerNoMatches}</span></div> : filteredProviders.map((provider) => {
          const state = providerStates[provider.id] ?? provider.authState;
          const expanded = apiKeyProvider === provider.id;
          const oauthLocked = state === "configured";
          const authSource = providerAuthSourceLabel(provider.authSource);
          return <div className={`provider-card ${expanded ? "expanded" : ""} ${focusProviderId === provider.id ? "focused" : ""}`} data-provider-id={provider.id} key={provider.id}>
            <div className="provider-main">
              <div className="provider-logo">{provider.name.slice(0, 1)}</div>
              <div className="provider-copy"><div><strong>{provider.name}</strong><span className={`provider-state ${state}`}><span className="status-dot" />{state === "configured" ? t.configured : state === "expired" ? t.expired : t.missing}</span></div><small>{provider.id} · {t.providerModels(provider.modelCount)}{authSource ? ` · ${authSource}` : ""}</small></div>
              <div className="provider-actions">
                {provider.isCustom && <button type="button" className="button ghost" disabled={isBusy} onClick={() => openEditProvider(provider)}>{t.editProvider}</button>}
                {provider.hasStoredCredential && <button className="button danger-subtle" disabled={isBusy} onClick={() => { setLogoutError(null); setPendingLogout(provider); }}>{t.removeProviderAuth}</button>}
                {provider.authMethods.includes("oauth") && <button className="button primary" disabled={isBusy || oauthLocked} onClick={() => void auth(provider.id, "oauth")}>{busyProvider === provider.id ? t.authorizing : t.oauth}</button>}
                {provider.authMethods.includes("api-key") && <button className="button ghost" aria-expanded={expanded} aria-controls={`api-key-${provider.id}`} disabled={isBusy} onClick={() => { if (expanded) closeApiKeyForm(); else { setApiKeyProvider(provider.id); setApiKeyValue(""); setAuthNotice(null); setAuthUrl(null); setManagementNotice(null); setFieldErrors((current) => ({ ...current, [provider.id]: undefined })); } }}>{t.apiKey}</button>}
                <button type="button" className="icon-button provider-remove-button" disabled={isBusy} onClick={() => { setProviderRemovalError(null); setPendingProviderRemoval(provider); }} aria-label={t.removeProvider} title={t.removeProvider}><Icon name="trash" size={15} /></button>
              </div>
            </div>
            {expanded && <form id={`api-key-${provider.id}`} className="api-key-form" onSubmit={(event) => { event.preventDefault(); void auth(provider.id, "api-key", apiKeyValue); }}><label htmlFor={`api-key-input-${provider.id}`}><strong>{t.apiKey}</strong><small>{provider.name}</small></label><div className="api-key-controls"><input id={`api-key-input-${provider.id}`} type="password" autoFocus value={apiKeyValue} onChange={(event) => setApiKeyValue(event.target.value)} placeholder={t.enterApiKey} aria-describedby={fieldErrors[provider.id] ? `api-key-error-${provider.id}` : undefined} /><button className="button primary" disabled={!apiKeyValue.trim() || isBusy} type="submit">{busyProvider === provider.id ? t.saving : t.save}</button><button className="button ghost" type="button" disabled={isBusy} onClick={closeApiKeyForm}>{t.cancel}</button></div>{fieldErrors[provider.id] && <div id={`api-key-error-${provider.id}`} className="field-error" role="alert">{fieldErrors[provider.id]}</div>}</form>}
          </div>;
        })}
      </div>
      <div className="settings-footer"><span>{providers.length ? providerQuery || providerFilter !== "all" ? t.providerFilteredCount(filteredProviders.length, providers.length) : t.providerCount(providers.length) : ""}</span><button className="button ghost" onClick={onClose} disabled={isBusy}>{t.done}</button></div>
      {pendingLogout && <div className="auth-prompt-backdrop"><div ref={logoutPromptRef} className="auth-prompt provider-logout-prompt" role="alertdialog" aria-modal="true" aria-labelledby="provider-logout-title" aria-describedby="provider-logout-description"><span className="confirm-icon"><Icon name="alert" /></span><h3 id="provider-logout-title">{t.removeProviderAuthTitle(pendingLogout.name)}</h3><p id="provider-logout-description">{t.removeProviderAuthBody(pendingLogout.name)}</p>{logoutError && <div className="inline-error" role="alert">{logoutError}</div>}<div><button type="button" className="button ghost" disabled={Boolean(busyProvider)} onClick={() => { setPendingLogout(null); setLogoutError(null); }}>{t.cancel}</button><button type="button" className="button danger" disabled={Boolean(busyProvider)} onClick={() => void logout(pendingLogout.id)}>{busyProvider === pendingLogout.id ? t.removingProviderAuth : t.removeProviderAuth}</button></div></div></div>}
      {pendingProviderRemoval && <div className="auth-prompt-backdrop"><div ref={providerRemovalPromptRef} className="auth-prompt provider-logout-prompt" role="alertdialog" aria-modal="true" aria-labelledby="provider-removal-title" aria-describedby="provider-removal-description"><span className="confirm-icon"><Icon name="alert" /></span><h3 id="provider-removal-title">{pendingProviderRemoval.isCustom ? t.removeCustomProviderTitle(pendingProviderRemoval.name) : t.hideProviderTitle(pendingProviderRemoval.name)}</h3><p id="provider-removal-description">{pendingProviderRemoval.isCustom ? t.removeCustomProviderBody(pendingProviderRemoval.name) : t.hideProviderBody(pendingProviderRemoval.name)}</p>{providerRemovalError && <div className="inline-error" role="alert">{providerRemovalError}</div>}<div><button type="button" className="button ghost" disabled={Boolean(busyProvider)} onClick={() => { setPendingProviderRemoval(null); setProviderRemovalError(null); }}>{t.cancel}</button><button type="button" className="button danger" disabled={Boolean(busyProvider)} onClick={() => void removeProvider(pendingProviderRemoval)}>{busyProvider === pendingProviderRemoval.id ? t.removingProvider : t.removeProvider}</button></div></div></div>}
      {createProviderOpen && <div className="auth-prompt-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeCreateProvider(); }}>
        <form ref={providerCreatePromptRef} className="auth-prompt provider-create-prompt" role="dialog" aria-modal="true" aria-labelledby="provider-create-title" onSubmit={(event) => { event.preventDefault(); void saveProvider(); }}>
          <h3 id="provider-create-title">{editingProvider ? t.editProviderTitle : t.addProviderTitle}</h3>
          <p>{editingProvider ? t.editProviderDescription : t.addProviderDescription}</p>
          <label htmlFor="provider-create-name">
            <span>{t.providerName}</span>
            <input id="provider-create-name" autoFocus type="text" value={providerDraft.name} onChange={(event) => updateProviderDraft("name", event.target.value)} placeholder={t.providerNamePlaceholder} aria-invalid={Boolean(providerDraftErrors.name)} aria-describedby={providerDraftErrors.name ? "provider-create-name-error" : undefined} />
            {providerDraftErrors.name && <small id="provider-create-name-error" className="field-error" role="alert">{providerDraftErrors.name}</small>}
          </label>
          <label htmlFor="provider-create-url">
            <span>{t.providerServiceUrl}</span>
            <input id="provider-create-url" type="url" value={providerDraft.baseUrl} onChange={(event) => updateProviderDraft("baseUrl", event.target.value)} placeholder={t.providerServiceUrlPlaceholder} aria-invalid={Boolean(providerDraftErrors.baseUrl)} aria-describedby={providerDraftErrors.baseUrl ? "provider-create-url-error" : undefined} />
            {providerDraftErrors.baseUrl && <small id="provider-create-url-error" className="field-error" role="alert">{providerDraftErrors.baseUrl}</small>}
          </label>
          <label htmlFor="provider-create-api-key">
            <span>{t.apiKey}</span>
            <input id="provider-create-api-key" type="password" autoComplete="new-password" value={providerDraft.apiKey} onChange={(event) => updateProviderDraft("apiKey", event.target.value)} placeholder={editingProvider ? t.providerApiKeyOptional : t.enterApiKey} aria-invalid={Boolean(providerDraftErrors.apiKey)} aria-describedby={providerDraftErrors.apiKey ? "provider-create-api-key-error" : undefined} />
            {providerDraftErrors.apiKey && <small id="provider-create-api-key-error" className="field-error" role="alert">{providerDraftErrors.apiKey}</small>}
          </label>
          <section className="provider-model-editor" aria-labelledby="provider-models-title">
            <div className="provider-model-editor-heading">
              <span><strong id="provider-models-title">{t.providerModelsLabel}</strong><small>{t.providerModelsHint}</small></span>
              <button type="button" className="button ghost" disabled={isBusy || providerDiscoveryRequirementsMissing} title={providerDiscoveryRequirementsMissing ? t.providerDiscoveryRequirements : undefined} aria-busy={discoveringProviderModels} onClick={() => void discoverProviderModels()}>{discoveringProviderModels ? t.discoveringProviderModels : editingProvider ? t.refreshProviderModels : t.discoverProviderModels}</button>
            </div>
            <div className="provider-model-entry">
              <input type="text" value={providerDraft.modelIdInput} onChange={(event) => updateProviderDraft("modelIdInput", event.target.value)} placeholder={t.providerModelIdPlaceholder} aria-label={t.providerModelId} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addManualProviderModel(); } }} />
              <button type="button" className="button ghost" disabled={isBusy || !providerDraft.modelIdInput.trim()} onClick={addManualProviderModel}>{t.addModel}</button>
            </div>
            {providerDraft.models.length > 0 && <div className="provider-model-list">{providerDraft.models.map((model) => <div className="provider-model-row" key={model.id}><span><strong>{model.name}</strong><small>{model.id}</small></span><button type="button" className="icon-button" aria-label={t.removeModel(model.name)} title={t.removeModel(model.name)} disabled={isBusy} onClick={() => { setProviderDraft((current) => ({ ...current, models: current.models.filter((item) => item.id !== model.id) })); setProviderDraftErrors((current) => ({ ...current, models: undefined })); }}><Icon name="x" size={13} /></button></div>)}</div>}
            {providerDraftErrors.models && <small className="field-error" role="alert">{providerDraftErrors.models}</small>}
            {providerDiscoveryError && <div className="inline-error" role="alert">{providerDiscoveryError}</div>}
            {providerModelCandidates.length > 0 && <div className="provider-discovery-results" aria-live="polite"><strong>{t.providerDiscoveredModels(providerModelCandidates.length)}</strong><div>{providerModelCandidates.map((model) => {
              const alreadyConfigured = providerDraftModelIds.has(model.id);
              return <label className={`provider-model-candidate ${alreadyConfigured ? "configured" : ""}`} key={model.id}><input type="checkbox" checked={selectedCandidateIds.includes(model.id)} disabled={alreadyConfigured} onChange={() => toggleCandidate(model.id)} /><span><strong>{model.name}</strong><small>{model.id}</small></span>{alreadyConfigured && <em>{t.providerModelAlreadyConfigured}</em>}</label>;
            })}</div><button type="button" className="button ghost" disabled={isBusy || selectedCandidateIds.length === 0} onClick={addDiscoveredModels}>{t.addSelectedModels(selectedCandidateIds.length)}</button></div>}
          </section>
          {providerCreateError && <div className="inline-error" role="alert">{providerCreateError}</div>}
          <div className="provider-editor-actions"><button type="button" className="button ghost" disabled={isBusy} onClick={closeCreateProvider}>{t.cancel}</button><button type="submit" className="button primary" disabled={isBusy}>{creatingProvider ? t.saving : editingProvider ? t.save : t.providerAddAction}</button></div>
          {!editingProvider && <section className="hidden-provider-section" aria-labelledby="hidden-provider-title"><strong id="hidden-provider-title">{t.hiddenProvidersTitle}</strong><small>{t.hiddenProvidersDescription}</small>{hiddenProvidersLoading ? <div className="hidden-provider-loading" role="status"><i /><i /></div> : hiddenProvidersError ? <div className="inline-error" role="alert">{hiddenProvidersError}</div> : hiddenProviders.length > 0 && <div className="hidden-provider-list">{hiddenProviders.map((provider) => <div className="hidden-provider-row" key={provider.id}><span><strong>{provider.name}</strong><small>{provider.id}</small></span><button type="button" className="button ghost" disabled={isBusy} onClick={() => void restoreHiddenProvider(provider)}>{restoringProvider === provider.id ? t.restoringProvider : t.restoreProvider}</button></div>)}</div>}</section>}
        </form>
      </div>}
      {authPromptVisible && authPrompt && <div className="auth-prompt-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) void cancelAuthPrompt(); }}><form ref={authPromptRef} className="auth-prompt" role="alertdialog" aria-modal="true" onSubmit={(event) => { event.preventDefault(); if (authPrompt.type !== "select") void resolvePrompt(authPrompt.value); }}><h3>{t.authPromptTitle}</h3><p>{authPrompt.message}</p>{authError && <div className="inline-error" role="alert">{authError}</div>}{authPrompt.type === "select" ? <div className="auth-prompt-options">{(authPrompt.options ?? []).map((option) => <button key={option.id} type="button" className="button ghost auth-prompt-option" onClick={() => void resolvePrompt(option.id)}><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</button>)}</div> : <label><span>{authPrompt.placeholder || t.authPromptFallback}</span><input autoFocus type={authPrompt.type === "secret" ? "password" : "text"} value={authPrompt.value} onChange={(event) => setAuthPrompt((current) => current ? { ...current, value: event.target.value } : current)} /></label>}<div><button type="button" className="button ghost" onClick={() => void cancelAuthPrompt()}>{t.cancel}</button>{authPrompt.type !== "select" && <button type="submit" className="button primary" disabled={!authPrompt.value}>{t.submit}</button>}</div></form></div>}
    </section>
  </div>;
}

export { ProviderSettings };
