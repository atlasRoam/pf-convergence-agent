/**
 * Theme JSON validation, kept out of `theme.ts` on purpose.
 *
 * Validating user-authored theme files needs typebox, which costs ~17 MB of module graph to import.
 * Palette lookup does not, so a presentation that only uses built-in themes should never pay for it.
 * `interactive-mode.ts` installs this validator; anything that does not simply skips validation, as
 * built-in themes already do.
 */

import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const ColorValueSchema = Type.Union([
	Type.String(), // hex "#ff0000", var ref "primary", or empty ""
	Type.Integer({ minimum: 0, maximum: 255 }), // 256-color index
]);

const ThemeJsonSchema = Type.Object({
	$schema: Type.Optional(Type.String()),
	name: Type.String(),
	vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
	colors: Type.Object({
		// Core UI (11 colors)
		accent: ColorValueSchema,
		border: ColorValueSchema,
		borderAccent: ColorValueSchema,
		borderMuted: ColorValueSchema,
		success: ColorValueSchema,
		error: ColorValueSchema,
		warning: ColorValueSchema,
		muted: ColorValueSchema,
		dim: ColorValueSchema,
		text: ColorValueSchema,
		thinkingText: ColorValueSchema,
		// Scrollbar (2 optional colors)
		scrollbarTrack: Type.Optional(ColorValueSchema),
		scrollbarThumb: Type.Optional(ColorValueSchema),
		// Backgrounds & Content Text (11 required, 2 optional)
		selectedBg: ColorValueSchema,
		searchMatchBg: Type.Optional(ColorValueSchema),
		searchMatchText: Type.Optional(ColorValueSchema),
		userMessageBg: ColorValueSchema,
		userMessageText: ColorValueSchema,
		customMessageBg: ColorValueSchema,
		customMessageText: ColorValueSchema,
		customMessageLabel: ColorValueSchema,
		toolPendingBg: ColorValueSchema,
		toolSuccessBg: ColorValueSchema,
		toolErrorBg: ColorValueSchema,
		toolTitle: ColorValueSchema,
		toolOutput: ColorValueSchema,
		// Markdown (10 colors)
		mdHeading: ColorValueSchema,
		mdLink: ColorValueSchema,
		mdLinkUrl: ColorValueSchema,
		mdCode: ColorValueSchema,
		mdCodeBlock: ColorValueSchema,
		mdCodeBlockBorder: ColorValueSchema,
		mdQuote: ColorValueSchema,
		mdQuoteBorder: ColorValueSchema,
		mdHr: ColorValueSchema,
		mdListBullet: ColorValueSchema,
		// Tool Diffs (3 colors)
		toolDiffAdded: ColorValueSchema,
		toolDiffRemoved: ColorValueSchema,
		toolDiffContext: ColorValueSchema,
		// Syntax Highlighting (9 colors)
		syntaxComment: ColorValueSchema,
		syntaxKeyword: ColorValueSchema,
		syntaxFunction: ColorValueSchema,
		syntaxVariable: ColorValueSchema,
		syntaxString: ColorValueSchema,
		syntaxNumber: ColorValueSchema,
		syntaxType: ColorValueSchema,
		syntaxOperator: ColorValueSchema,
		syntaxPunctuation: ColorValueSchema,
		// Thinking Level Borders (6 colors)
		thinkingOff: ColorValueSchema,
		thinkingMinimal: ColorValueSchema,
		thinkingLow: ColorValueSchema,
		thinkingMedium: ColorValueSchema,
		thinkingHigh: ColorValueSchema,
		thinkingXhigh: ColorValueSchema,
		thinkingMax: Type.Optional(ColorValueSchema),
		// Bash Mode (1 color)
		bashMode: ColorValueSchema,
	}),
	export: Type.Optional(
		Type.Object({
			pageBg: Type.Optional(ColorValueSchema),
			cardBg: Type.Optional(ColorValueSchema),
			infoBg: Type.Optional(ColorValueSchema),
		}),
	),
});

const compiledThemeSchema = Compile(ThemeJsonSchema);

export type ThemeColorValue = Static<typeof ColorValueSchema>;
export type ValidatedThemeJson = Static<typeof ThemeJsonSchema>;

/** Validate one theme document, throwing a message that names the offending tokens. */
export function validateThemeJson(label: string, json: unknown): ValidatedThemeJson {
	if (!compiledThemeSchema.Check(json)) {
		const errors = Array.from(compiledThemeSchema.Errors(json));
		const missingColors = new Set<string>();
		const otherErrors: string[] = [];

		for (const error of errors) {
			if (error.keyword === "required" && error.instancePath === "/colors") {
				const requiredProperties = (error.params as { requiredProperties?: string[] }).requiredProperties;
				for (const requiredProperty of requiredProperties ?? []) {
					missingColors.add(requiredProperty);
				}
				continue;
			}

			const path = error.instancePath || "/";
			otherErrors.push(`  - ${path}: ${error.message}`);
		}

		let errorMessage = `主题 "${label}" 无效：\n`;
		if (missingColors.size > 0) {
			errorMessage += "\n缺少必需的颜色标记：\n";
			errorMessage += Array.from(missingColors)
				.sort()
				.map((color) => `  - ${color}`)
				.join("\n");
			errorMessage += '\n\n请将这些颜色添加到主题的 "colors" 对象中。';
			errorMessage += "\n参考内置主题（dark.json、light.json）中的值。";
		}
		if (otherErrors.length > 0) {
			errorMessage += `\n\n其他错误：\n${otherErrors.join("\n")}`;
		}

		throw new Error(errorMessage);
	}

	const themeJson = json as ValidatedThemeJson;
	if (themeJson.name.includes("/")) {
		throw new Error(
			`主题名称 "${themeJson.name}" 无效：主题名称不能包含 "/"，该字符保留用于自动 light/dark 主题设置。`,
		);
	}
	return themeJson;
}
