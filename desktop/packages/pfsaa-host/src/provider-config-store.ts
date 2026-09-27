import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

const MODELS_FILE = "models.json";
const UI_STATE_FILE = "pfsaa-provider-ui.json";
const UI_STATE_VERSION = 1;
const PROVIDER_ID_MAX_LENGTH = 96;
const DEFAULT_JSON = "{\n}\n";

type JsonRecord = Record<string, unknown>;

export interface CustomProviderInput {
  name: string;
  baseUrl: string;
  models: readonly CustomProviderModel[];
}

export interface CustomProviderModel {
  id: string;
  name: string;
}

export interface CustomProviderPreviousConfig {
  name: unknown;
  baseUrl: unknown;
  models: unknown;
}

export interface EditableProviderConfiguration {
  baseUrl: string;
  models: readonly CustomProviderModel[];
}

export function normalizedProviderBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Service URL must be a valid http(s) URL.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error("Service URL must be an http(s) endpoint without credentials, query parameters, or fragments.");
  }
  return url.pathname === "/" ? url.origin : url.toString().replace(/\/$/, "");
}

export interface ProviderUiState {
  customProviderIds: readonly string[];
  hiddenProviders: Readonly<Record<string, string>>;
}

interface JsonDocument {
  path: string;
  original: string | undefined;
  content: string;
  value: JsonRecord;
}

let pendingMutation: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsoncObject(content: string, filePath: string): JsonRecord {
  const errors: ParseError[] = [];
  const parsed = parse(content, errors, { allowTrailingComma: false, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(`Unable to parse ${path.basename(filePath)} at offset ${first.offset}. Fix the file before managing Providers.`);
  }
  if (!isRecord(parsed)) throw new Error(`${path.basename(filePath)} must contain a JSON object.`);
  return parsed;
}

async function readJsonDocument(filePath: string): Promise<JsonDocument> {
  let original: string | undefined;
  try {
    original = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const content = original ?? DEFAULT_JSON;
  return { path: filePath, original, content, value: parseJsoncObject(content, filePath) };
}

function updateDocument(document: JsonDocument, jsonPath: Array<string | number>, value: unknown): void {
  const edits = modify(document.content, jsonPath, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  const next = applyEdits(document.content, edits);
  document.content = next.endsWith("\n") ? next : `${next}\n`;
  document.value = parseJsoncObject(document.content, document.path);
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const mode = await stat(filePath).then((entry) => entry.mode & 0o777).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return 0o600;
    throw error;
  });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function restoreDocument(document: JsonDocument): Promise<void> {
  if (document.original === undefined) {
    await rm(document.path, { force: true });
    return;
  }
  await writeAtomic(document.path, document.original);
}

async function persistDocuments(documents: JsonDocument[]): Promise<void> {
  const changed = documents.filter((document) => document.content !== (document.original ?? DEFAULT_JSON));
  const written: JsonDocument[] = [];
  try {
    for (const document of changed) {
      await writeAtomic(document.path, document.content);
      written.push(document);
    }
  } catch (error) {
    await Promise.allSettled(written.reverse().map((document) => restoreDocument(document)));
    throw error;
  }
}

async function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  let release: (() => void) | undefined;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const previous = pendingMutation;
  pendingMutation = previous.then(() => turn);
  await previous;
  try {
    return await operation();
  } finally {
    release?.();
  }
}

function isValidProviderId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(value) && value.length <= PROVIDER_ID_MAX_LENGTH;
}

function normalizeProviderIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && isValidProviderId(entry)))];
}

function normalizeHiddenProviders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.entries(value).reduce<Record<string, string>>((result, [providerId, name]) => {
    if (isValidProviderId(providerId) && typeof name === "string" && name.trim().length > 0 && name.length <= 160) result[providerId] = name;
    return result;
  }, {});
}

function readUiState(document: JsonDocument): ProviderUiState {
  const value = document.value;
  if (value.version !== undefined && value.version !== UI_STATE_VERSION) {
    throw new Error("The Provider management state was created by an unsupported PFSAA version.");
  }
  return {
    customProviderIds: normalizeProviderIds(value.customProviderIds),
    hiddenProviders: normalizeHiddenProviders(value.hiddenProviders),
  };
}

function applyUiState(document: JsonDocument, state: ProviderUiState): void {
  updateDocument(document, ["version"], UI_STATE_VERSION);
  updateDocument(document, ["customProviderIds"], [...state.customProviderIds]);
  updateDocument(document, ["hiddenProviders"], { ...state.hiddenProviders });
}

