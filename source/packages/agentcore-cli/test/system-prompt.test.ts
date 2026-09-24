import { describe, expect, test } from "vitest";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

const testSkill: Skill = {
	name: "test-skill",
	description: "A test skill.",
	filePath: "/skills/test-skill/SKILL.md",
	baseDir: "/skills/test-skill",
	sourceInfo: createSyntheticSourceInfo("/skills/test-skill/SKILL.md", { source: "test" }),
	disableModelInvocation: false,
};

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows （无） for empty tools list", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("可用工具：\n（无）");
			expect(
				prompt.startsWith(
					"你是电力系统潮流计算调整智能体。\n\n你通过读取文件、分解任务与命令、执行命令、编辑文件和创建文件来帮助用户完成工作。",
				),
			).toBe(true);
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				selectedTools: [],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("处理文件时清楚展示文件路径。");
			expect(prompt).toContain("除非用户明确要求，禁止读取、展示或传播认证文件、API key、令牌和密码。");
		});

		test("requires concise public working updates around tool use", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("必须在首次调用前以及每次关键工作阶段切换时");
			expect(prompt).toContain("不要展示命令全文、逐 token 内部推理或逐个低层工具调用");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when snippets are provided", () => {
			const prompt = buildSystemPrompt({
				toolSnippets: {
					read: "Read file contents",
					bash: "Execute bash commands",
					edit: "Make surgical edits",
					write: "Create or overwrite files",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});

		test.each([
			[["powershell"], "使用 PowerShell 执行列出、搜索和查找文件等操作。"],
			[["bash", "powershell"], "使用 bash 或 PowerShell 执行列出、搜索和查找文件等操作。"],
		] as const)("uses shell-specific guidance for %j", (selectedTools, expected) => {
			const prompt = buildSystemPrompt({
				selectedTools: [...selectedTools],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain(expected);
		});

		test("instructs models to resolve core docs under their documented base paths", () => {
			const prompt = buildSystemPrompt({
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- 文档和示例中的相对路径按其所属文档目录解析。");
			expect(prompt).toContain("- 处理相关问题时，完整读取所需 Markdown 文件，并按需跟随交叉引用。");
		});
	});

	describe("custom tool snippets", () => {
		test("includes custom tools in available tools section when promptSnippet is provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				toolSnippets: {
					dynamic_tool: "Run dynamic test behavior",
				},
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- dynamic_tool: Run dynamic test behavior");
		});

		test("omits custom tools from available tools section when promptSnippet is not provided", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("dynamic_tool");
		});
	});

	describe("prompt guidelines", () => {
		test("appends promptGuidelines to default guidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for project summaries."],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("- Use dynamic_tool for project summaries.");
		});

		test("deduplicates and trims promptGuidelines", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["read", "dynamic_tool"],
				promptGuidelines: ["Use dynamic_tool for summaries.", "  Use dynamic_tool for summaries.  ", "   "],
				contextFiles: [],
				skills: [],
				cwd: process.cwd(),
			});

			expect(prompt.match(/- Use dynamic_tool for summaries\./g)).toHaveLength(1);
		});
	});

	describe("skills", () => {
		test.each([
			{ name: "default prompt", customPrompt: undefined },
			{ name: "custom prompt", customPrompt: "Custom system prompt" },
		])("includes skills with only bash in the $name", ({ customPrompt }) => {
			const prompt = buildSystemPrompt({
				customPrompt,
				selectedTools: ["bash"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

			expect(prompt).toContain("<available_skills>");
			expect(prompt).toContain("<name>test-skill</name>");
			expect(prompt).toContain("当任务与某个 Skill 的描述匹配时，使用 bash 加载该 Skill 文件。");
		});

		test("omits skills without read or bash", () => {
			const prompt = buildSystemPrompt({
				selectedTools: ["write"],
				contextFiles: [],
				skills: [testSkill],
				cwd: process.cwd(),
			});

			expect(prompt).not.toContain("<available_skills>");
		});
	});
});
