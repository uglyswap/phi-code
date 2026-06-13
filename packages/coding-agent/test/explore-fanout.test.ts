import { describe, expect, test } from "vitest";
import {
	defaultExplorerSpecs,
	isRateLimited,
	READONLY_EXPLORER_TOOLS,
} from "../extensions/phi/providers/explore-fanout.js";

describe("isRateLimited", () => {
	test("detects rate-limit / overload markers", () => {
		expect(isRateLimited("HTTP 429 Too Many Requests")).toBe(true);
		expect(isRateLimited("the model is overloaded, retry later")).toBe(true);
		expect(isRateLimited("rate limited by provider")).toBe(true);
		expect(isRateLimited("quota exceeded")).toBe(true);
		expect(isRateLimited("resource exhausted")).toBe(true);
	});
	test("does not flag normal output", () => {
		expect(isRateLimited("Found 3 files; the architecture uses React")).toBe(false);
		expect(isRateLimited("")).toBe(false);
	});
});

describe("defaultExplorerSpecs", () => {
	test("returns three narrow-mandate read-only specs including the description", () => {
		const specs = defaultExplorerSpecs("Add JWT auth");
		expect(specs).toHaveLength(3);
		expect(specs.map((s) => s.focus)).toEqual([
			"architecture & reusable patterns",
			"impacted files",
			"risks & constraints",
		]);
		for (const s of specs) {
			expect(s.prompt).toContain("Add JWT auth");
			expect(s.prompt).toMatch(/read-only/i);
			expect(s.prompt).toMatch(/do NOT modify/i);
		}
	});
});

describe("READONLY_EXPLORER_TOOLS", () => {
	test("contains only read-only tools (no write/edit/bash)", () => {
		expect(READONLY_EXPLORER_TOOLS).toContain("read");
		expect(READONLY_EXPLORER_TOOLS).toContain("grep");
		expect(READONLY_EXPLORER_TOOLS).not.toContain("write");
		expect(READONLY_EXPLORER_TOOLS).not.toContain("edit");
		expect(READONLY_EXPLORER_TOOLS).not.toContain("bash");
	});
});
