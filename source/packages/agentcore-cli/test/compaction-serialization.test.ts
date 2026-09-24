import type { Message } from "@pfsaa/ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	it("should truncate long tool results", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[工具结果]:");
		expect(result).toContain("[另有 3000 个字符已截断]");
		expect(result).not.toContain("x".repeat(3000));
		// First 2000 chars should be present
		expect(result).toContain("x".repeat(2000));
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[工具结果]: ${shortContent}`);
		expect(result).not.toContain("已截断");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("已截断");
		expect(result).toContain(longText);
	});

	it("should serialize every conversation role with Chinese labels", () => {
		const result = serializeConversation([
			{ role: "user", content: "request", timestamp: 1 },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "reasoning" },
					{ type: "text", text: "answer" },
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "README.md" } },
				],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: "file contents" }],
				isError: false,
				timestamp: 3,
			},
		]);

		expect(result).toBe(
			'[用户]: request\n\n[智能体思考]: reasoning\n\n[智能体]: answer\n\n[智能体工具调用]: read(path="README.md")\n\n[工具结果]: file contents',
		);
	});
});
