import type { ThinkingLevel } from "@pfsaa/agent-core";
import { getSupportedThinkingLevels, type Model, type Transport } from "@pfsaa/ai";
import {
	type Component,
	Container,
	getCapabilities,
	type ScrollViewScrollbar,
	type SelectItem,
	type SettingItem,
	SettingsList,
	Spacer,
	Text,
} from "@pfsaa/tui";
import { formatHttpIdleTimeoutMs, HTTP_IDLE_TIMEOUT_CHOICES } from "../../../core/http-dispatcher.ts";
import type {
	DefaultProjectTrust,
	FullscreenExitOutput,
	MermaidRenderingMode,
	TuiMode,
	WarningSettings,
} from "../../../core/settings-manager.ts";
import { getSettingsListTheme, parseAutoThemeSetting, type TerminalTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";
import { SelectSubmenu, SteppedSubmenu, type SteppedSubmenuStep } from "./settings-submenu.ts";
import { THINKING_LEVEL_LABELS } from "./thinking-selector.ts";

const MODEL_PICKER_LAYOUT = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 46 };

const THINKING_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "不进行推理",
	minimal: "极简推理（约 1k token）",
	low: "轻度推理（约 2k token）",
	medium: "中度推理（约 8k token）",
	high: "深度推理（约 16k token）",
	xhigh: "超高强度推理（约 32k token）",
	max: "最大强度推理",
};

const DEFAULT_PROJECT_TRUST_LABELS: Record<DefaultProjectTrust, string> = {
	ask: "询问",
	always: "始终信任",
	never: "从不信任",
};

const DEFAULT_PROJECT_TRUST_BY_LABEL = new Map(
	Object.entries(DEFAULT_PROJECT_TRUST_LABELS).map(([value, label]) => [label, value as DefaultProjectTrust]),
);

const BOOLEAN_LABELS = { true: "开启", false: "关闭" } as const;
const MESSAGE_MODE_LABELS = { "one-at-a-time": "逐条", all: "全部" } as const;
const TRANSPORT_LABELS = {
	sse: "SSE",
	websocket: "WebSocket",
	"websocket-cached": "WebSocket（缓存）",
	auto: "自动",
} as const;
const MERMAID_RENDERING_LABELS = { off: "关闭", final: "最终结果", streaming: "流式" } as const;
const DOUBLE_ESCAPE_ACTION_LABELS = { tree: "会话树", fork: "分叉", none: "无操作" } as const;
const TREE_FILTER_MODE_LABELS = {
	default: "默认",
	"no-tools": "不显示工具",
	"user-only": "仅用户消息",
	"labeled-only": "仅标签",
	all: "全部",
} as const;
const TUI_MODE_LABELS = { regular: "常规", fullscreen: "全屏" } as const;
const FULLSCREEN_EXIT_OUTPUT_LABELS = { transcript: "完整记录", "resume-hint": "恢复提示" } as const;
const FULLSCREEN_SCROLLBAR_LABELS = { auto: "自动", always: "始终显示", hidden: "隐藏" } as const;

function displayValue<T extends string>(labels: Record<T, string>, value: T): string {
	return labels[value];
}

function displayValues<T extends string>(labels: Record<T, string>): string[] {
	return Object.values(labels);
}

function rawValue<T extends string>(labels: Record<T, string>, label: string): T | undefined {
	return (Object.entries(labels) as Array<[T, string]>).find(([, value]) => value === label)?.[0];
}

