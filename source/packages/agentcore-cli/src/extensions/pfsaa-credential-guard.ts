import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "../core/extensions/types.ts";
import { resolveConfigValue } from "../core/resolve-config-value.ts";

export const CREDENTIAL_REDACTION = "[已隐藏凭据]";

const FILE_TOOL_NAMES = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);
const MIN_SECRET_LENGTH = 8;
const AMBIENT_SECRET_NAME = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i;

export interface CredentialGuardSources {
	argv?: readonly string[];
	env?: Readonly<Record<string, string | undefined>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usesWindowsPaths(value: string): boolean {
	return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
}

function normalizeAbsolutePath(value: string, cwd: string, windowsPaths: boolean): string {
	if (windowsPaths) {
		return win32.resolve(cwd.replaceAll("/", "\\"), value.replaceAll("/", "\\")).toLowerCase();
	}
	return posix.resolve(cwd.replaceAll("\\", "/"), value.replaceAll("\\", "/"));
}

function addSecret(destination: Set<string>, value: unknown): void {
	if (typeof value === "string" && value.trim().length >= MIN_SECRET_LENGTH) destination.add(value);
}

function toStringEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
	const values: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined) values[name] = value;
	}
	return values;
}

function readCredentialSecrets(
	authPath: string,
	env: Readonly<Record<string, string | undefined>>,
): string[] {
	try {
		const parsed = JSON.parse(readFileSync(authPath, "utf8").replace(/^\uFEFF/, "")) as unknown;
		if (!isRecord(parsed)) return [];

		const secrets = new Set<string>();
		const ambientEnv = toStringEnvironment(env);
		for (const credential of Object.values(parsed)) {
			if (!isRecord(credential)) continue;
			if (credential.type === "api_key" && typeof credential.key === "string") {
				const credentialEnv = isRecord(credential.env)
					? Object.fromEntries(
							Object.entries(credential.env).filter(
								(entry): entry is [string, string] => typeof entry[1] === "string",
							),
						)
					: {};
				addSecret(secrets, resolveConfigValue(credential.key, { ...ambientEnv, ...credentialEnv }));
			} else if (credential.type === "oauth") {
				addSecret(secrets, credential.access);
				addSecret(secrets, credential.refresh);
			}
		}
		return [...secrets];
	} catch {
		return [];
	}
}

function collectCliSecrets(argv: readonly string[], destination: Set<string>): void {
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--") break;
		if (argument === "--api-key") {
			addSecret(destination, argv[index + 1]);
			index++;
		} else if (argument.startsWith("--api-key=")) {
			addSecret(destination, argument.slice("--api-key=".length));
		}
	}
}

function collectAmbientSecrets(
	env: Readonly<Record<string, string | undefined>>,
	destination: Set<string>,
): void {
	for (const [name, value] of Object.entries(env)) {
		if (AMBIENT_SECRET_NAME.test(name)) addSecret(destination, value);
	}
}

function replaceCredentials(text: string, credentials: readonly string[]): string {
	let redacted = text;
	for (const credential of credentials) {
		redacted = redacted.replaceAll(credential, CREDENTIAL_REDACTION);
	}
	return redacted;
}

