import { setKeybindings } from "@pfsaa/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatOAuthAuthenticationFailure } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("OAuthSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("projects provider-owned auth options without provider-specific filtering", () => {
		const getLoginProviderOptions = (
			InteractiveMode as unknown as {
				prototype: {
					getLoginProviderOptions(
						this: object,
						authType?: "oauth" | "api_key",
					): Array<{ id: string; name: string; authType: string; method?: { name: string; login?: unknown } }>;
				};
			}
		).prototype.getLoginProviderOptions;
		const providers = [
			{
				id: "anthropic",
				name: "Anthropic",
				auth: {
					oauth: { name: "Anthropic (Claude Pro/Max)", login: async () => ({}) },
					apiKey: { name: "Anthropic API key", login: async () => ({}) },
				},
			},
			{
				id: "google-vertex",
				name: "Google Vertex AI",
				auth: { apiKey: { name: "Google Cloud credentials" } },
			},
		];
		const fakeThis = {
			session: {
				modelRuntime: {
					getProviders: () => providers,
					getProviderAuthStatus: () => ({ configured: false }),
					isUsingOAuth: () => false,
				},
			},
		};

		const apiKeyOptions = getLoginProviderOptions.call(fakeThis, "api_key");
		expect(apiKeyOptions).toMatchObject([
			{
				id: "anthropic",
				name: "Anthropic",
				authType: "api_key",
				method: { name: "Anthropic API key" },
			},
			{
				id: "google-vertex",
				name: "Google Vertex AI",
				authType: "api_key",
				method: { name: "Google Cloud credentials" },
			},
		]);
		expect(getLoginProviderOptions.call(fakeThis, "oauth")).toMatchObject([
			{ id: "anthropic", name: "Anthropic", authType: "oauth" },
		]);
	});

	it("renders an option without compiled auth status as unconfigured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: "google", name: "Google", authType: "api_key", status: undefined }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("未配置");
		expect(output).not.toContain("✓ 已配置");
	});

	it("shows OAuth auth distinctly in the API key selector", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: "anthropic", name: "Anthropic", authType: "api_key", status: { type: "oauth", source: "OAuth" } }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("已配置订阅");
	});

	it("shows environment API key auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: "openai", name: "OpenAI", authType: "api_key", status: { type: "api_key", source: "OPENAI_API_KEY" } }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("✓ 环境变量：OPENAI_API_KEY");
		expect(output).not.toContain("未配置");
	});

	it("shows models.json API key auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[
				{
					id: "local-proxy",
					name: "local-proxy",
					authType: "api_key",
					status: { type: "api_key", source: "key in models.json" },
				},
			],
			() => {},
			() => {},
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("✓ key in models.json");
	});

	it("shows models.json command auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[
				{
					id: "op-proxy",
					name: "op-proxy",
					authType: "api_key",
					status: { type: "api_key", source: "command in models.json" },
				},
			],
			() => {},
			() => {},
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("✓ command in models.json");
	});
});

describe("InteractiveMode OAuth 取消处理", () => {
	const handleProviderLoginError = (
		InteractiveMode as unknown as {
			prototype: {
				handleProviderLoginError(
					this: { showError: (message: string) => void },
					providerName: string,
					authType: "oauth" | "api_key",
					error: unknown,
				): void;
			};
		}
	).prototype.handleProviderLoginError;

	it("将底层英文取消哨兵视为正常控制流", () => {
		const showError = vi.fn();

		handleProviderLoginError.call({ showError }, "Test Provider", "oauth", new Error("Login cancelled"));

		expect(showError).not.toHaveBeenCalled();
	});

	it("为真实 OAuth 错误显示中文失败提示", () => {
		const showError = vi.fn();

		handleProviderLoginError.call({ showError }, "Test Provider", "oauth", new Error("provider failed"));

		expect(showError).toHaveBeenCalledWith("登录 Test Provider 失败：provider failed");
	});
});

describe("AgentSession OAuth 认证错误", () => {
	it("保留 Provider id 和 /login 命令并翻译本地包装", () => {
		expect(formatOAuthAuthenticationFailure("test-provider")).toBe(
			'"test-provider" 认证失败。凭据可能已过期或网络不可用。运行 \'/login test-provider\' 重新认证。',
		);
	});
});
