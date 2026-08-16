import { describe, expect, it } from "vitest";
import type { CommandResult } from "../extensions/phi/providers/execution.ts";
import {
	breakingCasesToFailingStates,
	DEFAULT_REDTEAM_CONFIG,
	enumerateInputRegimes,
	initRedTeam,
	type RedTeamAttempt,
	recordAttempt,
	shouldContinueRedTeam,
} from "../extensions/phi/providers/redteam.ts";

const run = (exitCode: number | null, over: Partial<CommandResult> = {}): CommandResult => ({
	command: "adv",
	exitCode,
	stdout: "",
	stderr: "",
	durationMs: 5,
	timedOut: false,
	...over,
});
const attempt = (regime: string, result: CommandResult | null): RedTeamAttempt => ({
	regime,
	test: `test-${regime}`,
	result,
});

describe("recordAttempt — only a RED run is a break", () => {
	it("records a breaking case and resets dry when a test runs red", () => {
		const s = recordAttempt(
			initRedTeam(),
			attempt("empty input", run(1, { stderr: "AssertionError: boom" })),
			DEFAULT_REDTEAM_CONFIG,
		);
		expect(s.breakingCases).toHaveLength(1);
		expect(s.breakingCases[0].regime).toBe("empty input");
		expect(s.breakingCases[0].symptom).toContain("boom");
		expect(s.dry).toBe(0);
		expect(s.attemptsUsed).toBe(1);
	});

	it("counts a GREEN run as a dry round, no finding", () => {
		const s = recordAttempt(initRedTeam(), attempt("null", run(0)), DEFAULT_REDTEAM_CONFIG);
		expect(s.breakingCases).toHaveLength(0);
		expect(s.dry).toBe(1);
	});

	it("counts an UNRUNNABLE attempt as dry — no break you did not run", () => {
		const s = recordAttempt(initRedTeam(), attempt("wrong type", null), DEFAULT_REDTEAM_CONFIG);
		expect(s.breakingCases).toHaveLength(0);
		expect(s.dry).toBe(1);
	});

	it("a red round after dry rounds resets the counter", () => {
		let s = initRedTeam();
		s = recordAttempt(s, attempt("a", run(0)), DEFAULT_REDTEAM_CONFIG);
		expect(s.dry).toBe(1);
		s = recordAttempt(s, attempt("b", run(2)), DEFAULT_REDTEAM_CONFIG);
		expect(s.dry).toBe(0);
		expect(s.breakingCases).toHaveLength(1);
	});
});

describe("shouldContinueRedTeam", () => {
	it("stops after K consecutive dry rounds", () => {
		const cfg = { dryRoundsToStop: 2, maxAttempts: 10 };
		let s = initRedTeam();
		expect(shouldContinueRedTeam(s, cfg)).toBe(true);
		s = recordAttempt(s, attempt("a", run(0)), cfg);
		expect(shouldContinueRedTeam(s, cfg)).toBe(true);
		s = recordAttempt(s, attempt("b", run(0)), cfg);
		expect(shouldContinueRedTeam(s, cfg)).toBe(false); // 2 dry in a row
	});

	it("stops at the attempt budget", () => {
		const cfg = { dryRoundsToStop: 99, maxAttempts: 2 };
		let s = initRedTeam();
		s = recordAttempt(s, attempt("a", run(1)), cfg); // red → dry stays 0
		s = recordAttempt(s, attempt("b", run(1)), cfg);
		expect(s.attemptsUsed).toBe(2);
		expect(shouldContinueRedTeam(s, cfg)).toBe(false);
	});
});

describe("breakingCasesToFailingStates", () => {
	it("maps each break to a /debug-ready failing state", () => {
		const s = recordAttempt(
			initRedTeam(),
			attempt("boundary value", run(1, { stderr: "off by one" })),
			DEFAULT_REDTEAM_CONFIG,
		);
		const states = breakingCasesToFailingStates(s.breakingCases, "/repo");
		expect(states[0].reproCommand).toBe("test-boundary value");
		expect(states[0].expected).toContain("boundary value");
		expect(states[0].cwd).toBe("/repo");
	});
});

describe("enumerateInputRegimes", () => {
	it("always includes the universal boundaries", () => {
		const r = enumerateInputRegimes();
		expect(r).toEqual(
			expect.arrayContaining(["empty input", "null/undefined", "boundary value", "wrong type", "large input"]),
		);
	});
	it("adds streaming regime when the change touches IO/streaming", () => {
		expect(enumerateInputRegimes({ changedFiles: ["src/http/response.py"] })).toContain("buffered vs streaming");
	});
	it("adds auth regimes for auth-related changes", () => {
		const r = enumerateInputRegimes({ keywords: "validate jwt token on login" });
		expect(r).toContain("expired / tampered token");
	});
	it("stays minimal for an unrelated change", () => {
		expect(enumerateInputRegimes({ changedFiles: ["src/ui/button.tsx"] })).not.toContain("buffered vs streaming");
	});
});
