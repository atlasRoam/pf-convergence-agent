import type { ThinkingLevel } from "@pfsaa/agent-core";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@pfsaa/tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

const THINKING_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "不进行推理",
	minimal: "极简推理（约 1k token）",
	low: "轻度推理（约 2k token）",
	medium: "中度推理（约 8k token）",
	high: "深度推理（约 16k token）",
	xhigh: "超高强度推理（约 32k token）",
	max: "最大强度推理",
};

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
	off: "关闭",
	minimal: "极简",
	low: "轻度",
	medium: "中度",
	high: "深度",
	xhigh: "超高",
	max: "最大",
};

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private selectList: SelectList;
	private selectListChildIndex: number;
	private allItems: SelectItem[];
	private onSelect: (level: ThinkingLevel) => void;
	private onCancel: () => void;
	private onSelectAsDefault?: (level: ThinkingLevel) => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
		onSelectAsDefault?: (level: ThinkingLevel) => void,
		defaultThinkingLevel?: ThinkingLevel,
	) {
		super();
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.onSelectAsDefault = onSelectAsDefault;

		this.allItems = availableLevels.map((level) => ({
			value: level,
			label: `${level === currentLevel ? "✓ " : "  "}${THINKING_LEVEL_LABELS[level]}`,
			description:
				level === defaultThinkingLevel ? `${LEVEL_DESCRIPTIONS[level]} · 默认` : LEVEL_DESCRIPTIONS[level],
		}));

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text("思考级别", 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(`${keyDisplayText("app.thinking.cycle")} 在会话内循环切换思考级别`, 0, 0));
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		this.searchInput.onSubmit = () => this.selectList.handleInput("\r");
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		// Create selector
		this.selectList = this.buildSelectList(this.allItems, currentLevel);
		this.selectListChildIndex = this.children.length;
		this.addChild(this.selectList);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`  ${keyDisplayText("tui.select.confirm")} 选择 · ${keyDisplayText("app.thinking.save")} 设为默认 · ${keyDisplayText("tui.select.cancel")} 取消`,
				),
				0,
				0,
			),
		);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	private buildSelectList(items: SelectItem[], preselect?: ThinkingLevel): SelectList {
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), THINKING_SELECT_LIST_LAYOUT);
		const currentIndex = items.findIndex((item) => item.value === preselect);
		if (currentIndex !== -1) {
			list.setSelectedIndex(currentIndex);
		}
		list.onSelect = (item) => this.onSelect(item.value as ThinkingLevel);
		list.onCancel = () => this.onCancel();
		return list;
	}

	private applyFilter(query: string): void {
		const filtered = query
			? fuzzyFilter(this.allItems, query, (item) => `${item.value} ${item.description ?? ""}`)
			: this.allItems;
		const selectedValue = this.selectList.getSelectedItem()?.value as ThinkingLevel | undefined;
		const newList = this.buildSelectList(filtered, selectedValue);
		this.children[this.selectListChildIndex] = newList;
		this.selectList = newList;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.thinking.save") && this.onSelectAsDefault) {
			const item = this.selectList.getSelectedItem();
			if (item) this.onSelectAsDefault(item.value as ThinkingLevel);
			return;
		}

		const isNav =
			kb.matches(keyData, "tui.select.up") ||
			kb.matches(keyData, "tui.select.down") ||
			kb.matches(keyData, "tui.select.confirm") ||
			kb.matches(keyData, "tui.select.cancel");
		if (isNav) {
			this.selectList.handleInput(keyData);
			return;
		}

		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
