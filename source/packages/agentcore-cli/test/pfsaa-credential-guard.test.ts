import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	CREDENTIAL_REDACTION,
	type CredentialGuardSources,
	registerCredentialGuard,
} from "../src/extensions/pfsaa-credential-guard.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const TEST_CREDENTIAL = "test-secret-placeholder";
const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

type CapturedHandler = (event: unknown, context: { cwd: string }) => unknown | Promise<unknown>;

function captureHandlers(
	agentDir: string | undefined,
	sources: CredentialGuardSources = { argv: [], env: {} },
): Map<string, CapturedHandler> {
	const handlers = new Map<string, CapturedHandler>();
	const api = {
		on(event: string, handler: CapturedHandler) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	registerCredentialGuard(api, agentDir, sources);
	return handlers;
}

async function invoke(
	handlers: Map<string, CapturedHandler>,
	eventName: string,
	event: unknown,
	cwd: string,
): Promise<unknown> {
	const handler = handlers.get(eventName);
	if (!handler) throw new Error(`未注册扩展处理器：${eventName}`);
	return handler(event, { cwd });
}

describe("PFSAA 正式入口凭据防护", () => {
	let tempDir: string;
	let runtimeDir: string;
	let agentDir: string;
	let authPath: string;
	let handlers: Map<string, CapturedHandler>;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pfsaa-credential-guard-"));
		runtimeDir = join(tempDir, "runtime");
		agentDir = join(runtimeDir, ".agentcore");
		authPath = join(agentDir, "auth.json");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(authPath, JSON.stringify({ test: { type: "api_key", key: TEST_CREDENTIAL } }));
		handlers = captureHandlers(agentDir);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("阻止文件工具访问规范化后的 auth.json，但不误伤 sessions", async () => {
		for (const [toolName, path] of [
			["read", ".agentcore/auth.json"],
			["write", authPath.replaceAll("/", "\\")],
			["edit", "./.agentcore/../.agentcore/auth.json"],
		] as const) {
			await expect(
				invoke(
					handlers,
					"tool_call",
					{ type: "tool_call", toolName, toolCallId: `call-${toolName}`, input: { path } },
					runtimeDir,
				),
			).resolves.toEqual({ block: true, reason: "已阻止访问认证文件。" });
		}

		await expect(
			invoke(
				handlers,
				"tool_call",
				{
					type: "tool_call",
					toolName: "read",
					toolCallId: "call-session",
					input: { path: join(agentDir, "sessions", "session.jsonl") },
				},
				runtimeDir,
			),
		).resolves.toBeUndefined();
	});

	it("按 Windows 分隔符和大小写比较认证文件路径", async () => {
		const windowsHandlers = captureHandlers("C:\\Users\\Tester\\.agentcore");
		await expect(
			invoke(
				windowsHandlers,
				"tool_call",
				{
					type: "tool_call",
					toolName: "read",
					toolCallId: "call-windows",
					input: { path: "c:/USERS/tester/.AGENTCORE/AUTH.JSON" },
				},
				"C:\\Users\\Tester",
			),
		).resolves.toEqual({ block: true, reason: "已阻止访问认证文件。" });
	});

	it("阻止 bash 和 powershell 对当前 auth.json 的明显引用", async () => {
		for (const [toolName, command] of [
			["bash", `sed -n '1p' "${authPath.replace("/.agentcore/", "//.agentcore//")}"`],
			["bash", 'cat "$AGENTCORE_AGENT_DIR/auth.json"'],
			["powershell", 'Get-Content "$env:AGENTCORE_AGENT_DIR\\auth.json"'],
			["powershell", "Get-Content '$" + "{env:AGENTCORE_AGENT_DIR}/auth.json'"],
		] as const) {
			await expect(
				invoke(
					handlers,
					"tool_call",
					{ type: "tool_call", toolName, toolCallId: `call-${toolName}`, input: { command } },
					runtimeDir,
				),
			).resolves.toEqual({ block: true, reason: "已阻止命令访问认证文件。" });
		}

		await expect(
			invoke(
				handlers,
				"tool_call",
				{ type: "tool_call", toolName: "bash", toolCallId: "call-safe", input: { command: "rg --files .agentcore/sessions" } },
				runtimeDir,
			),
		).resolves.toBeUndefined();
	});

	it("阻止 include/exclude context 的 user_bash，但不处理普通用户命令", async () => {
		for (const excludeFromContext of [false, true]) {
			const blocked = await invoke(
				handlers,
				"user_bash",
				{
					type: "user_bash",
					command: 'cat "$AGENTCORE_AGENT_DIR/auth.json"',
					excludeFromContext,
					cwd: runtimeDir,
				},
				runtimeDir,
			);
			expect(blocked).toEqual({
				result: {
					output: "已阻止命令访问认证文件。",
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			});
			expect(JSON.stringify(blocked)).not.toContain(TEST_CREDENTIAL);

			await expect(
				invoke(
					handlers,
					"user_bash",
					{ type: "user_bash", command: "pwd", excludeFromContext, cwd: runtimeDir },
					runtimeDir,
				),
			).resolves.toBeUndefined();
		}
	});

	it("在工具文本结果进入上下文前精确隐藏已知凭据", async () => {
		const result = (await invoke(
			handlers,
			"tool_result",
			{
				type: "tool_result",
				toolName: "read",
				toolCallId: "call-result",
				input: {},
				content: [
					{ type: "text", text: `前缀 ${TEST_CREDENTIAL} 后缀 ${TEST_CREDENTIAL}` },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
				isError: false,
			},
			runtimeDir,
		)) as { content: Array<Record<string, unknown>> };

		expect(result.content).toEqual([
			{ type: "text", text: `前缀 ${CREDENTIAL_REDACTION} 后缀 ${CREDENTIAL_REDACTION}` },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		]);
	});

	it("递归隐藏普通 Provider payload 中的已知凭据并保留无关结构", async () => {
		const payload = {
			messages: [{ role: "user", content: `值=${TEST_CREDENTIAL}` }],
			metadata: { nested: [1, true, null, { safe: "普通文本", secret: TEST_CREDENTIAL }] },
		};
		const result = await invoke(
			handlers,
			"before_provider_request",
			{ type: "before_provider_request", payload },
			runtimeDir,
		);

		expect(result).toEqual({
			messages: [{ role: "user", content: `值=${CREDENTIAL_REDACTION}` }],
			metadata: { nested: [1, true, null, { safe: "普通文本", secret: CREDENTIAL_REDACTION }] },
		});
		expect(payload.messages[0].content).toContain(TEST_CREDENTIAL);
		expect(payload.metadata.nested.slice(0, 3)).toEqual([1, true, null]);
	});

	it("按 API-key schema 解析 env 和混合模板，不收集普通 Provider env", async () => {
		for (const credential of [
			{
				type: "api_key",
				key: "$TEST_CREDENTIAL_VALUE",
				env: {
					TEST_CREDENTIAL_VALUE: TEST_CREDENTIAL,
					ACCOUNT_ID: "ordinary-provider-account",
					GATEWAY_ID: "ordinary-provider-gateway",
				},
			},
			{
				type: "api_key",
				key: "$" + "{TEST_CREDENTIAL_VALUE}",
				env: { TEST_CREDENTIAL_VALUE: TEST_CREDENTIAL },
			},
			{
				type: "api_key",
				key: "$" + "{TEST_CREDENTIAL_PREFIX}$" + "{TEST_CREDENTIAL_SUFFIX}",
				env: { TEST_CREDENTIAL_PREFIX: "test-secret-", TEST_CREDENTIAL_SUFFIX: "placeholder" },
			},
		] as const) {
			writeFileSync(authPath, JSON.stringify({ test: credential }));
			const templateHandlers = captureHandlers(agentDir);
			const result = await invoke(
				templateHandlers,
				"before_provider_request",
				{
					type: "before_provider_request",
					payload: {
						secret: TEST_CREDENTIAL,
						account: "ordinary-provider-account",
						gateway: "ordinary-provider-gateway",
					},
				},
				runtimeDir,
			);
			expect(result).toEqual({
				secret: CREDENTIAL_REDACTION,
				account: "ordinary-provider-account",
				gateway: "ordinary-provider-gateway",
			});
		}
	});

	it.skipIf(process.platform === "win32")("只在实际结果/请求钩子中惰性解析 command API key（依赖 Bash 配置）", async () => {
		const executionMarker = join(tempDir, "command-resolved.txt");
		const resolverScript = join(tempDir, "resolve-command-credential.mjs");
		writeFileSync(
			resolverScript,
			`import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], "resolved");\nprocess.stdout.write(process.argv[3]);\n`,
		);
		const nodeInvocation = `${JSON.stringify(process.execPath)} ${JSON.stringify(resolverScript)} ${JSON.stringify(executionMarker)} ${JSON.stringify(TEST_CREDENTIAL)}`;
		const command = process.platform === "win32" ? `& ${nodeInvocation}` : nodeInvocation;
		writeFileSync(
			authPath,
			JSON.stringify({
				test: {
					type: "api_key",
					key: `!${command}`,
				},
			}),
		);

		const commandHandlers = captureHandlers(agentDir);
		expect(existsSync(executionMarker)).toBe(false);
		const result = await invoke(
			commandHandlers,
			"before_provider_request",
			{ type: "before_provider_request", payload: { secret: TEST_CREDENTIAL } },
			runtimeDir,
		);
		expect(existsSync(executionMarker)).toBe(true);
		expect(result).toEqual({ secret: CREDENTIAL_REDACTION });
	});

	it.each([
		["分离参数", ["--api-key", TEST_CREDENTIAL]],
		["等号参数", [`--api-key=${TEST_CREDENTIAL}`]],
	] as const)("收集 CLI --api-key 的%s形式", async (_name, argv) => {
		writeFileSync(authPath, "{}");
		const cliHandlers = captureHandlers(agentDir, { argv, env: {} });
		const result = await invoke(
			cliHandlers,
			"before_provider_request",
			{ type: "before_provider_request", payload: { secret: TEST_CREDENTIAL } },
			runtimeDir,
		);
		expect(result).toEqual({ secret: CREDENTIAL_REDACTION });
	});

	it("收集名称明显的 ambient secret，但忽略普通环境配置", async () => {
		writeFileSync(authPath, "{}");
		const ambientHandlers = captureHandlers(agentDir, {
			argv: [],
			env: {
				TEST_API_KEY: TEST_CREDENTIAL,
				PATH: "ordinary-provider-path",
				ACCOUNT_ID: "ordinary-provider-account",
				GATEWAY_ID: "ordinary-provider-gateway",
			},
		});
		const result = await invoke(
			ambientHandlers,
			"before_provider_request",
			{
				type: "before_provider_request",
				payload: {
					secret: TEST_CREDENTIAL,
					path: "ordinary-provider-path",
					account: "ordinary-provider-account",
					gateway: "ordinary-provider-gateway",
				},
			},
			runtimeDir,
		);
		expect(result).toEqual({
			secret: CREDENTIAL_REDACTION,
			path: "ordinary-provider-path",
			account: "ordinary-provider-account",
			gateway: "ordinary-provider-gateway",
		});
	});

	it("OAuth 只收集 canonical access/refresh，不收集扩展字段", async () => {
		writeFileSync(
			authPath,
			JSON.stringify({
				test: {
					type: "oauth",
					access: TEST_CREDENTIAL,
					refresh: TEST_CREDENTIAL,
					expires: 0,
					account: "ordinary-oauth-account",
				},
			}),
		);
		const oauthHandlers = captureHandlers(agentDir);
		const result = await invoke(
			oauthHandlers,
			"before_provider_request",
			{
				type: "before_provider_request",
				payload: { access: TEST_CREDENTIAL, refresh: TEST_CREDENTIAL, account: "ordinary-oauth-account" },
			},
			runtimeDir,
		);
		expect(result).toEqual({
			access: CREDENTIAL_REDACTION,
			refresh: CREDENTIAL_REDACTION,
			account: "ordinary-oauth-account",
		});
	});

	it("忽略过短配置值，避免大面积误替换", async () => {
		writeFileSync(authPath, JSON.stringify({ test: { type: "api_key", key: "short" } }));
		const shortValueHandlers = captureHandlers(agentDir);
		await expect(
			invoke(
				shortValueHandlers,
				"before_provider_request",
				{ type: "before_provider_request", payload: { text: "short value remains" } },
				runtimeDir,
			),
		).resolves.toBeUndefined();
	});

	it("普通 grep . 不被阻断，结果中的凭据在进入上下文前被隐藏", async () => {
		writeFileSync(join(runtimeDir, "normal.txt"), "ordinary-grep-result");
		const extensionRuntime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			(pi) => registerCredentialGuard(pi, agentDir, { argv: [], env: {} }),
			runtimeDir,
			createEventBus(),
			extensionRuntime,
		);
		const runner = new ExtensionRunner(
			[extension],
			extensionRuntime,
			runtimeDir,
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);

		await expect(
			runner.emitToolCall({
				type: "tool_call",
				toolName: "grep",
				toolCallId: "call-grep",
				input: { pattern: `${TEST_CREDENTIAL}|ordinary-grep-result`, path: "." },
			}),
		).resolves.toBeUndefined();

		const guarded = await runner.emitToolResult({
				type: "tool_result",
				toolName: "grep",
				toolCallId: "call-grep",
				input: { pattern: `${TEST_CREDENTIAL}|ordinary-grep-result`, path: "." },
				content: [
					{
						type: "text",
						text: `.agentcore/auth.json:1: ${TEST_CREDENTIAL}\nnormal.txt:1: ordinary-grep-result`,
					},
				],
				details: undefined,
				isError: false,
			});
		const guardedText = (guarded?.content ?? []).map((item) => (item.type === "text" ? item.text : "")).join("\n");
		expect(guardedText).not.toContain(TEST_CREDENTIAL);
		expect(guardedText).toContain(CREDENTIAL_REDACTION);
		expect(guardedText).toContain("ordinary-grep-result");
	});

	it("凭据文件缺失或无效时安全降级", async () => {
		writeFileSync(authPath, "{");
		const invalidHandlers = captureHandlers(agentDir);
		await expect(
			invoke(
				invalidHandlers,
				"before_provider_request",
				{ type: "before_provider_request", payload: { text: "普通文本" } },
				runtimeDir,
			),
		).resolves.toBeUndefined();
	});

	it("两个根启动脚本显式加载防护并保留发现禁用参数", () => {
		const shellEntry = readFileSync(join(PROJECT_DIR, "start.sh"), "utf8");
		const powershellEntry = readFileSync(join(PROJECT_DIR, "start.ps1"), "utf8");

		expect(shellEntry).toContain("packages/agentcore-cli/src/extensions/pfsaa-credential-guard.ts");
		expect(shellEntry).toContain('FORWARDED_ARGS+=(--extension "$CREDENTIAL_GUARD")');
		expect(shellEntry).toContain("--no-extensions");
		expect(shellEntry).toContain("--no-skills");
		expect(powershellEntry).toContain("packages/agentcore-cli/src/extensions/pfsaa-credential-guard.ts");
		const productArgs = '$forwardedArgs += @("--extension", $credentialGuard, "--skill", $productSkill)';
		expect(powershellEntry).toContain(productArgs);
		expect(powershellEntry).toContain('$forwardedArgs += $argument');
		expect(powershellEntry).toContain('$argument -eq "--"');
		expect(powershellEntry.indexOf(productArgs)).toBeLessThan(powershellEntry.indexOf('$forwardedArgs += $argument'));
		for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]) {
			expect(shellEntry).toContain(flag);
			expect(powershellEntry).toContain(`"${flag}"`);
		}
	});
});
