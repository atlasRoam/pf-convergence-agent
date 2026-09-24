import {
	type Context as AiContext,
	type Api,
	type AssistantMessage,
	contentText,
	type Model,
	type Models,
	type RetryCallbacks,
	type RetryPolicy,
	retryAssistantCall,
	type SimpleStreamOptions,
	type Usage,
	uuidv7,
} from "@pfsaa/ai";
import type { AgentMessage, ThinkingLevel } from "../../types.ts";
import { type Context, getTelemetryContext } from "../context.ts";
import { convertToLlm, createBranchSummaryMessage, createCompactionSummaryMessage } from "../messages.ts";
import { buildContextEntries, sessionEntryToContextMessages } from "../session/context.ts";
import type { CompactionEntry, Entry, JsonValue } from "../session/types.ts";
import { CompactionError, err, ok, type Result } from "../types.ts";
import { addUsage } from "../utils/usage.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	serializeConversation,
} from "./utils.ts";

/** File-operation details stored on generated compaction entries. */
export interface CompactionDetails extends Record<string, JsonValue> {
	/** Files read in the compacted history. */
	readFiles: string[];
	/** Files modified in the compacted history. */
	modifiedFiles: string[];
}
function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function extractFileOperations(
	messages: AgentMessage[],
	entries: Entry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (
			typeof prevCompaction.details === "object" &&
			prevCompaction.details !== null &&
			!Array.isArray(prevCompaction.details)
		) {
			if (Array.isArray(prevCompaction.details.readFiles)) {
				for (const path of prevCompaction.details.readFiles) {
					if (typeof path === "string") fileOps.read.add(path);
				}
			}
			if (Array.isArray(prevCompaction.details.modifiedFiles)) {
				for (const path of prevCompaction.details.modifiedFiles) {
					if (typeof path === "string") fileOps.edited.add(path);
				}
			}
		}
	}
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}
function getMessageFromEntry(entry: Entry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message as AgentMessage;
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: Entry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Generated compaction data ready to be persisted as a compaction entry. */
export interface CompactResult<T = JsonValue> {
	/** Summary text that replaces compacted history in future context. */
	summary: string;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Usage from the LLM call(s) that generated this summary, if available. */
	usage?: Usage;
	/** Retained recent messages stored directly on the compaction entry. */
	retainedTail: AgentMessage[];
	/** Optional implementation-specific details stored with the compaction entry. */
	details?: T;
}

export type SummaryRequest = (
	aiContext: AiContext,
	options: SimpleStreamOptions,
	context: Context,
) => Promise<AssistantMessage>;

export function createSummaryRequestOptions(options: SimpleStreamOptions, context: Context): SimpleStreamOptions {
	return {
		...options,
		signal: context.abortSignal,
		telemetryContext: getTelemetryContext(context),
		cacheRetention: "none",
		sessionId: options.sessionId ?? uuidv7(),
	};
}

export async function completeSimpleWithRetries(
	models: Models,
	model: Model<Api>,
	aiContext: AiContext,
	options: SimpleStreamOptions,
	retry: RetryPolicy | undefined,
	callbacks: RetryCallbacks | undefined,
	context: Context,
): Promise<AssistantMessage> {
	// Summaries are standalone requests, so isolate routing and avoid cache writes that cannot be reused.
	const requestOptions = createSummaryRequestOptions(options, context);
	return retryAssistantCall(
		() => models.completeSimple(model, aiContext, requestOptions),
		retry,
		requestOptions.signal,
		callbacks,
	);
}

/** Compaction thresholds and retention settings. */
export interface CompactionSettings {
	/** Enable automatic compaction decisions. */
	enabled: boolean;
	/** Tokens reserved for summary prompt and output. */
	reserveTokens: number;
	/** Approximate recent-context tokens to keep after compaction. */
	keepRecentTokens: number;
}

/** Default compaction settings used by the harness. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (
			assistantMsg.stopReason !== "aborted" &&
			assistantMsg.stopReason !== "error" &&
			assistantMsg.usage &&
			calculateContextTokens(assistantMsg.usage) > 0
		) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/** Return usage from the last valid assistant message in session entries. */
export function getLastAssistantUsage(entries: Entry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message as AgentMessage);
			if (usage) return usage;
		}
	}
	return undefined;
}

