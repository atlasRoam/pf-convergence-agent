import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	chordIndex: fileURLToPath(new URL("./packages/chord/src/index.ts", import.meta.url)),
	chordContext: fileURLToPath(new URL("./packages/chord/src/context/index.ts", import.meta.url)),
	chordDelta: fileURLToPath(new URL("./packages/chord/src/delta/index.ts", import.meta.url)),
	chordBundler: fileURLToPath(new URL("./packages/chord/src/bundler.ts", import.meta.url)),
	chordNode: fileURLToPath(new URL("./packages/chord/src/node.ts", import.meta.url)),
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent-core/src/index.ts", import.meta.url)),
	agentNode: fileURLToPath(new URL("./packages/agent-core/src/node.ts", import.meta.url)),
	agentSessionTesting: fileURLToPath(new URL("./packages/agent-core/src/harness/session/testing/index.ts", import.meta.url)),
	protocolIndex: fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
	clientIndex: fileURLToPath(new URL("./packages/client/src/index.ts", import.meta.url)),
	clientUnix: fileURLToPath(new URL("./packages/client/src/unix.ts", import.meta.url)),
	serverIndex: fileURLToPath(new URL("./packages/server/src/index.ts", import.meta.url)),
	serverUnix: fileURLToPath(new URL("./packages/server/src/transports/unix/index.ts", import.meta.url)),
	agentcoreCliIndex: fileURLToPath(new URL("./packages/agentcore-cli/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@pfsaa\/chord$/, replacement: workspaceSourcePaths.chordIndex },
			{ find: /^@pfsaa\/chord\/context$/, replacement: workspaceSourcePaths.chordContext },
			{ find: /^@pfsaa\/chord\/delta$/, replacement: workspaceSourcePaths.chordDelta },
			{ find: /^@pfsaa\/chord\/bundler$/, replacement: workspaceSourcePaths.chordBundler },
			{ find: /^@pfsaa\/chord\/node$/, replacement: workspaceSourcePaths.chordNode },
			{ find: /^@pfsaa\/telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@pfsaa\/telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@pfsaa\/ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@pfsaa\/ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@pfsaa\/ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@pfsaa\/ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@pfsaa\/agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@pfsaa\/agent-core\/node$/, replacement: workspaceSourcePaths.agentNode },
			{ find: /^@pfsaa\/agent-core\/harness\/session\/testing$/, replacement: workspaceSourcePaths.agentSessionTesting },
			{ find: /^@pfsaa\/protocol$/, replacement: workspaceSourcePaths.protocolIndex },
			{ find: /^@pfsaa\/client$/, replacement: workspaceSourcePaths.clientIndex },
			{ find: /^@pfsaa\/client\/unix$/, replacement: workspaceSourcePaths.clientUnix },
			{ find: /^@pfsaa\/server$/, replacement: workspaceSourcePaths.serverIndex },
			{ find: /^@pfsaa\/server\/unix$/, replacement: workspaceSourcePaths.serverUnix },
			{ find: /^@pfsaa\/tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
