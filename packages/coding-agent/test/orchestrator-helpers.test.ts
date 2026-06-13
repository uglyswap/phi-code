import { describe, expect, test } from "vitest";
import {
	extractBlockingFindings,
	extractHandoff,
	isTransientError,
	parsePhaseVerdict,
} from "../extensions/phi/providers/orchestrator-helpers.js";

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
