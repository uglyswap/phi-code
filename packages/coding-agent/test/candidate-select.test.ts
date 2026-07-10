import { describe, expect, it } from "vitest";
import {
	diffChangedLines,
	type FixCandidate,
	selectMinimalPassingCandidate,
} from "../extensions/phi/providers/candidate-select.js";

const patch = (changedLines: number) => {
	// A well-formed unified diff with `changedLines` +/- lines plus headers.
	const body = Array.from({ length: changedLines }, (_, i) => (i % 2 ? `-old${i}` : `+new${i}`)).join("\n");
	return `diff --git a/x.py b/x.py\nindex 111..222 100644\n--- a/x.py\n+++ b/x.py\n@@ -1,3 +1,3 @@\n${body}\n`;
};

describe("diffChangedLines", () => {
	it("counts +/- lines and ignores headers", () => {
		expect(diffChangedLines(patch(4))).toBe(4);
		expect(diffChangedLines("")).toBe(0);
		// headers only, no body changes
		expect(diffChangedLines("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n")).toBe(0);
	});
});

describe("selectMinimalPassingCandidate", () => {
	it("picks the smallest patch among those that pass the repro", () => {
		const candidates: FixCandidate[] = [
			{ source: "plan", patch: patch(12), passedRepro: true },
			{ source: "single-shot", patch: patch(4), passedRepro: true },
		];
		const sel = selectMinimalPassingCandidate(candidates);
		expect(sel.chosen?.source).toBe("single-shot");
		expect(sel.chosenSize).toBe(4);
		expect(sel.reason).toContain("smallest patch that passes");
	});

	it("prefers a passing candidate even if a smaller one FAILS the repro", () => {
		// The small one is wrong (fails repro); the larger one is correct.
		const candidates: FixCandidate[] = [
			{ source: "single-shot", patch: patch(2), passedRepro: false },
			{ source: "plan", patch: patch(8), passedRepro: true },
		];
		const sel = selectMinimalPassingCandidate(candidates);
		expect(sel.chosen?.source).toBe("plan");
	});

	it("chooses NOTHING when a repro existed but every candidate failed it", () => {
		// This is the anti-'confident wrong' rule: do not ship the least-bad.
		const candidates: FixCandidate[] = [
			{ source: "single-shot", patch: patch(2), passedRepro: false },
			{ source: "plan", patch: patch(9), passedRepro: false },
		];
		const sel = selectMinimalPassingCandidate(candidates);
		expect(sel.chosen).toBeNull();
		expect(sel.reason).toContain("no candidate passed");
	});

	it("falls back to the smallest non-empty patch when there is no repro to gate on", () => {
		const candidates: FixCandidate[] = [
			{ source: "plan", patch: patch(10) },
			{ source: "single-shot", patch: patch(3) },
		];
		const sel = selectMinimalPassingCandidate(candidates);
		expect(sel.chosen?.source).toBe("single-shot");
		expect(sel.reason).toContain("no acceptance repro");
	});

	it("ignores empty patches", () => {
		const candidates: FixCandidate[] = [
			{ source: "single-shot", patch: "   ", passedRepro: true },
			{ source: "plan", patch: patch(6), passedRepro: true },
		];
		const sel = selectMinimalPassingCandidate(candidates);
		expect(sel.chosen?.source).toBe("plan");
	});

	it("returns nothing when no candidate has a patch", () => {
		expect(selectMinimalPassingCandidate([{ source: "plan", patch: "" }]).chosen).toBeNull();
		expect(selectMinimalPassingCandidate([]).chosen).toBeNull();
	});

	it("breaks size ties by list order (caller orders by preference)", () => {
		const candidates: FixCandidate[] = [
			{ source: "plan", patch: patch(5), passedRepro: true },
			{ source: "single-shot", patch: patch(5), passedRepro: true },
		];
		// Equal size → first in list wins; put the preferred source first.
		expect(selectMinimalPassingCandidate(candidates).chosen?.source).toBe("plan");
	});
});
