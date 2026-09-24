import { describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

describe("provider authentication prompts", () => {
	it("uses a Chinese prompt for manual OAuth codes", async () => {
		const modelConfig = await ModelConfig.load(undefined);
		const extensionLogin = vi.fn(async (callbacks: { onManualCodeInput(): Promise<string> }) => {
			await callbacks.onManualCodeInput();
			return { access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 60_000 };
		});
		const provider = composeModelProvider("fake-oauth", undefined, modelConfig, {
			oauth: {
				name: "Fake OAuth",
				login: extensionLogin,
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
			},
		});
		const prompt = vi.fn(async () => "fake-code");

		await provider.auth.oauth?.login({ notify: vi.fn(), prompt, signal: new AbortController().signal });

		expect(prompt).toHaveBeenCalledWith({ type: "manual_code", message: "粘贴授权码" });
	});

	it("uses a Chinese prompt for default API key login", async () => {
		const modelConfig = await ModelConfig.load(undefined);
		const provider = composeModelProvider("fake-api-key", undefined, modelConfig, { apiKey: "fake-key" });
		const prompt = vi.fn(async () => "entered-fake-key");

		const credential = await provider.auth.apiKey?.login({
			notify: vi.fn(),
			prompt,
			signal: new AbortController().signal,
		});

		expect(prompt).toHaveBeenCalledWith({ type: "secret", message: "输入 API 密钥" });
		expect(credential).toEqual({ type: "api_key", key: "entered-fake-key" });
	});
});
