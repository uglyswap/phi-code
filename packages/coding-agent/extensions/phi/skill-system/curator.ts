/**
 * Curator (plan §C5). Deterministic transitions are a PURE function and always
 * active; LLM consolidation is opt-in (`curator.consolidate`). Nothing is ever
 * deleted: archiving moves the folder to `.archive/<name>/` and is reversible.
 * A fresh/never-seen skill is SEEDED, never archived; a `stale` skill that is
 * used again is reactivated.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "phi-code";
import { createSnapshot, restoreSnapshot } from "./backup.ts";
import { type CuratorConfig, loadConfig } from "./config.ts";
import { appendEntry, captureFiles, newEntryId } from "./ledger.ts";
import { archiveDir, skillsRoot, stateDir } from "./paths.ts";
import { parseForkOutput } from "./review.ts";
import { atomicWriteFile, dirExists, fileExists, moveTree, readTextFile, removeTree } from "./store.ts";
import {
	ESSENTIAL_SKILLS,
	isBundledSkill,
	isCuratorManaged,
	readUsageFile,
	saveUsage,
	seedIfMissing,
	type UsageEntry,
} from "./usage.ts";

export interface CuratorState {
	version: 1;
	enabled: boolean;
	paused: boolean;
	last_run_at: string | null;
	last_run_summary: Record<string, number>;
	last_activity_at: string;
	first_seen_at: string;
}

export interface TransitionPlan {
	stale: string[];
	archives: string[];
	reactivations: string[];
	seeds: string[];
	reanchors: string[];
}

export function curatorPath(): string {
	return join(stateDir(), "curator.json");
}

export function loadCuratorState(now: Date): CuratorState {
	try {
		return JSON.parse(readTextFile(curatorPath())) as CuratorState;
	} catch {
		return {
			version: 1,
			enabled: true,
			paused: false,
			last_run_at: null,
			last_run_summary: {},
			last_activity_at: now.toISOString(),
			first_seen_at: now.toISOString(),
		};
	}
}

export async function saveCuratorState(state: CuratorState): Promise<void> {
	await atomicWriteFile(curatorPath(), `${JSON.stringify(state, null, 2)}\n`);
}

export function shouldRunCurator(
	state: CuratorState,
	config: CuratorConfig,
	now: Date,
): { run: boolean; reason: string } {
	if (!config.enabled) return { run: false, reason: "disabled" };
	if (!state.enabled || state.paused) return { run: false, reason: "paused" };
	if (state.last_run_at === null) return { run: true, reason: "first-run" };
	const elapsedHours = (now.getTime() - Date.parse(state.last_run_at)) / 3_600_000;
	if (elapsedHours < config.intervalHours) return { run: false, reason: "interval" };
	const idleHours = (now.getTime() - Date.parse(state.last_activity_at)) / 3_600_000;
	if (idleHours < config.minIdleHours) return { run: false, reason: "not-idle" };
	return { run: true, reason: "due" };
}

/** PURE planner: which transitions would be applied for these entries. */
export function planTransitions(
	entries: Record<string, UsageEntry>,
	observedNames: readonly string[],
	config: CuratorConfig,
	now: Date,
): TransitionPlan {
	const plan: TransitionPlan = { stale: [], archives: [], reactivations: [], seeds: [], reanchors: [] };
	const staleCutoff = now.getTime() - config.staleAfterDays * 86_400_000;
	const archiveCutoff = now.getTime() - config.archiveAfterDays * 86_400_000;
	for (const name of observedNames) {
		const entry = entries[name];
		if (!entry) {
			plan.seeds.push(name);
			continue;
		}
		if (!isCuratorManaged(entry)) continue;
		if (entry.pinned) continue;
		if (ESSENTIAL_SKILLS.has(name)) continue;
		if (entry.state === "archived") continue;
		const bundled = isBundledSkill(name);
		if (bundled && entry.use_count === 0 && entry.state === "active" && entry.archived_at === null) {
			// Bundled skills are re-anchored ONCE so a fresh install is not aged out.
			const anchored = (entry as UsageEntry & { reanchored?: boolean }).reanchored === true;
			if (!anchored) plan.reanchors.push(name);
			continue;
		}
		const anchorIso = entry.last_used_at ?? entry.created_at;
		const anchor = Number.isFinite(Date.parse(anchorIso)) ? Date.parse(anchorIso) : now.getTime();
		if (entry.use_count === 0 && anchor > staleCutoff) {
			if (entry.state === "stale") plan.reactivations.push(name);
			continue;
		}
		if (anchor <= archiveCutoff) {
			plan.archives.push(name);
			continue;
		}
		if (anchor <= staleCutoff && entry.state === "active") plan.stale.push(name);
		else if (anchor > staleCutoff && entry.state === "stale") plan.reactivations.push(name);
	}
	return plan;
}

/** List observed skill names (top-level + one category level). */
export function observedSkillNames(): string[] {
	const root = skillsRoot();
	if (!dirExists(root)) return [];
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
			// Unreadable category folder — skip.
		}
	}
	return names;
}

