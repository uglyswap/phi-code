/**
 * Smart Router Extension - Intelligent model routing for different task types
 *
 * Uses sigma-agents SmartRouter for task classification and model recommendation.
 * Analyzes user input keywords and suggests the optimal model per task category.
 *
 * Configuration: ~/.phi/agent/routing.json
 * Command: /routing — show config, enable/disable, test, reload
 */

import type { ExtensionAPI } from "phi-code";
import { SmartRouter } from "sigma-agents";
import type { RoutingConfig, TaskCategory } from "sigma-agents";
import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Extension Config ────────────────────────────────────────────────────

interface ExtensionConfig {
	enabled: boolean;
	notifyOnRecommendation: boolean;
}

// ─── Extension ───────────────────────────────────────────────────────────

export default function smartRouterExtension(pi: ExtensionAPI) {
	const configDir = join(homedir(), ".phi", "agent");
	const configPath = join(configDir, "routing.json");

	let router = new SmartRouter(SmartRouter.defaultConfig());
	let extConfig: ExtensionConfig = {
		enabled: true,
		notifyOnRecommendation: true,
	};

	/**
	 * Load routing config from ~/.phi/agent/routing.json
	 */
	async function loadConfig() {
		try {
			const config = await SmartRouter.loadConfig(configPath);
			router = new SmartRouter(config);
		} catch {
			// No config file — use defaults, and save them for reference
			try {
				await mkdir(configDir, { recursive: true });
				const defaultConfig = SmartRouter.defaultConfig();
				await writeFile(configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
			} catch {
				// Can't write, that's fine
			}
		}
	}

	/**
	 * Resolve a model name to an available model.
	 * If the preferred model exists in the registry, use it.
	 * Otherwise, fall back to the current model.
	 */
	function resolveModel(preferredModel: string, ctx: any): string {
		try {
			const available = ctx.modelRegistry?.getAvailable?.() || [];
			if (available.some((m: any) => m.id === preferredModel)) {
				return preferredModel;
			}
			return ctx.model?.id || preferredModel;
		} catch {
			return ctx.model?.id || preferredModel;
		}
	}

	// ─── Input Event ─────────────────────────────────────────────────

	pi.on("input", async (event, ctx) => {
		if (!extConfig.enabled || event.source === "extension") {
			return { action: "continue" };
		}

		const recommendation = router.getRecommendation(event.text);

		if (recommendation.category !== "general") {
			// Find the recommended model in the registry
			const available = ctx.modelRegistry?.getAvailable?.() || [];
			const targetModel = available.find((m: any) => m.id === recommendation.model);
			const fallbackRoute = (router as any).config?.routes?.[recommendation.category];
			const fallbackModel = fallbackRoute?.fallback
				? available.find((m: any) => m.id === fallbackRoute.fallback)
				: undefined;

			const modelToUse = targetModel || fallbackModel;

			if (modelToUse && modelToUse.id !== ctx.model?.id) {
				// Actually switch the model
				const switched = await pi.setModel(modelToUse);
				if (switched && extConfig.notifyOnRecommendation) {
					ctx.ui.notify(
						`🔀 ${recommendation.category} → \`${modelToUse.id}\`${modelToUse.id !== recommendation.model ? ` (fallback)` : ""}`,
						"info"
					);
				}
			} else if (extConfig.notifyOnRecommendation && !modelToUse) {
				// Model not available — just notify
				ctx.ui.notify(
					`🔀 ${recommendation.category} → \`${recommendation.model}\` (not available, keeping current)`,
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
				const routingConfig = (router as any).config as RoutingConfig;
				let output = `**🔀 Smart Router** (powered by sigma-agents)\n\n`;
				output += `Status: ${extConfig.enabled ? "✅ Enabled" : "❌ Disabled"}\n`;
				output += `Notifications: ${extConfig.notifyOnRecommendation ? "On" : "Off"}\n\n`;

				output += `**Routes:**\n`;
				for (const [cat, route] of Object.entries(routingConfig.routes)) {
					output += `  **${cat}** → \`${route.preferredModel}\` (fallback: \`${route.fallback}\`) [agent: ${route.agent || "none"}]\n`;
					output += `    Keywords: ${route.keywords.slice(0, 6).join(", ")}${route.keywords.length > 6 ? "..." : ""}\n`;
				}
				output += `\n  **default** → \`${routingConfig.default.model}\`\n`;

				output += `\nConfig: \`${configPath}\``;
				output += `\nCommands: \`/routing enable|disable|notify-on|notify-off|reload|test\``;

				ctx.ui.notify(output, "info");
				return;
			}

			switch (arg) {
				case "enable":
					extConfig.enabled = true;
					ctx.ui.notify("✅ Smart routing enabled.", "info");
					break;
				case "disable":
					extConfig.enabled = false;
					ctx.ui.notify("❌ Smart routing disabled.", "info");
					break;
				case "notify-on":
					extConfig.notifyOnRecommendation = true;
					ctx.ui.notify("🔔 Routing notifications enabled.", "info");
					break;
				case "notify-off":
					extConfig.notifyOnRecommendation = false;
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
						const rec = router.getRecommendation(input);
						output += `"${input}"\n  → **${rec.category}** → \`${rec.model}\`\n\n`;
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
