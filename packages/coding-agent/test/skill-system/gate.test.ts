/**
 * Approval gate tests (plan §6.1/§6.2): one record per batch, approve applies,
 * reject discards, unreadable records are skipped, a replay whose target
 * changed keeps the record with an explicit cause.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPending, deletePending, listPending, readPending } from "../../extensions/phi/skill-system/gate.ts";
import { executeBatch } from "../../extensions/phi/skill-system/tool.ts";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "phi-gate-agent-"));
	process.env.PHI_CODING_AGENT_DIR = agentDir;
	// Enable the staging gate for this suite.
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ skillSystem: { writeApproval: true } }));
});

afterEach(() => {
	delete process.env.PHI_CODING_AGENT_DIR;
	rmSync(agentDir, { recursive: true, force: true });
});

const content = (name: string): string =>
	`---\nname: ${name}\ndescription: "Use when testing. Tests the gate."\nversion: 0.1.0\nauthor: Phi Agent\nlicense: MIT\n---\n\n# ${name}\n\n## When to Use\n\nWhen testing.\n`;

const skillDir = (name: string): string => join(agentDir, "skills", name);
const pendingDir = (): string => join(agentDir, "skills", ".state", "pending");

describe("approval gate", () => {
	it("stages a whole batch as ONE record and applies it on approval", async () => {
		const staged = await executeBatch(
			[
				{ action: "create", name: "gated", content: content("gated") },
				{ action: "write_file", name: "gated", file_path: "references/a.md", file_content: "x" },
			],
			{ origin: "foreground" },
		);
		expect(staged.staged).toBe(true);
		expect(staged.staged_id).toBeDefined();
		expect(existsSync(skillDir("gated"))).toBe(false);
		const records = listPending();
		expect(records.records).toHaveLength(1);
		expect(records.records[0].action).toBe("batch");
		expect(records.records[0].payload.operations).toHaveLength(2);

		const applied = await applyPending(staged.staged_id as string, executeBatch);
		expect(applied.success).toBe(true);
		expect(existsSync(join(skillDir("gated"), "SKILL.md"))).toBe(true);
		expect(existsSync(join(skillDir("gated"), "references", "a.md"))).toBe(true);
		expect(listPending().records).toHaveLength(0);
	});

	it("reject discards the record without applying anything", async () => {
		const staged = await executeBatch([{ action: "create", name: "rejected", content: content("rejected") }], {
			origin: "foreground",
		});
		deletePending(staged.staged_id as string);
		expect(listPending().records).toHaveLength(0);
		expect(existsSync(skillDir("rejected"))).toBe(false);
	});

	it("keeps the record when the replay fails (target changed since staging)", async () => {
		// Create the skill with the gate bypassed so the patch can be staged against it.
		await executeBatch([{ action: "create", name: "changed", content: content("changed") }], {
			origin: "foreground",
			bypassGate: true,
		});
		const staged = await executeBatch(
			[{ action: "patch", name: "changed", old_string: "## When to Use", new_string: "## When to Use (v2)" }],
			{ origin: "foreground" },
		);
		// The target changes: the staged old_string no longer matches.
		writeFileSync(
			join(skillDir("changed"), "SKILL.md"),
			content("changed").replace("## When to Use", "## REWRITTEN"),
		);
		const applied = await applyPending(staged.staged_id as string, executeBatch);
		expect(applied.success).toBe(false);
		expect(readPending(staged.staged_id as string)).toBeDefined();
		expect(String(applied.error)).toContain("KEPT");
	});

	it("skips unreadable records with a count instead of crashing", () => {
		mkdirSync(pendingDir(), { recursive: true });
		writeFileSync(join(pendingDir(), "deadbeef.json"), "{ not json");
		const records = listPending();
		expect(records.records).toHaveLength(0);
		expect(records.skipped).toBe(1);
	});

	it("staging survives an unwritable pending dir by returning a record anyway", async () => {
		// Point the state dir at a path that cannot be created (a file where a dir should be).
		const blocker = join(agentDir, "skills", ".state");
		mkdirSync(join(agentDir, "skills"), { recursive: true });
		writeFileSync(blocker, "not a directory");
		const staged = await executeBatch([{ action: "create", name: "blocked", content: content("blocked") }], {
			origin: "foreground",
		});
		expect(staged.staged).toBe(true);
		expect(staged.staged_id).toBeDefined();
		expect(existsSync(skillDir("blocked"))).toBe(false);
	});

	it("records the number of pending files on disk as one per batch", async () => {
		await executeBatch([{ action: "create", name: "one", content: content("one") }], { origin: "foreground" });
		await executeBatch([{ action: "create", name: "two", content: content("two") }], { origin: "foreground" });
		expect(readdirSync(pendingDir()).filter((file) => file.endsWith(".json"))).toHaveLength(2);
	});
});
