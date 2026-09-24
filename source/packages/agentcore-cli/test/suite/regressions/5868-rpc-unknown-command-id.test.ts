import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

// Regression for https://github.com/earendil-works/pi/issues/5868

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}

	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

describe("RPC unknown command responses (#5868)", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("preserves the request id on unknown command errors", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "test", type: "foobar" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "test",
					type: "response",
					command: "foobar",
					success: false,
					error: "未知命令：foobar",
				});
			});
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("returns Chinese errors without changing RPC response fields", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness();

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "model", type: "set_model", provider: "fake", modelId: "missing" }));
			rpcIo.lineHandler?.(JSON.stringify({ id: "clone", type: "clone" }));
			rpcIo.lineHandler?.(JSON.stringify({ id: "entries", type: "get_entries", since: "missing-entry" }));
			rpcIo.lineHandler?.(JSON.stringify({ id: "name", type: "set_session_name", name: "  " }));
			rpcIo.lineHandler?.("{");

			await vi.waitFor(() => {
				const output = parseOutputLines();
				expect(output).toContainEqual({
					id: "model",
					type: "response",
					command: "set_model",
					success: false,
					error: "未找到模型：fake/missing",
				});
				expect(output).toContainEqual({
					id: "clone",
					type: "response",
					command: "clone",
					success: false,
					error: "无法复制会话：未选择当前条目",
				});
				expect(output).toContainEqual({
					id: "entries",
					type: "response",
					command: "get_entries",
					success: false,
					error: "未找到条目：missing-entry",
				});
				expect(output).toContainEqual({
					id: "name",
					type: "response",
					command: "set_session_name",
					success: false,
					error: "会话名称不能为空",
				});
				expect(output).toContainEqual(
					expect.objectContaining({
						type: "response",
						command: "parse",
						success: false,
						error: expect.stringContaining("解析命令失败："),
					}),
				);
			});
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
});
