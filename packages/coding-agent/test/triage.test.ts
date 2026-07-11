import { describe, expect, it } from "vitest";
import { estimateFiles, MULTI_FILE_THRESHOLD, type Route, triage } from "../extensions/phi/providers/triage.js";

describe("estimateFiles", () => {
	it("defaults to 1 for prose with no paths", () => {
		expect(estimateFiles("add a login button")).toBe(1);
		expect(estimateFiles("")).toBe(1);
	});
	it("counts distinct path-like tokens", () => {
		expect(estimateFiles("touch src/a.ts and src/b.ts and src/a.ts")).toBe(2);
		expect(estimateFiles("edit main.py, utils.py, test_main.py")).toBe(3);
	});
});

describe("triage — cheapest route consistent with signals", () => {
	it("routes a supplied failing state straight to /debug (no planning)", () => {
		const d = triage({ hasFailingState: true, text: "build a huge app across many files" });
		expect(d.route).toBe("debug");
		expect(d.depth).toBe("minimal");
	});

	it("routes a small self-contained ask to a single shot", () => {
		const d = triage({ text: "rename getUser to fetchUser" });
		expect(d.route).toBe("single-shot");
		expect(d.depth).toBe("minimal");
	});

	it("routes a build-scale request to /build with full depth", () => {
		expect(triage({ text: "build a REST API from scratch" }).route).toBe("build");
		expect(triage({ text: "scaffold a new dashboard component" }).route).toBe("build");
	});

	it("routes a multi-file change to /build even without build keywords", () => {
		const d = triage({ estimatedFiles: MULTI_FILE_THRESHOLD });
		expect(d.route).toBe("build");
		expect(d.reason).toContain("files");
	});

	it("respects planOnly: a build-scale ask becomes /plan, not /build", () => {
		const d = triage({ text: "build a new service", planOnly: true });
		expect(d.route).toBe("plan");
		expect(d.depth).toBe("full");
	});

	it("planOnly does NOT force /plan on a small ask", () => {
		expect(triage({ text: "fix a typo", planOnly: true }).route).toBe("single-shot");
	});

	it("a forced mode always wins", () => {
		for (const r of ["debug", "build", "plan", "single-shot"] as Route[]) {
			expect(triage({ forced: r, text: "anything", hasFailingState: true }).route).toBe(r);
		}
	});

	it("is deterministic", () => {
		const s = { text: "build a new api endpoint with several files" };
		expect(triage(s)).toEqual(triage(s));
	});
});
