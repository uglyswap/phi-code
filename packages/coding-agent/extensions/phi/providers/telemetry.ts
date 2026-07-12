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
	/** Wall-clock of this phase attempt (ms); absent on legacy records. */
	durationMs?: number;
}

/** Aggregate .phi/runs.jsonl records into a readable markdown summary. */
export function summarizeRuns(records: RunRecord[]): string {
	if (records.length === 0) return "No runs recorded yet — run /fix, /debug or /build first.";
	const byMode = new Map<string, RunRecord[]>();
	for (const r of records) {
		const list = byMode.get(r.mode) ?? [];
		list.push(r);
		byMode.set(r.mode, list);
	}
	const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
	const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
	let out = `**Run telemetry** — ${records.length} run(s)\n\n`;
	out +=
		"| mode | runs | green/finished | blocked | unverified | avg duration | avg sandbox execs |\n|---|---|---|---|---|---|---|\n";
	for (const [mode, rs] of byMode) {
		const green = rs.filter((r) => /GREEN|FIXED|finished/i.test(r.outcome)).length;
		const blocked = rs.filter((r) => /BLOCKED/i.test(r.outcome)).length;
		const unv = rs.filter((r) => /UNVERIFIED/i.test(r.outcome)).length;
		out += `| ${mode} | ${rs.length} | ${pct(green, rs.length)} | ${pct(blocked, rs.length)} | ${pct(unv, rs.length)} | ${Math.round(avg(rs.map((x) => x.durationMs)) / 1000)}s | ${avg(rs.map((x) => x.sandboxExecs))} |\n`;
	}
	// /fix specifics: how often the shot alone was enough (the promise metric).
	const fixes = byMode.get("fix") ?? [];
	if (fixes.length) {
		const greenShot = fixes.filter((r) => /GREEN at single-shot cost/i.test(r.outcome)).length;
		const escalated = fixes.filter((r) => r.phases.some((p) => p.key === "localize" || p.key === "reproduce")).length;
		out += `\n/fix: green at single-shot cost ${pct(greenShot, fixes.length)}, escalated ${pct(escalated, fixes.length)}.\n`;
	}
	// Slowest phase kinds (durationMs is absent on legacy records).
	const durs = new Map<string, number[]>();
	for (const r of records)
		for (const ph of r.phases)
			if (typeof ph.durationMs === "number") {
				const l = durs.get(ph.key) ?? [];
				l.push(ph.durationMs);
				durs.set(ph.key, l);
			}
	if (durs.size) {
		const rows = [...durs]
			.map(([k, xs]) => ({ k, avg: avg(xs), n: xs.length }))
			.sort((a, b) => b.avg - a.avg)
			.slice(0, 5);
		out += `\nSlowest phases (avg): ${rows.map((r) => `${r.k} ${Math.round(r.avg / 1000)}s ×${r.n}`).join(", ")}.\n`;
	}
	const timeouts = records.flatMap((r) => r.phases).filter((p) => p.verdict === "TIMEOUT").length;
	if (timeouts) out += `\n⏰ ${timeouts} phase timeout(s) recorded.\n`;
	return out;
}

/** Parse a runs.jsonl blob (tolerant: bad lines are skipped). */
export function parseRunsJsonl(blob: string): RunRecord[] {
	const out: RunRecord[] = [];
	for (const line of blob.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try {
			const r = JSON.parse(t);
			if (r && typeof r.mode === "string" && Array.isArray(r.phases)) out.push(r as RunRecord);
		} catch {
			/* skip */
		}
	}
	return out;
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
