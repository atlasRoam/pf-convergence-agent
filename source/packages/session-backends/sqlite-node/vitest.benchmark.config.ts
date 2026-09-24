import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetryIndex = fileURLToPath(new URL("../../telemetry/src/index.ts", import.meta.url));
const aiIndex = fileURLToPath(new URL("../../ai/src/index.ts", import.meta.url));
const agentIndex = fileURLToPath(new URL("../../agent-core/src/index.ts", import.meta.url));
const agentSessionTesting = fileURLToPath(
	new URL("../../agent-core/src/harness/session/testing/index.ts", import.meta.url),
);

export default defineConfig({
	test: {
		environment: "node",
		benchmark: {
			include: ["benchmark/session/**/*.bench.ts"],
			reporters: ["verbose"],
		},
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@pfsaa\/telemetry$/, replacement: telemetryIndex },
			{ find: /^@pfsaa\/agent-core\/harness\/session\/testing$/, replacement: agentSessionTesting },
			{ find: /^@pfsaa\/agent-core$/, replacement: agentIndex },
			{ find: /^@pfsaa\/ai$/, replacement: aiIndex },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