export interface SettingsConfig {
	autoCompact: boolean;
	defaultModel: string;
	currentModel?: Model<any>;
	availableDefaultModels: readonly Model<any>[];
	showImages: boolean;
	imageWidthCells: number;
	autoResizeImages: boolean;
	blockImages: boolean;
	enableSkillCommands: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	transport: Transport;
	httpIdleTimeoutMs: number;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	modelThinkingLevels: Record<string, ThinkingLevel>;
	currentTheme: string;
	terminalTheme: TerminalTheme;
	availableThemes: string[];
	hideThinkingBlock: boolean;
	showToolExecutions: boolean;
	mermaidRenderingMode: MermaidRenderingMode;
	showCacheMissNotices: boolean;
	collapseChangelog: boolean;
	doubleEscapeAction: "fork" | "tree" | "none";
	treeFilterMode: "default" | "no-tools" | "user-only" | "labeled-only" | "all";
	showHardwareCursor: boolean;
	editorPaddingX: number;
	outputPad: 0 | 1;
	autocompleteMaxVisible: number;
	quietStartup: boolean;
	defaultProjectTrust: DefaultProjectTrust;
	clearOnShrink: boolean;
	showTerminalProgress: boolean;
	tuiMode: TuiMode;
	fullscreenExitOutput: FullscreenExitOutput;
	fullscreenScrollbar: ScrollViewScrollbar;
	fullscreenCopyOnSelect: boolean;
	warnings: WarningSettings;
}

export interface SettingsCallbacks {
	onAutoCompactChange: (enabled: boolean) => void;
	onShowImagesChange: (enabled: boolean) => void;
	onImageWidthCellsChange: (width: number) => void;
	onAutoResizeImagesChange: (enabled: boolean) => void;
	onBlockImagesChange: (blocked: boolean) => void;
	onEnableSkillCommandsChange: (enabled: boolean) => void;
	onSteeringModeChange: (mode: "all" | "one-at-a-time") => void;
	onFollowUpModeChange: (mode: "all" | "one-at-a-time") => void;
	onTransportChange: (transport: Transport) => void;
	onHttpIdleTimeoutMsChange: (timeoutMs: number) => void;
	onModelThinkingLevelChange: (provider: string, modelId: string, level: ThinkingLevel) => void;
	onModelThinkingLevelRemove: (provider: string, modelId: string) => void;
	onThemeChange: (theme: string) => void;
	onThemePreview?: (theme: string) => void;
	onHideThinkingBlockChange: (hidden: boolean) => void;
	onShowToolExecutionsChange: (shown: boolean) => void;
	onMermaidRenderingModeChange: (mode: MermaidRenderingMode) => void;
	onShowCacheMissNoticesChange: (shown: boolean) => void;
	onCollapseChangelogChange: (collapsed: boolean) => void;
	onDoubleEscapeActionChange: (action: "fork" | "tree" | "none") => void;
	onTreeFilterModeChange: (mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all") => void;
	onShowHardwareCursorChange: (enabled: boolean) => void;
	onEditorPaddingXChange: (padding: number) => void;
	onOutputPadChange: (padding: 0 | 1) => void;
	onAutocompleteMaxVisibleChange: (maxVisible: number) => void;
	onQuietStartupChange: (enabled: boolean) => void;
	onDefaultProjectTrustChange: (defaultProjectTrust: DefaultProjectTrust) => void;
	onClearOnShrinkChange: (enabled: boolean) => void;
	onShowTerminalProgressChange: (enabled: boolean) => void;
	onTuiModeChange: (mode: TuiMode) => void;
	onFullscreenExitOutputChange: (output: FullscreenExitOutput) => void;
	onFullscreenScrollbarChange: (mode: ScrollViewScrollbar) => void;
	onFullscreenCopyOnSelectChange: (enabled: boolean) => void;
	onWarningsChange: (warnings: WarningSettings) => void;
	onCancel: () => void;
}

/**
 * A submenu component for selecting from a list of options.
 */
class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsList;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Anthropic 额外用量",
				description: "Anthropic 订阅认证可能产生付费额外用量时发出警告",
				currentValue: displayValue(
					BOOLEAN_LABELS,
					String(this.state.anthropicExtraUsage ?? true) as "true" | "false",
				),
				values: displayValues(BOOLEAN_LABELS),
			},
		];

		this.settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: rawValue(BOOLEAN_LABELS, newValue) === "true" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}

const CLEAR_OVERRIDE_VALUE = "__clear__";

