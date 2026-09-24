import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "@pfsaa/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getToolPath } from "../src/utils/tools-manager.ts";

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ROUTER_SKILL_DIR = join(PROJECT_DIR, "source/.agentcore/skills/compute-engine");
const MANUAL_ADJUSTMENT_SKILL_DIR = join(PROJECT_DIR, "source/.agentcore/skills/powerflow-manual-adjustment");
const PFNT_46_SKILL_DIR = join(PROJECT_DIR, "source/.agentcore/skills/pfnt-4.6");
const CREDENTIAL_GUARD = join(PROJECT_DIR, "source/packages/agentcore-cli/src/extensions/pfsaa-credential-guard.ts");
const NATIVE_SHELL = process.platform === "win32" ? "powershell" : "bash";
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("PFNT Stage-3 native-tool entry", () => {
	it("keeps credential protection, isolated discovery and the two explicit product Skills", () => {
		const shell = readFileSync(join(PROJECT_DIR, "start.sh"), "utf8");
		const powershell = readFileSync(join(PROJECT_DIR, "start.ps1"), "utf8");
		for (const source of [shell, powershell]) {
			expect(source).toContain("pfsaa-credential-guard.ts");
			for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]) {
				expect(source).toContain(flag);
			}
		}
		expect(shell).toContain('SOURCE_DIR="$PROJECT_DIR/source"');
		expect(shell).toContain('PRODUCT_SKILL="$SOURCE_DIR/.agentcore/skills/compute-engine/SKILL.md"');
		expect(shell).toContain('MANUAL_ADJUSTMENT_SKILL="$SOURCE_DIR/.agentcore/skills/powerflow-manual-adjustment/SKILL.md"');
		expect(shell).toContain('[[ ! -f "$PRODUCT_SKILL" ]]');
		expect(shell).toContain('[[ ! -f "$MANUAL_ADJUSTMENT_SKILL" ]]');
		expect(powershell).toContain('$sourceDir = Join-Path $projectDir "source"');
		expect(powershell).toContain('$productSkill = Join-Path $sourceDir ".agentcore/skills/compute-engine/SKILL.md"');
		expect(powershell).toContain('$manualAdjustmentSkill = Join-Path $sourceDir ".agentcore/skills/powerflow-manual-adjustment/SKILL.md"');
		expect(powershell).toContain('Test-Path -LiteralPath $productSkill -PathType Leaf');
		expect(powershell).toContain('Test-Path -LiteralPath $manualAdjustmentSkill -PathType Leaf');
		expect(shell).toContain('MANDATORY_ARGS=(--extension "$CREDENTIAL_GUARD" --skill "$PRODUCT_SKILL" --skill "$MANUAL_ADJUSTMENT_SKILL")');
		expect(shell).toContain('FORWARDED_ARGS+=("${MANDATORY_ARGS[@]}")');
		expect(shell).toContain('"$arg" == "--"');
		expect(shell).toContain('FORWARDED_ARGS+=("$arg")');
		expect(shell.indexOf('MANDATORY_ARGS=(--extension "$CREDENTIAL_GUARD" --skill "$PRODUCT_SKILL" --skill "$MANUAL_ADJUSTMENT_SKILL")')).toBeLessThan(
			shell.indexOf('FORWARDED_ARGS+=("$arg")'),
		);
		const productArgs = '$mandatoryArgs = @("--extension", $credentialGuard, "--skill", $productSkill, "--skill", $manualAdjustmentSkill)';
		expect(powershell).toContain(productArgs);
		expect(powershell).toContain('$forwardedArgs += $argument');
		expect(powershell).toContain('$argument -eq "--"');
		expect(powershell.indexOf(productArgs)).toBeLessThan(powershell.indexOf('$forwardedArgs += $argument'));
	});

	it("declares only current CLI commands while retaining native editing", () => {
		const manifest = JSON.parse(readFileSync(join(PFNT_46_SKILL_DIR, "manifest.json"), "utf8")) as {
			write_support: string;
			commands: string[];
			[key: string]: unknown;
		};
		const skill = readFileSync(join(PFNT_46_SKILL_DIR, "SKILL.md"), "utf8");
		expect(manifest.write_support).toBe("agent-native-tools-for-work-copies");
		expect(manifest.commands).toEqual([
			"capabilities",
			"doctor",
			"manual",
			"describe",
			"inspect",
			"query",
			"run",
			"parse-results",
		]);
		const obsoleteKeys = [
			["legacy", "action", "write_support"].join("_"),
			["action", "schema_version"].join("_"),
			["candidate", "root"].join("_"),
		];
		for (const key of obsoleteKeys) expect(manifest).not.toHaveProperty(key);
		const obsoleteCommands = ["capabilities", "preview", "apply", "restore", "rollback", "run"].map((name) =>
			["action", name].join("-"),
		);
		for (const command of obsoleteCommands) {
			expect(manifest.commands).not.toContain(command);
			expect(skill).not.toContain(command);
		}
		expect(skill).not.toContain(["action", "*"].join("-"));
		expect(skill).toContain("原生 `read`、`grep`、`edit`、`write`");
		expect(skill).toContain("GBK/GB18030");
		expect(skill).toContain("35–38");
		expect(skill).toContain("同一工作文件再次调用 `run`");
	});

	it("loads only explicit resources and executes native editing and shell on a work copy", async () => {
		const root = mkdtempSync(join(tmpdir(), "pfnt-native-tools-"));
		temporaryDirectories.push(root);
		const runtimeDir = join(root, "runtime");
		const agentDir = join(runtimeDir, ".agentcore");
		mkdirSync(agentDir, { recursive: true });
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: runtimeDir,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [CREDENTIAL_GUARD],
			additionalSkillPaths: [join(ROUTER_SKILL_DIR, "SKILL.md"), join(MANUAL_ADJUSTMENT_SKILL_DIR, "SKILL.md")],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		expect(resourceLoader.getExtensions().extensions).toHaveLength(1);
		expect(resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual([
			"compute-engine",
			"powerflow-manual-adjustment",
		]);
		const { session } = await createAgentSession({
			cwd: runtimeDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			tools: ["read", "grep", "edit", "write", NATIVE_SHELL],
			settingsManager,
			sessionManager: SessionManager.inMemory(runtimeDir),
			resourceLoader,
		});
		try {
			await session.bindExtensions({});
			const active = session.getActiveToolNames();
			expect(active).toEqual(expect.arrayContaining(["read", "grep", "edit", "write", NATIVE_SHELL]));
			const runTool = async (name: string, args: Record<string, unknown>) => {
				const hook = session.agent.beforeToolCall;
				if (!hook) throw new Error("AgentSession did not bind tool hooks");
				const allowed = await hook({
					assistantMessage: {} as never,
					toolCall: { type: "toolCall", id: `native-${name}`, name, arguments: args },
					args,
					context: {} as never,
				});
				expect(allowed).toBeUndefined();
				const tool = session.agent.state.tools.find((item) => item.name === name);
				if (!tool) throw new Error(`Missing tool: ${name}`);
				return tool.execute(`native-${name}`, args);
			};

			const original = join(runtimeDir, "original.DAT");
			const work = join(runtimeDir, "work.DAT");
			const source = Buffer.concat([Buffer.from("B "), Buffer.from([0xb2, 0xe2]), Buffer.from("    500.0\r\n")]);
			writeFileSync(original, source);
			copyFileSync(original, work);
			await runTool("write", { path: "notes.txt", content: "alpha\nbeta\n" });
			await runTool("edit", { path: "notes.txt", edits: [{ oldText: "beta", newText: "gamma" }] });
			const read = await runTool("read", { path: "notes.txt" });
			expect(read.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("gamma") });
			if (getToolPath("rg")) {
				const search = await runTool("grep", { path: "notes.txt", pattern: "gamma" });
				expect(search.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("gamma") });
			} else {
				expect(session.getToolDefinition("grep")).toBeDefined();
				const searchAllowed = await session.agent.beforeToolCall?.({
					assistantMessage: {} as never,
					toolCall: {
						type: "toolCall",
						id: "native-grep",
						name: "grep",
						arguments: { path: "notes.txt", pattern: "gamma" },
					},
					args: { path: "notes.txt", pattern: "gamma" },
					context: {} as never,
				});
				expect(searchAllowed).toBeUndefined();
			}

			const variablePipe =
				process.platform === "win32"
					? "$value = 'ready'; $value | ForEach-Object { $_.ToUpperInvariant() }"
					: "value=ready; printf '%s\\n' \"$value\" | tr a-z A-Z";
			const shell = await runTool(NATIVE_SHELL, { command: variablePipe });
			expect(shell.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("READY") });
			const searchCommand =
				process.platform === "win32"
					? "Select-String -Path 'notes.txt' -Pattern 'gamma' | ForEach-Object { $_.Line }"
					: 'grep gamma "notes.txt"';
			const searched = await runTool(NATIVE_SHELL, { command: searchCommand });
			expect(searched.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("gamma") });
			const runNodeEdit = (script: string, path: string) => {
				const quotedNode =
					process.platform === "win32"
						? `& '${process.execPath.replaceAll("'", "''")}'`
						: `'${process.execPath.replaceAll("'", "'\\''")}'`;
				const quotedPath =
					process.platform === "win32" ? `'${path.replaceAll("'", "''")}'` : `'${path.replaceAll("'", "'\\''")}'`;
				return runTool(NATIVE_SHELL, { command: `${quotedNode} -e "${script}" ${quotedPath}` });
			};
			// A synthetic GBK name precedes the edited ASCII field; the original and all other bytes stay intact.
			const change =
				"const fs=require('node:fs');const p=process.argv[1];const b=fs.readFileSync(p);const old=Buffer.from('500.0');const at=b.indexOf(old);if(at<0||b.indexOf(old,at+1)>=0)process.exit(2);Buffer.from('510.0').copy(b,at);fs.writeFileSync(p,b)";
			await runNodeEdit(change, work);
			expect(readFileSync(original)).toEqual(source);
			expect(readFileSync(work)).toEqual(Buffer.concat([source.subarray(0, 8), Buffer.from("510.0\r\n")]));

			const busSource = Buffer.concat([Buffer.alloc(82, 32), Buffer.from("\r\n")]);
			busSource[0] = 66;
			Buffer.from([0xb2, 0xe2]).copy(busSource, 6);
			Buffer.from(" 500").copy(busSource, 14);
			Buffer.from("   12").copy(busSource, 47); // B: QSCHED; BE: Qmax
			Buffer.from("   -5").copy(busSource, 52);
			Buffer.from("1050").copy(busSource, 57); // B: Vmax; BE: Vhold
			Buffer.from(" 950").copy(busSource, 61);
			const busOriginal = join(runtimeDir, "bus-original.DAT");
			const busWork = join(runtimeDir, "bus-work.DAT");
			writeFileSync(busOriginal, busSource);
			copyFileSync(busOriginal, busWork);
			const setBase =
				"const fs=require('node:fs');const p=process.argv[1];const b=fs.readFileSync(p);if(b.subarray(14,18).toString('ascii')!==' 500')process.exit(2);Buffer.from(' 510').copy(b,14);fs.writeFileSync(p,b)";
			await runNodeEdit(setBase, busWork);
			expect(readFileSync(busWork).subarray(14, 18).toString("ascii")).toBe(" 510");
			const convert =
				"const fs=require('node:fs');const p=process.argv[1];const b=fs.readFileSync(p);if(b[0]!==66||b[1]!==32)process.exit(2);b[1]=69;Buffer.from('   20').copy(b,47);Buffer.from('1020').copy(b,57);Buffer.from('   7').copy(b,34);fs.writeFileSync(p,b)";
			await runNodeEdit(convert, busWork);
			const converted = readFileSync(busWork);
			expect(converted.subarray(0, 2).toString("ascii")).toBe("BE");
			expect(converted.subarray(34, 38).toString("ascii")).toBe("   7");
			expect(converted.subarray(47, 52).toString("ascii")).toBe("   20");
			expect(converted.subarray(52, 57)).toEqual(busSource.subarray(52, 57));
			expect(converted.subarray(57, 61).toString("ascii")).toBe("1020");
			const restore =
				"const fs=require('node:fs');const p=process.argv[1];const b=fs.readFileSync(p);if(b[0]!==66||b[1]!==69)process.exit(2);b[1]=32;Buffer.from('   12').copy(b,47);Buffer.from('1050').copy(b,57);fs.writeFileSync(p,b)";
			await runNodeEdit(restore, busWork);
			const expectedRestored = Buffer.from(busSource);
			Buffer.from(" 510").copy(expectedRestored, 14);
			Buffer.from("   7").copy(expectedRestored, 34);
			expect(readFileSync(busWork)).toEqual(expectedRestored);
			expect(readFileSync(busOriginal)).toEqual(busSource);
		} finally {
			session.dispose();
		}
	}, 30_000);
});
