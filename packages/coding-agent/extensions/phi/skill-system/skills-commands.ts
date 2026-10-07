/**
 * `/skill-system` — administrative surface (plan §C5.4, §C6, §C10).
 *
 * Never `/skills`: that name is taken by the bundled skill-loader and a second
 * registration would only create `/skills:2`. Every subcommand is additive; the
 * bare command lists state.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "phi-code";
import { getAgentDir, getPackageDir } from "phi-code";
import { createSnapshot, listSnapshots } from "./backup.ts";
import { loadConfig } from "./config.ts";
import { archiveSkillNow, loadCuratorState, restoreSkill, runCurator } from "./curator.ts";
import { applyPending, buildPendingDiff, deletePending, listPending, readPending } from "./gate.ts";
import { readEntries, rollbackEntry } from "./ledger.ts";
import { lintSkill } from "./linter.ts";
import { locateSkillDir, locksDir, skillsRoot } from "./paths.ts";
import { listFilesRelative, readTextFile } from "./store.ts";
import type { BatchOutcome, ExecuteBatchOptions, SkillOp } from "./tool.ts";
import { isCuratorManaged, readUsageFile, saveUsage, setPinned, usagePath } from "./usage.ts";

export interface SkillCommandDeps {
	apply: (ops: SkillOp[], options: ExecuteBatchOptions) => Promise<BatchOutcome>;
}

function tokenize(args: string): string[] {
	return args
		.trim()
		.split(/\s+/)
		.filter((token) => token !== "");
}

function flagValue(tokens: string[], flag: string): string | undefined {
	const index = tokens.indexOf(flag);
	if (index >= 0 && index + 1 < tokens.length) return tokens[index + 1];
	return undefined;
}

function listSkillNames(): string[] {
	const root = skillsRoot();
	if (!existsSync(root)) return [];
	const names: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		if (existsSync(join(root, entry.name, "SKILL.md"))) {
			names.push(entry.name);
			continue;
		}
		try {
			for (const child of readdirSync(join(root, entry.name), { withFileTypes: true })) {
				if (child.isDirectory() && existsSync(join(root, entry.name, child.name, "SKILL.md")))
					names.push(child.name);
			}
		} catch {
			// Unreadable category — skip.
		}
	}
	return names.sort();
}

function overviewText(): string {
	const names = listSkillNames();
	const { data } = readUsageFile();
	const pending = listPending();
	const pinned = data ? Object.values(data.skills).filter((entry) => entry.pinned).length : 0;
	return [
		`Skills: ${names.length} on disk; ${pending.records.length} pending; ${pinned} pinned`,
		names.length > 0 ? names.map((name) => `- ${name}`).join("\n") : "(no skills yet)",
		pending.records.length > 0 ? "Review with /skill-system pending" : "",
	]
		.filter((line) => line !== "")
		.join("\n");
}

function statusText(): string {
	const config = loadConfig();
	const state = loadCuratorState(new Date());
	const { data } = readUsageFile();
	const names = listSkillNames();
	const pinned = data ? Object.keys(data.skills).filter((name) => data.skills[name].pinned) : [];
	const lru = data
		? Object.entries(data.skills)
				.filter(([, entry]) => entry.last_used_at !== null)
				.sort((a, b) => String(a[1].last_used_at).localeCompare(String(b[1].last_used_at)))
				.slice(0, 5)
				.map(([name, entry]) => `${name} (${entry.last_used_at})`)
		: [];
	return [
		`curator.enabled=${config.curator.enabled} interval=${config.curator.intervalHours}h idle=${config.curator.minIdleHours}h`,
		`last run: ${state.last_run_at ?? "never"} summary=${JSON.stringify(state.last_run_summary)}`,
		`skills on disk: ${names.length}; pinned: ${pinned.join(", ") || "(none)"}`,
		`LRU: ${lru.join(", ") || "(no usage recorded)"}`,
		`usage registry: ${usagePath()}`,
	].join("\n");
}

function doctorText(tokens: string[]): string {
	const issues: string[] = [];
	const names = listSkillNames();
	for (const name of names) {
		const dir = locateSkillDir(name);
		if (!dir) continue;
		try {
			const raw = readTextFile(join(dir, "SKILL.md"));
			const findings = lintSkill({ name, dirName: name, raw, files: listFilesRelative(dir) });
			for (const finding of findings) {
				if (finding.severity === "error" || finding.rule === "dangling-reference") {
					issues.push(`${name}: ${finding.rule} — ${finding.message}`);
				}
			}
		} catch {
			issues.push(`${name}: SKILL.md unreadable`);
		}
	}
	// Orphan locks: lock files for skills that no longer exist on disk.
	try {
		for (const lock of readdirSync(locksDir())) {
			if (!lock.endsWith(".lock")) continue;
			issues.push(`orphan lock candidate: ${lock} (verify with a fresh session)`);
		}
	} catch {
		// No lock directory — nothing to check.
	}
	// Ledger entries pointing at missing skills.
	for (const entry of readEntries(1000)) {
		if (entry.name === "(batch)") continue;
		if (!locateSkillDir(entry.name) && entry.action !== "delete" && entry.action !== "archive") {
			issues.push(`ledger ${entry.id}: references missing skill "${entry.name}"`);
		}
	}
	if (tokens.includes("--extensions")) {
		const globalDir = join(getAgentDir(), "extensions");
		const bundledDir = join(getPackageDir(), "extensions", "phi");
		try {
			const globalNames = new Set(
				readdirSync(globalDir, { withFileTypes: true }).map((entry) => entry.name.replace(/\.ts$/, "")),
			);
			for (const entry of readdirSync(bundledDir, { withFileTypes: true })) {
				const name = entry.name.replace(/\.ts$/, "");
				if (globalNames.has(name))
					issues.push(`duplicate extension load path: ${name} exists globally and bundled`);
			}
		} catch {
			// One of the directories is missing — nothing to compare.
		}
	}
	if (tokens.includes("--fix-descriptions")) {
		for (const name of names) {
			const dir = locateSkillDir(name);
			if (!dir) continue;
			try {
				const findings = lintSkill({ name, dirName: name, raw: readTextFile(join(dir, "SKILL.md")) });
				const tooLong = findings.find((finding) => finding.rule === "description-length");
				if (tooLong) issues.push(`FIX: ${name} — shorten the description to <=60 chars (skill_manage patch)`);
			} catch {
				// Already reported.
			}
		}
	}
	if (issues.length === 0) return "doctor: no inconsistencies detected";
	return `doctor found ${issues.length} issue(s):\n${issues.join("\n")}`;
}

async function approveAll(deps: SkillCommandDeps): Promise<string> {
	const { records } = listPending();
	const lines: string[] = [];
	for (const record of records) {
		const outcome = await applyPending(record.id, deps.apply);
		lines.push(outcome.success ? `applied ${record.id}` : `kept ${record.id}: ${outcome.error}`);
	}
	return lines.length > 0 ? lines.join("\n") : "no pending records";
}

export function registerSkillSystemCommands(pi: ExtensionAPI, deps: SkillCommandDeps): void {
	pi.registerCommand("skill-system", {
		description: "Skill system administration (list, status, curator, gate, ledger, backups, doctor)",
		handler: async (args, ctx) => {
			const tokens = tokenize(args ?? "");
			const [sub = "list"] = tokens;
			const notify = (text: string, level: "info" | "error" = "info"): void => ctx.ui.notify(text, level);
			switch (sub) {
				case "list":
					notify(overviewText());
					return;
				case "status":
					notify(statusText());
					return;
				case "run": {
					const dryRun = tokens.includes("--dry-run");
					const summary = await runCurator({
						dryRun,
						force: true,
						reason: "manual",
						consolidate: tokens.includes("--consolidate"),
					});
					notify(
						`curator ${dryRun ? "(dry-run) " : ""}checked=${summary.checked} seeded=${summary.seeded} ` +
							`stale=${summary.marked_stale} archived=${summary.archived} reactivated=${summary.reactivated}` +
							(summary.notes.length > 0 ? `\n${summary.notes.join("\n")}` : ""),
					);
					return;
				}
				case "pin":
				case "unpin": {
					const name = tokens[1];
					if (!name) return notify(`usage: /skill-system ${sub} <name>`, "error");
					const { data } = readUsageFile();
					if (!data || !data.skills[name]) return notify(`skill "${name}" is not registered`, "error");
					setPinned(data, name, sub === "pin");
					await saveUsage(data);
					return notify(`${sub === "pin" ? "pinned" : "unpinned"} "${name}"`);
				}
				case "archive": {
					const name = tokens[1];
					if (!name) return notify("usage: /skill-system archive <name>", "error");
					const result = await archiveSkillNow(name, new Date());
					return notify(
						result.ok ? `archived "${name}"` : `archive failed: ${result.message}`,
						result.ok ? "info" : "error",
					);
				}
				case "restore": {
					const name = tokens[1];
					if (!name) return notify("usage: /skill-system restore <name>", "error");
					const result = await restoreSkill(name);
					return notify(result.message, result.ok ? "info" : "error");
				}
				case "prune": {
					const days = Number(flagValue(tokens, "--days") ?? loadConfig().curator.archiveAfterDays);
					const { data } = readUsageFile();
					if (!data) return notify("usage registry unavailable", "error");
					const cutoff = Date.now() - days * 86_400_000;
					const lines: string[] = [];
					for (const [name, entry] of Object.entries(data.skills)) {
						if (!isCuratorManaged(entry) || entry.pinned) continue;
						const anchor = Date.parse(entry.last_used_at ?? entry.created_at);
						if (!Number.isFinite(anchor) || anchor > cutoff) continue;
						const result = await archiveSkillNow(name, new Date());
						lines.push(`${name}: ${result.ok ? "archived" : result.message}`);
					}
					return notify(lines.length > 0 ? lines.join("\n") : "nothing to prune");
				}
				case "ledger": {
					const skill = flagValue(tokens, "--skill");
					const limit = Number(flagValue(tokens, "--limit") ?? 20);
					const entries = readEntries(10_000)
						.filter((entry) => (skill ? entry.name === skill : true))
						.slice(-limit);
					return notify(
						entries.length > 0
							? entries
									.map((entry) => `${entry.id} ${entry.ts} ${entry.actor} ${entry.action} ${entry.name}`)
									.join("\n")
							: "ledger is empty",
					);
				}
				case "rollback": {
					const id = tokens[1];
					if (!id) return notify("usage: /skill-system rollback <entry-id>", "error");
					const result = await rollbackEntry(id, (name) => locateSkillDir(name) ?? join(skillsRoot(), name));
					return notify(
						result.ok ? `restored ${result.restored} file(s)` : `rollback failed: ${result.error}`,
						result.ok ? "info" : "error",
					);
				}
				case "backup": {
					if (tokens.includes("--list")) {
						const snapshots = listSnapshots();
						return notify(
							snapshots.length > 0
								? snapshots
										.map((snapshot) => `${snapshot.id} ${snapshot.reason} (${snapshot.file_count} files)`)
										.join("\n")
								: "no snapshots yet",
						);
					}
					const info = createSnapshot(
						tokens.includes("--reason") ? `manual: ${flagValue(tokens, "--reason")}` : "manual",
						loadConfig().curator.backup.keep,
					);
					return notify(
						`snapshot ${info.id} — ${info.file_count} files, ${info.skill_count} skills, ${info.bytes} bytes`,
					);
				}
				case "pending": {
					const { records, skipped } = listPending();
					const lines = records.map(
						(record) => `${record.id} ${new Date(record.created_at).toISOString()} ${record.summary}`,
					);
					if (skipped > 0) lines.push(`(skipped ${skipped} unreadable record(s))`);
					return notify(lines.length > 0 ? lines.join("\n") : "no pending records");
				}
				case "diff": {
					const id = tokens[1];
					if (!id) return notify("usage: /skill-system diff <id>", "error");
					const record = readPending(id);
					if (!record) return notify(`pending record "${id}" not found`, "error");
					const diff = buildPendingDiff(record);
					const limit = ctx.hasUI ? 200 : 40;
					const lines = diff.split("\n");
					const truncated =
						lines.length > limit
							? `${lines.slice(0, limit).join("\n")}\n... (${lines.length - limit} more lines)`
							: diff;
					return notify(truncated);
				}
				case "approve": {
					const id = tokens[1];
					if (id === "all") return notify(await approveAll(deps));
					if (!id) return notify("usage: /skill-system approve <id|all>", "error");
					const outcome = await applyPending(id, deps.apply);
					return notify(
						outcome.success ? `applied ${id}` : `kept ${id}: ${outcome.error}`,
						outcome.success ? "info" : "error",
					);
				}
				case "reject": {
					const id = tokens[1];
					if (id === "all") {
						const { records } = listPending();
						for (const record of records) deletePending(record.id);
						return notify(`rejected ${records.length} record(s)`);
					}
					if (!id) return notify("usage: /skill-system reject <id|all>", "error");
					deletePending(id);
					return notify(`rejected ${id}`);
				}
				case "doctor":
					return notify(doctorText(tokens));
				default:
					return notify(
						[
							"usage: /skill-system <command>",
							"list | status | run [--dry-run] [--consolidate]",
							"pin <name> | unpin <name> | archive <name> | restore <name> | prune [--days N]",
							"ledger [--skill <name>] [--limit N] | rollback <entry-id>",
							"backup [--list] [--reason <text>] | pending | diff <id> | approve <id|all> | reject <id|all>",
							"doctor [--extensions] [--fix-descriptions]",
						].join("\n"),
						"error",
					);
			}
		},
	});
}