/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent assistant usage block. */
	trailingTokens: number;
	/** Index of the message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + safeJsonStringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}
function findValidCutPoints(entries: Entry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "compaction":
			case "branch_summary":
			case "custom":
				break;
		}
		if (entry.type === "branch_summary") cutPoints.push(i);
	}
	return cutPoints;
}

/** Find the user-visible message that starts the turn containing an entry. */
export function findTurnStartIndex(entries: Entry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

/** Cut point selected for compaction. */
export interface CutPointResult {
	/** Index of the first entry retained after compaction. */
	firstKeptEntryIndex: number;
	/** Index of the turn-start entry when the cut splits a turn, otherwise -1. */
	turnStartIndex: number;
	/** Whether the selected cut point splits an in-progress turn. */
	isSplitTurn: boolean;
}

/** Find the compaction cut point that keeps approximately the requested recent-token budget. */
export function findCutPoint(
	entries: Entry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0];

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const messageTokens = estimateTokens(entry.message as AgentMessage);
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			break;
		}
		cutIndex--;
	}
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

export const SUMMARIZATION_SYSTEM_PROMPT = `你是上下文摘要助手。你的任务是阅读用户与 AI 助手之间的对话，然后严格按照指定格式生成结构化摘要。

不要继续这段对话，不要回答对话中的任何问题，只输出结构化摘要。`;

const SUMMARIZATION_PROMPT = `以上消息是一段需要总结的对话。请生成结构化的上下文检查点摘要，供另一个大模型继续这项工作。

严格使用以下格式：

## 目标
[用户希望完成什么？如果会话涉及不同任务，可以列出多个目标。]

## 约束与偏好
- [用户提到的约束、偏好或要求]
- [如果没有提到，则写“无”]

## 进展
### 已完成
- [x] [已经完成的任务或改动]

### 进行中
- [ ] [当前正在处理的工作]

### 受阻
- [阻碍继续推进的问题，如有]

## 关键决策
- **[决策]**：[简要理由]

## 下一步
1. [接下来应该做什么，按顺序列出]

## 关键上下文
- [继续工作所需的数据、示例或引用]
- [不适用时写“无”]

各部分保持简洁。准确保留文件路径、函数名和错误信息。`;

const UPDATE_SUMMARIZATION_PROMPT = `以上消息是新的对话消息，需要合并到 <previous-summary> 标签中提供的已有摘要。

用新信息更新已有结构化摘要。规则如下：
- 保留上一份摘要中的全部已有信息。
- 补充新消息中的进展、决策和上下文。
- 更新“进展”部分：工作完成后，将相应条目从“进行中”移到“已完成”。
- 根据已经完成的工作更新“下一步”。
- 准确保留文件路径、函数名和错误信息。
- 如果某些内容已经不再相关，可以移除。

严格使用以下格式：

## 目标
[保留已有目标；如果任务范围扩展，补充新目标]

## 约束与偏好
- [保留已有内容，补充新发现的内容]

## 进展
### 已完成
- [x] [包括之前已完成和新完成的任务]

### 进行中
- [ ] [当前工作，按进展更新]

### 受阻
- [当前阻碍，移除已解决的问题]

## 关键决策
- **[决策]**：[简要理由，保留已有决策并补充新决策]

## 下一步
1. [根据当前状态更新]

## 关键上下文
- [保留重要上下文，按需补充新内容]

各部分保持简洁。准确保留文件路径、函数名和错误信息。`;

/** Generate or update a conversation summary for compaction. */
export async function generateSummary(
	currentMessages: AgentMessage[],
	models: Models,
	model: Model<Api>,
	reserveTokens: number,
	customInstructions: string | undefined,
	previousSummary: string | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	retry: RetryPolicy | undefined,
	callbacks: RetryCallbacks | undefined,
	context: Context,
): Promise<Result<string, CompactionError>> {
	const result = await generateSummaryWithUsage(
		currentMessages,
		models,
		model,
		reserveTokens,
		customInstructions,
		previousSummary,
		thinkingLevel,
		retry,
		callbacks,
		context,
	);
	return result.ok ? ok(result.value.text) : err(result.error);
}

