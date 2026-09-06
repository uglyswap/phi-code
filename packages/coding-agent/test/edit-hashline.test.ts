import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent } from "../src/core/tools/edit-diff.ts";
import { computeAnchors, lineAnchor, recoverByAnchors } from "../src/core/tools/edit-hashline.ts";

describe("hashline anchors", () => {
	it("computes stable anchors for lines", () => {
		const content = "const a = 1;\nconst b = 2;\nconst a = 1;";
		const anchors = computeAnchors(content);
		expect(anchors.get(lineAnchor("const a = 1;"))).toEqual([0, 2]);
		expect(anchors.get(lineAnchor("const b = 2;"))).toEqual([1]);
	});

	it("recovers a drifted window when most lines still match", () => {
		const content = [
			"function greet(name) {",
			'  const msg = "Hello, " + name;', // drifted from single quotes
			"  console.log(msg);",
			"}",
			"greet('world');",
		].join("\n");
		const oldText = ['function greet(name) {', "  const msg = 'Hello, ' + name;", "  console.log(msg);", "}"].join("\n");
		const recovery = recoverByAnchors(content, oldText);
		expect(recovery.found).toBe(true);
		expect(recovery.startLine).toBe(0);
		expect(recovery.endLine).toBe(4);
	});

	it("rejects ambiguous recovery", () => {
		const block = "if (x) {\n  doThing();\n}\n";
		const content = block + "\n" + block;
		const recovery = recoverByAnchors(content, "if (x) {\n  doThing();\n}");
		expect(recovery.found).toBe(false);
		expect(recovery.ambiguous).toBe(true);
	});

	it("does not recover single-line oldText", () => {
		expect(recoverByAnchors("a\nb\nc", "b").found).toBe(false);
	});
});

describe("edit tool anchor recovery integration", () => {
	it("applies an edit when the file drifted since read", () => {
		const content = [
			"function greet(name) {",
			'  const msg = "Hello, " + name;', // quotes changed after the model read the file
			"  console.log(msg);",
			"}",
			"",
			"greet('world');",
		].join("\n");
		const result = applyEditsToNormalizedContent(
			content,
			[
				{
					oldText: ["function greet(name) {", "  const msg = 'Hello, ' + name;", "  console.log(msg);", "}"].join("\n"),
					newText: ["function greet(name) {", "  console.log(`Hi, ${name}`);", "}"].join("\n"),
				},
			],
			"test.ts",
		);
		expect(result.newContent).toContain("console.log(`Hi, ${name}`);");
		expect(result.newContent).toContain("greet('world');");
	});

	it("still throws a not-found error when nothing anchors", () => {
		expect(() =>
			applyEditsToNormalizedContent("const a = 1;\n", [{ oldText: "completely\ndifferent\nblock", newText: "x" }], "test.ts"),
		).toThrow(/Could not find/);
	});

	it("still throws on ambiguous drifted locations", () => {
		// Two identical blocks in the file, both drifted from oldText (line 2
		// renamed), so exact/duplicate handling does not trigger first and both
		// windows score equally at recovery.
		const block = "if (x) {\n  doThing();\n}\n";
		const content = block + "\n" + block;
		expect(() =>
			applyEditsToNormalizedContent(
				content,
				[{ oldText: "if (x) {\n  doThingBefore();\n}", newText: "if (y) {}" }],
				"test.ts",
			),
		).toThrow(/multiple drifted/i);
	});

	it("exact matching keeps working untouched", () => {
		const content = "const a = 1;\nconst b = 2;";
		const result = applyEditsToNormalizedContent(content, [{ oldText: "const b = 2;", newText: "const b = 3;" }], "test.ts");
		expect(result.newContent).toBe("const a = 1;\nconst b = 3;");
	});
});
