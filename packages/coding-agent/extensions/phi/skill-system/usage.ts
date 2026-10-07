/**
 * Provenance + usage registry (plan §C2.2).
 *
 * `created_by` is NOT authorship — it is the curator opt-in flag:
 *   "agent"     written by the background review (or `adopt`) -> curator-managed
 *   "learn"     foreground learning -> never curator-managed
 *   "installed" installed from a hub
 *   absent/null unmarked -> never curator-managed (absent ≡ null: indexing on
 *               key presence alone already produced bug #67140).
 *
 * The registry also anchors the inactivity clock of the curator (seed at first
 * observation) and accumulates the review budget.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPackageDir } from "phi-code";
import { withLocks } from "./lock.ts";
import { stateDir } from "./paths.ts";
import { atomicWriteFile } from "./store.ts";

export type CreatedBy = "agent" | "learn" | "installed" | null;

export interface UsageEntry {
	created_by: CreatedBy;
	created_at: string;
	use_count: number;
	view_count: number;
	last_used_at: string | null;
	last_viewed_at: string | null;
	pinned: boolean;
	state: "active" | "stale" | "archived";
	archived_at: string | null;
	first_seen_at: string;
	/** Legacy field accepted for back-compat with the curator-managed predicate. */
	agent_created?: boolean;
}

export interface UsageFile {
	version: 1;
	skills: Record<string, UsageEntry>;
	review_costs?: { date: string; usd: number };
}

/** Skills referenced by the system prompt — pinned permanently. */
export const ESSENTIAL_SKILLS: ReadonlySet<string> = new Set(["self-improving"]);

/** Built-ins that must never be touched autonomously (superset hook). */
export function isProtectedBuiltin(name: string): boolean {
	return ESSENTIAL_SKILLS.has(name);
}

export function usagePath(): string {
	return join(stateDir(), "usage.json");
}

export function emptyUsage(): UsageFile {
	return { version: 1, skills: {} };
}

/** Filesystem truth: does a bundled skill with this name ship with the package? */
export function isBundledSkill(name: string): boolean {
	try {
		return existsSync(join(getPackageDir(), "skills", name, "SKILL.md"));
	} catch {
		return false;
	}
}

export function isHubInstalled(entry: UsageEntry | undefined): boolean {
	return entry?.created_by === "installed";
}

export function isCuratorManaged(entry: UsageEntry | undefined): boolean {
	if (!entry) return false;
	return entry.created_by === "agent" || entry.agent_created === true;
}

/**
 * Read the registry. `unreadable` is true when the file EXISTS but cannot be
 * parsed — every autonomy guard must fail closed on that signal.
 */
export function readUsageFile(): { data: UsageFile | undefined; unreadable: boolean } {
	const path = usagePath();
	if (!existsSync(path)) return { data: undefined, unreadable: false };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as UsageFile;
		if (!parsed || typeof parsed !== "object" || typeof parsed.skills !== "object") {
			return { data: undefined, unreadable: true };
		}
		return { data: parsed, unreadable: false };
	} catch {
		return { data: undefined, unreadable: true };
	}
}

export async function saveUsage(data: UsageFile): Promise<void> {
	await withLocks(["usage"], async () => {
		await atomicWriteFile(usagePath(), `${JSON.stringify(data, null, 2)}\n`);
	});
}

export function seedIfMissing(data: UsageFile, name: string, now: Date): { seeded: boolean } {
	if (data.skills[name]) return { seeded: false };
	const stamp = now.toISOString();
	data.skills[name] = {
		created_by: null,
		created_at: stamp,
		use_count: 0,
		view_count: 0,
		last_used_at: null,
		last_viewed_at: null,
		pinned: false,
		state: "active",
		archived_at: null,
		first_seen_at: stamp,
	};
	return { seeded: true };
}

export interface UsageMutation {
	reactivated: boolean;
}

export function markUsed(data: UsageFile, name: string, now: Date): UsageMutation {
	const entry = data.skills[name];
	if (!entry) return { reactivated: false };
	entry.use_count += 1;
	entry.last_used_at = now.toISOString();
	let reactivated = false;
	if (entry.state === "stale") {
		entry.state = "active";
		reactivated = true;
	}
	return { reactivated };
}

export function markViewed(data: UsageFile, name: string, now: Date): void {
	const entry = data.skills[name];
	if (!entry) return;
	entry.view_count += 1;
	entry.last_viewed_at = now.toISOString();
}

export function setPinned(data: UsageFile, name: string, pinned: boolean): boolean {
	const entry = data.skills[name];
	if (!entry) return false;
	entry.pinned = pinned;
	return true;
}

/** Mark a skill as curator-managed WITHOUT resetting its inactivity clock. */
export function adopt(data: UsageFile, name: string): { ok: boolean; reason?: string } {
	const entry = data.skills[name];
	if (!entry) return { ok: false, reason: `skill "${name}" is not registered` };
	if (isBundledSkill(name)) return { ok: false, reason: "bundled skills cannot be adopted" };
	if (isHubInstalled(entry)) return { ok: false, reason: "hub-installed skills cannot be adopted" };
	entry.created_by = "agent";
	return { ok: true };
}

export interface DeleteGuardContext {
	name: string;
	entry: UsageEntry | undefined;
	usageUnreadable: boolean;
	externalDirs?: readonly string[];
}

/** The 7 autonomy-delete conditions; fail-closed on an unreadable registry. */
export function canDeleteAutonomously(ctx: DeleteGuardContext): { allowed: true } | { allowed: false; reason: string } {
	if (ctx.usageUnreadable)
		return { allowed: false, reason: "provenance registry is unreadable — failing closed, no autonomous delete" };
	if (ctx.entry?.pinned) return { allowed: false, reason: "skill is pinned" };
	if (ESSENTIAL_SKILLS.has(ctx.name))
		return { allowed: false, reason: "essential skill referenced by the system prompt" };
	if ((ctx.externalDirs ?? []).includes(ctx.name))
		return { allowed: false, reason: "skill lives in an external directory" };
	if (isProtectedBuiltin(ctx.name)) return { allowed: false, reason: "protected built-in" };
	if (isHubInstalled(ctx.entry)) return { allowed: false, reason: "installed from a hub" };
	if (isBundledSkill(ctx.name)) return { allowed: false, reason: "bundled skill" };
	if (!isCuratorManaged(ctx.entry))
		return { allowed: false, reason: 'not curator-managed (created_by is not "agent")' };
	return { allowed: true };
}

export function todayKey(now: Date): string {
	return now.toISOString().slice(0, 10);
}

export function addReviewCost(data: UsageFile, usd: number, now: Date): void {
	const today = todayKey(now);
	const current = data.review_costs;
	if (!current || current.date !== today) {
		data.review_costs = { date: today, usd };
		return;
	}
	current.usd += usd;
}

export function todayReviewCost(data: UsageFile, now: Date): number {
	if (!data.review_costs || data.review_costs.date !== todayKey(now)) return 0;
	return data.review_costs.usd;
}
