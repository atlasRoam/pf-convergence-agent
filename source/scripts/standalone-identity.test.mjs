import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../..", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("root launchers isolate runtime sessions and load only the product resources", () => {
	for (const launcher of ["start.sh", "start.ps1"]) {
		const source = read(launcher);
		assert.match(source, /AGENTCORE_RUNTIME_CWD/);
		assert.match(source, /\.agentcore/);
		assert.match(source, /pfsaa-credential-guard/);
		for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]) {
			assert.ok(source.includes(flag), `${launcher} must pass ${flag}`);
		}
		assert.doesNotMatch(source, /PI_CODING_AGENT_DIR|runtime\/\.agent\//);
	}
	const shell = read("start.sh");
	assert.match(shell, /SOURCE_DIR="\$PROJECT_DIR\/source"/);
	assert.match(shell, /PRODUCT_SKILL="\$SOURCE_DIR\/\.agentcore\/skills\/compute-engine\/SKILL\.md"/);
	assert.match(shell, /MANUAL_ADJUSTMENT_SKILL="\$SOURCE_DIR\/\.agentcore\/skills\/powerflow-manual-adjustment\/SKILL\.md"/);
	assert.match(shell, /CREDENTIAL_GUARD="\$SOURCE_DIR\/packages\/agentcore-cli\/src\/extensions\/pfsaa-credential-guard\.ts"/);
	assert.match(shell, /\[\[ ! -f "\$PRODUCT_SKILL" \]\]/);
	assert.match(shell, /\[\[ ! -f "\$MANUAL_ADJUSTMENT_SKILL" \]\]/);
	assert.match(shell, /MANDATORY_ARGS=\(--extension "\$CREDENTIAL_GUARD" --skill "\$PRODUCT_SKILL" --skill "\$MANUAL_ADJUSTMENT_SKILL"\)/);
	assert.match(shell, /FORWARDED_ARGS\+=\("\$\{MANDATORY_ARGS\[@\]\}"\)/);
	const powershell = read("start.ps1");
	assert.match(powershell, /\$sourceDir = Join-Path \$projectDir "source"/);
	assert.match(powershell, /\$productSkill = Join-Path \$sourceDir "\.agentcore\/skills\/compute-engine\/SKILL\.md"/);
	assert.match(powershell, /\$manualAdjustmentSkill = Join-Path \$sourceDir "\.agentcore\/skills\/powerflow-manual-adjustment\/SKILL\.md"/);
	assert.match(powershell, /\$credentialGuard = Join-Path \$sourceDir "packages\/agentcore-cli\/src\/extensions\/pfsaa-credential-guard\.ts"/);
	assert.match(powershell, /Test-Path -LiteralPath \$productSkill -PathType Leaf/);
	assert.match(powershell, /Test-Path -LiteralPath \$manualAdjustmentSkill -PathType Leaf/);
	assert.match(powershell, /\$mandatoryArgs = @\("--extension", \$credentialGuard, "--skill", \$productSkill, "--skill", \$manualAdjustmentSkill\)/);
	assert.match(powershell, /\$forwardedArgs \+= \$mandatoryArgs/);
});

test("first-party packages have the 1.0.0 identity and no legacy binary alias", () => {
	const cli = JSON.parse(read("source/packages/agentcore-cli/package.json"));
	const core = JSON.parse(read("source/packages/agent-core/package.json"));
	assert.equal(cli.name, "@pfsaa/agentcore-cli");
	assert.equal(core.name, "@pfsaa/agent-core");
	assert.equal(cli.version, "1.0.0");
	assert.equal(core.version, "1.0.0");
	assert.deepEqual(Object.keys(cli.bin), ["agentcore"]);
});

test("tools manager imports streams through explicit Node builtins", () => {
	const source = read("source/packages/agentcore-cli/src/utils/tools-manager.ts");
	assert.match(source, /^import \{ Readable \} from "node:stream";$/m);
	assert.match(source, /^import \{ pipeline \} from "node:stream\/promises";$/m);
	assert.doesNotMatch(source, /from ["']stream(?:\/promises)?["']/);
});

test("model runtime and SDK do not import upstream catalog or attribution", () => {
	assert.doesNotMatch(read("source/packages/agentcore-cli/src/core/model-runtime.ts"), /withRemoteCatalog|pi\.dev/);
	assert.doesNotMatch(read("source/packages/agentcore-cli/src/core/sdk.ts"), /mergeProviderAttributionHeaders/);
	assert.doesNotMatch(read("source/packages/agentcore-cli/src/cli/args.ts"), /update \[source\|self\|pi\]/);
});

test("CLI bundle lazy OAuth entries resolve to implemented sources", () => {
	const bundle = read("source/scripts/build-agentcore-cli-bundle.mjs");
	const lazyEntries = bundle.split("const lazyResult = await build({", 2)[1]?.split("outdir:", 1)[0];
	assert.ok(lazyEntries, "lazy bundle entryPoints must exist");
	const names = [...lazyEntries.matchAll(/join\(aiDistDir, "auth", "oauth", "([^"]+\.js)"\)/g)].map((match) => match[1]);
	assert.ok(names.length > 0, "lazy OAuth entries must be checked");
	for (const name of names) {
		assert.doesNotThrow(() => read(`source/packages/ai/src/auth/oauth/${name.replace(/\.js$/, ".ts")}`));
	}
	assert.doesNotMatch(lazyEntries, /radius\.js|\bradius:/);
});
