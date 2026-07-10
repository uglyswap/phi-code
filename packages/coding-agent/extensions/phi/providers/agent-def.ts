/**
 * Agent definitions (.md with YAML frontmatter) — single source of truth for
 * parsing and discovery, shared by the /plan orchestrator (loadAgentDef) and
 * the /agents command (discoverAgents). Before this module existed the two
 * call sites each had their own parser and they had already drifted.
 *
 * Search order (first match wins):
 *   1. <cwd>/.phi/agents/           (project)
 *   2. ~/.phi/agent/agents/         (global — postinstall copies bundled here)
 *   3. <package>/agents/            (bundled, repo layout)
 *
 * Layout note: this file lives in extensions/phi/providers/. Three hops up is
 * the package root in the repo layout (packages/coding-agent) AND the agent
 * dir in the installed layout (~/.phi/agent), so the "bundled" candidate
 * resolves to a real agents/ directory in both.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export type AgentSource = "project" | "global" | "bundled";

export interface AgentDef {
	name: string;
	description: string;
	tools: string[];
	model: string;
	systemPrompt: string;
	filePath: string;
	source: AgentSource;
}

/**
 * Parse an agent .md file: YAML frontmatter (name, description, tools, model)
 * followed by the system prompt body. `tools` is a comma-separated list.
 * Returns null when the file has no frontmatter block.
 */
export function parseAgentMarkdown(content: string, filePath: string, source: AgentSource): AgentDef | null {
	const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!fmMatch) return null;

	const fields: Record<string, string> = {};
	for (const line of fmMatch[1].split("\n")) {
		const m = line.match(/^(\w+):\s*(.*)$/);
		if (m) fields[m[1]] = m[2].trim();
	}

	const name = fields.name || basename(filePath).replace(/\.md$/, "");
	if (!name) return null;

	return {
		name,
		description: fields.description || "No description",
		tools: (fields.tools || "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean),
		model: fields.model || "default",
		systemPrompt: fmMatch[2].trim(),
		filePath,
		source,
	};
}

function readAgentFile(filePath: string, source: AgentSource): AgentDef | null {
	try {
		return parseAgentMarkdown(readFileSync(filePath, "utf-8"), filePath, source);
	} catch {
		return null;
	}
}

/** Agent directories in precedence order (project > global > bundled). */
export function agentSearchDirs(cwd: string = process.cwd()): Array<{ dir: string; source: AgentSource }> {
	return [
		{ dir: join(cwd, ".phi", "agents"), source: "project" },
		{ dir: join(homedir(), ".phi", "agent", "agents"), source: "global" },
		{ dir: join(__dirname, "..", "..", "..", "agents"), source: "bundled" },
	];
}

/**
 * Load a single agent definition by name. Used by the /plan orchestrator to
 * activate a phase persona.
 */
export function loadAgentDef(name: string, cwd: string = process.cwd()): AgentDef | null {
	for (const { dir, source } of agentSearchDirs(cwd)) {
		const def = readAgentFile(join(dir, `${name}.md`), source);
		if (def) return def;
	}
	return null;
}

/**
 * Discover every agent definition across all sources, first match per name
 * wins. Used by the /agents command.
 */
export function discoverAgents(cwd: string = process.cwd()): AgentDef[] {
	const seen = new Set<string>();
	const agents: AgentDef[] = [];

	for (const { dir, source } of agentSearchDirs(cwd)) {
		if (!existsSync(dir)) continue;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const filePath = join(dir, entry);
			try {
				if (!statSync(filePath).isFile()) continue;
			} catch {
				continue;
			}
			const def = readAgentFile(filePath, source);
			if (def && !seen.has(def.name)) {
				seen.add(def.name);
				agents.push(def);
			}
		}
	}

	return agents;
}
