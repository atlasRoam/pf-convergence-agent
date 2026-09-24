import { createInterface } from "node:readline";
import type { AgentTool } from "@pfsaa/agent-core";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { findRenderers } from "./renderers/find.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

/** Relativize a find result against the search root and normalize it to posix separators. */
export function relativizeFindResultPath(
	resultPath: string,
	searchPath: string,
	pathModule: path.PlatformPath = path,
): string {
	const hadTrailingSeparator =
		resultPath.endsWith(pathModule.sep) || (pathModule.sep === "\\" && resultPath.endsWith("/"));
	const relativePath = pathModule.isAbsolute(resultPath) ? pathModule.relative(searchPath, resultPath) : resultPath;
	const posixPath = relativePath.split(pathModule.sep).join("/");
	return hadTrailingSeparator && !posixPath.endsWith("/") ? `${posixPath}/` : posixPath;
}

const findSchema = Type.Object({
	pattern: Type.String({
		description: "用于匹配文件的 glob 模式，例如 '*.ts'、'**/*.json' 或 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "要搜索的目录（默认：当前目录）" })),
	limit: Type.Optional(Type.Number({ description: "最多返回的结果数（默认：1000）" })),
});

export const findToolSystemPromptContribution = {
	snippet: "按 glob 模式查找文件，遵循 .gitignore",
	guidelines: [],
} as const;

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative or absolute paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: pathExists,
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	glob: () => [],
};

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem plus fd */
	operations?: FindOperations;
}

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "find",
		label: "查找文件",
		description: `按 glob 模式查找文件，返回相对于搜索目录的匹配文件路径，并遵循 .gitignore。输出最多保留 ${DEFAULT_LIMIT} 个结果或 ${DEFAULT_MAX_BYTES / 1024}KB，以先达到的限制为准。`,
		promptSnippet: findToolSystemPromptContribution.snippet,
		parameters: findSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("操作已取消"));
					return;
				}

				let settled = false;
				let stopChild: (() => void) | undefined;
				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					stopChild = undefined;
					fn();
				};
				const onAbort = () => {
					stopChild?.();
					settle(() => reject(new Error("操作已取消")));
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const searchPath = resolveToCwd(searchDir || ".", ctx?.cwd || cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
						const ops = customOps ?? defaultFindOperations;

						// If custom operations provide glob(), use that instead of fd.
						if (customOps?.glob) {
							if (!(await ops.exists(searchPath))) {
								settle(() => reject(new Error(`路径不存在：${searchPath}`)));
								return;
							}
							if (signal?.aborted) {
								settle(() => reject(new Error("操作已取消")));
								return;
							}
							const results = await ops.glob(pattern, searchPath, {
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: effectiveLimit,
							});
							if (signal?.aborted) {
								settle(() => reject(new Error("操作已取消")));
								return;
							}
							if (results.length === 0) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "未找到符合模式的文件" }],
										details: undefined,
									}),
								);
								return;
							}

							// Relativize paths against the search root for stable output.
							const relativized = results.map((p) => relativizeFindResultPath(p, searchPath));
							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							if (resultLimitReached) {
								notices.push(`已达到 ${effectiveLimit} 个结果的限制`);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`已达到 ${formatSize(DEFAULT_MAX_BYTES)} 限制`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							settle(() =>
								resolve({
									content: [{ type: "text", text: resultOutput }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
							return;
						}

						// Default implementation uses fd.
						const fdPath = await ensureTool("fd");
						if (signal?.aborted) {
							settle(() => reject(new Error("操作已取消")));
							return;
						}
						if (!fdPath) {
							settle(() => reject(new Error("fd 不可用且无法下载")));
							return;
						}

						const args: string[] = ["--glob", "--color=never", "--hidden"];

						// fd normally ignores .gitignore outside git repos, so keep --no-require-git
						// there. Inside repos, use fd's default git-aware behavior so parent
						// .gitignore rules stop at nested repo boundaries:
						// https://github.com/earendil-works/pi/issues/5960
						let insideGitRepo = false;
						for (let current = searchPath; ; ) {
							if (await pathExists(path.join(current, ".git"))) {
								insideGitRepo = true;
								break;
							}
							const parent = path.dirname(current);
							if (parent === current) break;
							current = parent;
						}
						if (!insideGitRepo) args.push("--no-require-git");
						args.push("--max-results", String(effectiveLimit));

						// fd --glob matches against the basename unless --full-path is set; in --full-path
						// mode it matches against the absolute candidate path, so a path-containing
						// pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
						let effectivePattern = pattern;
						if (pattern.includes("/")) {
							args.push("--full-path");
							if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
								effectivePattern = `**/${pattern}`;
							}
							// fd matches full paths using native separators on Windows.
							if (process.platform === "win32")
								effectivePattern = effectivePattern.replaceAll("/", String.raw`[/\\]`);
						}
						args.push("--", effectivePattern, searchPath);

						const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						const lines: string[] = [];

						stopChild = () => {
							if (!child.killed) {
								child.kill();
							}
						};

						const cleanup = () => {
							rl.close();
						};

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						rl.on("line", (line) => {
							lines.push(line);
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`运行 fd 失败：${error.message}`)));
						});

						child.on("close", (code) => {
							cleanup();
							if (signal?.aborted) {
								settle(() => reject(new Error("操作已取消")));
								return;
							}
							const output = lines.join("\n");
							if (code !== 0) {
								const errorMsg = stderr.trim() || `fd exited with code ${code}`;
								if (!output) {
									settle(() => reject(new Error(errorMsg)));
									return;
								}
							}
							if (!output) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "未找到符合模式的文件" }],
										details: undefined,
									}),
								);
								return;
							}

							const relativized: string[] = [];
							for (const rawLine of lines) {
								const line = rawLine.replace(/\r$/, "").trim();
								if (!line) continue;
								relativized.push(relativizeFindResultPath(line, searchPath));
							}

							const resultLimitReached = relativized.length >= effectiveLimit;
							const rawOutput = relativized.join("\n");
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let resultOutput = truncation.content;
							const details: FindToolDetails = {};
							const notices: string[] = [];
							if (resultLimitReached) {
								notices.push(
									`已达到 ${effectiveLimit} 个结果的限制。使用 limit=${effectiveLimit * 2} 获取更多结果，或缩小 pattern 范围`,
								);
								details.resultLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`已达到 ${formatSize(DEFAULT_MAX_BYTES)} 限制`);
								details.truncation = truncation;
							}
							if (notices.length > 0) {
								resultOutput += `\n\n[${notices.join(". ")}]`;
							}
							settle(() =>
								resolve({
									content: [{ type: "text", text: resultOutput }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (e) {
						if (signal?.aborted) {
							settle(() => reject(new Error("操作已取消")));
							return;
						}
						const error = e instanceof Error ? e : new Error(String(e));
						settle(() => reject(error));
					}
				})();
			});
		},
		...findRenderers,
	};
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
