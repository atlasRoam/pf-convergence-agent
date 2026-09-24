import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

interface PfntManifest {
	name: string;
	engine_id: string;
	entrypoint: string;
	schema: string;
}

interface EngineRegistryTemplate {
	schema_version: string;
	selected_engine_id: string;
	automatic_selection: boolean;
	engines: Array<{ engine_id: string; enabled: boolean }>;
}

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = resolve(TEST_DIR, "../../..");
const PROJECT_DIR = resolve(SOURCE_DIR, "..");
const ROUTER_SKILL_DIR = join(SOURCE_DIR, ".agentcore/skills/compute-engine");
const PFNT_46_SKILL_DIR = join(SOURCE_DIR, ".agentcore/skills/pfnt-4.6");

function readProjectFile(relativePath: string): string {
	return readFileSync(join(PROJECT_DIR, relativePath), "utf8");
}

describe("PFSAA 阶段二产品源码接入", () => {
	test.each(["start.sh", "start.ps1"])("%s 保持自动发现隔离并显式注入两个通用 Skill", (entry) => {
		const source = readProjectFile(entry);
		for (const flag of ["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"]) {
			expect(source).toContain(flag);
		}
		if (entry === "start.sh") {
			expect(source).toContain('SOURCE_DIR="$PROJECT_DIR/source"');
			expect(source).toContain('PRODUCT_SKILL="$SOURCE_DIR/.agentcore/skills/compute-engine/SKILL.md"');
			expect(source).toContain('MANUAL_ADJUSTMENT_SKILL="$SOURCE_DIR/.agentcore/skills/powerflow-manual-adjustment/SKILL.md"');
			expect(source).toContain('CREDENTIAL_GUARD="$SOURCE_DIR/packages/agentcore-cli/src/extensions/pfsaa-credential-guard.ts"');
			expect(source).toContain('[[ ! -f "$PRODUCT_SKILL" ]]');
			expect(source).toContain('[[ ! -f "$MANUAL_ADJUSTMENT_SKILL" ]]');
			expect(source).toContain('MANDATORY_ARGS=(--extension "$CREDENTIAL_GUARD" --skill "$PRODUCT_SKILL" --skill "$MANUAL_ADJUSTMENT_SKILL")');
			expect(source).toContain('FORWARDED_ARGS+=("${MANDATORY_ARGS[@]}")');
		} else {
			expect(source).toContain('$sourceDir = Join-Path $projectDir "source"');
			expect(source).toContain('$productSkill = Join-Path $sourceDir ".agentcore/skills/compute-engine/SKILL.md"');
			expect(source).toContain('$manualAdjustmentSkill = Join-Path $sourceDir ".agentcore/skills/powerflow-manual-adjustment/SKILL.md"');
			expect(source).toContain('$credentialGuard = Join-Path $sourceDir "packages/agentcore-cli/src/extensions/pfsaa-credential-guard.ts"');
			expect(source).toContain('Test-Path -LiteralPath $productSkill -PathType Leaf');
			expect(source).toContain('Test-Path -LiteralPath $manualAdjustmentSkill -PathType Leaf');
			expect(source).toContain('$mandatoryArgs = @("--extension", $credentialGuard, "--skill", $productSkill, "--skill", $manualAdjustmentSkill)');
			expect(source).toContain('$forwardedArgs += $mandatoryArgs');
		}
	});

	test("产品 Skill 的 manifest、入口、schema、CLI 和 runtime 合同完整", () => {
		const manifestPath = join(PFNT_46_SKILL_DIR, "manifest.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PfntManifest;
		expect(manifest.name).toBe("pfnt-4.6");
		expect(manifest.engine_id).toBe("pfnt-4.6");

		for (const path of [
			join(ROUTER_SKILL_DIR, "SKILL.md"),
			join(ROUTER_SKILL_DIR, "references/engine-catalog.md"),
			join(PFNT_46_SKILL_DIR, "SKILL.md"),
			join(PFNT_46_SKILL_DIR, manifest.entrypoint),
			join(PFNT_46_SKILL_DIR, manifest.schema),
			join(PFNT_46_SKILL_DIR, "references/PFSAA-windows-runtime.md"),
			join(PFNT_46_SKILL_DIR, "assets/engine-registry.template.json"),
			join(PROJECT_DIR, "setup-pfnt-runtime.ps1"),
		]) {
			expect(existsSync(path), path).toBe(true);
		}

		const schema = JSON.parse(readFileSync(join(PFNT_46_SKILL_DIR, manifest.schema), "utf8")) as { engine_id: string };
		expect(schema.engine_id).toBe("pfnt-4.6");
		const router = readFileSync(join(ROUTER_SKILL_DIR, "SKILL.md"), "utf8");
		const catalog = readFileSync(join(ROUTER_SKILL_DIR, "references/engine-catalog.md"), "utf8");
		const runtimeSetup = readProjectFile("setup-pfnt-runtime.ps1");
		expect(router).toContain("不猜测");
		expect(router).toContain("powerflow-manual-adjustment");
		expect(catalog).toContain("../pfnt-4.6/SKILL.md");
		expect(catalog).toContain("../pfnt-4.2/SKILL.md");
		expect(runtimeSetup).toContain("skills/pfnt-4.6/assets/engine-registry.template.json");
		expect(runtimeSetup).toContain('adapter_skill_id -ceq "pfnt-4.6"');
	});

	test("registry template 关闭自动选择且只登记 pfnt-4.6", () => {
		const templateText = readFileSync(join(PFNT_46_SKILL_DIR, "assets/engine-registry.template.json"), "utf8");
		const registry = JSON.parse(templateText) as EngineRegistryTemplate;
		expect(registry.schema_version).toBeTruthy();
		expect(registry.selected_engine_id).toBe("pfnt-4.6");
		expect(registry.automatic_selection).toBe(false);
		expect(registry.engines).toHaveLength(1);
		expect(registry.engines[0]).toMatchObject({ engine_id: "pfnt-4.6", enabled: false });
		expect(templateText).not.toContain("pfnt-4.2");
	});
});
