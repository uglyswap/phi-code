import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import {
	type ExternalEditorResult,
	editInExternalEditor,
	parseEditorCommand,
} from "../src/modes/interactive/external-editor.ts";

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
			command: `"${process.execPath}" "${editorFixturePath}" "${capturePath}"${fixtureFlag ? ` ${fixtureFlag}` : ""}`,
			content: "original",
		});
		const capture = JSON.parse(readFileSync(capturePath, "utf-8")) as EditorCapture;
		return { result, capture };
	} finally {
		rmSync(testDirectory, { recursive: true, force: true });
	}
}

describe("editInExternalEditor", () => {
	it("edits a prompt inside a private temporary directory", async () => {
		const { result, capture } = await runExternalEditor();
		const directory = dirname(capture.filePath);

		expect(result).toEqual({ status: "complete", content: "edited" });
		expect(dirname(directory)).toBe(tmpdir());
		expect(basename(directory)).toMatch(new RegExp(`^${APP_NAME}-editor-.+$`));
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

describe("parseEditorCommand", () => {
	it("splits on whitespace when nothing is quoted", () => {
		expect(parseEditorCommand("vim -n")).toEqual(["vim", "-n"]);
		expect(parseEditorCommand("  code   --wait  ")).toEqual(["code", "--wait"]);
	});

	it("keeps a quoted executable path with spaces in one token", () => {
		// The regression this guards: a plain split(" ") launched "C:\Program".
		expect(parseEditorCommand('"C:Program FilesMicrosoft VS CodeCode.exe" --wait')).toEqual([
			"C:Program FilesMicrosoft VS CodeCode.exe",
			"--wait",
		]);
		expect(parseEditorCommand("'/usr/local/my editor' -w")).toEqual(["/usr/local/my editor", "-w"]);
	});

	it("supports an escaped quote inside a double-quoted token", () => {
		expect(parseEditorCommand('"say \\"hi\\"" -n')).toEqual(['say "hi"', "-n"]);
	});

	it("returns an empty argument list for a blank command", () => {
		expect(parseEditorCommand("   ")).toEqual([]);
	});

	it("keeps an empty quoted token", () => {
		expect(parseEditorCommand('vim ""')).toEqual(["vim", ""]);
	});
});