/** Generate or update a conversation summary and return its provider usage. */
export function generateSummaryWithUsage(
	currentMessages: AgentMessage[],
	models: Models,
	model: Model<Api>,
	reserveTokens: number,
	customInstructions: string | undefined,
	previousSummary: string | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	retry: RetryPolicy | undefined,
	callbacks: RetryCallbacks | undefined,
	context: Context,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
	return generateSummaryWithRequest(
		currentMessages,
		{ model, reserveTokens, customInstructions, previousSummary, thinkingLevel },
		(aiContext, options, requestContext) =>
			completeSimpleWithRetries(models, model, aiContext, options, retry, callbacks, requestContext),
		context,
	);
}

export interface SummaryGenerationOptions {
	model: Model<Api>;
	reserveTokens: number;
	customInstructions?: string;
	previousSummary?: string;
	thinkingLevel?: ThinkingLevel;
}

/** Generate one summary through a caller-owned one-request boundary. */
export async function generateSummaryWithRequest(
	currentMessages: AgentMessage[],
	options: SummaryGenerationOptions,
	request: SummaryRequest,
	context: Context,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
	const { model, reserveTokens, customInstructions, previousSummary, thinkingLevel } = options;
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\n补充关注点：${customInstructions}`;
	}
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, reasoning: thinkingLevel }
			: { maxTokens };

	const response = await request(
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		createSummaryRequestOptions(completionOptions, context),
		context,
	);
	if (response.stopReason === "aborted") {
		return err(new CompactionError("aborted", response.errorMessage || "Summarization aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new CompactionError(
				"summarization_failed",
				`Summarization failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	const textContent = contentText(response.content);

	return ok({ text: textContent, usage: response.usage });
}

/** Prepared inputs for a compaction run. */
export interface CompactionPreparation {
	/** Messages summarized into the history summary. */
	messagesToSummarize: AgentMessage[];
	/** Prefix messages summarized separately when compaction splits a turn. */
	turnPrefixMessages: AgentMessage[];
	/** Recent messages retained after compaction and stored on the compaction entry. */
	retainedTail: AgentMessage[];
	/** Whether compaction splits a turn. */
	isSplitTurn: boolean;
	/** Estimated context tokens before compaction. */
	tokensBefore: number;
	/** Previous compaction summary used for iterative updates. */
	previousSummary?: string;
	/** File operations extracted from summarized history. */
	fileOps: FileOperations;
	/** Settings used to prepare compaction. */
	settings: CompactionSettings;
}

/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(
	pathEntries: Entry[],
	settings: CompactionSettings,
): Result<CompactionPreparation | undefined, CompactionError> {
	if (pathEntries.length === 0 || pathEntries[pathEntries.length - 1].type === "compaction") {
		return ok(undefined);
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let compactableEntries = pathEntries;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const virtualRetainedEntries: Entry[] = prevCompaction.retainedTail.map((message, index) => ({
			type: "message",
			id: `${prevCompaction.id}:retained:${index}`,
			parentId: index === 0 ? prevCompaction.id : `${prevCompaction.id}:retained:${index - 1}`,
			seq: prevCompaction.seq,
			timestamp: message.timestamp,
			message,
		}));
		compactableEntries = [...virtualRetainedEntries, ...pathEntries.slice(prevCompactionIndex + 1)];
	}
	const boundaryEnd = compactableEntries.length;

	const tokensBefore = estimateContextTokens(
		buildContextEntries(pathEntries).flatMap(sessionEntryToContextMessages),
	).tokens;

	const cutPoint = findCutPoint(compactableEntries, 0, boundaryEnd, settings.keepRecentTokens);
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = 0; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}
	const retainedTail: AgentMessage[] = [];
	for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
		const msg = getMessageFromEntryForCompaction(compactableEntries[i]);
		if (msg) retainedTail.push(msg);
	}
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return ok({
		messagesToSummarize,
		turnPrefixMessages,
		retainedTail,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	});
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = `这是一个过长回合的前缀部分，无法完整保留。后缀部分，即最近的工作内容，会继续保留。

请总结此前缀，为保留的后缀提供上下文：

## 原始请求
[用户在这个回合中提出了什么要求？]

## 前期进展
- [前缀中已经作出的关键决策和完成的工作]

## 后缀所需上下文
- [理解保留的近期工作所需的信息]

保持简洁，重点保留理解后缀所需的内容。`;

