/**
 * Smart Router Extension - Intelligent model routing for different task types
 *
 * Analyzes user input keywords and suggests the optimal model:
 * - code: implement, create, build, refactor → qwen3-coder-plus
 * - debug: fix, bug, error, crash → qwen3-max-2026-01-23
 * - explore: read, analyze, explain, understand → kimi-k2.5
 * - plan: plan, design, architect, spec → qwen3-max-2026-01-23
 * - test: test, verify, validate, check → kimi-k2.5
 * - review: review, audit, quality, security → qwen3.5-plus
 *
 * Configuration: ~/.phi/agent/routing.json (same format as config/routing.json)
 * Command: /routing — show config, enable/disable, test, reload
 */

import type { ExtensionAPI } from "phi-code";
import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────────

interface RouteEntry {
	description: string;
	keywords: string[];
	preferredModel: string;
	fallback: string;
	agent: string;
}

interface RoutingConfig {
	routes: Record<string, RouteEntry>;
	default: { model: string; agent: string | null };
}

interface FullConfig {
	routing: RoutingConfig;
	enabled: boolean;
	notifyOnRecommendation: boolean;
}

// ─── Defaults (aligned with config/routing.json and default-models.json) ──

const DEFAULT_ROUTING: RoutingConfig = {
	routes: {
		code: {
			description: "Code generation, implementation, refactoring",
			keywords: ["implement", "create", "build", "refactor", "write", "add", "modify", "update", "generate", "code", "develop", "function", "class"],
			preferredModel: "qwen3-coder-plus",
			fallback: "qwen3.5-plus",
			agent: "code",
		},
		debug: {
			description: "Debugging, fixing, error resolution",
			keywords: ["fix", "bug", "error", "debug", "crash", "broken", "failing", "issue", "troubleshoot", "repair", "solve"],
			preferredModel: "qwen3-max-2026-01-23",
			fallback: "qwen3.5-plus",
			agent: "code",
		},
		explore: {
			description: "Code reading, analysis, understanding",
			keywords: ["read", "analyze", "explain", "understand", "find", "search", "look", "show", "what", "how", "explore", "examine"],
			preferredModel: "kimi-k2.5",
			fallback: "glm-4.7",
			agent: "explore",
		},
		plan: {
			description: "Architecture, design, planning",
			keywords: ["plan", "design", "architect", "spec", "structure", "organize", "strategy", "approach", "roadmap"],
			preferredModel: "qwen3-max-2026-01-23",
			fallback: "qwen3.5-plus",
			agent: "plan",
		},
		test: {
			description: "Testing, validation, verification",
			keywords: ["test", "verify", "validate", "check", "assert", "coverage", "unit", "integration", "e2e"],
			preferredModel: "kimi-k2.5",
			fallback: "glm-4.7",
			agent: "test",
		},
		review: {
			description: "Code review, quality assessment",
			keywords: ["review", "audit", "quality", "security", "improve", "optimize", "refine", "critique"],
			preferredModel: "qwen3.5-plus",
			fallback: "qwen3-max-2026-01-23",
			agent: "review",
		},
	},
	default: {
		model: "qwen3.5-plus",
		agent: null,
	},
};

// ─── Extension ───────────────────────────────────────────────────────────