export interface CuratorRunOptions {
	now?: Date;
	dryRun?: boolean;
	force?: boolean;
	reason?: string;
	/** Force consolidation for this run (CLI override; config otherwise). */
	consolidate?: boolean;
	/** Test seam: override the consolidation fork runner. */
	forkRunner?: ConsolidationForkRunner;
}

export type ConsolidationForkRunner = (prompt: string) => Promise<{ code: number | null; stdout: string }>;

export interface CuratorRunSummary {
	checked: number;
	seeded: number;
	marked_stale: number;
	archived: number;
	reactivated: number;
	refused: number;
	consolidated: number;
	notes: string[];
}

/** Deterministic pass. `dryRun` mutates NOTHING (no state write, no moves). */
export async function runCurator(options: CuratorRunOptions = {}): Promise<CuratorRunSummary> {
	const now = options.now ?? new Date();
	const config = loadConfig();
	const state = loadCuratorState(now);
	if (state.last_run_at === null && !options.force) {
		// First start: give the user a full interval to pin/refuse before touching anything.
		state.last_run_at = now.toISOString();
		await saveCuratorState(state);
		return {
			checked: 0,
			seeded: 0,
			marked_stale: 0,
			archived: 0,
			reactivated: 0,
			refused: 0,
			consolidated: 0,
			notes: ["first run deferred"],
		};
	}
	const { data, unreadable } = readUsageFile();
	if (!data) {
		return {
			checked: 0,
			seeded: 0,
			marked_stale: 0,
			archived: 0,
			reactivated: 0,
			refused: 0,
			consolidated: 0,
			notes: [unreadable ? "usage registry unreadable — aborting" : "no usage registry"],
		};
	}
	const names = observedSkillNames();
	const summary: CuratorRunSummary = {
		checked: names.length,
		seeded: 0,
		marked_stale: 0,
		archived: 0,
		reactivated: 0,
		refused: 0,
		consolidated: 0,
		notes: [],
	};
	const plan = planTransitions(data.skills, names, config.curator, now);
	for (const name of plan.seeds) {
		if (!options.dryRun) seedIfMissing(data, name, now);
		summary.seeded++;
	}
	for (const name of plan.reanchors) {
		const entry = data.skills[name];
		if (entry && !options.dryRun) {
			entry.created_at = now.toISOString();
			(entry as UsageEntry & { reanchored?: boolean }).reanchored = true;
		}
	}
	for (const name of plan.reactivations) {
		const entry = data.skills[name];
		if (entry && !options.dryRun) entry.state = "active";
		summary.reactivated++;
	}
	for (const name of plan.stale) {
		const entry = data.skills[name];
		if (entry && !options.dryRun) entry.state = "stale";
		summary.marked_stale++;
	}
	let archiveBudget = config.curator.maxArchivePerRun;
	for (const name of plan.archives) {
		if (archiveBudget <= 0) {
			summary.refused++;
			summary.notes.push(`archive budget reached — "${name}" left in place`);
			continue;
		}
		archiveBudget--;
		summary.archived++;
		if (options.dryRun) continue;
		const moved = await archiveSkill(name, now);
		if (moved) {
			const entry = data.skills[name];
			if (entry) {
				entry.state = "archived";
				entry.archived_at = now.toISOString();
			}
		} else {
			summary.archived--;
			summary.notes.push(`could not archive "${name}"`);
		}
	}
	if ((options.consolidate || config.curator.consolidate) && !options.dryRun) {
		summary.consolidated = await consolidate(data, now, summary, options.forkRunner);
	}
	if (!options.dryRun) {
		state.last_run_at = now.toISOString();
		state.last_run_summary = {
			checked: summary.checked,
			seeded: summary.seeded,
			marked_stale: summary.marked_stale,
			archived: summary.archived,
			reactivated: summary.reactivated,
			consolidated: summary.consolidated,
		};
		await saveUsage(data);
		await saveCuratorState(state);
	}
	return summary;
}

async function archiveSkill(name: string, now: Date): Promise<boolean> {
	const source = join(skillsRoot(), name);
	const fromCategory = findCategoryDir(name);
	const actual = fromCategory ?? (fileExists(join(source, "SKILL.md")) || dirExists(source) ? source : undefined);
	if (!actual || !fileExists(join(actual, "SKILL.md"))) return false;
	const root = archiveDir();
	let target = join(root, name);
	if (dirExists(target)) target = join(root, `${name}-${now.getTime().toString(36)}`);
	try {
		const refs = captureFiles(actual);
		moveTree(actual, target);
		await appendEntry({
			id: newEntryId(),
			ts: now.toISOString(),
			actor: "curator",
			action: "archive",
			name,
			before: refs,
			after: [],
			evidence: { archived: true, target },
		});
		const parent = dirname(actual);
		if (parent !== skillsRoot()) {
			try {
				if (readdirSync(parent).length === 0) removeTree(parent);
			} catch {
				// Empty-dir cleanup is opportunistic.
			}
		}
		return true;
	} catch {
		return false;
	}
}

