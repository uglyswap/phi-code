/**
 * Store tests (plan §6.1): atomic write, BOM-safe read, tmp cleanup, tree
 * helpers.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	atomicWriteFile,
	cleanupStaleTmpFiles,
	copyTree,
	listFilesRelative,
	moveTree,
	readTextFile,
	removeTree,
} from "../../extensions/phi/skill-system/store.ts";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "phi-store-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("store", () => {
	it("writes atomically and leaves no tmp file behind", async () => {
		const file = join(root, "sub", "SKILL.md");
		await atomicWriteFile(file, "hello");
		expect(readFileSync(file, "utf8")).toBe("hello");
		expect(readdirSync(join(root, "sub")).filter((name) => name.includes(".tmp-"))).toHaveLength(0);
	});

	it("overwrites an existing file", async () => {
		const file = join(root, "a.md");
		await atomicWriteFile(file, "v1");
		await atomicWriteFile(file, "v2");
		expect(readFileSync(file, "utf8")).toBe("v2");
	});

	it("strips a leading BOM on read", () => {
		const file = join(root, "bom.md");
		writeFileSync(file, "\uFEFFcontent");
		expect(readTextFile(file)).toBe("content");
	});

	it("cleans stale tmp files but keeps fresh ones", async () => {
		const stale = join(root, ".SKILL.md.tmp-1-1");
		const fresh = join(root, ".SKILL.md.tmp-2-2");
		writeFileSync(stale, "x");
		writeFileSync(fresh, "x");
		const old = new Date(Date.now() - 2 * 3_600_000);
		utimesSync(stale, old, old);
		const removed = cleanupStaleTmpFiles(root);
		expect(removed).toBe(1);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	it("copies, moves and removes trees", () => {
		mkdirSync(join(root, "src", "nested"), { recursive: true });
		writeFileSync(join(root, "src", "nested", "file.md"), "x");
		copyTree(join(root, "src"), join(root, "copy"));
		expect(existsSync(join(root, "copy", "nested", "file.md"))).toBe(true);
		moveTree(join(root, "copy"), join(root, "moved"));
		expect(existsSync(join(root, "copy"))).toBe(false);
		expect(existsSync(join(root, "moved", "nested", "file.md"))).toBe(true);
		removeTree(join(root, "moved"));
		expect(existsSync(join(root, "moved"))).toBe(false);
	});

	it("lists relative files and skips dot/state directories", () => {
		mkdirSync(join(root, ".state"), { recursive: true });
		mkdirSync(join(root, "references"), { recursive: true });
		writeFileSync(join(root, "SKILL.md"), "x");
		writeFileSync(join(root, "references", "a.md"), "x");
		writeFileSync(join(root, ".state", "ledger.jsonl"), "x");
		const files = listFilesRelative(root);
		expect(files).toContain("SKILL.md");
		expect(files).toContain("references/a.md");
		expect(files.some((file) => file.includes(".state"))).toBe(false);
	});
});
