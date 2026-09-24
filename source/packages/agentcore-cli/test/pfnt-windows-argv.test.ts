import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = resolve(TEST_DIR, "../../..");
const PROJECT_DIR = resolve(SOURCE_DIR, "..");
const PWSH_AVAILABLE = (() => {
	const probe = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-Command", "exit 0"], { stdio: "ignore" });
	return probe.error === undefined && probe.status === 0;
})();

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

function count(values: string[], expected: string): number {
	return values.filter((value) => value === expected).length;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("PFNT Windows launcher argv boundary", () => {
	it("uses Node with the real tsx module and places mandatory resources before user argv", () => {
		const launcher = readFileSync(join(PROJECT_DIR, "start.ps1"), "utf8");
		expect(launcher).toContain("node_modules/tsx/dist/cli.mjs");
		expect(launcher).not.toContain("node_modules/.bin/tsx.cmd");
		expect(launcher).not.toMatch(/cmd\.exe/i);
		expect(launcher).not.toContain('"--import"');
		expect(launcher).toContain('$launchArgs = @($tsxCli, "--tsconfig", $tsconfig, $cliEntry)');
		expect(launcher).toContain("& $nodeBin @launchArgs");
		expect(launcher).toContain("Set-Location -LiteralPath $runtimeDir");
		expect(launcher).toContain("$exitCode = $LASTEXITCODE");
		expect(launcher).toContain("exit $exitCode");
		expect(launcher).toContain('$script:PSNativeCommandArgumentPassing = "Standard"');
		expect(launcher).toContain("$script:PSNativeCommandUseErrorActionPreference = $false");
		expect(launcher).toContain('$mandatoryArgs = @("--extension", $credentialGuard, "--skill", $productSkill, "--skill", $manualAdjustmentSkill)');
		expect(launcher.match(/\$forwardedArgs \+= \$mandatoryArgs/g)).toHaveLength(2);
		for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]) {
			expect(launcher.split(flag)).toHaveLength(2);
		}
		expect(launcher).toContain("foreach ($argument in $args)");
		expect(launcher).toContain('$argument -eq "--"');
		expect(launcher).toContain("$forwardedArgs += $argument");
	});

	it.skipIf(!PWSH_AVAILABLE)(
		"preserves multiline and special-character user arguments through an actual PowerShell launch",
		() => {
			const projectDir = temporaryDirectory("pfnt pwsh argv-");
			const sourceDir = join(projectDir, "source");
			const runtimeDir = join(projectDir, "runtime");
			const tsxCli = join(sourceDir, "node_modules/tsx/dist/cli.mjs");
			const cliEntry = join(sourceDir, "packages/agentcore-cli/src/cli.ts");
			const credentialGuard = join(sourceDir, "packages/agentcore-cli/src/extensions/pfsaa-credential-guard.ts");
			const productSkill = join(sourceDir, ".agentcore/skills/compute-engine/SKILL.md");
			const manualAdjustmentSkill = join(sourceDir, ".agentcore/skills/powerflow-manual-adjustment/SKILL.md");
			const tsconfig = join(sourceDir, "tsconfig.json");
			const capturePath = join(projectDir, "argv-capture.json");
			const launcher = join(projectDir, "start.ps1");
			const inheritedLegacyLauncher = join(projectDir, "invoke-with-legacy-settings.ps1");
			for (const path of [tsxCli, cliEntry, credentialGuard, productSkill, manualAdjustmentSkill, tsconfig]) {
				mkdirSync(dirname(path), { recursive: true });
			}
			writeFileSync(launcher, readFileSync(join(PROJECT_DIR, "start.ps1"), "utf8"));
			writeFileSync(
				inheritedLegacyLauncher,
				`$PSNativeCommandArgumentPassing = "Legacy"
$PSNativeCommandUseErrorActionPreference = $true
& (Join-Path $PSScriptRoot "start.ps1") @args
exit $LASTEXITCODE
`,
			);
			writeFileSync(
				tsxCli,
				`import { writeFileSync } from "node:fs";
const capture = process.env.PFNT_TEST_ARGV_CAPTURE;
if (!capture) throw new Error("missing capture path");
writeFileSync(capture, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
process.exitCode = Number(process.env.PFNT_TEST_EXIT_CODE ?? "0");
`,
			);
			for (const path of [cliEntry, credentialGuard]) writeFileSync(path, "");
			writeFileSync(productSkill, "# Compute Engine\n");
			writeFileSync(manualAdjustmentSkill, "# Powerflow Manual Adjustment\n");
			writeFileSync(tsconfig, "{}\n");

			const message = "第一行\r\n第二行\n第三行 \"double quotes\" 'single quotes' spaces  & | > < $() ; ` ^ %";
			const userExtension = join(projectDir, "user extension.ts");
			const userSkill = join(projectDir, "user skill.md");
			const userArgs = ["--extension", userExtension, "--skill", userSkill, "--", message, ""];
			const launched = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-File", inheritedLegacyLauncher, ...userArgs], {
				cwd: projectDir,
				env: {
					...process.env,
					PFNT_TEST_ARGV_CAPTURE: capturePath,
					PFNT_TEST_EXIT_CODE: "23",
				},
				encoding: "utf8",
				timeout: 30_000,
			});
			expect(launched.error).toBeUndefined();
			expect(launched.status, `${launched.stdout}\n${launched.stderr}`).toBe(23);
			expect(existsSync(capturePath)).toBe(true);
			const captured = JSON.parse(readFileSync(capturePath, "utf8")) as { argv: string[]; cwd: string };
			const expectedPrefix = [
				"--tsconfig",
				tsconfig,
				cliEntry,
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--extension",
				userExtension,
				"--skill",
				userSkill,
				"--extension",
				credentialGuard,
				"--skill",
				productSkill,
				"--skill",
				manualAdjustmentSkill,
			];
			expect(captured.argv).toEqual([...expectedPrefix, "--", message, ""]);
			expect(captured.argv.at(-2)).toBe(message);
			expect(captured.argv.at(-1)).toBe("");
			expect(count(captured.argv, credentialGuard)).toBe(1);
			expect(count(captured.argv, productSkill)).toBe(1);
			expect(count(captured.argv, manualAdjustmentSkill)).toBe(1);
			expect(resolve(captured.cwd)).toBe(resolve(runtimeDir));
		},
	);
});