function redactValue(value: unknown, credentials: readonly string[]): unknown {
	if (typeof value === "string") return replaceCredentials(value, credentials);
	if (Array.isArray(value)) {
		let changed = false;
		const redacted = value.map((item) => {
			const next = redactValue(item, credentials);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? redacted : value;
	}
	if (!isRecord(value)) return value;

	let changed = false;
	const redacted: Record<string, unknown> = { ...value };
	for (const [key, item] of Object.entries(value)) {
		const next = redactValue(item, credentials);
		if (next !== item) {
			redacted[key] = next;
			changed = true;
		}
	}
	return changed ? redacted : value;
}

function containsPathReference(command: string, reference: string, windowsPaths: boolean): boolean {
	const normalizedCommand = command.replace(/["'`]/g, "").replace(/[\\/]+/g, "/");
	const normalizedReference = reference.replace(/[\\/]+/g, "/");
	const haystack = windowsPaths ? normalizedCommand.toLowerCase() : normalizedCommand;
	const needle = windowsPaths ? normalizedReference.toLowerCase() : normalizedReference;
	let offset = 0;

	while (offset <= haystack.length - needle.length) {
		const index = haystack.indexOf(needle, offset);
		if (index < 0) return false;
		const before = index > 0 ? haystack[index - 1] : undefined;
		const after = haystack[index + needle.length];
		const isPathCharacter = (character: string | undefined): boolean =>
			character !== undefined && /[a-z0-9_.\\/-]/i.test(character);
		if (!isPathCharacter(before) && (after === undefined || !/[a-z0-9_.-]/i.test(after))) return true;
		offset = index + 1;
	}
	return false;
}

function referencesAgentDirVariable(command: string): boolean {
	const compact = command.replace(/[\s"'`]/g, "").replaceAll("\\", "/");
	return /(?:\$\{AGENTCORE_AGENT_DIR\}|\$\{env:AGENTCORE_AGENT_DIR\}|\$AGENTCORE_AGENT_DIR|\$env:AGENTCORE_AGENT_DIR|%AGENTCORE_AGENT_DIR%|AGENTCORE_AGENT_DIR)\/+auth\.json(?![a-z0-9_.-])/i.test(
		compact,
	);
}

export function registerCredentialGuard(
	pi: ExtensionAPI,
	agentDir: string | undefined,
	sources: CredentialGuardSources = {},
): void {
	const trimmedAgentDir = agentDir?.trim();
	if (!trimmedAgentDir) return;

	const windowsPaths = usesWindowsPaths(trimmedAgentDir);
	const baseCwd = windowsPaths ? trimmedAgentDir : process.cwd();
	const authPath = windowsPaths
		? win32.join(trimmedAgentDir.replaceAll("/", "\\"), "auth.json")
		: posix.join(trimmedAgentDir.replaceAll("\\", "/"), "auth.json");
	const normalizedAuthPath = normalizeAbsolutePath(authPath, baseCwd, windowsPaths);
	const knownCredentials = new Set<string>();
	const argv = sources.argv ?? process.argv.slice(2);
	const env = sources.env ?? process.env;

	const getKnownCredentials = (): string[] => {
		for (const credential of readCredentialSecrets(authPath, env)) knownCredentials.add(credential);
		collectCliSecrets(argv, knownCredentials);
		collectAmbientSecrets(env, knownCredentials);
		return [...knownCredentials].sort((left, right) => right.length - left.length);
	};
	const commandReferencesAuth = (command: string, cwd: string): boolean => {
		const normalizedCwd = normalizeAbsolutePath(cwd, cwd, windowsPaths);
		const relativeAuthPath = windowsPaths
			? win32.relative(normalizedCwd, normalizedAuthPath)
			: posix.relative(normalizedCwd, normalizedAuthPath);
		const localReferences = [normalizedAuthPath];
		if (relativeAuthPath && !relativeAuthPath.startsWith("..") && !usesWindowsPaths(relativeAuthPath)) {
			localReferences.push(relativeAuthPath, `.${windowsPaths ? "\\" : "/"}${relativeAuthPath}`);
		}
		return (
			referencesAgentDirVariable(command) ||
			localReferences.some((reference) => containsPathReference(command, reference, windowsPaths))
		);
	};

	pi.on("tool_call", (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		if (FILE_TOOL_NAMES.has(event.toolName) && typeof input.path === "string") {
			const requestedPath = normalizeAbsolutePath(input.path, ctx.cwd, windowsPaths);
			if (requestedPath === normalizedAuthPath) {
				return { block: true, reason: "已阻止访问认证文件。" };
			}
		}

		if (SHELL_TOOL_NAMES.has(event.toolName) && typeof input.command === "string") {
			if (commandReferencesAuth(input.command, ctx.cwd)) {
				return { block: true, reason: "已阻止命令访问认证文件。" };
			}
		}

		return undefined;
	});

	pi.on("user_bash", (event) => {
		if (!commandReferencesAuth(event.command, event.cwd)) return undefined;
		return {
			result: {
				output: "已阻止命令访问认证文件。",
				exitCode: 1,
				cancelled: false,
				truncated: false,
			},
		};
	});

	pi.on("tool_result", (event) => {
		const credentials = getKnownCredentials();
		if (credentials.length === 0) return undefined;
		let changed = false;
		const content = event.content.map((item) => {
			if (item.type !== "text") return item;
			const text = replaceCredentials(item.text, credentials);
			if (text === item.text) return item;
			changed = true;
			return { ...item, text };
		});
		return changed ? { content } : undefined;
	});

	pi.on("before_provider_request", (event) => {
		const credentials = getKnownCredentials();
		if (credentials.length === 0) return undefined;
		const payload = redactValue(event.payload, credentials);
		return payload === event.payload ? undefined : payload;
	});
}

const credentialGuardExtension: ExtensionFactory = (pi) => {
	registerCredentialGuard(pi, process.env.AGENTCORE_AGENT_DIR);
};

export default credentialGuardExtension;
