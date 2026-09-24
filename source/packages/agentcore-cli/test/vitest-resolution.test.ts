import { existsSync } from "node:fs";
import { describe, expect, test } from "vitest";
import config from "../vitest.config.ts";

const aliases = config.resolve?.alias as Array<{ find: RegExp; replacement: string }>;

describe("workspace Vitest aliases", () => {
	test("resolves first-party entry points and subpaths to existing sources", () => {
		for (const specifier of [
			"@pfsaa/chord/context",
			"@pfsaa/chord/delta",
			"@pfsaa/chord/node",
			"@pfsaa/ai/compat",
			"@pfsaa/ai/oauth",
			"@pfsaa/ai/providers/all",
			"@pfsaa/agent-core",
			"@pfsaa/agent-core/node",
			"@pfsaa/agent-core/harness/session/testing",
			"@pfsaa/agentcore-cli",
			"@pfsaa/server/unix",
		]) {
			const alias = aliases.find(({ find }) => find.test(specifier));
			expect(alias, specifier).toBeDefined();
			expect(existsSync(specifier.replace(alias!.find, alias!.replacement)), specifier).toBe(true);
		}
	});

	test("leaves Node builtins and external packages to normal resolution", () => {
		for (const specifier of ["stream", "node:stream", "vitest/config", "@silvia-odwyer/photon-node"]) {
			expect(aliases.some(({ find }) => find.test(specifier)), specifier).toBe(false);
		}
		expect(config.test?.env?.AGENTCORE_OFFLINE).toBe("1");
		expect(config.test?.unstubEnvs).toBe(true);
	});
});