function providersFromModels(document: JsonDocument): JsonRecord {
  const providers = document.value.providers;
  if (providers === undefined) return {};
  if (!isRecord(providers)) throw new Error("models.json providers must be an object.");
  return providers;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.codePointAt(0)! < 0x20);
}

function normalizedInput(input: CustomProviderInput): CustomProviderInput {
  const name = input.name.trim();
  if (!name || name.length > 80 || hasControlCharacter(name)) throw new Error("Provider name must be 1–80 printable characters.");
  const models = input.models.map((model) => {
    const id = model.id.trim();
    const modelName = model.name.trim() || id;
    if (!id || id.length > 200 || hasControlCharacter(id)) throw new Error("Model ID must be 1–200 printable characters.");
    if (modelName.length > 200 || hasControlCharacter(modelName)) throw new Error("Model name must be at most 200 printable characters.");
    return { id, name: modelName };
  });
  if (models.length === 0) throw new Error("At least one model is required.");
  if (models.length > 200) throw new Error("A Provider cannot contain more than 200 models.");
  if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error("Model IDs must be unique within a Provider.");
  return { name, baseUrl: normalizedProviderBaseUrl(input.baseUrl), models };
}

function editableConfiguration(value: unknown): EditableProviderConfiguration | undefined {
  if (!isRecord(value) || value.api !== "openai-completions" || typeof value.baseUrl !== "string" || !Array.isArray(value.models)) return undefined;
  if (!value.models.every((model) => isRecord(model) && typeof model.id === "string" && (model.name === undefined || typeof model.name === "string"))) return undefined;
  try {
    const normalized = normalizedInput({
      name: "Provider",
      baseUrl: value.baseUrl,
      models: value.models.map((model: JsonRecord) => ({ id: model.id as string, name: typeof model.name === "string" ? model.name : model.id as string })),
    });
    return { baseUrl: normalized.baseUrl, models: normalized.models };
  } catch {
    return undefined;
  }
}

