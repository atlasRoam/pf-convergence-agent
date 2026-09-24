import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { type ExternalEditorResult, editInExternalEditor } from "../src/modes/interactive/external-editor.ts";

const editorFixturePath = fileURLToPath(new URL("./fixtures/fake-external-editor.mjs", import.meta.url));

interface EditorCapture {
	filePath: string;
	content: string;
	entries: string[];
	directoryMode: number;
}

async function runExternalEditor(fixtureFlag?: "--fail" | "--empty"): Promise<{
	result: ExternalEditorResult;
	capture: EditorCapture;
}> {
	const testDirectory = mkdtempSync(join(tmpdir(), "pi-external-editor-test-"));
	const capturePath = join(testDirectory, "capture.json");
	try {
		const result = await editInExternalEditor({
			command: `${process.execPath} ${editorFixturePath} ${capturePath}${fixtureFlag ? ` ${fixtureFlag}` : ""}`,
			content: "original",
		});
		const capture = JSON.parse(readFileSync(capturePath, "utf-8")) as EditorCapture;
		return { result, capture };
	} finally {
		rmSync(testDirectory, { recursive: true, force: true });
	}
}

describe("editInExternalEditor", () => {
	it("prints the Chinese launch and resume notice", async () => {
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await runExternalEditor();

			expect(write).toHaveBeenCalledOnce();
			const notice = String(write.mock.calls[0][0]);
			const [launchLine, resumeLine, trailing] = notice.split("\n");
			expect(launchLine).toMatch(
				new RegExp(`^正在启动外部编辑器：${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} .+capture\\.json$`),
			);
			expect(launchLine).toContain(editorFixturePath);
			expect(resumeLine).toBe("PFSAA 将在编辑器退出后继续。");
			expect(trailing).toBe("");
		} finally {
			write.mockRestore();
		}
	});

	it("edits a prompt inside a private temporary directory", async () => {
		const { result, capture } = await runExternalEditor();
		const directory = dirname(capture.filePath);

		expect(result).toEqual({ status: "complete", content: "edited" });
		expect(dirname(directory)).toBe(tmpdir());
		expect(basename(directory)).toMatch(/^pi-editor-.+$/);
		expect(basename(capture.filePath)).toBe("prompt.md");
		expect(capture.entries).toEqual(["prompt.md"]);
		expect(capture.content).toBe("original");
		if (process.platform !== "win32") {
			expect(capture.directoryMode & 0o077).toBe(0);
		}
		expect(existsSync(directory)).toBe(false);
	});

	it("keeps the original content when the editor exits unsuccessfully", async () => {
		const { result, capture } = await runExternalEditor("--fail");

		expect(result).toEqual({ status: "failed" });
		expect(existsSync(dirname(capture.filePath))).toBe(false);
	});
	it("returns empty content when the editor clears the prompt", async () => {
		const { result } = await runExternalEditor("--empty");

		expect(result).toEqual({ status: "complete", content: "" });
	});
});
