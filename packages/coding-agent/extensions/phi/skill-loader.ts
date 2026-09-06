/**
 * Skill Loader Extension - Dynamic skill loading and context injection
 *
 * Uses sigma-skills SkillScanner and SkillLoader for skill discovery and matching.
 * Skills are folders containing SKILL.md files with specialized knowledge.
 * When skill-related keywords are detected in user input, a compact skill hint
 * (name, description, SKILL.md path) is appended to the message so the model
 * actually SEES it and can load the full content via the `read` tool. A UI
 * notification alone never reaches the model.
 *
 * Discovery locations (in priority order):
 * 1. .phi/skills/ (project-local, highest priority)
 * 2. ~/.phi/agent/skills/ (global user skills)
 * 3. Bundled skills shipped with the package (lowest priority)
 *
 * Features:
 * - Automatic skill discovery at startup
 * - Keyword-based skill detection with an injection threshold
 * - Auto-injection of skill hints into the model context (autoInject)
 * - /skills command to list available skills
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "phi-code";
import type { SkillsConfig } from "sigma-skills";
import { SkillLoader, SkillScanner } from "sigma-skills";

export default function skillLoaderExtension(pi: ExtensionAPI) {
	// Bundled skills live at <package>/skills in the repo layout (two hops up
	// from extensions/phi/); postinstall copies them to ~/.phi/agent/skills
	// (== globalDir) in the installed layout. Probe both (the scanner dedupes
	// by skill name).
	const bundledCandidates = [join(__dirname, "..", "..", "skills"), join(homedir(), ".phi", "agent", "skills")];
	const cwd = process.cwd();
	const config: SkillsConfig = {
		globalDir: join(homedir(), ".phi", "agent", "skills"),
		projectDir: join(cwd, ".phi", "skills"),
		bundledDir: bundledCandidates.find((dir) => existsSync(dir)) ?? bundledCandidates[0],
		autoInject: true,
		// Ecosystem sources (omp-style discovery): reuse skills written for
		// other agents. Ordered by precedence, first-wins on name dedup.
		extraDirs: [
			join(cwd, ".claude", "skills"),
			join(cwd, ".agents", "skills"),
			join(cwd, ".codex", "skills"),
			join(cwd, ".github", "skills"),
		],
		managedDir: join(homedir(), ".phi", "agent", "managed-skills"),
	};

	const scanner = new SkillScanner(config);
	const loader = new SkillLoader(scanner);

	// Skills already hinted this session — hint each skill once, not on every
	// message of a long conversation about the same topic.
	const hintedSkills = new Set<string>();

	// ─── Input Event: Match skills to user input ─────────────────────

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" };
		}
		// Slash commands and skill blocks are not prose — nothing to match.
		if (event.text.trimStart().startsWith("/")) {
			return { action: "continue" };
		}

		const matches = loader.findRelevantSkills(event.text);
		// findRelevantSkills scores any shared word; require a clear signal
		// (name match or several keywords) before surfacing a skill.
		const strong = matches.filter((m) => m.score >= 3 && !hintedSkills.has(m.skill.name)).slice(0, 2);
		if (strong.length === 0) {
			return { action: "continue" };
		}
		for (const match of strong) {
			hintedSkills.add(match.skill.name);
		}

		const names = strong.map((m) => m.skill.name).join(", ");
		ctx.ui.notify(`📚 Skill hint: ${names} (injected into context)`, "info");

		if (!config.autoInject) {
			return { action: "continue" };
		}

		const hints = strong
			.map((m) => `- ${m.skill.name}: ${m.skill.description} — full content: read ${join(m.skill.path, "SKILL.md")}`)
			.join("\n");
		return {
			action: "transform",
			text: `${event.text}\n\n[Skill hints — relevant local skills detected for this request. Read the SKILL.md before applying:\n${hints}]`,
			images: event.images,
		};
	});

	// ─── /skills Command ─────────────────────────────────────────────

	pi.registerCommand("skills", {
		description: "List available skills or show details for a specific skill",
		handler: async (args, ctx) => {
			const query = args.trim();

			if (!query) {
				// List all skills
				const skills = loader.listSkills();

				if (skills.length === 0) {
					ctx.ui.notify(
						"No skills found. Create skill directories with SKILL.md files in:\n" +
							`- \`${config.projectDir}\` (project-local)\n` +
							`- \`${config.globalDir}\` (global)\n` +
							"Or install bundled skills via `/phi-init`.",
						"info",
					);
					return;
				}

				let message = `**📚 Available Skills (${skills.length}):**\n\n`;
				for (const skill of skills) {
					message += `  **${skill.name}** — ${skill.description}\n`;
					message += `    📁 \`${skill.path}\`\n`;
				}
				message += `\nUse \`/skills <name>\` for details.`;
				ctx.ui.notify(message, "info");
			} else {
				// Show specific skill
				const content = loader.getSkillContext(query);
				if (content) {
					const skill = loader.listSkills().find((s) => s.name === query);
					ctx.ui.notify(
						`**📚 Skill: ${query}**\n\n` +
							`Path: \`${skill?.path || "unknown"}\`\n` +
							`Keywords: ${skill?.keywords.slice(0, 10).join(", ") || "none"}\n\n` +
							`---\n\n${content.slice(0, 2000)}${content.length > 2000 ? "\n\n... (truncated, use `read` for full content)" : ""}`,
						"info",
					);
				} else {
					ctx.ui.notify(`Skill "${query}" not found. Use \`/skills\` to list available skills.`, "warning");
				}
			}
		},
	});
}
