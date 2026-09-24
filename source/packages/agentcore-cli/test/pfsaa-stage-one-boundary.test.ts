import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

type JsonRecord = Record<string, unknown>;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = resolve(TEST_DIR, "../../..");
const PROJECT_DIR = resolve(SOURCE_DIR, "..");
const PLACEHOLDER_KEY = "test-secret-placeholder";
const FIRST_MARKER = "第一会话约定：ALPHA-731";
const SECOND_TURN_MARKER = "第二轮历史检查：BETA-419";
const SECOND_SESSION_MARKER = "第二会话约定：GAMMA-208";
const RESTORE_MARKER = "恢复会话检查：DELTA-624";
const SKILL_BODY_MARKER = "STAGE_SKILL_BODY_512";

async function waitForExit(
	child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: string | null }> {
	return new Promise((resolveExit, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolveExit({ code, signal }));
	});
}

class RpcProcess {
	readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<
		string,
		{ resolve: (value: JsonRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	private readonly settledWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
	private stdoutBuffer = "";
	private stderr = "";

	constructor(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
		this.child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString()));
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderr += chunk.toString();
		});
		this.child.once("exit", (code, signal) => {
			const error = new Error(`RPC 进程提前退出：code=${code} signal=${signal}\n${this.stderr}`);
			for (const waiter of this.pending.values()) {
				clearTimeout(waiter.timer);
				waiter.reject(error);
			}
			this.pending.clear();
			for (const waiter of this.settledWaiters.splice(0)) waiter.reject(error);
		});
	}

	async send(id: string, command: JsonRecord): Promise<JsonRecord> {
		const response = new Promise<JsonRecord>((resolveResponse, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`等待 RPC 响应超时：${id}\n${this.stderr}`));
			}, 20_000);
			this.pending.set(id, { resolve: resolveResponse, reject, timer });
		});
		this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		return response;
	}

	async promptAndWait(id: string, message: string): Promise<void> {
		const settled = new Promise<void>((resolveSettled, reject) => {
			this.settledWaiters.push({ resolve: resolveSettled, reject });
		});
		const response = await this.send(id, { type: "prompt", message });
		expect(response).toMatchObject({ type: "response", command: "prompt", success: true });
		await settled;
	}

	private handleStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		for (;;) {
			const newline = this.stdoutBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			if (!line) continue;
			let record: JsonRecord;
			try {
				record = JSON.parse(line) as JsonRecord;
			} catch {
				this.stderr += `${line}\n`;
				continue;
			}
			if (record.type === "response" && typeof record.id === "string") {
				const waiter = this.pending.get(record.id);
				if (waiter) {
					clearTimeout(waiter.timer);
					this.pending.delete(record.id);
					waiter.resolve(record);
				}
			}
			if (record.type === "agent_settled") {
				this.settledWaiters.shift()?.resolve();
			}
		}
	}
}

function messageText(payload: JsonRecord): string {
	return JSON.stringify(payload.messages ?? []);
}

function entryText(session: SessionManager): string {
	return JSON.stringify(session.getEntries());
}

function readCapturedPayloads(path: string): JsonRecord[] {
	if (!existsSync(path)) return [];
	const content = readFileSync(path, "utf8").trim();
	return content ? content.split("\n").map((line) => JSON.parse(line) as JsonRecord) : [];
}

function getSystemText(payload: JsonRecord): string {
	if (!Array.isArray(payload.messages)) return "";
	return payload.messages
		.filter((message): message is JsonRecord => typeof message === "object" && message !== null)
		.filter((message) => message.role === "system")
		.map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
		.join("\n");
}

function getAvailableSkills(payload: JsonRecord): Array<{ name: string; description: string; location: string }> {
	const block = getSystemText(payload).match(/<available_skills>([\s\S]*?)<\/available_skills>/)?.[1] ?? "";
	return Array.from(
		block.matchAll(
			/<skill>\s*<name>([^<]+)<\/name>\s*<description>([^<]+)<\/description>\s*<location>([^<]+)<\/location>\s*<\/skill>/g,
		),
		(match) => ({ name: match[1], description: match[2], location: match[3] }),
	);
}

function replaceSessionHeaderCwd(sessionFile: string, cwd: string): void {
	const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
	const header = JSON.parse(lines[0]) as JsonRecord;
	if (header.type !== "session") throw new Error(`无效会话头：${sessionFile}`);
	header.cwd = cwd;
	lines[0] = JSON.stringify(header);
	writeFileSync(sessionFile, `${lines.join("\n")}\n`);
}

