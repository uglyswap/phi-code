/**
 * Phi Init Extension - Interactive setup wizard for Phi Code
 *
 * Detects providers (API keys + local endpoints), then lets the user
 * manually assign models to each agent role (code, debug, plan, explore, test, review).
 *
 * Creates ~/.phi/agent/ structure with routing, agents, and memory.
 */

import type { ExtensionAPI } from "phi-code";
import { writeFile, mkdir, copyFile, readdir, access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

// ─── Types ───────────────────────────────────────────────────────────────

interface DetectedProvider {
	name: string;
	envVar: string;
	baseUrl: string;
	models: string[];
	available: boolean;
	local?: boolean; // True for Ollama/LM Studio (models discovered at runtime)
}

interface RoutingConfig {
	routes: Record<string, {
		description: string;
		keywords: string[];
		preferredModel: string;
		fallback: string;
		agent: string;
	}>;
	default: { model: string; agent: string | null };
}

// ─── Dynamic Model Specs via OpenRouter ──────────────────────────────────

interface ModelSpec {
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
}

// Cache for OpenRouter model data (fetched once per session)
let openRouterCache: Map<string, ModelSpec> | null = null;

/**
 * Fetch model specs from OpenRouter's free API (no key needed).
 * Returns a map of model base name → specs.
 * Falls back to conservative defaults if unreachable.
 */
async function fetchModelSpecs(): Promise<Map<string, ModelSpec>> {
	if (openRouterCache) return openRouterCache;

	const cache = new Map<string, ModelSpec>();

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		const res = await fetch("https://openrouter.ai/api/v1/models", {
			signal: controller.signal,
		});
		clearTimeout(timeout);

		if (res.ok) {
			const data = await res.json() as any;
			for (const m of (data.data || [])) {
				const contextLength = m.context_length || 128000;
				const maxOutput = m.top_provider?.max_completion_tokens || Math.min(contextLength, 16384);
				const hasReasoning = (m.supported_parameters || []).includes("reasoning");

				// Store by full ID and by base name (for fuzzy matching)
				const spec: ModelSpec = {
					contextWindow: contextLength,
					maxTokens: typeof maxOutput === "number" ? maxOutput : 16384,
					reasoning: hasReasoning,
				};

				cache.set(m.id, spec);
				// Also store by short name (e.g., "qwen3.5-plus" from "qwen/qwen3.5-plus-02-15")
				const parts = m.id.split("/");
				if (parts.length > 1) {
					cache.set(parts[1], spec);
				}
			}
		}
	} catch {
		// OpenRouter unreachable — cache stays empty, fallback used
	}

	openRouterCache = cache;
	return cache;
}

/**
 * Get model spec by ID. Tries OpenRouter cache first with fuzzy matching,
 * then falls back to conservative defaults.
 */
async function getModelSpec(id: string): Promise<ModelSpec> {
	const cache = await fetchModelSpecs();

	// Exact match
	if (cache.has(id)) return cache.get(id)!;

	// Try common prefixed variants
	const prefixes = ["qwen/", "moonshotai/", "z-ai/", "minimax/", "openai/", "anthropic/", "google/"];
	for (const prefix of prefixes) {
		const key = prefix + id;
		if (cache.has(key)) return cache.get(key)!;
	}

	// Fuzzy: find by base name inclusion
	const lower = id.toLowerCase().replace(/[-_.]/g, "");
	for (const [key, spec] of cache) {
		const keyLower = key.toLowerCase().replace(/[-_.]/g, "");
		if (keyLower.includes(lower) || lower.includes(keyLower.split("/").pop() || "")) {
			return spec;
		}
	}

	// Conservative fallback
	return { contextWindow: 128000, maxTokens: 16384, reasoning: true };
}

/**
 * Synchronous fallback for non-async contexts.
 * Uses cached data if available, otherwise returns defaults.
 */
function getModelSpecSync(id: string): ModelSpec {
	if (!openRouterCache) return { contextWindow: 128000, maxTokens: 16384, reasoning: true };

	if (openRouterCache.has(id)) return openRouterCache.get(id)!;

	const prefixes = ["qwen/", "moonshotai/", "z-ai/", "minimax/", "openai/", "anthropic/", "google/"];
	for (const prefix of prefixes) {
		if (openRouterCache.has(prefix + id)) return openRouterCache.get(prefix + id)!;
	}

	return { contextWindow: 128000, maxTokens: 16384, reasoning: true };
}

