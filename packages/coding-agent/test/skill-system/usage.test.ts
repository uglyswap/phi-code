/**
 * Provenance + ownership guard tests (plan §C2.2, DoD 1bis/7bis).
 *
 * `created_by` is a curator opt-in flag, not authorship; an absent record and
 * `created_by: null` must resolve identically; every autonomy guard fails
 * CLOSED when the registry is unreadable.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../extensions/phi/skill-system/config.ts";
import { planTransitions } from "../../extensions/phi/skill-system/curator.ts";
import {
	adopt,
	canDeleteAutonomously,
	ESSENTIAL_SKILLS,
	emptyUsage,
	isBundledSkill,
	isCuratorManaged,
	isHubInstalled,
	isProtectedBuiltin,
	markUsed,
	seedIfMissing,
	type UsageEntry,
} from "../../extensions/phi/skill-system/usage.ts";

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
	return {
		created_by: "agent",
		created_at: "2026-01-01T00:00:00.000Z",
		use_count: 0,
		view_count: 0,
		last_used_at: null,
		last_viewed_at: null,
		pinned: false,
		state: "active",
		archived_at: null,
		first_seen_at: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("ownership guards (7 conditions)", () => {
	it("1. pinned skills are never deleted autonomously", () => {
		const result = canDeleteAutonomously({ name: "x", entry: entry({ pinned: true }), usageUnreadable: false });
		expect(result.allowed).toBe(false);
		if (!result.allowed) expect(result.reason).toContain("pinned");
	});

	it("2. essential skills are refused", () => {
		expect(ESSENTIAL_SKILLS.has("self-improving")).toBe(true);
		const result = canDeleteAutonomously({ name: "self-improving", entry: entry(), usageUnreadable: false });
		expect(result.allowed).toBe(false);
		if (!result.allowed) expect(result.reason).toContain("essential");
	});

	it("3. external directories are refused", () => {
		const result = canDeleteAutonomously({
			name: "x",
			entry: entry(),
			usageUnreadable: false,
			externalDirs: ["x"],
		});
		expect(result.allowed).toBe(false);
		if (!result.allowed) expect(result.reason).toContain("external");
	});

	it("4. protected built-ins are refused (predicate)", () => {
		expect(isProtectedBuiltin("self-improving")).toBe(true);
		expect(isProtectedBuiltin("docker-ops")).toBe(false);
	});

	it("5. hub-installed skills are refused", () => {
		expect(isHubInstalled(entry({ created_by: "installed" }))).toBe(true);
		const result = canDeleteAutonomously({
			name: "x",
			entry: entry({ created_by: "installed" }),
			usageUnreadable: false,
		});
		expect(result.allowed).toBe(false);
		if (!result.allowed) expect(result.reason).toContain("hub");
	});

	it("6. bundled skills are refused even when curator-managed", () => {
		expect(isBundledSkill("docker-ops")).toBe(true);
		const result = canDeleteAutonomously({ name: "docker-ops", entry: entry(), usageUnreadable: false });
		expect(result.allowed).toBe(false);
		if (!result.allowed) expect(result.reason).toContain("bundled");
	});

	it("7. non curator-managed skills are refused", () => {
		for (const createdBy of ["learn", null] as const) {
			const result = canDeleteAutonomously({
				name: "x",
				entry: entry({ created_by: createdBy }),
				usageUnreadable: false,
			});
			expect(result.allowed).toBe(false);
			if (!result.allowed) expect(result.reason).toContain("curator-managed");
		}
	});

	it("8. an unreadable registry fails CLOSED", () => {
		const result = canDeleteAutonomously({ name: "x", entry: entry(), usageUnreadable: true });
		expect(result.allowed).toBe(false);
		if (!result.allowed) expect(result.reason).toContain("fail");
	});

	it("9. a plain curator-managed skill is allowed", () => {
		const result = canDeleteAutonomously({ name: "my-skill", entry: entry(), usageUnreadable: false });
		expect(result.allowed).toBe(true);
	});
});

describe("provenance semantics", () => {
	it("absent record and created_by null resolve identically", () => {
		expect(isCuratorManaged(undefined)).toBe(false);
		expect(isCuratorManaged(entry({ created_by: null }))).toBe(false);
		expect(isCuratorManaged(entry({ created_by: "agent" }))).toBe(true);
		expect(isCuratorManaged(entry({ created_by: null, agent_created: true }))).toBe(true);
	});

	it("adopt marks curator-managed WITHOUT resetting the clock", () => {
		const usage = emptyUsage();
		seedIfMissing(usage, "s", new Date("2026-01-01T00:00:00.000Z"));
		usage.skills.s.created_by = "learn";
		usage.skills.s.last_used_at = "2026-02-01T00:00:00.000Z";
		const result = adopt(usage, "s");
		expect(result.ok).toBe(true);
		expect(usage.skills.s.created_by).toBe("agent");
		expect(usage.skills.s.last_used_at).toBe("2026-02-01T00:00:00.000Z");
	});

	it("stale -> used reactivates", () => {
		const usage = emptyUsage();
		seedIfMissing(usage, "s", new Date());
		usage.skills.s.state = "stale";
		const mutation = markUsed(usage, "s", new Date());
		expect(mutation.reactivated).toBe(true);
		expect(usage.skills.s.state).toBe("active");
	});

	it("a freshly seeded skill is never planned for archiving", () => {
		const usage = emptyUsage();
		seedIfMissing(usage, "fresh", new Date("2026-06-01T00:00:00.000Z"));
		usage.skills.fresh.created_by = "agent";
		const plan = planTransitions(
			usage.skills,
			["fresh"],
			{ ...DEFAULT_CONFIG.curator, staleAfterDays: 14, archiveAfterDays: 30 },
			new Date("2026-06-02T00:00:00.000Z"),
		);
		expect(plan.archives).toEqual([]);
		expect(plan.stale).toEqual([]);
	});

	it("a stale skill past archiveAfterDays is planned for ARCHIVE (never delete)", () => {
		const usage = emptyUsage();
		seedIfMissing(usage, "old", new Date("2026-01-01T00:00:00.000Z"));
		usage.skills.old.created_by = "agent";
		usage.skills.old.use_count = 3;
		usage.skills.old.last_used_at = "2026-01-02T00:00:00.000Z";
		const plan = planTransitions(
			usage.skills,
			["old"],
			{ ...DEFAULT_CONFIG.curator, staleAfterDays: 14, archiveAfterDays: 30 },
			new Date("2026-06-01T00:00:00.000Z"),
		);
		expect(plan.archives).toEqual(["old"]);
	});

	it("non-curator-managed skills are never planned for transitions", () => {
		const usage = emptyUsage();
		seedIfMissing(usage, "learned", new Date("2026-01-01T00:00:00.000Z"));
		usage.skills.learned.created_by = "learn";
		const plan = planTransitions(
			usage.skills,
			["learned"],
			{ ...DEFAULT_CONFIG.curator, staleAfterDays: 14, archiveAfterDays: 30 },
			new Date("2026-06-01T00:00:00.000Z"),
		);
		expect(plan.archives).toEqual([]);
		expect(plan.stale).toEqual([]);
	});
});
