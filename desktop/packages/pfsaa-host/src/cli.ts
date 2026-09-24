#!/usr/bin/env node
import { loadAgentCoreSdk } from "@pfsaa/agentcore-adapter";

async function run(): Promise<void> {
  const sdk = await loadAgentCoreSdk();
  if (!sdk.main) throw new Error("The installed runtime does not expose its command-line entry point");
  // Keep this entry point deliberately transparent. AgentCore owns argument parsing,
  // stdout/stderr, stdin JSONL, auth printing, sessions, and exit semantics.
  await sdk.main(process.argv.slice(2));
}

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
