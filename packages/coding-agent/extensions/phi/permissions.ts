/**
 * Permissions Extension - /permissions command
 *
 * Shows the effective permission policy and provides quick toggles that write
 * to the user-level config (~/.phi/agent/permissions.json).
 *
 * Usage:
 *   /permissions                  Show effective policy
 *   /permissions exec allow       Set tier decision (read|write|exec allow|deny|prompt)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionCommandContext, getAgentDir } from "phi-code";

/** Resolved per call so PHI_CODING_AGENT_DIR is honored. */
function userConfigPath(): string {
	return join(getAgentDir(), "permissions.json");
}
const TIERS = ["read", "write", "exec"] as const;
const DECISIONS = ["allow", "deny", "prompt"] as const;

/** Returns undefined when the file exists but cannot be parsed (never silently treat it as empty). */
function loadUserConfig(): Record<string, unknown> | undefined {
	return loadConfigObject(userConfigPath());
}

/** {} when absent, undefined when present but not a JSON object. */
function loadConfigObject(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

const STRICTNESS: Record<string, number> = { allow: 0, prompt: 1, deny: 2 };

/**
 * Effective tier decision, mirroring the core engine (src/core/permissions/
 * policy.ts): a trusted project file can only TIGHTEN the user's decision, and
 * an unset tier means "prompt".
 */
function effectiveTier(user: unknown, project: unknown): string {
	const valid = (v: unknown): v is string => typeof v === "string" && v in STRICTNESS;
	const u = valid(user) ? user : undefined;
	const p = valid(project) ? project : undefined;
	if (u && p) return STRICTNESS[u] >= STRICTNESS[p] ? u : p;
	return u ?? p ?? "prompt";
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("permissions", {
		description: "Show or adjust tool permission policy (read/write/exec tiers)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);

			if (parts.length === 2) {
				const [tier, decision] = parts as [string, string];
				if (!(TIERS as readonly string[]).includes(tier) || !(DECISIONS as readonly string[]).includes(decision)) {
					ctx.ui.notify(`Usage: /permissions <${TIERS.join("|")}> <${DECISIONS.join("|")}>`, "error");
					return;
				}
				const config = loadUserConfig();
				if (!config) {
					// Rewriting would drop the user's existing rules.
					ctx.ui.notify(`${userConfigPath()} is not valid JSON; fix it before changing tiers.`, "error");
					return;
				}
				config[tier] = decision;
				mkdirSync(getAgentDir(), { recursive: true });
				writeFileSync(userConfigPath(), JSON.stringify(config, null, 2));
				ctx.ui.notify(`Permission tier "${tier}" set to "${decision}" (user config). Applies immediately.`, "info");
				return;
			}

			if (parts.length > 0) {
				ctx.ui.notify(`Usage: /permissions [${TIERS.join("|")} ${DECISIONS.join("|")}]`, "error");
				return;
			}

			const user = loadUserConfig();
			if (!user) {
				ctx.ui.notify(`${userConfigPath()} is not valid JSON.`, "error");
				return;
			}
			const projectPath = join(ctx.cwd, ".phi", "permissions.json");
			const projectFile = existsSync(projectPath);
			const trusted = ctx.isProjectTrusted();
			// The core engine merges a TRUSTED project file into the policy: show
			// the merged (effective) tiers, not the user file alone. An unparsable
			// project file is ignored by the engine, so it is ignored here too.
			const projectParsed = projectFile && trusted ? loadConfigObject(projectPath) : undefined;
			const project = projectParsed ?? {};
			const projectRules = Array.isArray(project.rules)
				? project.rules.filter((r) => (r as { decision?: unknown })?.decision !== "allow").length
				: 0;
			const summary = [
				existsSync(userConfigPath()) || projectParsed !== undefined
					? "Custom policy active"
					: "Legacy allow-everything mode (no permissions.json found)",
				`tiers: ${TIERS.map((t) => `${t}=${effectiveTier(user[t], project[t])}`).join(" ")}`,
				`user rules: ${Array.isArray(user.rules) ? user.rules.length : 0}`,
				...(projectFile && trusted ? [`project rules: ${projectRules}`] : []),
				...(projectFile && !trusted ? ["project permissions.json ignored (untrusted project)"] : []),
				"toggle: /permissions <read|write|exec> <allow|deny|prompt>",
			].join(" | ");
			ctx.ui.notify(summary, "info");
		},
	});
}
