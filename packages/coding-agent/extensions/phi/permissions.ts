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
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "phi-code";

const USER_CONFIG = join(homedir(), ".phi", "agent", "permissions.json");
const TIERS = ["read", "write", "exec"] as const;
const DECISIONS = ["allow", "deny", "prompt"] as const;

function loadUserConfig(): Record<string, unknown> {
	try {
		if (existsSync(USER_CONFIG)) return JSON.parse(readFileSync(USER_CONFIG, "utf8"));
	} catch {}
	return {};
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
				config[tier] = decision;
				mkdirSync(join(homedir(), ".phi", "agent"), { recursive: true });
				writeFileSync(USER_CONFIG, JSON.stringify(config, null, 2));
				ctx.ui.notify(
					`Permission tier "${tier}" set to "${decision}" (user config). New sessions pick it up.`,
					"info",
				);
				return;
			}

			if (parts.length > 0) {
				ctx.ui.notify(`Usage: /permissions [${TIERS.join("|")} ${DECISIONS.join("|")}]`, "error");
				return;
			}

			const user = loadUserConfig();
			const summary = [
				existsSync(USER_CONFIG) || existsSync(join(ctx.cwd, ".phi", "permissions.json"))
					? "Custom policy active"
					: "Legacy allow-everything mode (no permissions.json found)",
				`tiers: ${TIERS.map((t) => `${t}=${(user[t] as string) ?? "prompt"}`).join(" ")}`,
				`user rules: ${Array.isArray(user.rules) ? user.rules.length : 0}`,
				"toggle: /permissions <read|write|exec> <allow|deny|prompt>",
			].join(" | ");
			ctx.ui.notify(summary, "info");
		},
	});
}
