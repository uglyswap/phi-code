import { describe, expect, it } from "vitest";
import {
	type AcceptanceCriterion,
	checkAcceptance,
	formatAcceptance,
	validateCriteria,
} from "../extensions/phi/providers/acceptance.ts";

describe("checkAcceptance (executable criteria)", () => {
	it("runs each check command and classifies pass/fail/manual", () => {
		const criteria: AcceptanceCriterion[] = [
			{ description: "passes", check: "exit 0" },
			{ description: "fails", check: "exit 1" },
			{ description: "manual, no check" },
		];
		const report = checkAcceptance(criteria);
		expect(report.results[0].satisfied).toBe(true);
		expect(report.results[1].satisfied).toBe(false);
		expect(report.results[2].satisfied).toBeNull();
		expect(report.failed).toHaveLength(1);
		expect(report.manual).toHaveLength(1);
	});

	it("allCheckablePassed is false when any check fails", () => {
		expect(checkAcceptance([{ description: "a", check: "exit 0" }]).allCheckablePassed).toBe(true);
		expect(checkAcceptance([{ description: "a", check: "exit 1" }]).allCheckablePassed).toBe(false);
	});

	it("does NOT count manual criteria as passing (anti-circularity)", () => {
		// Only manual criteria → nothing was actually verified → not "all passed".
		const report = checkAcceptance([{ description: "manual only" }]);
		expect(report.allCheckablePassed).toBe(false);
		expect(report.manual).toHaveLength(1);
	});

	it("treats an empty/whitespace check as manual", () => {
		const report = checkAcceptance([{ description: "x", check: "   " }]);
		expect(report.results[0].satisfied).toBeNull();
	});
});

describe("formatAcceptance", () => {
	it("renders marks for pass/fail/manual", () => {
		const md = formatAcceptance(
			checkAcceptance([
				{ description: "ok", check: "exit 0" },
				{ description: "bad", check: "exit 1" },
				{ description: "man" },
			]),
		);
		expect(md).toContain("✅ ok");
		expect(md).toContain("❌ bad");
		expect(md).toContain("❔ man");
	});
});

describe("validateCriteria", () => {
	it("accepts strings and {description, check} objects", () => {
		const c = validateCriteria(["a plain criterion", { description: "with check", check: "pytest x" }]);
		expect(c).toHaveLength(2);
		expect(c[0]).toEqual({ description: "a plain criterion" });
		expect(c[1]).toEqual({ description: "with check", check: "pytest x" });
	});
	it("drops malformed entries", () => {
		expect(validateCriteria([{ description: "" }, 42, null, { check: "no desc" }])).toEqual([]);
		expect(validateCriteria("not an array")).toEqual([]);
	});
	it("ignores an empty check string", () => {
		expect(validateCriteria([{ description: "d", check: "  " }])).toEqual([{ description: "d", check: undefined }]);
	});
});