async function runToExit(
	command: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
	const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	return { ...(await waitForExit(child)), stdout, stderr };
}

describe.runIf(process.platform !== "win32")("PFSAA 阶段零与阶段一正式 CLI 边界", () => {
	let projectShell: string;
	let runtimeDir: string;
	let unrelatedCwd: string;
	let startScript: string;
	let skillPath: string;
	let capturePath: string;
	let hookCapturePath: string;
	let ignoredSessionDir: string;
	let launchEnv: NodeJS.ProcessEnv;
	let cliArgs: string[];
	let useRootStartScript: boolean;
	let firstSessionFile: string;
	let secondSessionFile: string;
	let rpc: RpcProcess;

	beforeAll(() => {
		projectShell = mkdtempSync(join(tmpdir(), "PFSAA 阶段一-"));
		runtimeDir = join(projectShell, "runtime");
		unrelatedCwd = join(projectShell, "无关 工作目录");
		startScript = join(projectShell, "start.sh");
		capturePath = join(projectShell, "provider-payload.jsonl");
		hookCapturePath = join(projectShell, "provider-hook-payload.jsonl");
		ignoredSessionDir = join(projectShell, "不应使用的会话");
		const agentDir = join(runtimeDir, ".agent");
		const skillDir = join(projectShell, "显式 Skill", "stage-boundary");
		skillPath = join(skillDir, "SKILL.md");
		const extensionPath = join(projectShell, "faux-provider.ts");
		const cliLauncherPath = join(projectShell, "cli-launcher.mts");

		mkdirSync(agentDir, { recursive: true });
		mkdirSync(unrelatedCwd, { recursive: true });
		mkdirSync(skillDir, { recursive: true });
		copyFileSync(join(PROJECT_DIR, "start.sh"), startScript);
		chmodSync(startScript, 0o755);
		symlinkSync(SOURCE_DIR, join(projectShell, "source"), "dir");
		writeFileSync(
			skillPath,
			`---\nname: stage-boundary\ndescription: 阶段一正式边界验收专用 Skill\n---\n\n# 临时验收 Skill\n\n正文标记：${SKILL_BODY_MARKER}\n`,
		);
		writeFileSync(
			cliLauncherPath,
			`import { setupCli } from ${JSON.stringify(join(SOURCE_DIR, "packages", "agentcore-cli", "src", "cli", "setup.ts"))};
import { main } from ${JSON.stringify(join(SOURCE_DIR, "packages", "agentcore-cli", "src", "main.ts"))};

setupCli();
await main(process.argv.slice(2));
`,
		);
		writeFileSync(
			extensionPath,
			`import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@pfsaa/agentcore-cli";

const capturePath = ${JSON.stringify(capturePath)};
const hookCapturePath = ${JSON.stringify(hookCapturePath)};
const skillPath = ${JSON.stringify(skillPath)};
let issuedSkillRead = false;

function sse(delta: Record<string, unknown>, finishReason: string): Response {
	const chunks = [
		{
			id: "chatcmpl-stage-one",
			object: "chat.completion.chunk",
			created: 0,
			model: "stage-model",
			choices: [{ index: 0, delta, finish_reason: null }],
		},
		{
			id: "chatcmpl-stage-one",
			object: "chat.completion.chunk",
			created: 0,
			model: "stage-model",
			choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
			usage: { prompt_tokens: 100, completion_tokens: 10 },
		},
	];
	return new Response(chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\\n\\n").join("") + "data: [DONE]\\n\\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event) => {
		appendFileSync(hookCapturePath, JSON.stringify(event.payload) + "\\n", "utf8");
		return event.payload;
	});

	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		if (!url.includes("stage.invalid")) throw new Error("测试扩展阻止了意外网络请求：" + url);
		const payload = JSON.parse(String(init?.body ?? "{}"));
		appendFileSync(capturePath, JSON.stringify(payload) + "\\n", "utf8");
		const serialized = JSON.stringify(payload);
		if (serialized.includes("上下文摘要助手")) {
			return sse({ role: "assistant", content: "## 目标\\n保留阶段验收历史。\\n\\n## 下一步\\n继续验证。" }, "stop");
		}
		if (!issuedSkillRead) {
			issuedSkillRead = true;
			return sse({
				role: "assistant",
				tool_calls: [{
					index: 0,
					id: "call_stage_skill",
					type: "function",
					function: { name: "bash", arguments: JSON.stringify({ command: "cat " + JSON.stringify(skillPath) }) },
				}],
			}, "tool_calls");
		}
		const content = serialized.includes(${JSON.stringify(SECOND_SESSION_MARKER)})
			? "第二会话已记录"
			: serialized.includes(${JSON.stringify(SECOND_TURN_MARKER)})
				? "历史已核对"
				: "普通请求完成";
		return sse({ role: "assistant", content }, "stop");
	}) as typeof fetch;
}
`,
		);

		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"stage-provider": {
						baseUrl: "https://stage.invalid/v1",
						api: "openai-completions",
						models: [
							{
								id: "stage-model",
								name: "Stage Model",
								reasoning: false,
								input: ["text"],
								contextWindow: 32_768,
								maxTokens: 4_096,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "auth.json"),
			JSON.stringify({ "stage-provider": { type: "api_key", key: PLACEHOLDER_KEY } }),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ compaction: { enabled: true, reserveTokens: 1_024, keepRecentTokens: 1 } }),
		);

		useRootStartScript = process.env.AGENTCORE_STAGE_TEST_ROOT_START === "1";
		if (useRootStartScript) {
			const accidentalProjectSettingsDir = join(runtimeDir, ".agentcore");
			mkdirSync(accidentalProjectSettingsDir, { recursive: true });
			writeFileSync(join(accidentalProjectSettingsDir, "settings.json"), "{ invalid project settings");
		}
		const cleanProcessEnv: NodeJS.ProcessEnv = {};
		for (const key of Object.keys(process.env)) {
			if (
				key === "NODE_OPTIONS" ||
				key.startsWith("VITEST") ||
				/(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)
			) {
				continue;
			}
			cleanProcessEnv[key] = process.env[key];
		}
		launchEnv = {
			...cleanProcessEnv,
			AGENTCORE_AGENT_DIR: useRootStartScript ? join(projectShell, "不应使用的配置") : agentDir,
			AGENTCORE_RUNTIME_CWD: useRootStartScript ? join(projectShell, "不应使用的 cwd") : undefined,
			AGENTCORE_OFFLINE: "1",
			AGENTCORE_SKIP_VERSION_CHECK: "1",
			AGENTCORE_TELEMETRY: "0",
			TSX_TSCONFIG_PATH: join(projectShell, "source", "tsconfig.json"),
		};
		if (useRootStartScript) {
			launchEnv.AGENTCORE_SESSION_DIR = ignoredSessionDir;
		} else {
			delete launchEnv.AGENTCORE_SESSION_DIR;
			delete launchEnv.AGENTCORE_RUNTIME_CWD;
		}
		cliArgs = [
			"--mode",
			"rpc",
			"--provider",
			"stage-provider",
			"--model",
			"stage-model",
			"--name",
			"中文 会话",
			"--skill",
			skillPath,
			"--extension",
			extensionPath,
		];

		if (useRootStartScript) {
			rpc = new RpcProcess(startScript, cliArgs, unrelatedCwd, launchEnv);
		} else {
			const ptyLauncherPath = join(projectShell, "pty-cli-launcher.sh");
			const directArgs = [
				"--import",
				join(projectShell, "source", "node_modules", "tsx", "dist", "loader.mjs"),
				cliLauncherPath,
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				...cliArgs,
			];
			const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
			writeFileSync(
				ptyLauncherPath,
				`#!/usr/bin/env bash\nset -euo pipefail\nstty -echo\nexec ${quote(process.execPath)} ${directArgs.map(quote).join(" ")}\n`,
			);
			chmodSync(ptyLauncherPath, 0o755);
			rpc = new RpcProcess("/usr/bin/script", ["-qefc", quote(ptyLauncherPath), "/dev/null"], runtimeDir, launchEnv);
		}
	});

	afterAll(() => {
		if (rpc?.child.exitCode === null && rpc.child.signalCode === null) rpc.child.kill("SIGTERM");
	});

	it("通过正式 CLI 捕获普通、工具循环、历史和摘要 payload，并读取两个原生会话", async () => {
		const initialState = await rpc.send("state-initial", { type: "get_state" });
		expect(initialState).toMatchObject({ type: "response", command: "get_state", success: true });

		await rpc.promptAndWait("prompt-first", `${FIRST_MARKER}。请按需读取 stage-boundary Skill。`);
		await rpc.promptAndWait("prompt-second", SECOND_TURN_MARKER);

		const compactResponse = await rpc.send("compact", { type: "compact", customInstructions: "保留验收标记" });
		expect(compactResponse).toMatchObject({ type: "response", command: "compact", success: true });
		const firstState = await rpc.send("state-first", { type: "get_state" });
		firstSessionFile = (firstState.data as JsonRecord).sessionFile as string;
		expect(firstSessionFile).toBeTypeOf("string");

		const newSession = await rpc.send("new-session", { type: "new_session" });
		expect(newSession).toMatchObject({ success: true, data: { cancelled: false } });
		await rpc.promptAndWait("prompt-new-session", SECOND_SESSION_MARKER);
		const secondState = await rpc.send("state-second", { type: "get_state" });
		secondSessionFile = (secondState.data as JsonRecord).sessionFile as string;
		expect(secondSessionFile).toBeTypeOf("string");
		expect(secondSessionFile).not.toBe(firstSessionFile);
		const requests = readCapturedPayloads(capturePath);
		const hookPayloads = readCapturedPayloads(hookCapturePath);

		const ordinaryPayload = requests[0];
		const toolResultPayload = requests[1];
		const historyPayload = requests.find((payload) => messageText(payload).includes(SECOND_TURN_MARKER));
		const summaryPayload = requests.find((payload) => JSON.stringify(payload).includes("上下文摘要助手"));
		expect(ordinaryPayload).toBeDefined();
		expect(toolResultPayload).toBeDefined();
		expect(historyPayload).toBeDefined();
		expect(summaryPayload).toBeDefined();

		const ordinaryText = JSON.stringify(ordinaryPayload);
		expect(ordinaryText).toContain("你是电力系统潮流计算调整智能体。");
		expect(ordinaryText).toContain("<name>stage-boundary</name>");
		expect(ordinaryText).toContain(FIRST_MARKER);
		expect((ordinaryPayload.tools as JsonRecord[]).map((tool) => (tool.function as JsonRecord).name)).toEqual([
			"read",
			"bash",
			"edit",
			"write",
		]);
		expect(ordinaryText).toContain("读取文件");
		expect(getAvailableSkills(ordinaryPayload)).toEqual([
			{
				name: "stage-boundary",
				description: "阶段一正式边界验收专用 Skill",
				location: skillPath,
			},
		]);
		expect(JSON.stringify(toolResultPayload)).toContain(SKILL_BODY_MARKER);
		expect(JSON.stringify(historyPayload)).toContain(FIRST_MARKER);
		expect(JSON.stringify(historyPayload)).toContain("普通请求完成");
		expect(summaryPayload?.tools ?? []).toEqual([]);
		expect(JSON.stringify(summaryPayload)).toContain("保留验收标记");
		expect(hookPayloads).toHaveLength(
			requests.filter((payload) => !JSON.stringify(payload).includes("上下文摘要助手")).length,
		);
		expect(JSON.stringify(hookPayloads)).toContain(FIRST_MARKER);
		expect(JSON.stringify(hookPayloads)).not.toContain("上下文摘要助手");

		for (const payload of requests) {
			const serialized = JSON.stringify(payload);
			expect(serialized).not.toContain(PLACEHOLDER_KEY);
			expect(serialized).not.toContain("engineer-professional");
			expect(serialized).not.toContain("Adding a New LLM Provider");
			expect(serialized).not.toContain("interactive-testing");
		}

		const expectedSessionDir = join(runtimeDir, ".agent", "sessions");
		if (useRootStartScript) {
			expect(dirname(firstSessionFile)).toBe(expectedSessionDir);
			expect(dirname(secondSessionFile)).toBe(expectedSessionDir);
			expect(!existsSync(ignoredSessionDir) || readdirSync(ignoredSessionDir).length === 0).toBe(true);
		} else {
			expect(dirname(secondSessionFile)).toBe(dirname(firstSessionFile));
		}

		const firstSession = SessionManager.open(firstSessionFile);
		const secondSession = SessionManager.open(secondSessionFile);
		expect(entryText(firstSession)).toContain(FIRST_MARKER);
		expect(entryText(firstSession)).toContain(SECOND_TURN_MARKER);
		expect(entryText(secondSession)).toContain(SECOND_SESSION_MARKER);
		expect(firstSession.getCwd()).toBe(runtimeDir);
		expect(secondSession.getCwd()).toBe(runtimeDir);

		const sessions = await SessionManager.list(runtimeDir, dirname(firstSessionFile));
		expect(sessions.map((session) => session.path)).toEqual(
			expect.arrayContaining([firstSessionFile, secondSessionFile]),
		);

		const rpcExitPromise = waitForExit(rpc.child);
		rpc.child.kill("SIGTERM");
		await rpcExitPromise;
	}, 60_000);

	it.runIf(process.env.AGENTCORE_STAGE_TEST_ROOT_START === "1")(
		"根 start.sh 恢复外部 cwd 会话时保持 runtime cwd 和原生历史",
		async () => {
			replaceSessionHeaderCwd(secondSessionFile, unrelatedCwd);
			const previousRequestCount = readCapturedPayloads(capturePath).length;
			const restoredRpc = new RpcProcess(
				startScript,
				[...cliArgs, "--session", secondSessionFile],
				unrelatedCwd,
				launchEnv,
			);
			try {
				const restoredState = await restoredRpc.send("restored-state", { type: "get_state" });
				expect(restoredState).toMatchObject({
					type: "response",
					command: "get_state",
					success: true,
					data: { sessionFile: secondSessionFile },
				});
				expect((restoredState.data as JsonRecord).messageCount).toBeGreaterThan(0);

				const cwdResponse = await restoredRpc.send("restored-cwd", { type: "bash", command: "pwd" });
				expect(((cwdResponse.data as JsonRecord).output as string).trim()).toBe(runtimeDir);

				await restoredRpc.promptAndWait("restored-prompt", RESTORE_MARKER);
				const restoredRequests = readCapturedPayloads(capturePath).slice(previousRequestCount);
				expect(
					restoredRequests.some((payload) => {
						const text = messageText(payload);
						return text.includes(SECOND_SESSION_MARKER) && text.includes(RESTORE_MARKER);
					}),
				).toBe(true);
			} finally {
				if (restoredRpc.child.exitCode === null && restoredRpc.child.signalCode === null) {
					const exitPromise = waitForExit(restoredRpc.child);
					restoredRpc.child.kill("SIGTERM");
					await exitPromise;
				}
			}
		},
		60_000,
	);

	it.runIf(process.env.AGENTCORE_STAGE_TEST_ROOT_START === "1")(
		"根入口忽略 runtime 项目级 .agentcore 设置",
		async () => {
			const result = await runToExit(startScript, ["--help"], unrelatedCwd, launchEnv);
			expect(result.code).toBe(0);
			expect(result.stderr).not.toContain("项目设置");
			expect(result.stderr).not.toContain(join(runtimeDir, ".agentcore", "settings.json"));
		},
		60_000,
	);

	it.runIf(process.env.AGENTCORE_STAGE_TEST_ROOT_START === "1")(
		"根入口拒绝冲突 --session-dir，并保持 PowerShell 静态参数合同",
		async () => {
			const conflictingSessionDir = join(projectShell, "冲突会话目录");
			const result = await runToExit(
				startScript,
				["--session-dir", conflictingSessionDir, "--help"],
				unrelatedCwd,
				launchEnv,
			);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("错误：固定产品运行入口的会话目录为");
			expect(result.stderr).toContain(`--session-dir 不能指向其他目录：${conflictingSessionDir}`);

			const powershellEntry = readFileSync(join(PROJECT_DIR, "start.ps1"), "utf8");
			expect(powershellEntry).toContain("$env:AGENTCORE_RUNTIME_CWD = $runtimeDir");
			expect(powershellEntry).toContain('$env:AGENTCORE_SESSION_DIR = Join-Path $agentDir "sessions"');
			expect(powershellEntry).toContain('$defaultPfntPython = Join-Path $runtimeDir "python/pfnt-cli-3.11.14/Scripts/python.exe"');
			expect(powershellEntry).toContain('$env:WSLENV = ($retainedWslenvEntries + ($wslPathVariables | ForEach-Object { "$_/p" })) -join ":"');
		},
		60_000,
	);
});
