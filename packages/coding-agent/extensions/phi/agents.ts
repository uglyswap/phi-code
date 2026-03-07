/**
 * Agents Extension - Sub-agent management and visibility
 *
 * Provides:
 * - /agents command to list all configured sub-agents
 * - /agents <name> to show detailed agent info
 * - Agent definitions loaded from ~/.phi/agent/agents/ and .phi/agents/
 * - Model assignment visibility
 */

import type { ExtensionAPI } from "phi-code";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

interface AgentDefinition {
	name: string;
	description: string;
	tools: string[];
	model: string;
	source: string; // "global", "project", "bundled"
	filePath: string;
	systemPrompt: string;
}

/**
 * Parse YAML frontmatter from agent .md file
 */
function parseAgentFile(filePath: string): AgentDefinition | null {
	try {
		const content = readFileSync(filePath, "utf-8");
		const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

		if (!fmMatch) return null;

		const frontmatter = fmMatch[1];
		const body = fmMatch[2].trim();

		// Simple YAML parser for our frontmatter
		const fields: Record<string, string> = {};
		for (const line of frontmatter.split("\n")) {
			const match = line.match(/^(\w+):\s*(.*)$/);
			if (match) {
				fields[match[1]] = match[2].trim();
			}
		}

		if (!fields.name) return null;

		return {
			name: fields.name,
			description: fields.description || "No description",
			tools: (fields.tools || "").split(",").map(t => t.trim()).filter(Boolean),
			model: fields.model || "default",
			source: "unknown",
			filePath,
			systemPrompt: body,
		};
	} catch {
		return null;
	}
}

/**
 * Scan a directory for agent .md files
 */
function scanAgentDir(dir: string, source: string): AgentDefinition[] {
	const agents: AgentDefinition[] = [];

	if (!existsSync(dir)) return agents;

	try {
		const entries = readdirSync(dir);
		for (const entry of entries) {
			if (!entry.endsWith(".md")) continue;
			const fullPath = join(dir, entry);
			if (!statSync(fullPath).isFile()) continue;

			const agent = parseAgentFile(fullPath);
			if (agent) {
				agent.source = source;
				agents.push(agent);
			}
		}
	} catch {
		// Directory not readable
	}

	return agents;
}

export default function agentsExtension(pi: ExtensionAPI) {
	/**
	 * Discover all agent definitions from all sources
	 */
	function discoverAgents(): AgentDefinition[] {
		const seen = new Set<string>();
		const allAgents: AgentDefinition[] = [];

		const addAgents = (agents: AgentDefinition[]) => {
			for (const agent of agents) {
				if (!seen.has(agent.name)) {
					seen.add(agent.name);
					allAgents.push(agent);
				}
			}
		};

		// 1. Project-local agents
		addAgents(scanAgentDir(join(process.cwd(), ".phi", "agents"), "project"));

		// 2. Global agents
		addAgents(scanAgentDir(join(homedir(), ".phi", "agent", "agents"), "global"));

		// 3. Bundled agents (shipped with package)
		const bundledDir = join(__dirname, "..", "..", "..", "agents");
		if (existsSync(bundledDir)) {
			addAgents(scanAgentDir(bundledDir, "bundled"));
		}

		return allAgents;
	}

	/**
	 * /agents command
	 */
	pi.registerCommand("agents", {
		description: "List and inspect sub-agent definitions",
		handler: async (args, ctx) => {
			const agents = discoverAgents();
			const arg = args.trim().toLowerCase();

			if (agents.length === 0) {
				ctx.ui.notify("No agent definitions found.\n\nCreate agent files in:\n- `.phi/agents/` (project)\n- `~/.phi/agent/agents/` (global)\n\nFormat: Markdown with YAML frontmatter (name, description, tools, model).", "info");
				return;
			}

			// Show specific agent details
			if (arg && arg !== "list") {
				const agent = agents.find(a => a.name.toLowerCase() === arg);
				if (!agent) {
					ctx.ui.notify(`Agent "${arg}" not found. Available: ${agents.map(a => a.name).join(", ")}`, "warning");
					return;
				}

				const detail = `**Agent: ${agent.name}**

📝 ${agent.description}
🤖 Model: \`${agent.model}\`
🔧 Tools: ${agent.tools.map(t => `\`${t}\``).join(", ")}
📁 Source: ${agent.source} (\`${agent.filePath}\`)

**System Prompt:**
\`\`\`
${agent.systemPrompt.substring(0, 800)}${agent.systemPrompt.length > 800 ? "\n..." : ""}
\`\`\``;

				ctx.ui.notify(detail, "info");
				return;
			}

			// List all agents
			let output = `**🤖 Sub-Agents (${agents.length})**\n\n`;

			// Group by source
			const bySource: Record<string, AgentDefinition[]> = {};
			for (const agent of agents) {
				const key = agent.source;
				if (!bySource[key]) bySource[key] = [];
				bySource[key].push(agent);
			}

			const sourceLabels: Record<string, string> = {
				project: "📁 Project (.phi/agents/)",
				global: "🏠 Global (~/.phi/agent/agents/)",
				bundled: "📦 Bundled (shipped with Phi Code)",
			};

			for (const [source, sourceAgents] of Object.entries(bySource)) {
				output += `**${sourceLabels[source] || source}**\n`;
				for (const agent of sourceAgents) {
					output += `  • **${agent.name}** → \`${agent.model}\`\n`;
					output += `    ${agent.description}\n`;
					output += `    Tools: ${agent.tools.join(", ")}\n`;
				}
				output += "\n";
			}

			output += `Use \`/agents <name>\` for detailed info on a specific agent.`;

			ctx.ui.notify(output, "info");
		},
	});

	// Session start: show agent count
	pi.on("session_start", async (_event, ctx) => {
		const agents = discoverAgents();
		if (agents.length > 0) {
			ctx.ui.notify(`🤖 ${agents.length} sub-agents available. /agents to list.`, "info");
		}
	});
}
