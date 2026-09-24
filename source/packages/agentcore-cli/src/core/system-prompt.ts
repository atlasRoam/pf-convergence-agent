/**
 * System prompt construction and project context loading
 */

import { getDocsPath, getReadmePath } from "../config.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const promptCwd = cwd.replace(/\\/g, "/");

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const skillFileReadTool = (["read", "bash"] as const).find((tool) => tools.includes(tool));

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n<project_context>\n\n";
			prompt += "项目专用说明与指引：\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
			}
			prompt += "</project_context>\n";
		}

		// Append skills when a tool capable of reading their files is available.
		if (skillFileReadTool && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills, skillFileReadTool);
		}

		prompt += `\n当前工作目录：${promptCwd}\n`;

		return prompt;
	}

	// Get absolute paths to shipped documentation.
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();

	// Build tools list based on selected tools.
	// A tool appears in Available tools only when the caller provides a one-line snippet.
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "（无）";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasPowerShell = tools.includes("powershell");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");

	// File exploration guidelines
	if ((hasBash || hasPowerShell) && !hasGrep && !hasFind && !hasLs) {
		if (hasBash && hasPowerShell) {
			addGuideline("使用 bash 或 PowerShell 执行列出、搜索和查找文件等操作。");
		} else if (hasPowerShell) {
			addGuideline("使用 PowerShell 执行列出、搜索和查找文件等操作。");
		} else {
			addGuideline("使用 bash 执行 ls、rg、find 等文件操作。");
		}
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("回答保持简洁。");
	addGuideline("处理文件时清楚展示文件路径。");
	addGuideline(
		"任务需要调用工具时，必须在首次调用前以及每次关键工作阶段切换时，先用 1-3 句向用户说明已确认的事实或当前判断、即将采取的动作，以及涉及改动时的目标对象或范围。",
	);
	addGuideline(
		"公开工作说明只描述可验证的判断和计划；不要展示命令全文、逐 token 内部推理或逐个低层工具调用。连续的读取、搜索和执行合并为同一阶段；工具失败或验算未达目标后，在下一阶段说明结果和调整方向。",
	);
	addGuideline("除非用户明确要求，禁止读取、展示或传播认证文件、API key、令牌和密码。");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `你是电力系统潮流计算调整智能体。

你通过读取文件、分解任务与命令、执行命令、编辑文件和创建文件来帮助用户完成工作。

你围绕用户提出的电力系统潮流计算、结果分析和调整目标，结合当前实际可用的工具与 Skill 组织操作，并依据实际读取和执行结果作答。

可用工具：
${toolsList}

除上面列出的工具外，你还可能使用当前运行环境注册的其他自定义工具。工具能力和参数以实际注册的定义为准。

通用操作指引：
${guidelines}

保持回答简洁，操作对象、文件路径、关键结果和需要用户决定的事项表达清楚。默认使用中文；代码、命令、字段名、路径和原始错误信息保持准确。

需要了解以前会话的背景或工作进度时，通过当前可用的工具查阅相关会话记录，再结合本次要求继续工作。明确区分已经读取到的事实、尚未核实的信息和建议。

核心文档：仅在用户询问 agent 核心、配置、会话、工具、Skill 或终端界面本身时，按需读取随当前版本提供的对应文档。
- 主文档：${readmePath}
- 补充文档：${docsPath}
- 文档和示例中的相对路径按其所属文档目录解析。
- 处理相关问题时，完整读取所需 Markdown 文件，并按需跟随交叉引用。`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "项目专用说明与指引：\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

	// Append skills when a tool capable of reading their files is available.
	if (skillFileReadTool && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills, skillFileReadTool);
	}

	prompt += `\n当前工作目录：${promptCwd}`;

	return prompt;
}
