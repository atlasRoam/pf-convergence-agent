import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.AGENTCORE_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.AGENTCORE_EXPERIMENTAL;
		} else {
			process.env.AGENTCORE_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when AGENTCORE_EXPERIMENTAL is unset", () => {
		delete process.env.AGENTCORE_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when AGENTCORE_EXPERIMENTAL is empty", () => {
		process.env.AGENTCORE_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when AGENTCORE_EXPERIMENTAL is set to 1", () => {
		process.env.AGENTCORE_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when AGENTCORE_EXPERIMENTAL is set to 0", () => {
		process.env.AGENTCORE_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when AGENTCORE_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.AGENTCORE_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