function modelSettingKey(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function modelDisplayLabel(model: Model<any>): string {
	return `${model.id} [${model.provider}]`;
}

function modelThinkingOverridesSummary(overrides: Record<string, ThinkingLevel>): string {
	const count = Object.keys(overrides).length;
	if (count === 0) return "无";
	return `已配置 ${count} 个`;
}

function modelItemLabel(model: Model<any>): string {
	return `${model.id} ${theme.fg("muted", `[${model.provider}]`)}`;
}

function themeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return availableThemes.map((name) => ({
		value: name,
		label: `${name === currentTheme ? "✓ " : "  "}${name}`,
	}));
}

const AUTOMATIC_THEME_VALUE = "/";

function singleModeThemeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return [
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "  自动",
			description: "根据终端浅色或深色外观使用不同主题",
		},
		...themeItems(availableThemes, currentTheme),
	];
}

function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;

	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, currentFixedTheme, "dark");
	return { lightTheme: themeName, darkTheme: themeName };
}

class ThemeSubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly callbacks: SettingsCallbacks;
	private readonly availableThemes: string[];
	private readonly terminalTheme: TerminalTheme;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly originalThemeSetting: string;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		callbacks: SettingsCallbacks,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.callbacks = callbacks;
		this.availableThemes = availableThemes;
		this.terminalTheme = terminalTheme;
		this.onDone = onDone;
		this.originalThemeSetting = currentThemeSetting;
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			"dark",
		);

		if (this.mode === "automatic") {
			this.showAutomaticMenu();
		} else {
			this.showSingleMenu();
		}
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(renderComponent: Component, inputComponent: Component = renderComponent): void {
		this.clear();
		this.addChild(renderComponent);
		this.inputComponent = inputComponent;
	}

	private showSingleMenu(): void {
		this.mode = "single";
		const menu = new SelectSubmenu(
			"主题",
			"选择主题，或选择“自动”以跟随终端外观。",
			singleModeThemeItems(this.availableThemes, this.singleTheme),
			this.singleTheme,
			(value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.callbacks.onThemePreview?.(this.getThemeSetting());
					this.showAutomaticMenu();
					return;
				}

				this.singleTheme = value;
				this.apply(value);
			},
			() => this.cancel(),
			(value) => {
				this.callbacks.onThemePreview?.(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
		);
		this.setContent(menu);
	}

	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", "自动主题")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", "分别选择终端浅色与深色外观使用的主题。"), 0, 0));
		content.addChild(new Text(theme.fg("muted", "检测浅色或深色外观需要终端支持。"), 0, 0));
		content.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "浅色主题",
				description: "自动模式下终端为浅色外观时使用的主题",
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect("浅色主题", "选择终端为浅色外观时使用的主题", currentValue, done, (value) => {
						this.lightTheme = value;
						this.callbacks.onThemePreview?.(this.getThemeSetting());
						done(value);
					}),
			},
			{
				id: "dark-theme",
				label: "深色主题",
				description: "自动模式下终端为深色外观时使用的主题",
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect("深色主题", "选择终端为深色外观时使用的主题", currentValue, done, (value) => {
						this.darkTheme = value;
						this.callbacks.onThemePreview?.(this.getThemeSetting());
						done(value);
					}),
			},
			{
				id: "apply",
				label: "应用",
				description: "保存并返回",
				currentValue: "保存并返回",
				values: ["保存并返回"],
			},
			{
				id: "single-mode",
				label: "更改模式",
				description: "浅色和深色外观使用同一主题",
				currentValue: "切换为单一主题",
				values: ["切换为单一主题"],
			},
		];

		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				switch (id) {
					case "single-mode":
						this.mode = "single";
						this.singleTheme = this.getActiveAutomaticTheme();
						this.callbacks.onThemePreview?.(this.singleTheme);
						this.showSingleMenu();
						break;
					case "apply":
						this.apply(this.getAutomaticThemeSetting());
						break;
				}
			},
			() => this.cancel(),
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			description,
			themeItems(this.availableThemes, currentValue),
			currentValue,
			onSelect,
			() => {
				this.callbacks.onThemePreview?.(this.getThemeSetting());
				done();
			},
			(value) => this.callbacks.onThemePreview?.(value),
		);
	}

	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	private apply(themeSetting: string): void {
		this.onDone(themeSetting);
	}

	private cancel(): void {
		this.callbacks.onThemePreview?.(this.originalThemeSetting);
		this.onDone();
	}
}

