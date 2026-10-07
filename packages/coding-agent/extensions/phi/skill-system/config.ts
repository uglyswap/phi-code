/**
 * Configuration for the skill-system extension (plan §5.2, §5.3).
 *
 * Reads `skillSystem.*` from `<agentDir>/settings.json` on every call (cheap,
 * and honors PHI_CODING_AGENT_DIR). Malformed values fall back to defaults —
 * a broken settings file must never take the extension offline.
 *
 * Environment flags use the branded-then-legacy order (PHI_ then PI_). The
 * core `readBrandedEnv` helper is not exported to extensions, so the same
 * semantics are implemented locally.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "phi-code";

export interface ReviewConfig {
	enabled: boolean;
	nudgeInterval: number;
	minIntervalSeconds: number;
	maxIterations: number;
	timeoutSeconds: number;
	maxDigestChars: number;
	dailyBudgetUSD: number;
	model: string | null;
	notify: "off" | "on" | "verbose";
}

export interface CuratorConfig {
	enabled: boolean;
	intervalHours: number;
	minIdleHours: number;
	staleAfterDays: number;
	archiveAfterDays: number;
	consolidate: boolean;
	pruneBundled: boolean;
	maxArchivePerRun: number;
	backup: { enabled: boolean; keep: number };
}

export interface SkillSystemConfig {
	enabled: boolean;
	createDir: string | null;
	writeApproval: boolean;
	security: { scanOnWrite: boolean; quarantineProjectSkills: boolean };
	lint: { enabled: boolean; blockOnInjection: boolean };
	learn: Record<string, never>;
	review: ReviewConfig;
	curator: CuratorConfig;
	ledger: { enabled: boolean; maxBytes: number; blobGraceSeconds: number };
}

export const DEFAULT_CONFIG: SkillSystemConfig = {
	enabled: true,
	createDir: null,
	writeApproval: false,
	security: { scanOnWrite: false, quarantineProjectSkills: true },
	lint: { enabled: true, blockOnInjection: true },
	learn: {},
	review: {
		enabled: true,
		nudgeInterval: 10,
		minIntervalSeconds: 300,
		maxIterations: 12,
		timeoutSeconds: 180,
		maxDigestChars: 120000,
		dailyBudgetUSD: 0.5,
		model: null,
		notify: "on",
	},
	curator: {
		enabled: true,
		intervalHours: 168,
		minIdleHours: 2,
		staleAfterDays: 14,
		archiveAfterDays: 30,
		consolidate: false,
		pruneBundled: false,
		maxArchivePerRun: 10,
		backup: { enabled: true, keep: 2 },
	},
	ledger: { enabled: true, maxBytes: 5242880, blobGraceSeconds: 3600 },
};

/** PHI_SKILL_SYSTEM_<suffix> then PI_SKILL_SYSTEM_<suffix>. */
export function readSkillSystemEnv(suffix: string): string | undefined {
	return process.env[`PHI_SKILL_SYSTEM_${suffix}`] ?? process.env[`PI_SKILL_SYSTEM_${suffix}`];
}

export function isDisabledByEnv(): boolean {
	return readSkillSystemEnv("DISABLE") === "1";
}

/** Set inside the review fork so it never schedules another review. */
export function isReviewFork(): boolean {
	return readSkillSystemEnv("REVIEW") === "1";
}

export function allowWriteOverride(): boolean {
	return readSkillSystemEnv("ALLOW_WRITE") === "1";
}

export function debugEnabled(): boolean {
	return readSkillSystemEnv("DEBUG") === "1";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function asString(value: unknown, fallback: string | null): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Merge + validate the `skillSystem` block of settings.json. */
export function loadConfig(): SkillSystemConfig {
	const d = DEFAULT_CONFIG;
	let raw: Record<string, unknown> = {};
	try {
		const settings = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as Record<
			string,
			unknown
		>;
		raw = asObject(asObject(settings).skillSystem);
	} catch {
		raw = {};
	}
	const security = asObject(raw.security);
	const lint = asObject(raw.lint);
	const review = asObject(raw.review);
	const curator = asObject(raw.curator);
	const curatorBackup = asObject(curator.backup);
	const ledger = asObject(raw.ledger);
	const notify = review.notify;
	return {
		enabled: asBoolean(raw.enabled, d.enabled),
		createDir: asString(raw.createDir, d.createDir),
		writeApproval: asBoolean(raw.writeApproval, d.writeApproval),
		security: {
			scanOnWrite: asBoolean(security.scanOnWrite, d.security.scanOnWrite),
			quarantineProjectSkills: asBoolean(security.quarantineProjectSkills, d.security.quarantineProjectSkills),
		},
		lint: {
			enabled: asBoolean(lint.enabled, d.lint.enabled),
			blockOnInjection: asBoolean(lint.blockOnInjection, d.lint.blockOnInjection),
		},
		learn: {},
		review: {
			enabled: asBoolean(review.enabled, d.review.enabled),
			nudgeInterval: asNumber(review.nudgeInterval, d.review.nudgeInterval, 1, 10000),
			minIntervalSeconds: asNumber(review.minIntervalSeconds, d.review.minIntervalSeconds, 0, 86400),
			maxIterations: asNumber(review.maxIterations, d.review.maxIterations, 1, 1000),
			timeoutSeconds: asNumber(review.timeoutSeconds, d.review.timeoutSeconds, 10, 3600),
			maxDigestChars: asNumber(review.maxDigestChars, d.review.maxDigestChars, 1000, 10_000_000),
			dailyBudgetUSD: asNumber(review.dailyBudgetUSD, d.review.dailyBudgetUSD, 0, 1000),
			model: asString(review.model, d.review.model),
			notify: notify === "off" || notify === "on" || notify === "verbose" ? notify : d.review.notify,
		},
		curator: {
			enabled: asBoolean(curator.enabled, d.curator.enabled),
			intervalHours: asNumber(curator.intervalHours, d.curator.intervalHours, 0, 8760),
			minIdleHours: asNumber(curator.minIdleHours, d.curator.minIdleHours, 0, 8760),
			staleAfterDays: asNumber(curator.staleAfterDays, d.curator.staleAfterDays, 1, 3650),
			archiveAfterDays: asNumber(curator.archiveAfterDays, d.curator.archiveAfterDays, 1, 3650),
			consolidate: asBoolean(curator.consolidate, d.curator.consolidate),
			pruneBundled: asBoolean(curator.pruneBundled, d.curator.pruneBundled),
			maxArchivePerRun: asNumber(curator.maxArchivePerRun, d.curator.maxArchivePerRun, 1, 1000),
			backup: {
				enabled: asBoolean(curatorBackup.enabled, d.curator.backup.enabled),
				keep: asNumber(curatorBackup.keep, d.curator.backup.keep, 0, 100),
			},
		},
		ledger: {
			enabled: asBoolean(ledger.enabled, d.ledger.enabled),
			maxBytes: asNumber(ledger.maxBytes, d.ledger.maxBytes, 1024, 1024 * 1024 * 1024),
			blobGraceSeconds: asNumber(ledger.blobGraceSeconds, d.ledger.blobGraceSeconds, 0, 7 * 86400),
		},
	};
}
