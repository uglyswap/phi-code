/**
 * Skill Loader Extension - Dynamic skill loading and context injection
 *
 * Uses sigma-skills SkillScanner and SkillLoader for skill discovery and matching.
 * Skills are folders containing SKILL.md files with specialized knowledge.
 * When skill-related keywords are detected in user input, the model is notified
 * and can load the full skill content via the `read` tool.
 *
 * Discovery locations (in priority order):
 * 1. .phi/skills/ (project-local, highest priority)
 * 2. ~/.phi/agent/skills/ (global user skills)
 * 3. Bundled skills shipped with the package (lowest priority)
 *
 * Features:
 * - Automatic skill discovery at startup
 * - Keyword-based skill detection and loading
 * - /skills command to list available skills
 * - Contextual skill notification via ui.notify
 */

import type { ExtensionAPI, ExtensionContext } from "phi-code";
import { SkillScanner, SkillLoader } from "sigma-skills";
import type { SkillsConfig } from "sigma-skills";
import { join } from "node:path";
import { homedir } from "node:os";

export default function skillLoaderExtension(pi: ExtensionAPI) {
	const config: SkillsConfig = {
		globalDir: join(homedir(), ".phi", "agent", "skills"),
		projectDir: join(process.cwd(), ".phi", "skills"),
		bundledDir: join(__dirname, "..", "..", "..", "skills"),
		autoInject: true,
	};

	const scanner = new SkillScanner(config);
	const loader = new SkillLoader(scanner);

	// ─── Input Event: Match skills to user input ─────────────────────

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" };
		}

		const matches = loader.findRelevantSkills(event.text);

		if (matches.length > 0) {
			// Notify about top matches (max 3)
			const topMatches = matches.slice(0, 3);
			for (const match of topMatches) {
				ctx.ui.notify(
					`📚 Relevant skill: **${match.skill.name}** — ${match.skill.description}\nUse \`read ${match.skill.path}/SKILL.md\` for full content.`,
					"info"
				);
			}

			const skillNames = topMatches.map(m => m.skill.name).join(", ");
			ctx.ui.notify(`🧠 Loaded ${topMatches.length} skill(s): ${skillNames}`, "info");
		}

		return { action: "continue" };
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
						"info"
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
					const skill = loader.listSkills().find(s => s.name === query);
					ctx.ui.notify(
						`**📚 Skill: ${query}**\n\n` +
						`Path: \`${skill?.path || "unknown"}\`\n` +
						`Keywords: ${skill?.keywords.slice(0, 10).join(", ") || "none"}\n\n` +
						`---\n\n${content.slice(0, 2000)}${content.length > 2000 ? "\n\n... (truncated, use `read` for full content)" : ""}`,
						"info"
					);
				} else {
					ctx.ui.notify(`Skill "${query}" not found. Use \`/skills\` to list available skills.`, "warning");
				}
			}
		},
	});

	// ─── Session Start: Load skills ──────────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		const skills = loader.listSkills();
		console.log(`[skill-loader] Loaded ${skills.length} skills from 3 locations`);
	});
}
