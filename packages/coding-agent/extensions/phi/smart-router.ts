/**
 * Smart Router Extension - Intelligent model routing for different task types
 *
 * Analyzes user input to suggest the most appropriate model for the task:
 * - Code tasks (implement, create, refactor, build) → coder model
 * - Debug tasks (fix, bug, error, debug) → reasoning model  
 * - Exploration tasks (read, analyze, explain, understand) → fast model
 * - Planning tasks (plan, design, architect, spec) → reasoning model
 *
 * Reads configuration from ~/.phi/agent/routing.json if available.
 * Currently only notifies user of recommendations - automatic switching to be added later.
 *
 * Features:
 * - Input analysis and model recommendations
 * - Configurable routing rules
 * - User notifications via ctx.ui.notify
 *
 * Usage:
 * 1. Copy to packages/coding-agent/extensions/phi/smart-router.ts
 * 2. Optionally configure via ~/.phi/agent/routing.json
 */

import type { ExtensionAPI } from "phi-code";
import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

interface RoutingConfig {
	patterns: {
		code: string[];
		debug: string[];
		exploration: string[];
		planning: string[];
	};
	models: {
		coder: string;
		reasoning: string;
		fast: string;
	};
	enabled: boolean;
	notifyOnRecommendation: boolean;
}

const DEFAULT_CONFIG: RoutingConfig = {
	patterns: {
		code: ["implement", "create", "build", "refactor", "code", "write", "develop", "generate"],
		debug: ["fix", "bug", "error", "debug", "troubleshoot", "repair", "solve", "issue"],
		exploration: ["read", "analyze", "explain", "understand", "explore", "examine", "review", "what is"],
		planning: ["plan", "design", "architect", "spec", "strategy", "approach", "organize", "structure"]
	},
	models: {
		coder: "anthropic/claude-sonnet-3.5",
		reasoning: "anthropic/claude-opus",  
		fast: "anthropic/claude-haiku"
	},
	enabled: true,
	notifyOnRecommendation: true
};

