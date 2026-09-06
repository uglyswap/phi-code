/**
 * Permission policy engine. Merges user config (~/.phi/agent/permissions.json)
 * and project config (.phi/permissions.json, wins on rules order: project rules
 * are evaluated first).
 *
 * Default behavior when NO config exists: everything allowed. This preserves
 * the pre-permissions behavior of Phi Code (non-regression requirement).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type PermissionTier, tierForTool } from "./tiers.ts";

export type PermissionDecision = "allow" | "deny" | "prompt";

export interface PermissionRule {
	tool: string;
	pattern?: string;
	decision: PermissionDecision;
}

export interface PermissionsConfig {
	read?: PermissionDecision;
	write?: PermissionDecision;
	exec?: PermissionDecision;
	rules?: PermissionRule[];
}

export interface ResolvedPolicy {
	/** True when no config file existed at all (legacy allow-everything mode) */
	legacyAllowAll: boolean;
	config: PermissionsConfig;
}

let cached: { key: string; policy: ResolvedPolicy } | undefined;

function loadConfigFile(path: string): PermissionsConfig | undefined {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8")) as PermissionsConfig;
	} catch {
		return undefined;
	}
}

export function loadPolicy(cwd: string): ResolvedPolicy {
	const userPath = join(homedir(), ".phi", "agent", "permissions.json");
	const projectPath = join(cwd, ".phi", "permissions.json");
	const key = `${userPath}|${projectPath}`;
	if (cached?.key === key) return cached.policy;

	const user = loadConfigFile(userPath);
	const project = loadConfigFile(projectPath);
	const legacyAllowAll = !user && !project;

	const config: PermissionsConfig = {
		read: project?.read ?? user?.read,
		write: project?.write ?? user?.write,
		exec: project?.exec ?? user?.exec,
		// Project rules first (more specific scope wins).
		rules: [...(project?.rules ?? []), ...(user?.rules ?? [])],
	};
	cached = { key, policy: { legacyAllowAll, config } };
	return cached.policy;
}

/** Test helper / runtime invalidation. */
export function resetPolicyCache(): void {
	cached = undefined;
}

function globToRegex(glob: string): RegExp {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

/** Extract the string a rule pattern matches against (bash: the command). */
function subjectForTool(_toolName: string, params: unknown): string {
	if (params && typeof params === "object") {
		const p = params as Record<string, unknown>;
		if (typeof p.command === "string") return p.command;
		if (typeof p.path === "string") return p.path;
	}
	try {
		return JSON.stringify(params) ?? "";
	} catch {
		return "";
	}
}

export function decide(
	policy: ResolvedPolicy,
	toolName: string,
	params: unknown,
	declaredTier?: PermissionTier,
): { decision: PermissionDecision; tier: PermissionTier; matchedRule?: PermissionRule } {
	if (policy.legacyAllowAll) {
		return { decision: "allow", tier: tierForTool(toolName, declaredTier) };
	}

	const subject = subjectForTool(toolName, params);
	for (const rule of policy.config.rules ?? []) {
		if (rule.tool !== toolName && rule.tool !== "*") continue;
		if (rule.pattern && !globToRegex(rule.pattern).test(subject)) continue;
		return { decision: rule.decision, tier: tierForTool(toolName, declaredTier), matchedRule: rule };
	}

	const tier = tierForTool(toolName, declaredTier);
	const tierDecision = policy.config[tier] ?? "prompt";
	return { decision: tierDecision, tier };
}
