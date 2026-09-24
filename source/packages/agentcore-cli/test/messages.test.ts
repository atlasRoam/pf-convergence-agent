import { describe, expect, it } from "vitest";
import { bashExecutionToText, type BashExecutionMessage } from "../src/core/messages.ts";

function message(overrides: Partial<BashExecutionMessage> = {}): BashExecutionMessage {
	return {
		role: "bashExecution",
		command: "npm test",
		output: "ok",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 1,
		...overrides,
	};
}

describe("bashExecutionToText", () => {
	it("wraps command output for model context", () => {
		expect(bashExecutionToText(message())).toBe("已运行 `npm test`\n```\nok\n```");
	});

	it("marks commands without output", () => {
		expect(bashExecutionToText(message({ output: "" }))).toBe("已运行 `npm test`\n（无输出）");
	});

	it("marks cancellation instead of a nonzero exit", () => {
		expect(bashExecutionToText(message({ cancelled: true, exitCode: 130 }))).toBe(
			"已运行 `npm test`\n```\nok\n```\n\n（命令已取消）",
		);
	});

	it("includes a nonzero exit code", () => {
		expect(bashExecutionToText(message({ exitCode: 7 }))).toBe(
			"已运行 `npm test`\n```\nok\n```\n\n命令退出，退出码为 7",
		);
	});

	it("preserves the full-output path when output is truncated", () => {
		expect(bashExecutionToText(message({ truncated: true, fullOutputPath: "/tmp/full.log" }))).toBe(
			"已运行 `npm test`\n```\nok\n```\n\n[输出已截断。完整输出：/tmp/full.log]",
		);
	});
});
