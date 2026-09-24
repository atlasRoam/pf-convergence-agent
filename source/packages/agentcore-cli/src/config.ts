import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath } from "./utils/paths.ts";
import { stripBom } from "./utils/text.ts";

const sourceDir = dirname(fileURLToPath(import.meta.url));

export const isBunBinary = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN")
	|| import.meta.url.includes("%7EBUN");
declare const AGENTCORE_BUNDLED_NODE: boolean;
export const isBundledNode = typeof AGENTCORE_BUNDLED_NODE !== "undefined" && AGENTCORE_BUNDLED_NODE;

export function findNodePackageDir(startDir: string): string {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			const parent = dirname(dir);
			return basename(dir) === "dist" && existsSync(join(parent, "package.json")) ? parent : dir;
		}
		dir = dirname(dir);
	}
	return startDir;
}

export function getPackageDir(): string {
	const envDir = process.env.AGENTCORE_PACKAGE_DIR;
	if (envDir) return normalizePath(envDir);
	return isBunBinary ? dirname(process.execPath) : findNodePackageDir(sourceDir);
}

export function getThemesDir(): string {
	if (isBunBinary) return join(getPackageDir(), "theme");
	const packageDir = getPackageDir();
	return join(packageDir, existsSync(join(packageDir, "src")) ? "src" : "dist", "modes", "interactive", "theme");
}

export function getExportTemplateDir(): string {
	if (isBunBinary) return join(getPackageDir(), "export-html");
	const packageDir = getPackageDir();
	return join(packageDir, existsSync(join(packageDir, "src")) ? "src" : "dist", "core", "export-html");
}

export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

export function getReadmePath(): string {
	return resolve(getPackageDir(), "README.md");
}

export function getDocsPath(): string {
	return resolve(getPackageDir(), "docs");
}

export function getExamplesPath(): string {
	return resolve(getPackageDir(), "examples");
}

export function getChangelogPath(): string {
	return resolve(getPackageDir(), "CHANGELOG.md");
}

export function getInteractiveAssetsDir(): string {
	if (isBunBinary) return join(getPackageDir(), "assets");
	const packageDir = getPackageDir();
	return join(packageDir, existsSync(join(packageDir, "src")) ? "src" : "dist", "modes", "interactive", "assets");
}

export function getBundledInteractiveAssetPath(name: string): string {
	return join(getInteractiveAssetsDir(), name);
}

interface PackageJson {
	name?: string;
	version?: string;
	agentcoreConfig?: { configDir?: string };
}

let pkg: PackageJson = {};
try {
	pkg = JSON.parse(stripBom(readFileSync(getPackageJsonPath(), "utf8"))) as PackageJson;
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

export const PACKAGE_NAME = pkg.name || "@pfsaa/agentcore-cli";
export const APP_NAME = "agentcore";
export const DISPLAY_NAME = "PFSAA";
export const PRODUCT_DESCRIPTION = "PFSAA: 电力系统潮流计算调整智能体";
export const APP_TITLE = DISPLAY_NAME;
export const CONFIG_DIR_NAME = pkg.agentcoreConfig?.configDir || ".agentcore";
export const VERSION = pkg.version || "0.0.0";

export const ENV_AGENT_DIR = "AGENTCORE_AGENT_DIR";
export const ENV_SESSION_DIR = "AGENTCORE_SESSION_DIR";
export const ENV_RUNTIME_CWD = "AGENTCORE_RUNTIME_CWD";

export function expandTildePath(path: string): string {
	return normalizePath(path);
}

export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	return envDir ? expandTildePath(envDir) : join(homedir(), CONFIG_DIR_NAME, "agent");
}

export function getCustomThemesDir(): string { return join(getAgentDir(), "themes"); }
export function getModelsPath(): string { return join(getAgentDir(), "models.json"); }
export function getAuthPath(): string { return join(getAgentDir(), "auth.json"); }
export function getSettingsPath(): string { return join(getAgentDir(), "settings.json"); }
export function getToolsDir(): string { return join(getAgentDir(), "tools"); }
export function getBinDir(): string { return join(getAgentDir(), "bin"); }
export function getPromptsDir(): string { return join(getAgentDir(), "prompts"); }
export function getSessionsDir(): string { return join(getAgentDir(), "sessions"); }
export function getDebugLogPath(): string { return join(getAgentDir(), `${APP_NAME}-debug.log`); }