/**
 * Main settings selector component.
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;

	constructor(config: SettingsConfig, callbacks: SettingsCallbacks) {
		super();

		const supportsImages = getCapabilities().images;
		const followUpKey = keyDisplayText("app.message.followUp");
		const cycleThinkingKey = keyDisplayText("app.thinking.cycle");
		let currentWarnings = { ...config.warnings };
		const currentModelThinkingLevels = { ...config.modelThinkingLevels };
		const defaultModelByValue = new Map(
			config.availableDefaultModels.map((model) => [modelSettingKey(model), model]),
		);
		const currentDefaultModelKey = defaultModelByValue.has(config.defaultModel) ? config.defaultModel : undefined;
		const currentModelKey = config.currentModel ? modelSettingKey(config.currentModel) : undefined;

		const items: SettingItem[] = [
			{
				id: "autocompact",
				label: "自动压缩",
				description: "上下文过大时自动压缩",
				currentValue: displayValue(BOOLEAN_LABELS, String(config.autoCompact) as "true" | "false"),
				values: displayValues(BOOLEAN_LABELS),
			},
			{
				id: "steering-mode",
				label: "引导消息模式",
				description: "流式响应时按 Enter 将消息加入引导队列。逐条：逐条发送并等待响应；全部：一次发送全部。",
				currentValue: displayValue(MESSAGE_MODE_LABELS, config.steeringMode),
				values: displayValues(MESSAGE_MODE_LABELS),
			},
			{
				id: "follow-up-mode",
				label: "后续消息模式",
				description: `${followUpKey} 将后续消息排队到智能体停止。逐条：逐条发送并等待响应；全部：一次发送全部。`,
				currentValue: displayValue(MESSAGE_MODE_LABELS, config.followUpMode),
				values: displayValues(MESSAGE_MODE_LABELS),
			},
			{
				id: "transport",
				label: "传输方式",
				description: "提供方支持多种传输方式时优先使用的方式",
				currentValue: displayValue(TRANSPORT_LABELS, config.transport),
				values: displayValues(TRANSPORT_LABELS),
			},
			{
				id: "http-idle-timeout",
				label: "HTTP 空闲超时",
				description: "等待 HTTP 响应头或正文数据块时允许的最长空闲时间。本地模型暂停超过五分钟时可禁用。",
				currentValue: formatHttpIdleTimeoutMs(config.httpIdleTimeoutMs),
				values: HTTP_IDLE_TIMEOUT_CHOICES.map((choice) => choice.label),
			},
			{
				id: "hide-thinking",
				label: "隐藏思考过程",
				description: "隐藏助手响应中的思考块",
				currentValue: displayValue(BOOLEAN_LABELS, String(config.hideThinkingBlock) as "true" | "false"),
				values: displayValues(BOOLEAN_LABELS),
			},
			{
				id: "show-tool-executions",
				label: "显示工具调用详情",
				description: "显示工具调用的参数、输出和错误详情",
				currentValue: displayValue(BOOLEAN_LABELS, String(config.showToolExecutions) as "true" | "false"),
				values: displayValues(BOOLEAN_LABELS),
			},
			{
				id: "mermaid-rendering",
				label: "Mermaid 图表",
				description: "将 Mermaid 代码块渲染为 Unicode 图表",
				currentValue: displayValue(MERMAID_RENDERING_LABELS, config.mermaidRenderingMode),
				values: displayValues(MERMAID_RENDERING_LABELS),
			},
			{
				id: "cache-miss-notices",
				label: "缓存未命中提示",
				description: "显示缓存成本和提供方恢复诊断提示",
				currentValue: displayValue(BOOLEAN_LABELS, String(config.showCacheMissNotices) as "true" | "false"),
				values: displayValues(BOOLEAN_LABELS),
			},
			{
				id: "collapse-changelog",
				label: "折叠更新日志",
				description: "更新后显示精简的更新日志",
				currentValue: displayValue(BOOLEAN_LABELS, String(config.collapseChangelog) as "true" | "false"),
				values: displayValues(BOOLEAN_LABELS),
			},
			{
				id: "quiet-startup",
				label: "安静启动",
				description: "启动时不显示详细信息",
				currentValue: displayValue(BOOLEAN_LABELS, String(config.quietStartup) as "true" | "false"),
				values: displayValues(BOOLEAN_LABELS),
			},
			{
				id: "default-project-trust",
				label: "默认项目信任",
				description: "没有扩展或已保存决定时使用的项目信任行为",
				currentValue: DEFAULT_PROJECT_TRUST_LABELS[config.defaultProjectTrust],
				values: Object.values(DEFAULT_PROJECT_TRUST_LABELS),
			},
			{
				id: "double-escape-action",
				label: "双击 Escape 操作",
				description: "编辑器为空时连续按两次 Escape 执行的操作",
				currentValue: displayValue(DOUBLE_ESCAPE_ACTION_LABELS, config.doubleEscapeAction),
				values: displayValues(DOUBLE_ESCAPE_ACTION_LABELS),
			},
			{
				id: "tree-filter-mode",
				label: "会话树筛选模式",
				description: "打开 /tree 时使用的默认筛选条件",
				currentValue: displayValue(TREE_FILTER_MODE_LABELS, config.treeFilterMode),
				values: displayValues(TREE_FILTER_MODE_LABELS),
			},
			{
				id: "warnings",
				label: "警告",
				description: "逐项启用或禁用警告",
				currentValue: "配置",
				submenu: (_currentValue, done) =>
					new WarningSettingsSubmenu(
						currentWarnings,
						(warnings) => {
							currentWarnings = warnings;
							callbacks.onWarningsChange(warnings);
						},
						() => done(),
					),
			},
			{
				id: "model-thinking",
				label: "各模型的默认思考级别",
				description: `覆盖指定模型的默认思考级别。${cycleThinkingKey} 可在会话内循环切换。`,
				currentValue: modelThinkingOverridesSummary(currentModelThinkingLevels),
				submenu: (_currentValue, done) => {
					const steps: SteppedSubmenuStep[] = [
						{
							key: "model",
							title: "按模型设置思考级别",
							description: "选择要配置的模型",
							options: () => {
								const sorted = [...config.availableDefaultModels].sort((a, b) => {
									const aKey = modelSettingKey(a);
									const bKey = modelSettingKey(b);
									if (aKey === currentModelKey) return -1;
									if (bKey === currentModelKey) return 1;
									if (aKey === currentDefaultModelKey) return -1;
									if (bKey === currentDefaultModelKey) return 1;
									return a.provider.localeCompare(b.provider);
								});
								const items: SelectItem[] = sorted.map((model) => {
									const key = modelSettingKey(model);
									const override = currentModelThinkingLevels[key];
									return {
										value: key,
										label: modelItemLabel(model),
										description: override ?? undefined,
									};
								});
								if (items.length === 0) {
									items.push({
										value: "__none__",
										label: "没有可用模型",
										description: "请先登录提供方或配置 API 密钥",
									});
								}
								return items;
							},
							preselect: () => currentModelKey ?? currentDefaultModelKey,
							searchable: true,
							layout: MODEL_PICKER_LAYOUT,
						},
						{
							key: "level",
							title: (ctx) => {
								const m = defaultModelByValue.get(ctx.model);
								return `${m ? modelDisplayLabel(m) : ctx.model} 的思考级别`;
							},
							description: "选择此模型的默认思考级别",
							options: (ctx) => {
								const model = defaultModelByValue.get(ctx.model);
								if (!model) return [];
								const levels = (
									model.reasoning ? getSupportedThinkingLevels(model) : ["off"]
								) as ThinkingLevel[];
								const activeLevel = currentModelThinkingLevels[ctx.model];
								const items: SelectItem[] = levels.map((level) => ({
									value: level,
									label: `${level === activeLevel ? "✓ " : "  "}${THINKING_LEVEL_LABELS[level]}`,
									description: THINKING_DESCRIPTIONS[level],
								}));
								if (currentModelThinkingLevels[ctx.model] !== undefined) {
									items.push({
										value: CLEAR_OVERRIDE_VALUE,
										label: "  （清除覆盖）",
										description: `恢复全局默认值（${THINKING_LEVEL_LABELS[config.thinkingLevel]}）`,
									});
								}
								return items;
							},
							preselect: (ctx) => currentModelThinkingLevels[ctx.model],
						},
					];

					const summary = () => modelThinkingOverridesSummary(currentModelThinkingLevels);

					return new SteppedSubmenu(
						steps,
						(selections) => {
							const model = defaultModelByValue.get(selections.model);
							if (!model) return;
							if (selections.level === CLEAR_OVERRIDE_VALUE) {
								callbacks.onModelThinkingLevelRemove(model.provider, model.id);
								delete currentModelThinkingLevels[selections.model];
							} else {
								callbacks.onModelThinkingLevelChange(
									model.provider,
									model.id,
									selections.level as ThinkingLevel,
								);
								currentModelThinkingLevels[selections.model] = selections.level as ThinkingLevel;
							}
						},
						() => {
							done(summary());
						},
						{ loop: true },
					);
				},
			},
			{
				id: "tui-mode",
				label: "TUI 模式",
				description: "界面布局；全屏模式为实验功能",
				currentValue: displayValue(TUI_MODE_LABELS, config.tuiMode),
				values: displayValues(TUI_MODE_LABELS),
			},
			{
				id: "fullscreen-exit-output",
				label: "全屏退出输出",
				description: "退出全屏模式时输出完整记录或仅输出会话恢复提示",
				currentValue: displayValue(FULLSCREEN_EXIT_OUTPUT_LABELS, config.fullscreenExitOutput),
				values: displayValues(FULLSCREEN_EXIT_OUTPUT_LABELS),
			},
			{
				id: "fullscreen-scrollbar",
				label: "全屏滚动条",
				description: "全屏模式下的滚动条行为；不影响常规模式",
				currentValue: displayValue(FULLSCREEN_SCROLLBAR_LABELS, config.fullscreenScrollbar),
				values: displayValues(FULLSCREEN_SCROLLBAR_LABELS),
			},
			{
				id: "fullscreen-copy-on-select",
				label: "全屏选中即复制",
				description: "全屏模式下自动复制选中文本；禁用后使用 Ctrl+X 复制",
				currentValue: displayValue(BOOLEAN_LABELS, String(config.fullscreenCopyOnSelect) as "true" | "false"),
				values: displayValues(BOOLEAN_LABELS),
			},
			{
				id: "theme",
				label: "主题",
				description: "界面配色主题",
				currentValue: config.currentTheme,
				submenu: (currentValue, done) =>
					new ThemeSubmenu(currentValue, config.terminalTheme, config.availableThemes, callbacks, done),
			},
		];

		// Only show image toggle if terminal supports it
		if (supportsImages) {
			// Insert after autocompact
			items.splice(1, 0, {
				id: "show-images",
				label: "显示图像",
				description: "在终端中内联渲染图像",
				currentValue: displayValue(BOOLEAN_LABELS, String(config.showImages) as "true" | "false"),
				values: displayValues(BOOLEAN_LABELS),
			});
			items.splice(2, 0, {
				id: "image-width-cells",
				label: "图像宽度",
				description: "内联图像的首选终端单元格宽度",
				currentValue: String(config.imageWidthCells),
				values: ["60", "80", "120"],
			});
		}

		// Image auto-resize toggle (always available, affects both attached and read images)
		items.splice(supportsImages ? 3 : 1, 0, {
			id: "auto-resize-images",
			label: "自动缩放图像",
			description: "将大图缩放到最大 2000x2000，以提高模型兼容性",
			currentValue: displayValue(BOOLEAN_LABELS, String(config.autoResizeImages) as "true" | "false"),
			values: displayValues(BOOLEAN_LABELS),
		});

		// Block images toggle (always available, insert after auto-resize-images)
		const autoResizeIndex = items.findIndex((item) => item.id === "auto-resize-images");
		items.splice(autoResizeIndex + 1, 0, {
			id: "block-images",
			label: "阻止发送图像",
			description: "禁止向大模型提供方发送图像",
			currentValue: displayValue(BOOLEAN_LABELS, String(config.blockImages) as "true" | "false"),
			values: displayValues(BOOLEAN_LABELS),
		});

		// Skill commands toggle (insert after block-images)
		const blockImagesIndex = items.findIndex((item) => item.id === "block-images");
		items.splice(blockImagesIndex + 1, 0, {
			id: "skill-commands",
			label: "Skill 命令",
			description: "将 Skill 注册为 /skill:name 命令",
			currentValue: displayValue(BOOLEAN_LABELS, String(config.enableSkillCommands) as "true" | "false"),
			values: displayValues(BOOLEAN_LABELS),
		});

		// Hardware cursor toggle (insert after skill-commands)
		const skillCommandsIndex = items.findIndex((item) => item.id === "skill-commands");
		items.splice(skillCommandsIndex + 1, 0, {
			id: "show-hardware-cursor",
			label: "显示硬件光标",
			description: "显示终端光标，同时为输入法支持定位光标",
			currentValue: displayValue(BOOLEAN_LABELS, String(config.showHardwareCursor) as "true" | "false"),
			values: displayValues(BOOLEAN_LABELS),
		});

		// Editor padding toggle (insert after show-hardware-cursor)
		const hardwareCursorIndex = items.findIndex((item) => item.id === "show-hardware-cursor");
		items.splice(hardwareCursorIndex + 1, 0, {
			id: "editor-padding",
			label: "编辑器边距",
			description: "输入编辑器的水平边距（0-3）",
			currentValue: String(config.editorPaddingX),
			values: ["0", "1", "2", "3"],
		});

		// Output padding toggle (insert after editor-padding)
		const editorPaddingIndex = items.findIndex((item) => item.id === "editor-padding");
		items.splice(editorPaddingIndex + 1, 0, {
			id: "output-padding",
			label: "输出边距",
			description: "用户消息、助手消息和思考过程的水平边距",
			currentValue: String(config.outputPad),
			values: ["0", "1"],
		});

		// Autocomplete max visible toggle (insert after output-padding)
		const outputPaddingIndex = items.findIndex((item) => item.id === "output-padding");
		items.splice(outputPaddingIndex + 1, 0, {
			id: "autocomplete-max-visible",
			label: "自动补全最大条目数",
			description: "自动补全下拉列表中的最大可见条目数（3-20）",
			currentValue: String(config.autocompleteMaxVisible),
			values: ["3", "5", "7", "10", "15", "20"],
		});

		// Clear on shrink toggle (insert after autocomplete-max-visible)
		const autocompleteIndex = items.findIndex((item) => item.id === "autocomplete-max-visible");
		items.splice(autocompleteIndex + 1, 0, {
			id: "clear-on-shrink",
			label: "收缩时清屏",
			description: "内容收缩时清除空行（可能引起闪烁）",
			currentValue: displayValue(BOOLEAN_LABELS, String(config.clearOnShrink) as "true" | "false"),
			values: displayValues(BOOLEAN_LABELS),
		});

		// Terminal progress toggle (insert after clear-on-shrink)
		const clearOnShrinkIndex = items.findIndex((item) => item.id === "clear-on-shrink");
		items.splice(clearOnShrinkIndex + 1, 0, {
			id: "terminal-progress",
			label: "终端进度",
			description: "在终端标签栏显示 OSC 9;4 进度指示",
			currentValue: displayValue(BOOLEAN_LABELS, String(config.showTerminalProgress) as "true" | "false"),
			values: displayValues(BOOLEAN_LABELS),
		});

		// Add borders
		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "autocompact":
						callbacks.onAutoCompactChange(rawValue(BOOLEAN_LABELS, newValue) === "true");
						break;
					case "show-images":
						callbacks.onShowImagesChange(rawValue(BOOLEAN_LABELS, newValue) === "true");
						break;
					case "image-width-cells":
						callbacks.onImageWidthCellsChange(parseInt(newValue, 10));
						break;
					case "auto-resize-images":
						callbacks.onAutoResizeImagesChange(rawValue(BOOLEAN_LABELS, newValue) === "true");
						break;
					case "block-images":
						callbacks.onBlockImagesChange(rawValue(BOOLEAN_LABELS, newValue) === "true");
						break;
					case "skill-commands":
						callbacks.onEnableSkillCommandsChange(rawValue(BOOLEAN_LABELS, newValue) === "true");
						break;
					case "steering-mode":
						callbacks.onSteeringModeChange(rawValue(MESSAGE_MODE_LABELS, newValue) ?? "one-at-a-time");
						break;
					case "follow-up-mode":
						callbacks.onFollowUpModeChange(rawValue(MESSAGE_MODE_LABELS, newValue) ?? "one-at-a-time");
						break;
					case "transport":
						callbacks.onTransportChange(rawValue(TRANSPORT_LABELS, newValue) ?? "auto");
						break;
					case "http-idle-timeout": {
						const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.label === newValue);
						if (choice) {
							callbacks.onHttpIdleTimeoutMsChange(choice.timeoutMs);
						}
						break;
					}
					case "hide-thinking":
						callbacks.onHideThinkingBlockChange(rawValue(BOOLEAN_LABELS, newValue) === "true");
						break;
					case "show-tool-executions":
						callbacks.onShowToolExecutionsChange(rawValue(BOOLEAN_LABELS, newValue) === "true");
						break;
					case "mermaid-rendering":
						callbacks.onMermaidRenderingModeChange(rawValue(MERMAID_RENDERING_LABELS, newValue) ?? "off");
						break;
					case "cache-miss-notices":
						callbacks.onShowCacheMissNoticesChange(rawValue(BOOLEAN_LABELS, newValue) === "true");
						break;
					case "collapse-changelog":
						callbacks.onCollapseChangelogChange(rawValue(BOOLEAN_LABELS, newValue) === "true");
						break;
					case "quiet-startup":
						callbacks.onQuietStartupChange(rawValue(BOOLEAN_LABELS, newValue) === "true");
						break;
					case "default-project-trust": {
						const defaultProjectTrust = DEFAULT_PROJECT_TRUST_BY_LABEL.get(newValue);
						if (defaultProjectTrust) {
							callbacks.onDefaultProjectTrustChange(defaultProjectTrust);
						}
						break;
					}
					case "double-escape-action":
						callbacks.onDoubleEscapeActionChange(rawValue(DOUBLE_ESCAPE_ACTION_LABELS, newValue) ?? "none");
						break;
					case "tree-filter-mode":
						callbacks.onTreeFilterModeChange(rawValue(TREE_FILTER_MODE_LABELS, newValue) ?? "default");
						break;
					case "show-hardware-cursor":
						callbacks.onShowHardwareCursorChange(rawValue(BOOLEAN_LABELS, newValue) === "true");
						break;
					case "editor-padding":
						callbacks.onEditorPaddingXChange(parseInt(newValue, 10));
						break;
					case "output-padding":
						callbacks.onOutputPadChange(newValue === "0" ? 0 : 1);
						break;
					case "autocomplete-max-visible":
						callbacks.onAutocompleteMaxVisibleChange(parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						callbacks.onClearOnShrinkChange(rawValue(BOOLEAN_LABELS, newValue) === "true");
						break;
					case "terminal-progress":
						callbacks.onShowTerminalProgressChange(rawValue(BOOLEAN_LABELS, newValue) === "true");
						break;
					case "tui-mode":
						callbacks.onTuiModeChange(rawValue(TUI_MODE_LABELS, newValue) ?? "regular");
						break;
					case "fullscreen-exit-output":
						callbacks.onFullscreenExitOutputChange(
							rawValue(FULLSCREEN_EXIT_OUTPUT_LABELS, newValue) ?? "transcript",
						);
						break;
					case "fullscreen-scrollbar":
						callbacks.onFullscreenScrollbarChange(rawValue(FULLSCREEN_SCROLLBAR_LABELS, newValue) ?? "auto");
						break;
					case "fullscreen-copy-on-select":
						callbacks.onFullscreenCopyOnSelectChange(rawValue(BOOLEAN_LABELS, newValue) === "true");
						break;
					case "theme":
						callbacks.onThemeChange(newValue);
						break;
				}
			},
			callbacks.onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