export default function smartRouterExtension(pi: ExtensionAPI) {
	let config: RoutingConfig = DEFAULT_CONFIG;
	const configDir = join(homedir(), ".phi", "agent");
	const configPath = join(configDir, "routing.json");

	/**
	 * Load routing configuration
	 */
	async function loadConfig() {
		try {
			await access(configPath);
			const configText = await readFile(configPath, 'utf-8');
			const userConfig = JSON.parse(configText) as Partial<RoutingConfig>;
			
			// Merge with defaults
			config = {
				...DEFAULT_CONFIG,
				...userConfig,
				patterns: { ...DEFAULT_CONFIG.patterns, ...userConfig.patterns },
				models: { ...DEFAULT_CONFIG.models, ...userConfig.models }
			};
		} catch (error) {
			// Config doesn't exist or is invalid, use defaults
			console.log("Using default routing configuration");
			await saveDefaultConfig();
		}
	}

	/**
	 * Save default configuration file
	 */
	async function saveDefaultConfig() {
		try {
			await mkdir(configDir, { recursive: true });
			await writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
			console.log(`Created default routing config at ${configPath}`);
		} catch (error) {
			console.warn("Failed to save default routing config:", error);
		}
	}

	/**
	 * Analyze input text to determine task type
	 */
	function analyzeTaskType(text: string): { type: keyof RoutingConfig['patterns'] | null; confidence: number; matches: string[] } {
		const normalizedText = text.toLowerCase();
		const results: Array<{ type: keyof RoutingConfig['patterns']; confidence: number; matches: string[] }> = [];

		// Check each pattern category
		for (const [category, patterns] of Object.entries(config.patterns)) {
			const matches: string[] = [];
			let matchCount = 0;

			for (const pattern of patterns) {
				if (normalizedText.includes(pattern.toLowerCase())) {
					matches.push(pattern);
					matchCount++;
				}
			}

			if (matchCount > 0) {
				// Calculate confidence based on match count and pattern length
				const confidence = (matchCount / patterns.length) * 100;
				results.push({ 
					type: category as keyof RoutingConfig['patterns'], 
					confidence, 
					matches 
				});
			}
		}

		// Return the highest confidence match
		if (results.length === 0) {
			return { type: null, confidence: 0, matches: [] };
		}

		results.sort((a, b) => b.confidence - a.confidence);
		return results[0];
	}

	/**
	 * Get recommended model for task type
	 */
	function getRecommendedModel(taskType: keyof RoutingConfig['patterns'] | null): string | null {
		if (!taskType) return null;

		switch (taskType) {
			case 'code':
				return config.models.coder;
			case 'debug':
			case 'planning':
				return config.models.reasoning;
			case 'exploration':
				return config.models.fast;
			default:
				return null;
		}
	}

	/**
	 * Get task type description
	 */
	function getTaskDescription(taskType: keyof RoutingConfig['patterns'] | null): string {
		switch (taskType) {
			case 'code':
				return 'Code Implementation';
			case 'debug':
				return 'Debugging & Problem Solving';
			case 'exploration':
				return 'Analysis & Understanding';
			case 'planning':
				return 'Planning & Design';
			default:
				return 'General Task';
		}
	}

	/**
	 * Input interceptor for smart routing
	 */
	pi.on("input", async (event, ctx) => {
		// Skip if routing is disabled or this is an extension-generated message
		if (!config.enabled || event.source === "extension") {
			return { action: "continue" };
		}

		// Analyze the input
		const analysis = analyzeTaskType(event.text);
		
		// Only recommend if we have good confidence (>= 30%)
		if (analysis.type && analysis.confidence >= 30) {
			const recommendedModel = getRecommendedModel(analysis.type);
			const taskDescription = getTaskDescription(analysis.type);

			if (recommendedModel && config.notifyOnRecommendation) {
				const message = `💡 Detected: ${taskDescription} (${analysis.confidence.toFixed(0)}% confidence)
Recommended model: ${recommendedModel}
Matched patterns: ${analysis.matches.join(", ")}`;

				ctx.ui.notify(message, "info");
			}
		}

		return { action: "continue" };
	});

	/**
	 * Register routing configuration command
	 */
	pi.registerCommand("routing", {
		description: "Show or configure smart routing settings",
		handler: async (args, ctx) => {
			if (!args.trim()) {
				// Show current configuration
				const statusMessage = `Smart Router Configuration:

**Status:** ${config.enabled ? "Enabled" : "Disabled"}
**Notifications:** ${config.notifyOnRecommendation ? "Enabled" : "Disabled"}

**Model Assignments:**
- Code tasks: ${config.models.coder}
- Debug tasks: ${config.models.reasoning}
- Exploration: ${config.models.fast}  
- Planning: ${config.models.reasoning}

**Pattern Matching:**
- Code: ${config.patterns.code.join(", ")}
- Debug: ${config.patterns.debug.join(", ")}
- Exploration: ${config.patterns.exploration.join(", ")}
- Planning: ${config.patterns.planning.join(", ")}

Config file: ${configPath}`;

				ctx.ui.notify(statusMessage, "info");
				return;
			}

			const arg = args.trim().toLowerCase();

			switch (arg) {
				case "enable":
					config.enabled = true;
					ctx.ui.notify("Smart routing enabled", "info");
					break;
				case "disable":
					config.enabled = false;
					ctx.ui.notify("Smart routing disabled", "info");
					break;
				case "notify-on":
					config.notifyOnRecommendation = true;
					ctx.ui.notify("Routing notifications enabled", "info");
					break;
				case "notify-off":
					config.notifyOnRecommendation = false;
					ctx.ui.notify("Routing notifications disabled", "info");
					break;
				case "reload":
					await loadConfig();
					ctx.ui.notify("Routing configuration reloaded", "info");
					break;
				case "test":
					// Test mode - show what would be recommended for different inputs
					const testInputs = [
						"implement a new feature",
						"fix this bug", 
						"explain how this works",
						"plan the system architecture"
					];
					
					let testResults = "**Routing Test Results:**\n\n";
					for (const input of testInputs) {
						const analysis = analyzeTaskType(input);
						const model = getRecommendedModel(analysis.type);
						testResults += `"${input}" → ${analysis.type || 'none'} (${analysis.confidence.toFixed(0)}%) → ${model || 'default'}\n`;
					}
					
					ctx.ui.notify(testResults, "info");
					break;
				default:
					ctx.ui.notify("Usage: /routing [enable|disable|notify-on|notify-off|reload|test]", "warning");
			}
		},
	});

	/**
	 * Load configuration on session start
	 */
	pi.on("session_start", async (_event, _ctx) => {
		await loadConfig();
	});
}