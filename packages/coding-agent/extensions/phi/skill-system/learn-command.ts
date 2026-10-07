/**
 * `/learn` command + observation of the bundled `learn` tool (plan §C3).
 *
 * The bundled `learn` TOOL cannot be reliably overridden (extension discovery
 * order is not guaranteed), so we OBSERVE it instead: after a successful
 * promoted write we lint the produced skill and append the deviations to the
 * result the model reads — same turn, no load-order dependency.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolResultEvent } from "phi-code";

type LearnObservation = { content: ToolResultEvent["content"] };

import { loadConfig } from "./config.ts";
import { buildLearnPrompt } from "./learn-prompt.ts";
import { lintSkill } from "./linter.ts";
import { readTextFile } from "./store.ts";

export function registerLearnCommand(pi: ExtensionAPI): void {
	pi.registerCommand("learn", {
		description: "Distill a reusable skill from any source (folder, URL, conversation, notes)",
		handler: async (args, ctx) => {
			if (!loadConfig().enabled) {
				ctx.ui.notify("skill-system is disabled (skillSystem.enabled=false)", "error");
				return;
			}
			const prompt = buildLearnPrompt(args ?? "");
			ctx.ui.notify("/learn — collecting sources, then writing the skill...", "info");
			pi.sendUserMessage(prompt);
		},
	});
}

/** Returns an augmented result when the bundled `learn` tool wrote off-standard. */
export function observeLearnResult(event: ToolResultEvent): LearnObservation | undefined {
	if (event.toolName !== "learn") return undefined;
	if (event.isError) return undefined;
	const details = event.details;
	if (!details || typeof details !== "object") return undefined;
	const record = details as { promoted?: unknown; path?: unknown; slug?: unknown };
	if (record.promoted !== true) return undefined;
	const dir = typeof record.path === "string" ? record.path : undefined;
	if (!dir) return undefined;
	const skillFile = join(dir, "SKILL.md");
	if (!existsSync(skillFile)) return undefined;
	let findings: ReturnType<typeof lintSkill>;
	try {
		const name = typeof record.slug === "string" ? record.slug : (dir.split(/[\\/]/).pop() ?? "skill");
		findings = lintSkill({ name, dirName: name, raw: readTextFile(skillFile), files: ["SKILL.md"] });
	} catch {
		return undefined;
	}
	if (findings.length === 0) return undefined;
	const lines = findings.map((finding) => `  - ${finding.rule}: ${finding.message}`).join("\n");
	const augmented: (typeof event.content)[number] = {
		type: "text",
		text:
			`\n\nThe bundled \`learn\` tool wrote this skill outside the standards:\n${lines}\n` +
			'Fix it with `skill_manage` (action="patch") — notably the description, capped at 60 characters. ' +
			"For new skills, prefer `/learn` (the command) or `skill_manage` directly.",
	};
	return { content: [...event.content, augmented] };
}
