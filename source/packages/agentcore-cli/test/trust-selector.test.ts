import { setKeybindings } from "@pfsaa/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("TrustSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("keeps the saved trusted decision marked while browsing", () => {
		const selector = new TrustSelectorComponent({
			cwd: "/project",
			savedDecision: { path: "/project", decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		let output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("已保存决定：已信任（/project）");
		expect(output).toContain("当前会话：已信任");
		expect(output).toContain("→ ✓ 信任");

		selector.handleInput("\x1b[B");
		output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("✓ 信任");
		expect(output).toContain("→   信任父目录（/）");
		expect(output).not.toContain("✓ 不信任");
	});

	it("selects a trust decision", () => {
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd: "/project",
			savedDecision: null,
			projectTrusted: false,
			onSelect,
			onCancel: () => {},
		});

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({ trusted: true, updates: [{ path: "/project", decision: true }] });
	});

	it("labels saved ancestor decisions as inherited", () => {
		const selector = new TrustSelectorComponent({
			cwd: "/parent/project/nested",
			savedDecision: { path: "/parent", decision: true },
			projectTrusted: true,
			onSelect: () => {},
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));

		expect(output).toContain("已保存决定：已信任（继承自 /parent）");
	});

	it("adds a trust parent option", () => {
		const onSelect = vi.fn();
		const selector = new TrustSelectorComponent({
			cwd: "/parent/project",
			savedDecision: { path: "/parent", decision: true },
			projectTrusted: true,
			onSelect,
			onCancel: () => {},
		});

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("已保存决定：已信任（继承自 /parent）");
		expect(output).toContain("✓ 信任父目录（/parent）");

		selector.handleInput("\n");

		expect(onSelect).toHaveBeenCalledWith({
			trusted: true,
			updates: [
				{ path: "/parent", decision: true },
				{ path: "/parent/project", decision: null },
			],
		});
	});
});
