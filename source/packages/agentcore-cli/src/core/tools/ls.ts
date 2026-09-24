import { readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@pfsaa/agent-core";
import nodePath from "path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { lsRenderers } from "./renderers/ls.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "要列出的目录（默认：当前目录）" })),
	limit: Type.Optional(Type.Number({ description: "最多返回的目录项数（默认：500）" })),
});

export const lsToolSystemPromptContribution = {
	snippet: "列出目录内容",
	guidelines: [],
} as const;

export type LsToolInput = Static<typeof lsSchema>;

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
	truncation?: TruncationResult;
	entryLimitReached?: number;
}

/**
 * Pluggable operations for the ls tool.
 * Override these to delegate directory listing to remote systems (for example SSH).
 */
export interface LsOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Get file or directory stats. Throws if not found. */
	stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean }> | { isDirectory: () => boolean };
	/** Read directory entries */
	readdir: (absolutePath: string) => Promise<string[]> | string[];
}

const defaultLsOperations: LsOperations = {
	exists: pathExists,
	stat: fsStat,
	readdir: fsReaddir,
};

export interface LsToolOptions {
	/** Custom operations for directory listing. Default: local filesystem */
	operations?: LsOperations;
}

export function createLsToolDefinition(
	cwd: string,
	options?: LsToolOptions,
): ToolDefinition<typeof lsSchema, LsToolDetails | undefined> {
	const ops = options?.operations ?? defaultLsOperations;
	return {
		name: "ls",
		label: "列出目录",
		description: `列出目录内容。返回按字母排序的目录项，目录以 '/' 结尾，并包含点文件。输出最多保留 ${DEFAULT_LIMIT} 个目录项或 ${DEFAULT_MAX_BYTES / 1024}KB，以先达到的限制为准。`,
		promptSnippet: lsToolSystemPromptContribution.snippet,
		parameters: lsSchema,
		async execute(
			_toolCallId,
			{ path, limit }: { path?: string; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("操作已取消"));
					return;
				}

				const onAbort = () => reject(new Error("操作已取消"));
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const dirPath = resolveToCwd(path || ".", ctx?.cwd || cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;

						// Check if path exists.
						if (!(await ops.exists(dirPath))) {
							reject(new Error(`路径不存在：${dirPath}`));
							return;
						}

						// Check if path is a directory.
						const stat = await ops.stat(dirPath);
						if (!stat.isDirectory()) {
							reject(new Error(`不是目录：${dirPath}`));
							return;
						}

						// Read directory entries.
						let entries: string[];
						try {
							entries = await ops.readdir(dirPath);
						} catch (e: any) {
							reject(new Error(`无法读取目录：${e.message}`));
							return;
						}

						// Sort alphabetically, case-insensitive.
						entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

						// Format entries with directory indicators.
						const results: string[] = [];
						let entryLimitReached = false;
						for (const entry of entries) {
							if (results.length >= effectiveLimit) {
								entryLimitReached = true;
								break;
							}

							const fullPath = nodePath.join(dirPath, entry);
							let suffix = "";
							try {
								const entryStat = await ops.stat(fullPath);
								if (entryStat.isDirectory()) suffix = "/";
							} catch {
								// Skip entries we cannot stat.
								continue;
							}
							results.push(entry + suffix);
						}

						signal?.removeEventListener("abort", onAbort);

						if (results.length === 0) {
							resolve({ content: [{ type: "text", text: "（空目录）" }], details: undefined });
							return;
						}

						const rawOutput = results.join("\n");
						// Apply byte truncation. There is no separate line limit because entry count is already capped.
						const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
						let output = truncation.content;
						const details: LsToolDetails = {};
						// Build actionable notices for truncation and entry limits.
						const notices: string[] = [];
						if (entryLimitReached) {
							notices.push(
								`已达到 ${effectiveLimit} 个目录项的限制。使用 limit=${effectiveLimit * 2} 获取更多结果`,
							);
							details.entryLimitReached = effectiveLimit;
						}
						if (truncation.truncated) {
							notices.push(`已达到 ${formatSize(DEFAULT_MAX_BYTES)} 限制`);
							details.truncation = truncation;
						}
						if (notices.length > 0) {
							output += `\n\n[${notices.join(". ")}]`;
						}

						resolve({
							content: [{ type: "text", text: output }],
							details: Object.keys(details).length > 0 ? details : undefined,
						});
					} catch (e: any) {
						signal?.removeEventListener("abort", onAbort);
						reject(e);
					}
				})();
			});
		},
		...lsRenderers,
	};
}

export function createLsTool(cwd: string, options?: LsToolOptions): AgentTool<typeof lsSchema> {
	return wrapToolDefinition(createLsToolDefinition(cwd, options));
}
