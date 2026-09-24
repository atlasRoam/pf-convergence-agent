import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../ai/src/compat.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent-core/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: ["test/harness/**/*.test.ts"],
		coverage: {
			provider: "v8",
			all: true,
			include: ["src/harness/**/*.ts", "src/agent.ts", "src/agent-loop.ts"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text", "html", "lcov"],
			reportsDirectory: "coverage/harness",
		},
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@pfsaa\/telemetry$/, replacement: telemetrySrcIndex },
			{ find: /^@pfsaa\/agent-core$/, replacement: agentSrcIndex },
			{ find: /^@pfsaa\/ai$/, replacement: aiSrcIndex },
			{ find: /^@pfsaa\/ai\/compat$/, replacement: aiSrcCompat },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
