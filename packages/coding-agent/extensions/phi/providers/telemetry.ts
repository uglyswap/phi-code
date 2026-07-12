/**
 * Run telemetry — one JSONL line per orchestration run (.phi/runs.jsonl), so
 * "how do /fix //debug //build actually behave over time?" is answered by
 * appending to a file on every run instead of mounting a measurement campaign.
 * Pure record building here; the single append call-site lives in the driver.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PhaseRecord {
	key: string;
	label: string;
	model: string;
	verdict: string | null;
	retried: boolean;
	blockedRetried: boolean;
}

export interface RunRecord {
	mode: string;
	startedAt: string;
	durationMs: number;
	phases: PhaseRecord[];
	completedPhases: number;
	skippedPhases: number;
	sandboxExecs: number;
	outcome: string;
}

/** Build the run record (pure — timestamps/durations are supplied). */
export function buildRunRecord(input: {
	mode: string;
	startedAtMs: number | null;
	endedAtMs: number;
	phases: PhaseRecord[];
	completedPhases: number;
	skippedPhases: number;
	sandboxExecs: number;
	outcome: string;
}): RunRecord {
	const started = input.startedAtMs ?? input.endedAtMs;
	return {
		mode: input.mode,
		startedAt: new Date(started).toISOString(),
		durationMs: Math.max(0, input.endedAtMs - started),
		phases: input.phases,
		completedPhases: input.completedPhases,
		skippedPhases: input.skippedPhases,
		sandboxExecs: input.sandboxExecs,
		// Strip markdown noise; keep the headline single-line and bounded.
		outcome: input.outcome
			.replace(/\*\*|`/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 300),
	};
}

/** Serialize for JSONL (single line, newline-terminated). */
export function toJsonlLine(record: RunRecord): string {
	return `${JSON.stringify(record)}\n`;
}

/** Append a run record to <cwd>/.phi/runs.jsonl. Best-effort — never throws. */
export function appendRunRecord(cwd: string, record: RunRecord): boolean {
	try {
		const file = join(cwd, ".phi", "runs.jsonl");
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, toJsonlLine(record), "utf-8");
		return true;
	} catch {
		return false;
	}
}