// ─── Provider Detection ──────────────────────────────────────────────────

function detectProviders(): DetectedProvider[] {
	const providers: DetectedProvider[] = [
		{
			name: "Alibaba Coding Plan",
			envVar: "ALIBABA_CODING_PLAN_KEY",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			models: ["qwen3.5-plus", "qwen3-max-2026-01-23", "qwen3-coder-plus", "qwen3-coder-next", "kimi-k2.5", "glm-5", "glm-4.7", "MiniMax-M2.5"],
			available: false,
		},
		{
			name: "OpenAI",
			envVar: "OPENAI_API_KEY",
			baseUrl: "https://api.openai.com/v1",
			models: ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini"],
			available: false,
		},
		{
			name: "Anthropic",
			envVar: "ANTHROPIC_API_KEY",
			baseUrl: "https://api.anthropic.com/v1",
			models: ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"],
			available: false,
		},
		{
			name: "Google",
			envVar: "GOOGLE_API_KEY",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			models: ["gemini-2.5-pro", "gemini-2.5-flash"],
			available: false,
		},
		{
			name: "OpenRouter",
			envVar: "OPENROUTER_API_KEY",
			baseUrl: "https://openrouter.ai/api/v1",
			models: [],
			available: false,
		},
		{
			name: "Groq",
			envVar: "GROQ_API_KEY",
			baseUrl: "https://api.groq.com/openai/v1",
			models: ["llama-3.3-70b-versatile", "mixtral-8x7b-32768"],
			available: false,
		},
		{
			name: "Ollama",
			envVar: "OLLAMA",
			baseUrl: "http://localhost:11434/v1",
			models: [], // Discovered at runtime
			available: false,
			local: true,
		},
		{
			name: "LM Studio",
			envVar: "LM_STUDIO",
			baseUrl: "http://localhost:1234/v1",
			models: [], // Discovered at runtime
			available: false,
			local: true,
		},
	];

	for (const p of providers) {
		if (p.local) {
			// Local providers: check if server is running by probing the URL
			p.available = false; // Will be checked async in detectLocalProviders()
		} else {
			p.available = !!process.env[p.envVar];
		}
	}

	return providers;
}

/**
 * Detect local providers (Ollama, LM Studio) by probing their endpoints
 * and fetching available models dynamically.
 */
async function detectLocalProviders(providers: DetectedProvider[]): Promise<void> {
	for (const p of providers) {
		if (!p.local) continue;
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 3000);
			const res = await fetch(`${p.baseUrl}/models`, {
				signal: controller.signal,
				headers: { Authorization: `Bearer ${p.envVar === "OLLAMA" ? "ollama" : "lm-studio"}` },
			});
			clearTimeout(timeout);
			if (res.ok) {
				const data = await res.json() as any;
				const models = (data.data || []).map((m: any) => m.id).filter(Boolean);
				if (models.length > 0) {
					p.models = models;
					p.available = true;
				}
			}
		} catch {
			// Server not running — that's fine
		}
	}
}

function getAllAvailableModels(providers: DetectedProvider[]): string[] {
	return providers.filter(p => p.available).flatMap(p => p.models);
}

// ─── Routing Presets ─────────────────────────────────────────────────────

const TASK_ROLES = [
	{ key: "code", label: "Code Generation", desc: "Writing and modifying code", agent: "code", defaultModel: "default" },
	{ key: "debug", label: "Debugging", desc: "Finding and fixing bugs", agent: "code", defaultModel: "default" },
	{ key: "plan", label: "Planning", desc: "Architecture and design", agent: "plan", defaultModel: "default" },
	{ key: "explore", label: "Exploration", desc: "Code reading and analysis", agent: "explore", defaultModel: "default" },
	{ key: "test", label: "Testing", desc: "Running and writing tests", agent: "test", defaultModel: "default" },
	{ key: "review", label: "Code Review", desc: "Quality and security review", agent: "review", defaultModel: "default" },
] as const;

const KEYWORDS: Record<string, string[]> = {
	code: ["implement", "create", "build", "refactor", "write", "add", "modify", "update", "generate"],
	debug: ["fix", "bug", "error", "debug", "crash", "broken", "failing", "issue", "troubleshoot"],
	explore: ["read", "analyze", "explain", "understand", "find", "search", "look", "show", "what", "how"],
	plan: ["plan", "design", "architect", "spec", "structure", "organize", "strategy", "approach"],
	test: ["test", "verify", "validate", "check", "assert", "coverage"],
	review: ["review", "audit", "quality", "security", "improve", "optimize"],
};