function providerIdFromName(name: string, occupiedIds: Iterable<string>): string {
  const occupied = new Set([...occupiedIds].map((id) => id.toLocaleLowerCase()));
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "provider";
  const prefix = `pfsaa-${slug}`.slice(0, PROVIDER_ID_MAX_LENGTH);
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = suffix === 1 ? prefix : `${prefix.slice(0, PROVIDER_ID_MAX_LENGTH - String(suffix).length - 1)}-${suffix}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new Error("Unable to allocate a unique Provider ID.");
}

async function openDocuments(agentDir: string): Promise<{ models: JsonDocument; ui: JsonDocument; state: ProviderUiState }> {
  const [models, ui] = await Promise.all([
    readJsonDocument(path.join(agentDir, MODELS_FILE)),
    readJsonDocument(path.join(agentDir, UI_STATE_FILE)),
  ]);
  return { models, ui, state: readUiState(ui) };
}

export async function getProviderUiState(agentDir: string): Promise<ProviderUiState> {
  return serializeMutation(async () => (await openDocuments(agentDir)).state);
}

export async function createCustomProvider(agentDir: string, input: CustomProviderInput, occupiedProviderIds: Iterable<string> = []): Promise<{ providerId: string }> {
  return serializeMutation(async () => {
    const { models, ui, state } = await openDocuments(agentDir);
    const providers = providersFromModels(models);
    const normalized = normalizedInput(input);
    const providerId = providerIdFromName(normalized.name, [...Object.keys(providers), ...occupiedProviderIds]);
    const provider = {
      name: normalized.name,
      baseUrl: normalized.baseUrl,
      api: "openai-completions",
      models: normalized.models,
    };
    updateDocument(models, ["providers", providerId], provider);
    applyUiState(ui, {
      customProviderIds: [...new Set([...state.customProviderIds, providerId])],
      hiddenProviders: Object.fromEntries(Object.entries(state.hiddenProviders).filter(([id]) => id !== providerId)),
    });
    await persistDocuments([models, ui]);
    return { providerId };
  });
}

export async function updateEditableProvider(agentDir: string, providerId: string, input: CustomProviderInput): Promise<CustomProviderPreviousConfig> {
  return serializeMutation(async () => {
    if (!isValidProviderId(providerId)) throw new Error("Invalid Provider ID.");
    const { models } = await openDocuments(agentDir);
    const existing = providersFromModels(models)[providerId];
    if (!editableConfiguration(existing) || !isRecord(existing)) throw new Error("Only locally configured OpenAI-compatible Providers can be edited.");
    const normalized = normalizedInput(input);
    const existingModels = Array.isArray(existing.models) ? existing.models : [];
    const existingModelsById = new Map(existingModels.filter(isRecord).filter((model) => typeof model.id === "string").map((model) => [model.id as string, model]));
    const nextModels = normalized.models.map((model) => {
      const previous = existingModelsById.get(model.id);
      return previous ? { ...previous, ...model } : model;
    });
    const previousConfig: CustomProviderPreviousConfig = {
      name: existing.name,
      baseUrl: existing.baseUrl,
      models: existing.models,
    };
    updateDocument(models, ["providers", providerId, "name"], normalized.name);
    updateDocument(models, ["providers", providerId, "baseUrl"], normalized.baseUrl);
    updateDocument(models, ["providers", providerId, "models"], nextModels);
    await persistDocuments([models]);
    return previousConfig;
  });
}

export async function restoreEditableProviderFields(agentDir: string, providerId: string, previous: CustomProviderPreviousConfig): Promise<void> {
  return serializeMutation(async () => {
    if (!isValidProviderId(providerId)) throw new Error("Invalid Provider ID.");
    const { models } = await openDocuments(agentDir);
    if (!editableConfiguration(providersFromModels(models)[providerId])) throw new Error("Provider configuration is missing or not editable.");
    updateDocument(models, ["providers", providerId, "name"], previous.name);
    updateDocument(models, ["providers", providerId, "baseUrl"], previous.baseUrl);
    updateDocument(models, ["providers", providerId, "models"], previous.models);
    await persistDocuments([models]);
  });
}

export async function removeCustomProvider(agentDir: string, providerId: string): Promise<void> {
  return serializeMutation(async () => {
    if (!isValidProviderId(providerId)) throw new Error("Invalid Provider ID.");
    const { models, ui, state } = await openDocuments(agentDir);
    if (!state.customProviderIds.includes(providerId)) throw new Error("Only Providers added from PFSAA can be removed from models.json.");
    updateDocument(models, ["providers", providerId], undefined);
    applyUiState(ui, {
      customProviderIds: state.customProviderIds.filter((id) => id !== providerId),
      hiddenProviders: Object.fromEntries(Object.entries(state.hiddenProviders).filter(([id]) => id !== providerId)),
    });
    await persistDocuments([models, ui]);
  });
}

export async function hideProvider(agentDir: string, providerId: string, name: string): Promise<void> {
  return serializeMutation(async () => {
    if (!isValidProviderId(providerId)) throw new Error("Invalid Provider ID.");
    const { models, ui, state } = await openDocuments(agentDir);
    if (state.customProviderIds.includes(providerId)) throw new Error("Custom Providers must be removed instead of hidden.");
    applyUiState(ui, {
      customProviderIds: state.customProviderIds,
      hiddenProviders: { ...state.hiddenProviders, [providerId]: name.trim().slice(0, 160) || providerId },
    });
    await persistDocuments([models, ui]);
  });
}

export async function restoreProvider(agentDir: string, providerId: string): Promise<void> {
  return serializeMutation(async () => {
    if (!isValidProviderId(providerId)) throw new Error("Invalid Provider ID.");
    const { models, ui, state } = await openDocuments(agentDir);
    if (!(providerId in state.hiddenProviders)) throw new Error("This Provider is not hidden.");
    const hiddenProviders = { ...state.hiddenProviders };
    delete hiddenProviders[providerId];
    applyUiState(ui, { customProviderIds: state.customProviderIds, hiddenProviders });
    await persistDocuments([models, ui]);
  });
}

export function providerConfigurations(agentDir: string): Promise<{ ids: readonly string[]; editable: Readonly<Record<string, EditableProviderConfiguration>> }> {
  return serializeMutation(async () => {
    const { models } = await openDocuments(agentDir);
    const providers = providersFromModels(models);
    const editable: Record<string, EditableProviderConfiguration> = {};
    for (const [providerId, value] of Object.entries(providers)) {
      const configuration = editableConfiguration(value);
      if (configuration) editable[providerId] = configuration;
    }
    return { ids: Object.keys(providers), editable };
  });
}
