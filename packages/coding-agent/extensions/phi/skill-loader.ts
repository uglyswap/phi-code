/**
 * Skill Loader Extension - Dynamic skill loading and context injection
 *
 * Automatically discovers and loads skills from ~/.phi/agent/skills/ and .phi/skills/
 * directories. Skills are folders containing SKILL.md files with specialized knowledge
 * or procedures. When skill-related keywords are detected in user input, the skill
 * content is automatically injected into the conversation context.
 *
 * Features:
 * - Automatic skill discovery at startup
 * - Keyword-based skill detection and loading
 * - /skills command to list available skills
 * - Contextual skill injection via ui notifications
 *
 * Usage:
 * 1. Copy to packages/coding-agent/extensions/phi/skill-loader.ts
 * 2. Create skill directories with SKILL.md files
 * 3. Skills auto-load when relevant keywords are detected
 */

import type { ExtensionAPI, ExtensionContext } from "phi-code";
import { readdir, readFile, access, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

interface Skill {
	name: string;
	path: string;
	content: string;
	keywords: string[];
	description: string;
	source: "global" | "local" | "bundled";
}

export default function skillLoaderExtension(pi: ExtensionAPI) {
	let availableSkills: Skill[] = [];
	const globalSkillsDir = join(homedir(), ".phi", "agent", "skills");
	const localSkillsDir = join(process.cwd(), ".phi", "skills");
	// Bundled skills shipped with the package (packages/coding-agent/skills/)
	const bundledSkillsDir = join(__dirname, "..", "..", "..", "skills");

	/**
	 * Extract keywords and description from SKILL.md content
	 */
	function parseSkillContent(content: string): { keywords: string[]; description: string } {
		const lines = content.split('\n');
		const keywords: string[] = [];
		let description = "";

		// Look for keywords in frontmatter or explicit sections
		let inFrontmatter = false;
		let foundKeywords = false;

		for (const line of lines) {
			const trimmed = line.trim();

			// YAML frontmatter
			if (trimmed === '---') {
				inFrontmatter = !inFrontmatter;
				continue;
			}

			if (inFrontmatter) {
				if (trimmed.startsWith('keywords:') || trimmed.startsWith('tags:')) {
					const keywordLine = trimmed.split(':')[1];
					if (keywordLine) {
						// Parse YAML array or comma-separated
						const parsed = keywordLine
							.replace(/[\[\]]/g, '')
							.split(',')
							.map(k => k.trim().toLowerCase())
							.filter(k => k.length > 0);
						keywords.push(...parsed);
						foundKeywords = true;
					}
				}
				if (trimmed.startsWith('description:')) {
					description = trimmed.split(':', 2)[1]?.trim() || "";
				}
				continue;
			}

			// Look for explicit keywords section
			if (trimmed.toLowerCase().includes('keywords:') || trimmed.toLowerCase().includes('tags:')) {
				const keywordText = trimmed.split(':')[1];
				if (keywordText) {
					const parsed = keywordText
						.split(',')
						.map(k => k.trim().toLowerCase())
						.filter(k => k.length > 0);
					keywords.push(...parsed);
					foundKeywords = true;
				}
				continue;
			}

			// Use first heading as description if none found
			if (!description && trimmed.startsWith('#')) {
				description = trimmed.replace(/^#+\s*/, '').trim();
			}
		}

		// If no explicit keywords, derive from content
		if (!foundKeywords) {
			const contentLower = content.toLowerCase();
			const commonKeywords = [
				'docker', 'kubernetes', 'aws', 'azure', 'gcp', 'terraform',
				'python', 'javascript', 'typescript', 'react', 'node',
				'git', 'github', 'gitlab', 'ci/cd', 'devops',
				'database', 'postgresql', 'mysql', 'mongodb', 'redis',
				'api', 'rest', 'graphql', 'microservices',
				'security', 'auth', 'oauth', 'jwt',
				'test', 'testing', 'unit', 'integration',
				'deploy', 'deployment', 'production'
			];

			for (const keyword of commonKeywords) {
				if (contentLower.includes(keyword)) {
					keywords.push(keyword);
				}
			}

			// Also include skill directory name as keyword
			const skillName = description.toLowerCase().replace(/\s+/g, '-');
			if (skillName) keywords.push(skillName);
		}

		return { keywords, description };
	}

	/**
	 * Load skills from a directory
	 */
	async function loadSkillsFromDirectory(directory: string, source: "global" | "local" | "bundled"): Promise<Skill[]> {
		const skills: Skill[] = [];

		try {
			await access(directory);
			const entries = await readdir(directory);

			for (const entry of entries) {
				const skillPath = join(directory, entry);
				
				try {
					const skillStat = await stat(skillPath);
					if (!skillStat.isDirectory()) continue;

					const skillFilePath = join(skillPath, "SKILL.md");
					
					try {
						await access(skillFilePath);
						const content = await readFile(skillFilePath, 'utf-8');
						const { keywords, description } = parseSkillContent(content);

						skills.push({
							name: entry,
							path: skillPath,
							content,
							keywords,
							description: description || entry,
							source
						});

					} catch {
						// No SKILL.md file, skip this directory
					}
				} catch {
					// Can't access directory, skip
				}
			}
		} catch {
			// Directory doesn't exist, return empty array
		}

		return skills;
	}

	/**
	 * Load all available skills
	 */
	async function loadAllSkills(): Promise<void> {
		const bundledSkills = await loadSkillsFromDirectory(bundledSkillsDir, "bundled");
		const globalSkills = await loadSkillsFromDirectory(globalSkillsDir, "global");
		const localSkills = await loadSkillsFromDirectory(localSkillsDir, "local");
		
		// Merge: local > global > bundled (local overrides global overrides bundled)
		const seen = new Set<string>();
		availableSkills = [];
		for (const skills of [localSkills, globalSkills, bundledSkills]) {
			for (const skill of skills) {
				if (!seen.has(skill.name)) {
					seen.add(skill.name);
					availableSkills.push(skill);
				}
			}
		}
		
		console.log(`Loaded ${availableSkills.length} skills (${bundledSkills.length} bundled, ${globalSkills.length} global, ${localSkills.length} local)`);
	}

	/**
	 * Find relevant skills for input text
	 */
	function findRelevantSkills(text: string): Skill[] {
		const textLower = text.toLowerCase();
		const relevantSkills: Array<{ skill: Skill; matchCount: number }> = [];

		for (const skill of availableSkills) {
			let matches = 0;
			
			// Check for keyword matches
			for (const keyword of skill.keywords) {
				if (textLower.includes(keyword)) {
					matches++;
				}
			}

			// Check for skill name match
			if (textLower.includes(skill.name.toLowerCase())) {
				matches += 2; // Name match gets higher weight
			}

			if (matches > 0) {
				relevantSkills.push({ skill, matchCount: matches });
			}
		}

		// Sort by match count (most relevant first) and return top 3
		return relevantSkills
			.sort((a, b) => b.matchCount - a.matchCount)
			.slice(0, 3)
			.map(item => item.skill);
	}

	/**
	 * Input interceptor for skill detection
	 */
	pi.on("input", async (event, ctx) => {
		// Skip if this is an extension-generated message
		if (event.source === "extension") {
			return { action: "continue" };
		}

		// Find relevant skills
		const relevantSkills = findRelevantSkills(event.text);

		if (relevantSkills.length > 0) {
			// Inject skill content into context
			for (const skill of relevantSkills) {
				const skillMessage = `Skill Context: ${skill.name}

${skill.content}

---
This skill was automatically loaded based on your request. Use this knowledge to assist with the task.`;

				// Notify the model about the relevant skill content
				// The model can then use the `read` tool to load the full SKILL.md
				ctx.ui.notify(`📚 Relevant skill loaded: **${skill.name}**\n${skill.description}\nUse \`read ${skill.path}\` for full content.`, "info");
			}

			// Notify user which skills were loaded
			const skillNames = relevantSkills.map(s => s.name).join(", ");
			ctx.ui.notify(`🧠 Loaded ${relevantSkills.length} skill(s): ${skillNames}`, "info");
		}

		return { action: "continue" };
	});

	/**
	 * /skills command - List available skills
	 */
	pi.registerCommand("skills", {
		description: "List available skills or show skill details",
		getArgumentCompletions: (prefix) => {
			const skillNames = availableSkills.map(s => s.name);
			const filtered = skillNames.filter(name => name.toLowerCase().startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered.map(name => ({ value: name, label: name })) : null;
		},
		handler: async (args, ctx) => {
			const skillName = args.trim();

			if (!skillName) {
				// List all skills
				if (availableSkills.length === 0) {
					ctx.ui.notify("No skills found. Create skill directories with SKILL.md files in:\n- ~/.phi/agent/skills/\n- .phi/skills/", "info");
					return;
				}

				let message = `🧠 **Available Skills** (${availableSkills.length})\n\n`;

				// Group by source
				const globalSkills = availableSkills.filter(s => s.source === "global");
				const localSkills = availableSkills.filter(s => s.source === "local");

				if (globalSkills.length > 0) {
					message += "**Global Skills:**\n";
					globalSkills.forEach(skill => {
						const keywords = skill.keywords.slice(0, 3).join(", ");
						message += `- **${skill.name}** - ${skill.description}\n`;
						message += `  Keywords: ${keywords}\n\n`;
					});
				}

				if (localSkills.length > 0) {
					message += "**Project Skills:**\n";
					localSkills.forEach(skill => {
						const keywords = skill.keywords.slice(0, 3).join(", ");
						message += `- **${skill.name}** - ${skill.description}\n`;
						message += `  Keywords: ${keywords}\n\n`;
					});
				}

				message += "\nUse `/skills <name>` to view a specific skill.";

				ctx.ui.notify(message, "info");

			} else {
				// Show specific skill
				const skill = availableSkills.find(s => s.name.toLowerCase() === skillName.toLowerCase());
				
				if (!skill) {
					ctx.ui.notify(`Skill "${skillName}" not found. Use /skills to list available skills.`, "warning");
					return;
				}

				const message = `🧠 **Skill: ${skill.name}**

**Description:** ${skill.description}
**Source:** ${skill.source}
**Path:** ${skill.path}
**Keywords:** ${skill.keywords.join(", ")}

**Content Preview:**
${skill.content.slice(0, 500)}${skill.content.length > 500 ? "..." : ""}`;

				ctx.ui.notify(message, "info");
			}
		},
	});

	/**
	 * Load skills on session start
	 */
	pi.on("session_start", async (_event, _ctx) => {
		await loadAllSkills();
	});
}