/**
 * Agents Extension - Sub-agent management and visibility
 *
 * Provides:
 * - /agents command to list all configured sub-agents
 * - /agents <name> to show detailed agent info
 * - Agent definitions loaded from .phi/agents/, ~/.phi/agent/agents/ and the
 *   bundled agents/ directory via the shared providers/agent-def module
 *   (same parser and search order as the /plan orchestrator).
 */

import type { ExtensionAPI } from "phi-code";
import { type AgentDef, discoverAgents } from "./providers/agent-def.js";

export default function agentsExtension(pi: ExtensionAPI) {
	/**
	 * /agents command
	 */
	pi.registerCommand("agents", {
		description: "List and inspect sub-agent definitions",
		handler: async (args, ctx) => {
			const agents = discoverAgents();
			const arg = args.trim().toLowerCase();

			if (agents.length === 0) {
				ctx.ui.notify(
					"No agent definitions found.\n\nCreate agent files in:\n- `.phi/agents/` (project)\n- `~/.phi/agent/agents/` (global)\n\nFormat: Markdown with YAML frontmatter (name, description, tools, model).",
					"info",
				);
				return;
			}

			// Show specific agent details
			if (arg && arg !== "list") {
				const agent = agents.find((a) => a.name.toLowerCase() === arg);
				if (!agent) {
					ctx.ui.notify(`Agent "${arg}" not found. Available: ${agents.map((a) => a.name).join(", ")}`, "warning");
					return;
				}

				const detail = `**Agent: ${agent.name}**

📝 ${agent.description}
🤖 Model: \`${agent.model}\`
🔧 Tools: ${agent.tools.map((t) => `\`${t}\``).join(", ")}
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
			const bySource: Record<string, AgentDef[]> = {};
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