export { serializeConversation } from "./utils.ts";

/** Generate compaction summary data from prepared session history. */
export function compact(
	preparation: CompactionPreparation,
	models: Models,
	model: Model<Api>,
	customInstructions: string | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	retry: RetryPolicy | undefined,
	callbacks: RetryCallbacks | undefined,
	context: Context,
): Promise<Result<CompactResult, CompactionError>> {
	return compactWithRequest(
		preparation,
		{ model, customInstructions, thinkingLevel },
		(aiContext, options, requestContext) =>
			completeSimpleWithRetries(models, model, aiContext, options, retry, callbacks, requestContext),
		context,
	);
}

export interface CompactGenerationOptions {
	model: Model<Api>;
	customInstructions?: string;
	thinkingLevel?: ThinkingLevel;
}

/** Generate compaction data through a caller-owned boundary for each provider request. */
export async function compactWithRequest(
	preparation: CompactionPreparation,
	options: CompactGenerationOptions,
	request: SummaryRequest,
	context: Context,
): Promise<Result<CompactResult, CompactionError>> {
	const { model, customInstructions, thinkingLevel } = options;
	const {
		messagesToSummarize,
		turnPrefixMessages,
		retainedTail,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	let summary: string;
	let summaryUsage: Usage;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		let historyText = "无先前历史。";
		let historyUsage: Usage | undefined;
		if (messagesToSummarize.length > 0) {
			const historyResult = await generateSummaryWithRequest(
				messagesToSummarize,
				{ model, reserveTokens: settings.reserveTokens, customInstructions, previousSummary, thinkingLevel },
				request,
				context,
			);
			if (!historyResult.ok) return err(historyResult.error);
			historyText = historyResult.value.text;
			historyUsage = historyResult.value.usage;
		}
		const turnPrefixResult = await generateTurnPrefixSummary(
			turnPrefixMessages,
			model,
			settings.reserveTokens,
			thinkingLevel,
			request,
			context,
		);
		if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
		summary = `${historyText}\n\n---\n\n**回合上下文（拆分回合）：**\n\n${turnPrefixResult.value.text}`;
		summaryUsage = historyUsage ? addUsage(historyUsage, turnPrefixResult.value.usage) : turnPrefixResult.value.usage;
	} else {
		const summaryResult = await generateSummaryWithRequest(
			messagesToSummarize,
			{ model, reserveTokens: settings.reserveTokens, customInstructions, previousSummary, thinkingLevel },
			request,
			context,
		);
		if (!summaryResult.ok) return err(summaryResult.error);
		summary = summaryResult.value.text;
		summaryUsage = summaryResult.value.usage;
	}

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);
	const details: CompactionDetails = { readFiles, modifiedFiles };

	return ok({ summary, tokensBefore, usage: summaryUsage, retainedTail, details });
}
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<Api>,
	reserveTokens: number,
	thinkingLevel: ThinkingLevel | undefined,
	request: SummaryRequest,
	context: Context,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const completionOptions =
		model.reasoning && thinkingLevel && thinkingLevel !== "off"
			? { maxTokens, reasoning: thinkingLevel }
			: { maxTokens };
	const response = await request(
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		createSummaryRequestOptions(completionOptions, context),
		context,
	);
	if (response.stopReason === "aborted") {
		return err(new CompactionError("aborted", response.errorMessage || "Turn prefix summarization aborted"));
	}
	if (response.stopReason === "error") {
		return err(
			new CompactionError(
				"summarization_failed",
				`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`,
			),
		);
	}

	return ok({
		text: contentText(response.content),
		usage: response.usage,
	});
}
