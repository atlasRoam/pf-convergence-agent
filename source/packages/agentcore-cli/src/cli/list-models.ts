/**
 * List available models with optional fuzzy search
 */

import type { Api, Model } from "@pfsaa/ai";
import { fuzzyFilter, visibleWidth } from "@pfsaa/tui";
import chalk from "chalk";
import { formatNoModelsAvailableMessage } from "../core/auth-guidance.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";

/**
 * Format a number as human-readable (e.g., 200000 -> "200K", 1000000 -> "1M")
 */
function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	return count.toString();
}

function padColumn(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

/**
 * List available models, optionally filtered by search pattern
 */
export async function listModels(
	modelRuntime: ModelRuntime,
	searchPattern?: string,
	signal?: AbortSignal,
): Promise<void> {
	const loadError = modelRuntime.getError();
	if (loadError) {
		console.error(chalk.yellow(`警告：加载 models.json 时出错：\n${loadError}`));
	}

	const models = [...(await modelRuntime.getAvailable(undefined, { signal }))];

	if (models.length === 0) {
		console.log(formatNoModelsAvailableMessage());
		return;
	}

	// Apply fuzzy filter if search pattern provided
	let filteredModels: Model<Api>[] = models;
	if (searchPattern) {
		filteredModels = fuzzyFilter(models, searchPattern, (m) => `${m.provider} ${m.id}`);
	}

	if (filteredModels.length === 0) {
		console.log(`没有匹配 "${searchPattern}" 的模型`);
		return;
	}

	// Sort by provider, then by model id
	filteredModels.sort((a, b) => {
		const providerCmp = a.provider.localeCompare(b.provider);
		if (providerCmp !== 0) return providerCmp;
		return a.id.localeCompare(b.id);
	});

	// Calculate column widths
	const rows = filteredModels.map((m) => ({
		provider: m.provider,
		model: m.id,
		context: formatTokenCount(m.contextWindow),
		maxOut: formatTokenCount(m.maxTokens),
		thinking: m.reasoning ? "是" : "否",
		images: m.input.includes("image") ? "是" : "否",
	}));

	const headers = {
		provider: "提供方",
		model: "模型",
		context: "上下文",
		maxOut: "最大输出",
		thinking: "思考",
		images: "图像",
	};

	const widths = {
		provider: Math.max(visibleWidth(headers.provider), ...rows.map((r) => visibleWidth(r.provider))),
		model: Math.max(visibleWidth(headers.model), ...rows.map((r) => visibleWidth(r.model))),
		context: Math.max(visibleWidth(headers.context), ...rows.map((r) => visibleWidth(r.context))),
		maxOut: Math.max(visibleWidth(headers.maxOut), ...rows.map((r) => visibleWidth(r.maxOut))),
		thinking: Math.max(visibleWidth(headers.thinking), ...rows.map((r) => visibleWidth(r.thinking))),
		images: Math.max(visibleWidth(headers.images), ...rows.map((r) => visibleWidth(r.images))),
	};

	// Print header
	const headerLine = [
		padColumn(headers.provider, widths.provider),
		padColumn(headers.model, widths.model),
		padColumn(headers.context, widths.context),
		padColumn(headers.maxOut, widths.maxOut),
		padColumn(headers.thinking, widths.thinking),
		padColumn(headers.images, widths.images),
	].join("  ");
	console.log(headerLine);

	// Print rows
	for (const row of rows) {
		const line = [
			padColumn(row.provider, widths.provider),
			padColumn(row.model, widths.model),
			padColumn(row.context, widths.context),
			padColumn(row.maxOut, widths.maxOut),
			padColumn(row.thinking, widths.thinking),
			padColumn(row.images, widths.images),
		].join("  ");
		console.log(line);
	}
}
