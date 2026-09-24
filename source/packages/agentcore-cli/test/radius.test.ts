import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@pfsaa/ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

describe("removed Radius provider", () => {
	it("does not advertise Radius even when stale credentials are present", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({
				radius: { type: "api_key", key: "unused-test-key" },
			}),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});

		expect(runtime.getProviders().map((provider) => provider.id)).not.toContain("radius");
		expect(runtime.getProvider("radius")).toBeUndefined();
		expect(runtime.getModels("radius")).toEqual([]);
	});

	it.each([
		{ radius: { baseUrl: "https://example.test/v1", api: "pi-messages", apiKey: "$TEST_KEY" } },
		{ "radius-dev": { baseUrl: "https://example.test/v1", oauth: "radius" } },
	])("rejects the retired Radius models.json contract: %j", async (providers) => {
		const directory = mkdtempSync(join(tmpdir(), "agentcore-radius-config-"));
		try {
			const modelsPath = join(directory, "models.json");
			writeFileSync(modelsPath, JSON.stringify({ providers }));
			const runtime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsStore: new InMemoryModelsStore(),
				modelsPath,
				refreshOnCreate: false,
			});
			expect(runtime.getError()).toContain("Unsupported Radius provider configuration");
			expect(runtime.getProvider("radius")).toBeUndefined();
			expect(runtime.getProvider("radius-dev")).toBeUndefined();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