function createRouting(assignments: Record<string, { preferred: string; fallback: string }>): RoutingConfig {
	const routes: RoutingConfig["routes"] = {};
	for (const role of TASK_ROLES) {
		const assignment = assignments[role.key];
		routes[role.key] = {
			description: role.desc,
			keywords: KEYWORDS[role.key] || [],
			preferredModel: assignment?.preferred || role.defaultModel,
			fallback: assignment?.fallback || role.defaultModel,
			agent: role.agent,
		};
	}
	return {
		routes,
		default: { model: assignments["default"]?.preferred || "default", agent: null },
	};
}

// ─── Extension ───────────────────────────────────────────────────────────

export default function initExtension(pi: ExtensionAPI) {
	const phiDir = join(homedir(), ".phi");
	const agentDir = join(phiDir, "agent");
	const agentsDir = join(agentDir, "agents");
	const memoryDir = join(phiDir, "memory");

	/**
	 * Create all necessary directories
	 */
	async function ensureDirs() {
		for (const dir of [agentDir, agentsDir, join(agentDir, "skills"), join(agentDir, "extensions"), memoryDir, join(memoryDir, "ontology")]) {
			await mkdir(dir, { recursive: true });
		}
	}

	/**
	 * Copy bundled agent definitions to user directory
	 */
	async function copyBundledAgents() {
		const bundledDir = resolve(join(__dirname, "..", "..", "..", "agents"));
		if (!existsSync(bundledDir)) return;

		try {
			const files = await readdir(bundledDir);
			for (const file of files) {
				if (file.endsWith(".md")) {
					const dest = join(agentsDir, file);
					if (!existsSync(dest)) {
						await copyFile(join(bundledDir, file), dest);
					}
				}
			}
		} catch {
			// bundled dir not available
		}
	}

	/**
	 * Create AGENTS.md template
	 */
	async function createAgentsTemplate() {
		const agentsMdPath = join(memoryDir, "AGENTS.md");
		if (existsSync(agentsMdPath)) return; // Don't overwrite

		await writeFile(agentsMdPath, `# AGENTS.md — Persistent Instructions

This file is loaded at the start of every session. Use it to store:
- Project conventions and rules
- Recurring instructions
- Important context the agent should always know

## Project

- Name: (your project name)
- Language: TypeScript
- Framework: (your framework)

## Conventions

- (your coding conventions)
- (your naming rules)
- (your commit format)

## Important Notes

- (anything the agent should always remember)

---

_Edit this file to customize Phi Code's behavior for your project._
`, "utf-8");
	}

	// ─── MODE: Auto ──────────────────────────────────────────────────

	/**
	 * Manual mode is the only setup mode.
	 * User assigns each model to each agent role interactively.
	 */
	// ─── MODE: Manual ────────────────────────────────────────────────

	async function manualMode(availableModels: string[], ctx: any): Promise<Record<string, { preferred: string; fallback: string }>> {
		ctx.ui.notify("🎛️ Manual mode: assign a model to each task category.\n", "info");

		const modelOptions = ["default (use current model)", ...availableModels];
		const assignments: Record<string, { preferred: string; fallback: string }> = {};

		for (const role of TASK_ROLES) {
			// Primary model selection
			const chosen = await ctx.ui.select(
				`${role.label} — ${role.desc}`,
				modelOptions,
			);
			const preferredModel = (chosen && chosen !== modelOptions[0]) ? chosen : "default";

			// Fallback model selection
			const fallbackOptions = modelOptions.filter(m => m !== chosen);
			const fallbackChoice = await ctx.ui.select(
				`Fallback for ${role.label}`,
				fallbackOptions,
			);
			const fallback = (fallbackChoice && fallbackChoice !== modelOptions[0]) ? fallbackChoice : "default";

			assignments[role.key] = { preferred: preferredModel, fallback };
			ctx.ui.notify(`  ✅ ${role.label}: ${preferredModel} (fallback: ${fallback})`, "info");
		}

		// Default model
		const defaultChoice = await ctx.ui.select("Default model (for general tasks)", modelOptions);
		let defaultModel = (defaultChoice && defaultChoice !== modelOptions[0]) ? defaultChoice : "default";
		assignments["default"] = { preferred: defaultModel, fallback: availableModels[0] || "default" };

		return assignments;
	}

	// ─── Command ─────────────────────────────────────────────────────

	pi.registerCommand("phi-init", {
		description: "Initialize Phi Code — interactive setup wizard",
		handler: async (args, ctx) => {
			try {
				ctx.ui.notify("╔══════════════════════════════════════╗", "info");
				ctx.ui.notify("║     φ  Phi Code Setup Wizard        ║", "info");
				ctx.ui.notify("╚══════════════════════════════════════╝\n", "info");

				// Pre-fetch model specs from OpenRouter (async, cached)
				ctx.ui.notify("🔍 Fetching model specs from OpenRouter...", "info");
				await fetchModelSpecs();

				// 1. Detect providers
				ctx.ui.notify("🔍 Detecting providers...\n", "info");
				const providers = detectProviders();

				// Also check models.json for previously configured providers
				const modelsJsonPath = join(agentDir, "models.json");
				try {
					const mjContent = await readFile(modelsJsonPath, "utf-8");
					const mjConfig = JSON.parse(mjContent);
					if (mjConfig.providers) {
						for (const [id, config] of Object.entries<any>(mjConfig.providers)) {
							// Mark provider as available if it has an API key in models.json
							if (config.apiKey) {
								const match = providers.find(p =>
									id.includes(p.name.toLowerCase().split(" ")[0]) ||
									p.name.toLowerCase().replace(/\s+/g, "-") === id
								);
								if (match) {
									match.available = true;
									if (config.models?.length > 0) {
										match.models = config.models.map((m: any) => m.id || m);
									}
								}
							}
						}
					}
				} catch { /* no models.json yet */ }

				// Probe local providers (Ollama, LM Studio)
				await detectLocalProviders(providers);

				let available = providers.filter(p => p.available);
				const cloudConfigured = available.filter(p => !p.local);

				// Always show provider status and offer to add/change
				ctx.ui.notify("**Provider Status:**", "info");
				for (const p of providers) {
					const status = p.available ? "✅" : "⬜";
					const tag = p.local ? " (local)" : "";
					const modelCount = p.available ? ` — ${p.models.length} model(s)` : "";
					ctx.ui.notify(`  ${status} ${p.name}${tag}${modelCount}`, "info");
				}

				// No warning needed — the wizard itself handles configuration

				// Provider configuration loop — add as many providers as needed
				let addingProviders = true;
				while (addingProviders) {
					const providerOptions = [
						"Done — continue with current providers",
						...providers.map(p => {
							const status = p.available ? "✅" : "⬜";
							const tag = p.local ? " (local)" : "";
							const modelCount = p.available ? ` (${p.models.length} models)` : "";
							return `${status} ${p.name}${tag}${modelCount}`;
						}),
					];
					const addProvider = await ctx.ui.select("Configure a provider (add multiple!):", providerOptions);

					const choiceIdx = providerOptions.indexOf(addProvider ?? "");
					if (choiceIdx <= 0) { // 0 = Done, or cancelled
						addingProviders = false;
						break;
					}

					const chosen = providers[choiceIdx - 1];

					if (chosen.local) {
						const port = chosen.name === "Ollama" ? 11434 : 1234;
						if (!chosen.available) {
							ctx.ui.notify(`\n💡 **${chosen.name}** — make sure it's running on port ${port}.`, "info");
							ctx.ui.notify("Then restart phi and run `/phi-init` again.\n", "info");
						} else {
							ctx.ui.notify(`\n✅ **${chosen.name}** is running with ${chosen.models.length} model(s).\n`, "info");
						}
					} else {
						// Cloud provider — choose auth method
						const supportsOAuth = ["openai", "anthropic", "google"].includes(
							chosen.name.toLowerCase().split(" ")[0]
						);

						let authMethod = "api-key";
						if (supportsOAuth) {
							const authChoice = await ctx.ui.select(
								`How to authenticate with ${chosen.name}?`,
								["API Key (paste your key)", "OAuth (browser login via /login)"]
							);
							if (authChoice?.includes("OAuth")) {
								authMethod = "oauth";
							}
						}

						if (authMethod === "oauth") {
							ctx.ui.notify(`\n🔐 **${chosen.name}** — Use \`/login\` after setup to authenticate via OAuth.`, "info");
							ctx.ui.notify("OAuth opens a browser window for secure login.\n", "info");
							// Mark as available for model assignment (auth will be done via /login)
							chosen.available = true;
						} else {
							// API Key method
							ctx.ui.notify(`\n🔑 **${chosen.name}**`, "info");

							const apiKey = await ctx.ui.input(
								`Enter your ${chosen.name} API key`,
								"Paste your key here"
							);

							if (!apiKey || apiKey.trim().length < 5) {
								ctx.ui.notify("❌ Invalid API key. Skipped.\n", "error");
							} else {
								// Save to models.json (merges with existing)
								let modelsConfig: any = { providers: {} };
								try {
									const existing = await readFile(modelsJsonPath, "utf-8");
									modelsConfig = JSON.parse(existing);
									if (!modelsConfig.providers) modelsConfig.providers = {};
								} catch { /* new file */ }

								const providerId = chosen.name.toLowerCase().replace(/\s+/g, "-");
								modelsConfig.providers[providerId] = {
									baseUrl: chosen.baseUrl,
									api: "openai-completions",
									apiKey: apiKey.trim(),
									models: await Promise.all(chosen.models.map(async (id: string) => {
										const spec = await getModelSpec(id);
										return {
											id,
											name: id,
											reasoning: spec.reasoning,
											input: ["text"],
											contextWindow: spec.contextWindow,
											maxTokens: spec.maxTokens,
										};
									})),
								};

								await writeFile(modelsJsonPath, JSON.stringify(modelsConfig, null, 2), "utf-8");
								process.env[chosen.envVar] = apiKey.trim();
								chosen.available = true;

								const masked = apiKey.trim().substring(0, 6) + "..." + apiKey.trim().slice(-4);
								ctx.ui.notify(`✅ **${chosen.name}** configured (${masked})`, "info");
								ctx.ui.notify(`   ${chosen.models.length} models added to \`models.json\`\n`, "info");
							}
						}
					}
				} // end while (addingProviders)

				// Re-check available after potential additions
				available = providers.filter(p => p.available);

				if (available.length === 0) {
					ctx.ui.notify("\n❌ No providers available. Run `/phi-init` again after setting up a provider.", "error");
					return;
				}

				const allModels = getAllAvailableModels(providers);
				ctx.ui.notify(`\n✅ **${allModels.length} models** available from ${available.length} provider(s).\n`, "info");

				// 2. Assign models to agents (manual)
				ctx.ui.notify(`\n📋 **Assign a model to each agent role:**\n`, "info");

				const assignments = await manualMode(allModels, ctx);

				// 4. Create directory structure
				ctx.ui.notify("\n📁 Creating directories...", "info");
				await ensureDirs();

				// 5. Write routing config
				ctx.ui.notify("🔀 Writing routing configuration...", "info");
				const routing = createRouting(assignments);
				await writeFile(join(agentDir, "routing.json"), JSON.stringify(routing, null, 2), "utf-8");

				// 6. Copy bundled agents
				ctx.ui.notify("🤖 Setting up sub-agents...", "info");
				await copyBundledAgents();

				// 7. Create AGENTS.md template
				ctx.ui.notify("📝 Creating memory template...", "info");
				await createAgentsTemplate();

				// 8. Summary
				ctx.ui.notify("\n╔══════════════════════════════════════╗", "info");
				ctx.ui.notify("║     ✅  Setup Complete!              ║", "info");
				ctx.ui.notify("╚══════════════════════════════════════╝\n", "info");

				ctx.ui.notify("**Configuration:**", "info");
				ctx.ui.notify(`  📁 Config: ${agentDir}`, "info");
				ctx.ui.notify(`  📁 Memory: ${memoryDir}`, "info");
				ctx.ui.notify(`  🤖 Agents: ${agentsDir}`, "info");

				ctx.ui.notify("\n**Model Assignments:**", "info");
				for (const role of TASK_ROLES) {
					const a = assignments[role.key];
					ctx.ui.notify(`  ${role.label}: \`${a.preferred}\` (fallback: \`${a.fallback}\`)`, "info");
				}
				ctx.ui.notify(`  Default: \`${assignments["default"].preferred}\``, "info");

				ctx.ui.notify("\n**Next steps:**", "info");
				ctx.ui.notify("  • Edit `~/.phi/memory/AGENTS.md` with your project instructions", "info");
				ctx.ui.notify("  • Run `/agents` to see available sub-agents", "info");
				ctx.ui.notify("  • Run `/skills` to see available skills", "info");
				ctx.ui.notify("  • Run `/benchmark all` to test model performance", "info");
				ctx.ui.notify("  • Start coding! 🚀\n", "info");

			} catch (error) {
				ctx.ui.notify(`❌ Setup failed: ${error}`, "error");
			}
		},
	});

}
