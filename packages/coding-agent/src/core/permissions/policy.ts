/**
 * Permission policy engine. Merges user config (<agentDir>/permissions.json)
 * and project config (<cwd>/.phi/permissions.json).
 *
 * Security model:
 * - The project file is read only for TRUSTED projects (a cloned repo must not
 *   be able to relax the user's policy).
 * - Even when trusted, the project can only TIGHTEN the policy: tier decisions
 *   take the strictest of user and project, and project "allow" rules are ignored.
 *
 * Default behavior when NO config exists: everything allowed. This preserves
 * the pre-permissions behavior of Phi Code (non-regression requirement).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";
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

export interface LoadPolicyOptions {
	/** Whether <cwd>/.phi/permissions.json may be read. Defaults to false (untrusted). */
	projectTrusted?: boolean;
}

let cached: { key: string; policy: ResolvedPolicy } | undefined;

function loadConfigFile(path: string): PermissionsConfig | undefined {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as PermissionsConfig;
	} catch {
		return undefined;
	}
}

/** Cache key component that changes whenever the file is created, edited or deleted. */
function fileStamp(path: string): string {
	try {
		const st = statSync(path);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "absent";
	}
}

const STRICTNESS: Record<PermissionDecision, number> = { allow: 0, prompt: 1, deny: 2 };

function stricter(
	a: PermissionDecision | undefined,
	b: PermissionDecision | undefined,
): PermissionDecision | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

export function loadPolicy(cwd: string, options: LoadPolicyOptions = {}): ResolvedPolicy {
	const userPath = join(getAgentDir(), "permissions.json");
	const projectPath = options.projectTrusted ? join(cwd, ".phi", "permissions.json") : undefined;
	const key = [userPath, fileStamp(userPath), projectPath ?? "-", projectPath ? fileStamp(projectPath) : "-"].join(
		"|",
	);
	if (cached?.key === key) return cached.policy;

	const user = loadConfigFile(userPath);
	const project = projectPath ? loadConfigFile(projectPath) : undefined;
	const legacyAllowAll = !user && !project;

	const config: PermissionsConfig = {
		read: stricter(user?.read, project?.read),
		write: stricter(user?.write, project?.write),
		exec: stricter(user?.exec, project?.exec),
		// Project rules come first but may only add "prompt"/"deny": an "allow" from a
		// project file would override the user's own restrictions.
		rules: [...(project?.rules ?? []).filter((rule) => rule.decision !== "allow"), ...(user?.rules ?? [])],
	};
	cached = { key, policy: { legacyAllowAll, config } };
	return cached.policy;
}

/** Test helper / runtime invalidation. */
export function resetPolicyCache(): void {
	cached = undefined;
}

function isCommandTool(_toolName: string, params: unknown): boolean {
	return !!params && typeof params === "object" && typeof (params as Record<string, unknown>).command === "string";
}

/** Shell operators that chain, substitute or redirect commands. */
function hasShellControlOperators(command: string): boolean {
	return /[;&|`<>\n\r]|\$\(/.test(command);
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
	const chained = isCommandTool(toolName, params) && hasShellControlOperators(subject);
	for (const rule of policy.config.rules ?? []) {
		if (rule.tool !== toolName && rule.tool !== "*") continue;
		if (rule.pattern && !globToRegex(rule.pattern).test(subject)) continue;
		// `allow bash "git *"` must not approve `git status; rm -rf ~`: an allow
		// pattern only vouches for a single simple command.
		if (rule.decision === "allow" && rule.pattern && chained) continue;
		return { decision: rule.decision, tier: tierForTool(toolName, declaredTier), matchedRule: rule };
	}

	const tier = tierForTool(toolName, declaredTier);
	const tierDecision = policy.config[tier] ?? "prompt";
	return { decision: tierDecision, tier };
}
