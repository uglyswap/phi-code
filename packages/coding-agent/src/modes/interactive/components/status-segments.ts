import { spawn } from "node:child_process";

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

/** Token usage of a single message, with the provider-reported cost when known. */
export interface MessageUsageForCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

/**
 * Cost in USD of one message's usage. Prefers the provider-reported cost; otherwise estimates it
 * with `rates`, which must be the rates of the model that PRODUCED the message. Summing this per
 * message keeps multi-model sessions (/plan phases, /model switches) correct, whereas pricing the
 * whole session at the current model's rates did not.
 */
export function computeMessageCostUsd(usage: MessageUsageForCost, rates?: ModelCostRates): number {
	if (usage.cost.total > 0) return usage.cost.total;
	return computeSessionCostUsd({ ...usage, cost: 0 }, rates);
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

/**
 * Runner for `git status --porcelain`; injectable for tests. May answer synchronously or
 * asynchronously; the default runner is asynchronous so the footer never blocks rendering.
 */
export type GitPorcelainRunner = (repoDir: string) => string | null | Promise<string | null>;

/** Upper bound for one background `git status`, so a hung git cannot pin a child process. */
const GIT_STATUS_TIMEOUT_MS = 10_000;

/**
 * Asynchronous `git status --porcelain`. Only emptiness matters, so the process is stopped as
 * soon as it prints a non-blank byte: on large repositories this avoids walking every change.
 * `--no-optional-locks` keeps the background call from taking index.lock.
 */
function defaultGitPorcelainRunner(repoDir: string): Promise<string | null> {
	return new Promise((resolvePromise) => {
		let settled = false;
		let output = "";
		const finish = (value: string | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise(value);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("git", ["--no-optional-locks", "status", "--porcelain"], {
				cwd: repoDir,
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			resolvePromise(null);
			return;
		}
		const timer = setTimeout(() => {
			child.kill();
			finish(null);
		}, GIT_STATUS_TIMEOUT_MS);
		timer.unref?.();
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			output += chunk;
			if (output.trim().length > 0) {
				finish(output);
				child.kill();
			}
		});
		// "error" (git missing: ENOENT) must be consumed or Node raises an unhandled exception.
		child.on("error", () => finish(null));
		child.on("close", (code) => finish(code === 0 ? output : null));
	});
}

interface GitDirtyCacheEntry {
	/** null when git failed or the path is not a repository. */
	dirty: boolean | null;
	expiresAt: number;
}

/**
 * Dirty-state lookup with a 2 second TTL cache, called from the footer render path.
 *
 * With an asynchronous runner (the default), isDirty() never blocks: it returns the last known
 * value (null before the first answer) and refreshes it in the background, at most one git
 * process per repository at a time; `onUpdate` fires when a refresh changes the answer so the
 * caller can re-render. The previous implementation ran a synchronous `git status` on the render
 * path every 2 seconds, freezing the TUI on large repositories and on Windows.
 * Returns null when git is unavailable or the path is not a repo.
 */
export class GitDirtyCache {
	private static readonly TTL_MS = 2000;
	private cache = new Map<string, GitDirtyCacheEntry>();
	/** Token of the refresh in flight per repository; invalidate() drops it so a stale answer is ignored. */
	private inFlight = new Map<string, number>();
	private nextRefreshToken = 0;
	private runner: GitPorcelainRunner;
	private now: () => number;
	private onUpdate: (() => void) | undefined;

	constructor(
		runner: GitPorcelainRunner = defaultGitPorcelainRunner,
		now: () => number = Date.now,
		onUpdate?: () => void,
	) {
		this.runner = runner;
		this.now = now;
		this.onUpdate = onUpdate;
	}

	isDirty(repoDir: string): boolean | null {
		const now = this.now();
		const cached = this.cache.get(repoDir);
		if (cached && cached.expiresAt > now) {
			return cached.dirty;
		}
		if (this.inFlight.has(repoDir)) {
			return cached?.dirty ?? null;
		}

		const output = this.runner(repoDir);
		if (!(output instanceof Promise)) {
			if (output === null) return null;
			const dirty = parseGitPorcelainDirty(output);
			this.cache.set(repoDir, { dirty, expiresAt: now + GitDirtyCache.TTL_MS });
			return dirty;
		}

		const token = ++this.nextRefreshToken;
		this.inFlight.set(repoDir, token);
		void output
			.catch(() => null)
			.then((result) => {
				if (this.inFlight.get(repoDir) !== token) return;
				this.inFlight.delete(repoDir);
				const dirty = result === null ? null : parseGitPorcelainDirty(result);
				const previous = this.cache.get(repoDir)?.dirty ?? null;
				// Failures are cached too, so a broken git is not respawned on every frame.
				this.cache.set(repoDir, { dirty, expiresAt: this.now() + GitDirtyCache.TTL_MS });
				if (dirty !== previous) this.onUpdate?.();
			});
		return cached?.dirty ?? null;
	}

	invalidate(repoDir?: string): void {
		if (repoDir === undefined) {
			this.cache.clear();
			this.inFlight.clear();
		} else {
			this.cache.delete(repoDir);
			this.inFlight.delete(repoDir);
		}
	}
}
