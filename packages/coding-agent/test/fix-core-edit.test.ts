import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { applyEditsToNormalizedContent } from "../src/core/tools/edit-diff.ts";
import { recoverByAnchors } from "../src/core/tools/edit-hashline.ts";

describe("fix-core edit: single edit object (#7835)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "phi-fix-core-edit-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("accepts edits sent as one object or as a JSON string of one object", async () => {
		const tool = createEditToolDefinition(testDir);
		const prepare = tool.prepareArguments;
		expect(prepare).toBeDefined();
		const single = { oldText: "a", newText: "b" };
		expect(prepare?.({ path: "f.txt", edits: { ...single } })).toEqual({ path: "f.txt", edits: [single] });
		expect(prepare?.({ path: "f.txt", edits: JSON.stringify(single) })).toEqual({ path: "f.txt", edits: [single] });

		const filePath = join(testDir, "f.txt");
		writeFileSync(filePath, "hello a\n");
		const args = prepare?.({ path: "f.txt", edits: { oldText: "hello a", newText: "hello b" } });
		await tool.execute("call", args as never, undefined, undefined, undefined as never);
		expect(readFileSync(filePath, "utf-8")).toBe("hello b\n");
	});
});

describe("fix-core edit: safe hashline anchor recovery", () => {
	it("refuses a window whose first line no longer matches (no one-line slide)", () => {
		// The first line of oldText drifted. The old algorithm anchored the window at the
		// second line and slid it one line past the region, overwriting "tail();".
		const content = ["function a() {", "  one();", "  two();", "  three();", "}", "tail();"].join("\n");
		const oldText = ["function a(x) {", "  one();", "  two();", "  three();", "}"].join("\n");
		const recovery = recoverByAnchors(content, oldText);
		expect(recovery.found).toBe(false);
		expect(() => applyEditsToNormalizedContent(content, [{ oldText, newText: "replaced" }], "f.ts")).toThrow(
			/Could not find/,
		);
	});

	it("refuses when the last line does not match the window end", () => {
		const content = ["start();", "  one();", "  two();", "  three();", "other();", "after();"].join("\n");
		const oldText = ["start();", "  one();", "  two();", "  three();", "end();"].join("\n");
		expect(recoverByAnchors(content, oldText).found).toBe(false);
	});

	it("refuses a window where too many lines were never seen by the model", () => {
		const content = ["begin();", "x1();", "x2();", "x3();", "  one();", "finish();"].join("\n");
		const oldText = ["begin();", "  one();", "finish();"].join("\n");
		expect(recoverByAnchors(content, oldText).found).toBe(false);
	});

	it("does not count a duplicated line twice", () => {
		const content = ["open {", "}", "}", "}", "close"].join("\n");
		const oldText = ["open {", "}", "a", "b", "close"].join("\n");
		const recovery = recoverByAnchors(content, oldText);
		// Only "open {", one "}" and "close" match: 3/5 = 0.6 with the old double counting giving 1.0.
		expect(recovery.score).toBeLessThanOrEqual(0.6);
	});

	it("reports a recovered edit and the overwritten lines in the tool result", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "phi-fix-core-edit-"));
		try {
			const filePath = join(testDir, "f.ts");
			const content = [
				"function greet(name) {",
				'  const msg = "Hello, " + name;',
				"  console.log(msg);",
				"  return msg;",
				"}",
				"",
				"greet('world');",
			].join("\n");
			writeFileSync(filePath, content);
			const oldText = [
				"function greet(name) {",
				"  const msg = 'Hello, ' + name;",
				"  console.log(msg);",
				"  return msg;",
				"}",
			].join("\n");
			const applied = applyEditsToNormalizedContent(content, [{ oldText, newText: "function greet() {}" }], "f.ts");
			expect(applied.recoveredEdits).toEqual([
				{ editIndex: 0, startLine: 0, endLine: 5, score: 0.8, unmatchedWindowLines: 1 },
			]);
			expect(applied.newContent).toBe("function greet() {}\n\ngreet('world');");

			const tool = createEditToolDefinition(testDir);
			const result = await tool.execute(
				"call",
				{ path: "f.ts", edits: [{ oldText, newText: "function greet() {}" }] },
				undefined,
				undefined,
				undefined as never,
			);
			const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
			expect(text).toContain("fuzzy anchor recovery to lines 1-5 (similarity 80%)");
			expect(text).toContain("1 line(s) in that range did not match oldText and were overwritten.");
			expect(text).toContain("Re-read the file to verify the result.");
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("keeps leading and trailing blank lines of oldText aligned with blank lines in the file", () => {
		const content = ["x();", "", "a();", "b2();", "c();", "", "y();"].join("\n");
		const recovery = recoverByAnchors(content, ["", "a();", "b();", "c();", ""].join("\n"));
		expect(recovery).toMatchObject({ found: true, startLine: 1, endLine: 6 });
		expect(recoverByAnchors(["x();", "a();", "b2();", "c();"].join("\n"), "\na();\nb();\nc();").found).toBe(false);
	});
});
