import { describe, expect, test } from "vitest";
import {
	extractBlockingFindings,
	extractHandoff,
	isTransientError,
	parsePhaseVerdict,
} from "../extensions/phi/providers/orchestrator-helpers.ts";

describe("parsePhaseVerdict", () => {
	test("parses the canonical verdict line with markdown hashes", () => {
		expect(parsePhaseVerdict("## VERDICT: PASS\n\n# Report")).toBe("PASS");
		expect(parsePhaseVerdict("## VERDICT: FAIL")).toBe("FAIL");
		expect(parsePhaseVerdict("VERDICT: BLOCKED")).toBe("BLOCKED");
		expect(parsePhaseVerdict("#### VERDICT:SKIP")).toBe("SKIP");
	});
	test("is case-insensitive and tolerant of bold/markup", () => {
		expect(parsePhaseVerdict("**VERDICT:** pass")).toBe("PASS");
		expect(parsePhaseVerdict("verdict: fail")).toBe("FAIL");
	});
	test("returns null when no verdict is present", () => {
		expect(parsePhaseVerdict("# Report\nno verdict here")).toBeNull();
		expect(parsePhaseVerdict("")).toBeNull();
	});
	test("only matches a verdict at the start of a line (not mid-sentence prose)", () => {
		// A model that writes 'the VERDICT: is unclear' mid-paragraph must NOT be
		// read as a real verdict; the contract is a leading line.
		expect(parsePhaseVerdict("The final verdict: pass or fail is unclear.")).toBeNull();
	});
	test("takes the FIRST verdict line when the report accidentally has several", () => {
		expect(parsePhaseVerdict("## VERDICT: FAIL\n...\n## VERDICT: PASS")).toBe("FAIL");
	});
	test("rejects an unknown verdict token", () => {
		expect(parsePhaseVerdict("VERDICT: MAYBE")).toBeNull();
	});
});

describe("extractBlockingFindings / extractHandoff", () => {
	const report = [
		"## VERDICT: FAIL",
		"# Final Review",
		"## Findings",
		"- a.ts:1 - bug",
		"## BLOCKING",
		"- a.ts:1 - must fix the null deref",
		"- b.ts:9 - missing await",
		"## HANDOFF",
		"Critical Files: a.ts:1, b.ts:9",
		"Next: fix the two blocking items",
	].join("\n");

	test("extracts the BLOCKING section body", () => {
		const b = extractBlockingFindings(report);
		expect(b).toContain("must fix the null deref");
		expect(b).toContain("missing await");
		expect(b).not.toContain("VERDICT");
		expect(b).not.toContain("Critical Files");
	});
	test("extracts the HANDOFF section body", () => {
		const h = extractHandoff(report);
		expect(h).toContain("Critical Files: a.ts:1, b.ts:9");
		expect(h).toContain("Next: fix");
		expect(h).not.toContain("must fix the null deref");
	});
	test("returns empty string when section is absent", () => {
		expect(extractBlockingFindings("# no blocking")).toBe("");
		expect(extractHandoff("")).toBe("");
	});
	test("extracts a HANDOFF written as a heading, a bold label, or a plain label", () => {
		// Models emit all three shapes for the same section — tolerate each.
		expect(extractHandoff("### HANDOFF\nNext: ship it\n")).toContain("Next: ship it");
		expect(extractHandoff("**HANDOFF**\nNext: bold form\n")).toContain("Next: bold form");
		expect(extractHandoff("HANDOFF:\nNext: plain form\n")).toContain("Next: plain form");
	});
	test("stops the section at the next heading of any level", () => {
		const r = "## BLOCKING\n- fix x\n### Sub\n- detail\n## HANDOFF\nNext: y";
		const b = extractBlockingFindings(r);
		expect(b).toContain("fix x");
		expect(b).not.toContain("Next: y");
	});
	test("splits a report written entirely with bold labels (no headings)", () => {
		const r = "**BLOCKING**\n- fix the deref\n**HANDOFF**\nNext: patch it";
		expect(extractBlockingFindings(r)).toContain("fix the deref");
		expect(extractBlockingFindings(r)).not.toContain("Next: patch it");
		expect(extractHandoff(r)).toContain("Next: patch it");
	});
	test("does not truncate a body that contains inline bold", () => {
		const r = "## BLOCKING\n- **Critical**: null deref in a.ts\n- **High**: missing await\n## HANDOFF\nNext: fix";
		const b = extractBlockingFindings(r);
		expect(b).toContain("null deref");
		expect(b).toContain("missing await");
	});
	test("does not treat a prose line starting with the section word as a header (F7)", () => {
		// "Blocking issues remain: 2" must NOT be read as a BLOCKING header.
		const r = "# Report\nBlocking issues remain: 2 in total.\n## BLOCKING\n- the real one\n## HANDOFF\nNext: go";
		const b = extractBlockingFindings(r);
		expect(b).toContain("the real one");
		expect(b).not.toContain("remain: 2");
	});
	test("still accepts heading with trailing text (## HANDOFF notes)", () => {
		expect(extractHandoff("## HANDOFF notes\nNext: ship")).toContain("Next: ship");
	});
});

describe("isTransientError", () => {
	const msg = (content: string) => ({ content });
	test("flags timeouts, 5xx, 429 and broken JSON", () => {
		expect(isTransientError([msg("Error: request timed out after 300s")])).toBe(true);
		expect(isTransientError([msg("HTTP 503 Service Unavailable")])).toBe(true);
		expect(isTransientError([msg("429 too many requests")])).toBe(true);
		expect(isTransientError([msg("connection reset by peer")])).toBe(true);
		expect(isTransientError([msg("invalid JSON in tool call")])).toBe(true);
		expect(isTransientError([msg("model overloaded, try again")])).toBe(true);
	});
	test("does NOT flag a 401 (fatal, handled separately)", () => {
		expect(isTransientError([msg("401 Unauthorized: invalid access token")])).toBe(false);
	});
	test("does NOT flag normal successful output", () => {
		expect(isTransientError([msg("Successfully wrote 1200 bytes to src/index.ts")])).toBe(false);
		expect(isTransientError([])).toBe(false);
	});
});
