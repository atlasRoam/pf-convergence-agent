import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Exact matches for bare specifiers and the imported `@pfsaa/ai/utils/uuid` subpath.
 * A prefix alias would rewrite subpaths onto `index.ts/utils/uuid`.
 */
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@pfsaa\/agent-core$/, replacement: src("../agent-core/src/index.ts") },
			{ find: /^@pfsaa\/ai$/, replacement: src("../ai/src/index.ts") },
			{ find: /^@pfsaa\/ai\/utils\/uuid$/, replacement: src("../ai/src/utils/uuid.ts") },
			{ find: /^@pfsaa\/telemetry$/, replacement: src("../telemetry/src/index.ts") },
			{ find: /^@pfsaa\/protocol$/, replacement: src("../protocol/src/index.ts") },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
