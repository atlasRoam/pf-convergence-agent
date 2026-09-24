import { expect } from "vitest";
import { describeEval } from "vitest-evals";
import { createAgentcoreHarness } from "./agentcore-harness.ts";

const agentcoreHarness = createAgentcoreHarness({ noTools: "all" });

describeEval("agentCore smoke", { harness: agentcoreHarness }, (it) => {
	it("runs a basic prompt end to end", async ({ run }) => {
		const result = await run("What's the capital of France? Respond with only the city name.");

		expect(result.output.trim()).toBe("Paris");
		expect(result.errors).toEqual([]);
		expect(result.usage.provider).toBe(process.env.AGENTCORE_PROVIDER);
		expect(result.usage.model).toBe(process.env.AGENTCORE_MODEL);
		expect(result.usage.totalTokens).toBeGreaterThan(0);
	});
});
