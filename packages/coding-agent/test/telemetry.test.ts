import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendRunRecord, buildRunRecord, toJsonlLine } from "../extensions/phi/providers/telemetry.ts";

const input = {
	mode: "debug",
	startedAtMs: 1_000_000,
	endedAtMs: 1_090_000,
	phases: [
		{
			key: "reproduce",
			label: "🔴 Phase 1",
			model: "oc/mimo",
			verdict: "PASS",
			retried: false,
			blockedRetried: false,
		},
		{ key: "fix", label: "🔧 Phase 3", model: "ali/qwen", verdict: null, retried: true, blockedRetried: false },
	],
	completedPhases: 4,
	skippedPhases: 0,
	sandboxExecs: 6,
	outcome: "✅ **/debug finished.**",
};

describe("buildRunRecord / toJsonlLine", () => {
	it("builds a complete record with ISO start and duration", () => {
		const r = buildRunRecord(input);
		expect(r.mode).toBe("debug");
		expect(r.durationMs).toBe(90_000);
		expect(r.startedAt).toBe(new Date(1_000_000).toISOString());
		expect(r.phases).toHaveLength(2);
		expect(r.sandboxExecs).toBe(6);
	});
	it("strips markdown from the outcome and keeps it single-line", () => {
		const r = buildRunRecord({ ...input, outcome: "⏸️ **stopped**\n`BLOCKED` at\nREPRODUCE" });
		expect(r.outcome).toBe("⏸️ stopped BLOCKED at REPRODUCE");
	});
	it("tolerates a null start (duration 0, never negative)", () => {
		expect(buildRunRecord({ ...input, startedAtMs: null }).durationMs).toBe(0);
	});
	it("serializes to exactly one JSONL line", () => {
		const line = toJsonlLine(buildRunRecord(input));
		expect(line.endsWith("\n")).toBe(true);
		expect(line.slice(0, -1)).not.toContain("\n");
		expect(() => JSON.parse(line)).not.toThrow();
	});
});

describe("appendRunRecord", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("appends to <cwd>/.phi/runs.jsonl, creating the directory", () => {
		dir = mkdtempSync(join(tmpdir(), "telem-"));
		expect(appendRunRecord(dir, buildRunRecord(input))).toBe(true);
		expect(appendRunRecord(dir, buildRunRecord({ ...input, mode: "fix" }))).toBe(true);
		const lines = readFileSync(join(dir, ".phi", "runs.jsonl"), "utf-8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[1]).mode).toBe("fix");
	});
});
