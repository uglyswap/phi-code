/**
 * Curator integration tests (plan §6.2): dry-run mutates nothing, first pass is
 * deferred, archiving is reversible, fresh skills are never archived, a failed
 * consolidation restores the backup, and the per-run archive cap is enforced.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSnapshots } from "../../extensions/phi/skill-system/backup.ts";
import { loadCuratorState, restoreSkill, runCurator } from "../../extensions/phi/skill-system/curator.ts";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "phi-curator-agent-"));
	process.env.PHI_CODING_AGENT_DIR = agentDir;
	mkdirSync(join(agentDir, "skills"), { recursive: true });
});

afterEach(() => {
	delete process.env.PHI_CODING_AGENT_DIR;
	rmSync(agentDir, { recursive: true, force: true });
});

const NOW = new Date("2026-06-01T12:00:00.000Z");

function makeSkill(name: string): void {
	const dir = join(agentDir, "skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: "Use when testing. Tests."\nversion: 0.1.0\nauthor: Phi Agent\nlicense: MIT\n---\n\n# ${name}\n\n## When to Use\n\nWhen testing.\n`,
	);
}

function writeUsage(
	entries: Record<string, { created_at: string; last_used_at: string | null; use_count: number }>,
): void {
	const skills: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(entries)) {
		skills[name] = {
			created_by: "agent",
			created_at: entry.created_at,
			use_count: entry.use_count,
			view_count: 0,
			last_used_at: entry.last_used_at,
			last_viewed_at: null,
			pinned: false,
			state: "active",
			archived_at: null,
			first_seen_at: entry.created_at,
		};
	}
	const stateDir = join(agentDir, "skills", ".state");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, "usage.json"), JSON.stringify({ version: 1, skills }, null, 2));
}

function writeConfig(partial: Record<string, unknown>): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skillSystem: partial }));
}

describe("curator", () => {
	it("defers the very first pass (full interval for the user to pin/refuse)", async () => {
		makeSkill("old");
		writeUsage({ old: { created_at: "2026-01-01T00:00:00.000Z", last_used_at: null, use_count: 0 } });
		const summary = await runCurator({ now: NOW });
		expect(summary.notes).toContain("first run deferred");
		expect(existsSync(join(agentDir, "skills", "old", "SKILL.md"))).toBe(true);
		expect(loadCuratorState(NOW).last_run_at).toBe(NOW.toISOString());
	});

	it("--dry-run mutates nothing (no moves, no state write)", async () => {
		makeSkill("old");
		writeUsage({
			old: { created_at: "2026-01-01T00:00:00.000Z", last_used_at: "2026-01-02T00:00:00.000Z", use_count: 3 },
		});
		const summary = await runCurator({ now: NOW, dryRun: true, force: true });
		expect(summary.archived).toBe(1);
		expect(existsSync(join(agentDir, "skills", "old", "SKILL.md"))).toBe(true);
		expect(loadCuratorState(NOW).last_run_at).toBeNull();
	});

	it("archives deterministically and restore is reversible", async () => {
		makeSkill("old");
		writeUsage({
			old: { created_at: "2026-01-01T00:00:00.000Z", last_used_at: "2026-01-02T00:00:00.000Z", use_count: 3 },
		});
		const summary = await runCurator({ now: NOW, force: true });
		expect(summary.archived).toBe(1);
		expect(existsSync(join(agentDir, "skills", "old"))).toBe(false);
		expect(existsSync(join(agentDir, "skills", ".archive", "old", "SKILL.md"))).toBe(true);
		const restored = await restoreSkill("old", NOW);
		expect(restored.ok).toBe(true);
		expect(existsSync(join(agentDir, "skills", "old", "SKILL.md"))).toBe(true);
	});

	it("never archives a fresh skill", async () => {
		makeSkill("fresh");
		writeUsage({ fresh: { created_at: "2026-05-31T00:00:00.000Z", last_used_at: null, use_count: 0 } });
		const summary = await runCurator({ now: NOW, force: true });
		expect(summary.archived).toBe(0);
		expect(existsSync(join(agentDir, "skills", "fresh", "SKILL.md"))).toBe(true);
	});

	it("a failed consolidation restores the backup and keeps the skills", async () => {
		makeSkill("alpha");
		makeSkill("beta");
		writeUsage({
			alpha: { created_at: "2026-05-01T00:00:00.000Z", last_used_at: "2026-05-10T00:00:00.000Z", use_count: 2 },
			beta: { created_at: "2026-05-01T00:00:00.000Z", last_used_at: "2026-05-10T00:00:00.000Z", use_count: 2 },
		});
		const summary = await runCurator({
			now: NOW,
			force: true,
			consolidate: true,
			forkRunner: async () => ({ code: 1, stdout: "" }),
		});
		expect(summary.consolidated).toBe(0);
		expect(summary.notes.some((note) => note.includes("restored backup"))).toBe(true);
		expect(existsSync(join(agentDir, "skills", "alpha", "SKILL.md"))).toBe(true);
		expect(existsSync(join(agentDir, "skills", "beta", "SKILL.md"))).toBe(true);
		// pre-consolidation + pre-rollback snapshots both exist.
		expect(listSnapshots().length).toBeGreaterThanOrEqual(2);
	});

	it("enforces maxArchivePerRun and logs the refusal", async () => {
		makeSkill("a");
		makeSkill("b");
		makeSkill("c");
		const old = { created_at: "2026-01-01T00:00:00.000Z", last_used_at: "2026-01-02T00:00:00.000Z", use_count: 1 };
		writeUsage({ a: old, b: old, c: old });
		writeConfig({ curator: { maxArchivePerRun: 1 } });
		const summary = await runCurator({ now: NOW, force: true });
		expect(summary.archived).toBe(1);
		expect(summary.refused).toBe(2);
		expect(summary.notes.some((note) => note.includes("archive budget"))).toBe(true);
	});
});
