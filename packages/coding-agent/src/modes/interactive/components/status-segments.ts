import { spawnSync } from "node:child_process";

/**
 * Configurable status line segments for the footer.
 *
 * The footer is assembled from an ordered list of segment ids. The default
 * list (DEFAULT_STATUS_LINE_SEGMENTS) reproduces the historical footer
 * composition plus the cost segment, so enabling this feature is purely
 * additive: nothing disappears unless the user removes a segment via the
 * "statusLine.segments" setting.
 *
 * Segment ids:
 * - "cwd": current working directory, home-shortened (first line)
 * - "git": git branch with dirty marker (appended to the cwd line)
 * - "tokens": cumulative input/output tokens (up/down arrows)
 * - "cache": cache read/write tokens and latest cache hit rate
 * - "cost": cumulative session cost in USD
 * - "context": context window usage percentage
 * - "model": active model id, right-aligned
 */

export const STATUS_LINE_SEGMENT_IDS = ["cwd", "git", "tokens", "cache", "cost", "context", "model"] as const;

export type StatusLineSegmentId = (typeof STATUS_LINE_SEGMENT_IDS)[number];

/**
 * Default composition: the historical footer (cwd, git branch, token stats,
 * context usage, model) plus the cost segment. Purely additive.
 */
export const DEFAULT_STATUS_LINE_SEGMENTS: readonly StatusLineSegmentId[] = STATUS_LINE_SEGMENT_IDS;

const KNOWN_SEGMENTS: ReadonlySet<string> = new Set(STATUS_LINE_SEGMENT_IDS);

/**
 * Resolve the configured segment list. Unknown ids are dropped so a typo in
 * settings.json degrades gracefully instead of blanking the footer. Returns
 * the default composition when the config is missing, not an array, empty,
 * or contains only unknown ids.
 */
export function resolveStatusLineSegments(config: unknown): StatusLineSegmentId[] {
	if (!Array.isArray(config)) return [...DEFAULT_STATUS_LINE_SEGMENTS];
	const resolved: StatusLineSegmentId[] = [];
	for (const entry of config) {
		if (typeof entry !== "string") continue;
		const id = entry.trim();
		if (!KNOWN_SEGMENTS.has(id)) continue;
		const segment = id as StatusLineSegmentId;
		if (!resolved.includes(segment)) resolved.push(segment);
	}
	return resolved.length > 0 ? resolved : [...DEFAULT_STATUS_LINE_SEGMENTS];
}

/** Token usage accumulated over a whole session. */
export interface SessionTokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Cost in USD as reported by providers (0 when unknown). */
	cost: number;
}

/** Per-million-token pricing rates from the model catalogue. */
export interface ModelCostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Cumulative session cost in USD. Prefers the provider-reported cost; when
 * that is zero but tokens were consumed and the catalogue knows the model
 * rates, estimates cost as tokens x price per million.
 */
export function computeSessionCostUsd(totals: SessionTokenTotals, modelCost?: ModelCostRates): number {
	if (totals.cost > 0) return totals.cost;
	if (!modelCost) return 0;
	const estimate =
		(totals.input * modelCost.input +
			totals.output * modelCost.output +
			totals.cacheRead * modelCost.cacheRead +
			totals.cacheWrite * modelCost.cacheWrite) /
		1_000_000;
	return estimate > 0 ? estimate : 0;
}

/** Format a USD cost for compact footer display. */
export function formatCostUsd(cost: number): string {
	if (cost <= 0) return "$0.000";
	if (cost < 0.001) return "$<0.001";
	if (cost >= 100) return `$${cost.toFixed(0)}`;
	return `$${cost.toFixed(3)}`;
}

/**
 * Parse `git status --porcelain` output. Returns true when the working tree
 * or index has any change (dirty), false for a clean tree.
 */
export function parseGitPorcelainDirty(porcelainOutput: string): boolean {
	return porcelainOutput.trim().length > 0;
}

/** Render the git segment text: branch name plus a dirty marker. */
export function formatGitSegment(branch: string | null, dirty: boolean): string | null {
	if (!branch) return null;
	return dirty ? `${branch}*` : branch;
}

/** Runner signature for `git status --porcelain`; injectable for tests. */
export type GitPorcelainRunner = (repoDir: string) => string | null;

function defaultGitPorcelainRunner(repoDir: string): string | null {
	try {
		const result = spawnSync("git", ["--no-optional-locks", "status", "--porcelain"], {
			cwd: repoDir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.status !== 0 || typeof result.stdout !== "string") return null;
		return result.stdout;
	} catch {
		return null;
	}
}

/**
 * Dirty-state lookup with a 2 second TTL cache. `git status --porcelain` is
 * too slow to run on every footer frame, so results are cached per repo.
 * Returns null when git is unavailable or the path is not a repo.
 */
export class GitDirtyCache {
	private static readonly TTL_MS = 2000;
	private cache = new Map<string, { dirty: boolean; expiresAt: number }>();
	private runner: GitPorcelainRunner;
	private now: () => number;

	constructor(runner: GitPorcelainRunner = defaultGitPorcelainRunner, now: () => number = Date.now) {
		this.runner = runner;
		this.now = now;
	}

	isDirty(repoDir: string): boolean | null {
		const now = this.now();
		const cached = this.cache.get(repoDir);
		if (cached && cached.expiresAt > now) {
			return cached.dirty;
		}
		const output = this.runner(repoDir);
		if (output === null) return null;
		const dirty = parseGitPorcelainDirty(output);
		this.cache.set(repoDir, { dirty, expiresAt: now + GitDirtyCache.TTL_MS });
		return dirty;
	}

	invalidate(repoDir?: string): void {
		if (repoDir === undefined) {
			this.cache.clear();
		} else {
			this.cache.delete(repoDir);
		}
	}
}