function findCategoryDir(name: string): string | undefined {
	const root = skillsRoot();
	if (!dirExists(root)) return undefined;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const candidate = join(root, entry.name, name);
		if (fileExists(join(candidate, "SKILL.md"))) return candidate;
	}
	return undefined;
}

export async function archiveSkillNow(name: string, now: Date): Promise<{ ok: boolean; message: string }> {
	const moved = await archiveSkill(name, now);
	if (!moved) return { ok: false, message: `could not archive "${name}" (not found or move failed)` };
	const { data } = readUsageFile();
	if (data?.skills[name]) {
		data.skills[name].state = "archived";
		data.skills[name].archived_at = now.toISOString();
		await saveUsage(data);
	}
	return { ok: true, message: `archived "${name}"` };
}

/** Restore an archived skill (reversible by construction). */
export async function restoreSkill(name: string, now = new Date()): Promise<{ ok: boolean; message: string }> {
	const archived = join(archiveDir(), name);
	if (!dirExists(archived)) return { ok: false, message: `no archived skill named "${name}"` };
	const target = join(skillsRoot(), name);
	if (dirExists(target)) return { ok: false, message: `"${name}" already exists in the skills root` };
	try {
		moveTree(archived, target);
	} catch (error) {
		return { ok: false, message: `restore failed: ${String(error)}` };
	}
	const { data } = readUsageFile();
	if (data?.skills[name]) {
		data.skills[name].state = "active";
		data.skills[name].archived_at = null;
		await saveUsage(data);
	}
	await appendEntry({
		id: newEntryId(),
		ts: now.toISOString(),
		actor: "user",
		action: "restore",
		name,
		before: [],
		after: [],
		evidence: { restored: true },
	});
	return { ok: true, message: `restored "${name}"` };
}

/** Opt-in LLM consolidation: snapshot first, fork capped, restore on failure. */
async function consolidate(
	data: NonNullable<ReturnType<typeof readUsageFile>["data"]>,
	now: Date,
	summary: CuratorRunSummary,
	forkRunner?: ConsolidationForkRunner,
): Promise<number> {
	const config = loadConfig();
	const candidates = Object.keys(data.skills).filter(
		(name) => isCuratorManaged(data.skills[name]) && !isBundledSkill(name),
	);
	if (candidates.length < 2) return 0;
	const snapshot = createSnapshot("pre-consolidation", config.curator.backup.keep);
	const prompt = [
		"Consolidate the curator-managed skills listed below into class-level umbrellas.",
		"Use skill_manage only. To absorb a skill, call delete with a non-empty `absorbed_into` naming the umbrella —",
		"deletes are ARCHIVED, never permanent. Never create a new skill whose name is an artifact of a session.",
		`Archive at most ${config.curator.maxArchivePerRun} skills in this pass.`,
		`Candidates: ${candidates.join(", ")}`,
	].join("\n");
	const result = forkRunner
		? await forkRunner(prompt)
		: await runConsolidationFork(prompt, config.review.timeoutSeconds);
	const parsed = parseForkOutput(result.stdout);
	const applied = parsed.appliedNames.length;
	if (result.code !== 0 || parsed.errors.length > 0 || applied > config.curator.maxArchivePerRun) {
		const restored = restoreSnapshot(snapshot.id);
		summary.notes.push(
			restored.ok
				? `consolidation failed — restored backup ${snapshot.id} (pre-rollback snapshot ${restored.pre})`
				: `consolidation failed and RESTORE FAILED for ${snapshot.id} — manual recovery needed`,
		);
		return 0;
	}
	await appendEntry({
		id: newEntryId(),
		ts: now.toISOString(),
		action: "consolidate",
		actor: "curator",
		name: "(batch)",
		before: [],
		after: [],
		evidence: { snapshot: snapshot.id, applied },
	});
	return applied;
}

async function runConsolidationFork(
	prompt: string,
	timeoutSeconds: number,
): Promise<{ code: number | null; stdout: string }> {
	const distCli = join(getPackageDir(), "dist", "cli.js");
	const command = existsSync(distCli) ? process.execPath : "phi";
	const args = [
		...(existsSync(distCli) ? [distCli] : []),
		"--print",
		"--mode",
		"json",
		"--no-extensions",
		"--extension",
		join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
		"--tools",
		"skill_manage,read,grep,find,ls",
		"--no-skills",
		"--append-system-prompt",
		prompt,
	];
	return await new Promise<{ code: number | null; stdout: string }>((resolve) => {
		let stdout = "";
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				env: { ...process.env, PHI_SKILL_SYSTEM_REVIEW: "1", PHI_SKILL_SYSTEM_ALLOW_WRITE: "1" },
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			resolve({ code: 1, stdout: "" });
			return;
		}
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// Already dead.
			}
		}, timeoutSeconds * 1000);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ code: 1, stdout });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout });
		});
	});
}
