import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { printHelp } from "../src/cli/args.ts";
import { findNodePackageDir } from "../src/config.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

describe("findNodePackageDir", () => {
	test("skips binary metadata copied into dist", () => {
		tempDir = mkdtempSync(join(tmpdir(), "agentcore-package-dir-"));
		const distDir = join(tempDir, "dist");
		const bundleDir = join(distDir, "bundle");
		mkdirSync(bundleDir, { recursive: true });
		writeFileSync(join(tempDir, "package.json"), "{}");
		writeFileSync(join(distDir, "package.json"), "{}");

		expect(findNodePackageDir(bundleDir)).toBe(tempDir);
	});
});

describe("CLI help", () => {
	test("offers extension updates but no self-update command or flag", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			printHelp();
			const help = log.mock.calls.map(([message]) => String(message)).join("\n");
			expect(help).toContain("agentcore update [source]           仅更新已配置的扩展");
			expect(help).not.toMatch(/self-update|--self-update|update \[source\|self\|pi\]/);
		} finally {
			log.mockRestore();
		}
	});
});
