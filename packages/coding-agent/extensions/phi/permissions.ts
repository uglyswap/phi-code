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
	const path = userConfigPath();
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
			const projectFile = existsSync(join(ctx.cwd, ".phi", "permissions.json"));
			const summary = [
				existsSync(userConfigPath()) || (projectFile && ctx.isProjectTrusted())
					? "Custom policy active"
					: "Legacy allow-everything mode (no permissions.json found)",
				`tiers: ${TIERS.map((t) => `${t}=${(user[t] as string) ?? "prompt"}`).join(" ")}`,
				`user rules: ${Array.isArray(user.rules) ? user.rules.length : 0}`,
				...(projectFile && !ctx.isProjectTrusted() ? ["project permissions.json ignored (untrusted project)"] : []),
				"toggle: /permissions <read|write|exec> <allow|deny|prompt>",
			].join(" | ");
			ctx.ui.notify(summary, "info");
		},
	});
}