export default function smartRouterExtension(pi: ExtensionAPI) {
	const configDir = join(homedir(), ".phi", "agent");
	const configPath = join(configDir, "routing.json");

	let config: FullConfig = {
		routing: DEFAULT_ROUTING,
		enabled: true,
		notifyOnRecommendation: true,
	};

	/**
	 * Load routing config from ~/.phi/agent/routing.json
	 */
	async function loadConfig() {
		try {
			await access(configPath);
			const text = await readFile(configPath, "utf-8");
			const userConfig = JSON.parse(text);

			// Support both flat format (routes at top level) and wrapped format
			if (userConfig.routes) {
				config.routing = {
					routes: { ...DEFAULT_ROUTING.routes, ...userConfig.routes },
					default: userConfig.default || DEFAULT_ROUTING.default,
				};
			}

			if (typeof userConfig.enabled === "boolean") config.enabled = userConfig.enabled;
			if (typeof userConfig.notifyOnRecommendation === "boolean") config.notifyOnRecommendation = userConfig.notifyOnRecommendation;
		} catch {
			// No config file — use defaults, and save them for reference
			try {
				await mkdir(configDir, { recursive: true });
				await writeFile(configPath, JSON.stringify(DEFAULT_ROUTING, null, 2), "utf-8");
			} catch {
				// Can't write, that's fine
			}
		}
	}

	/**
	 * Analyze input text to classify task type
	 */
	function classifyTask(text: string): { category: string | null; confidence: number; matches: string[]; route: RouteEntry | null } {
		const lower = text.toLowerCase();
		const results: Array<{ category: string; confidence: number; matches: string[]; route: RouteEntry }> = [];

		for (const [category, route] of Object.entries(config.routing.routes)) {
			const matches: string[] = [];

			for (const keyword of route.keywords) {
				if (lower.includes(keyword.toLowerCase())) {
					matches.push(keyword);
				}
			}

			if (matches.length > 0) {
				// Confidence = weighted match ratio
				// More matches = higher confidence, but cap at 95%
				const ratio = matches.length / route.keywords.length;
				const confidence = Math.min(95, Math.round(ratio * 100 + matches.length * 5));
				results.push({ category, confidence, matches, route });
			}
		}

		if (results.length === 0) {
			return { category: null, confidence: 0, matches: [], route: null };
		}

		// Highest confidence wins
		results.sort((a, b) => b.confidence - a.confidence);
		return results[0];
	}

	// ─── Input Event ─────────────────────────────────────────────────

	/**
	 * Resolve a model name to an available model.
	 * If the preferred model exists in the registry, use it.
	 * Otherwise, fall back to the current model.
	 */
	function resolveModel(preferredModel: string, ctx: any): string {
		// Check if model exists in registry
		try {
			const available = ctx.modelRegistry?.getAvailable?.() || [];
			if (available.some((m: any) => m.id === preferredModel)) {
				return preferredModel;
			}
			// Model not available — use current model
			return ctx.model?.id || preferredModel;
		} catch {
			return ctx.model?.id || preferredModel;
		}
	}

	pi.on("input", async (event, ctx) => {
		if (!config.enabled || event.source === "extension") {
			return { action: "continue" };
		}

		const result = classifyTask(event.text);

		if (result.category && result.confidence >= 25 && result.route) {
			if (config.notifyOnRecommendation) {
				const resolved = resolveModel(result.route.preferredModel, ctx);
				const suffix = resolved !== result.route.preferredModel ? ` (→ ${resolved})` : "";
				ctx.ui.notify(
					`🔀 ${result.route.description} → \`${result.route.preferredModel}\`${suffix} (${result.confidence}% | ${result.matches.join(", ")})`,
					"info"
				);
			}
		}

		return { action: "continue" };
	});

	// ─── /routing Command ────────────────────────────────────────────

	pi.registerCommand("routing", {
		description: "Show or configure smart routing (enable/disable/test/reload)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			if (!arg) {
				// Show current config
				let output = `**🔀 Smart Router**\n\n`;
				output += `Status: ${config.enabled ? "✅ Enabled" : "❌ Disabled"}\n`;
				output += `Notifications: ${config.notifyOnRecommendation ? "On" : "Off"}\n\n`;

				output += `**Routes:**\n`;
				for (const [cat, route] of Object.entries(config.routing.routes)) {
					output += `  **${cat}** → \`${route.preferredModel}\` (fallback: \`${route.fallback}\`) [agent: ${route.agent}]\n`;
					output += `    Keywords: ${route.keywords.slice(0, 6).join(", ")}${route.keywords.length > 6 ? "..." : ""}\n`;
				}
				output += `\n  **default** → \`${config.routing.default.model}\`\n`;

				output += `\nConfig: \`${configPath}\``;
				output += `\nCommands: \`/routing enable|disable|notify-on|notify-off|reload|test\``;

				ctx.ui.notify(output, "info");
				return;
			}

			switch (arg) {
				case "enable":
					config.enabled = true;
					ctx.ui.notify("✅ Smart routing enabled.", "info");
					break;
				case "disable":
					config.enabled = false;
					ctx.ui.notify("❌ Smart routing disabled.", "info");
					break;
				case "notify-on":
					config.notifyOnRecommendation = true;
					ctx.ui.notify("🔔 Routing notifications enabled.", "info");
					break;
				case "notify-off":
					config.notifyOnRecommendation = false;
					ctx.ui.notify("🔕 Routing notifications disabled.", "info");
					break;
				case "reload":
					await loadConfig();
					ctx.ui.notify("🔄 Routing config reloaded from disk.", "info");
					break;
				case "test": {
					const tests = [
						"implement a new user authentication system",
						"fix the crash when uploading files larger than 10MB",
						"explain how the middleware chain works",
						"plan the migration from REST to GraphQL",
						"run all unit tests and check coverage",
						"review the PR for security vulnerabilities",
						"what time is it",
					];

					let output = "**🧪 Routing Test:**\n\n";
					for (const input of tests) {
						const result = classifyTask(input);
						const model = result.route?.preferredModel || config.routing.default.model;
						const tag = result.category || "default";
						output += `"${input}"\n  → **${tag}** (${result.confidence}%) → \`${model}\`\n\n`;
					}
					ctx.ui.notify(output, "info");
					break;
				}
				default:
					ctx.ui.notify("Usage: `/routing [enable|disable|notify-on|notify-off|reload|test]`", "warning");
			}
		},
	});

	// ─── Session Start ───────────────────────────────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		await loadConfig();
	});
}
