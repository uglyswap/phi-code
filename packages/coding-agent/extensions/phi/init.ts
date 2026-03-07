/**
 * Phi Init Extension - Interactive setup wizard for Phi Code
 *
 * Three modes:
 * - auto: Use Alibaba Coding Plan defaults (instant, recommended)
 * - benchmark: Test available models with /benchmark, then assign (10-15 min)
 * - manual: User assigns each model role interactively
 *
 * Creates ~/.phi/agent/ structure with routing, agents, and memory.
 */

import type { ExtensionAPI } from "phi-code";
import { writeFile, mkdir, copyFile, readdir, access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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

	// ─── Model Intelligence Database ─────────────────────────────────

	interface ModelProfile {
		id: string;
		capabilities: {
			coding: number;    // 0-100 score for code generation
			reasoning: number; // 0-100 score for debugging/planning
			speed: number;     // 0-100 score for fast tasks
			general: number;   // 0-100 overall score
		};
		hasReasoning: boolean;
	}

	/**
	 * Fetch model profiles from OpenRouter's free API.
	 * Classifies each model based on its description, name, and supported parameters.
	 * Falls back to name-based heuristics if OpenRouter is unreachable.
	 */
	async function fetchModelProfiles(modelIds: string[]): Promise<Map<string, ModelProfile>> {
		const profiles = new Map<string, ModelProfile>();

		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);
			const res = await fetch("https://openrouter.ai/api/v1/models", {
				signal: controller.signal,
			});
			clearTimeout(timeout);

			if (res.ok) {
				const data = await res.json() as any;
				const orModels: any[] = data.data || [];

				for (const modelId of modelIds) {
					// Try exact match first, then fuzzy match by base name
					const baseName = modelId.replace(/:.+$/, "").split("/").pop()?.toLowerCase() || modelId.toLowerCase();
					const match = orModels.find((m: any) => {
						const mId = m.id?.toLowerCase() || "";
						const mName = m.name?.toLowerCase() || "";
						return mId.includes(baseName) || mName.includes(baseName);
					});

					if (match) {
						const desc = (match.description || "").toLowerCase();
						const name = (match.name || "").toLowerCase();
						const hasReasoning = (match.supported_parameters || []).includes("reasoning")
							|| (match.supported_parameters || []).includes("include_reasoning");

						// Score based on description keywords and model characteristics
						let coding = 50, reasoning = 50, speed = 50, general = 60;

						// Coding signals
						if (/cod(e|ing|ex)|program|implement|refactor|software engineer/.test(desc) || /coder|codex|codestral/.test(name)) {
							coding = 85;
						}
						// Reasoning signals
						if (hasReasoning || /reason|think|logic|step.by.step|complex/.test(desc) || /o1|o3|pro|opus/.test(name)) {
							reasoning = 85;
						}
						// Speed signals (smaller/cheaper models)
						const pricing = match.pricing || {};
						const promptCost = parseFloat(pricing.prompt || "0.01");
						if (promptCost < 0.001 || /fast|flash|mini|small|haiku|lite|instant/.test(name)) {
							speed = 85;
						}
						// General quality (larger context = usually better)
						const ctx = match.context_length || 0;
						if (ctx >= 200000) general = 80;
						if (ctx >= 1000000) general = 90;
						if (/frontier|flagship|most.advanced|best|state.of.the.art/.test(desc)) general = 90;

						profiles.set(modelId, { id: modelId, capabilities: { coding, reasoning, speed, general }, hasReasoning });
					}
				}
			}
		} catch {
			// OpenRouter unreachable — will fall back to heuristics
		}

		// Fill in any models not found in OpenRouter with name-based heuristics
		for (const modelId of modelIds) {
			if (!profiles.has(modelId)) {
				profiles.set(modelId, classifyByName(modelId));
			}
		}

		return profiles;
	}

	/**
	 * Fallback: classify model by name patterns when OpenRouter data is unavailable.
	 */
	function classifyByName(modelId: string): ModelProfile {
		const l = modelId.toLowerCase();
		let coding = 50, reasoning = 50, speed = 50, general = 55;
		let hasReasoning = false;

		if (/coder|code|codestral/.test(l)) coding = 80;
		if (/max|pro|plus|opus|large|o1|o3/.test(l)) { reasoning = 80; general = 75; }
		if (/mini|flash|fast|small|haiku|lite/.test(l)) { speed = 80; }
		if (/o1|o3|deepseek-r1|qwq/.test(l)) { hasReasoning = true; reasoning = 85; }

		return { id: modelId, capabilities: { coding, reasoning, speed, general }, hasReasoning };
	}

	/**
	 * Auto-assign models using OpenRouter rankings + models.dev data.
	 * Works with ANY provider — cloud, local, or mixed.
	 *
	 * Strategy:
	 * 1. Fetch model profiles from OpenRouter (free, no API key needed)
	 * 2. Score each model for coding, reasoning, speed, and general tasks
	 * 3. Assign best model per role based on scores
	 * 4. Fall back to name-based heuristics if OpenRouter is unreachable
	 * 5. Single model? → everything uses that model (still works!)
	 */
	async function autoMode(availableModels: string[], ctx?: any): Promise<Record<string, { preferred: string; fallback: string }>> {
		const assignments: Record<string, { preferred: string; fallback: string }> = {};

		if (availableModels.length === 0) {
			const fb = { preferred: "default", fallback: "default" };
			for (const role of TASK_ROLES) assignments[role.key] = fb;
			assignments["default"] = fb;
			return assignments;
		}

		if (availableModels.length === 1) {
			const single = { preferred: availableModels[0], fallback: availableModels[0] };
			for (const role of TASK_ROLES) assignments[role.key] = single;
			assignments["default"] = single;
			return assignments;
		}

		// Fetch intelligence from OpenRouter
		if (ctx) ctx.ui.notify("📊 Fetching model rankings from OpenRouter...", "info");
		const profiles = await fetchModelProfiles(availableModels);

		// Find best model for each capability
		function bestFor(capability: keyof ModelProfile["capabilities"]): string {
			let best = availableModels[0], bestScore = 0;
			for (const id of availableModels) {
				const p = profiles.get(id);
				if (p && p.capabilities[capability] > bestScore) {
					bestScore = p.capabilities[capability];
					best = id;
				}
			}
			return best;
		}

		function secondBestFor(capability: keyof ModelProfile["capabilities"], excludeId: string): string {
			let best = availableModels.find(m => m !== excludeId) || excludeId;
			let bestScore = 0;
			for (const id of availableModels) {
				if (id === excludeId) continue;
				const p = profiles.get(id);
				if (p && p.capabilities[capability] > bestScore) {
					bestScore = p.capabilities[capability];
					best = id;
				}
			}
			return best;
		}

		const bestCoder = bestFor("coding");
		const bestReasoner = bestFor("reasoning");
		const bestFast = bestFor("speed");
		const bestGeneral = bestFor("general");

		assignments["code"] = { preferred: bestCoder, fallback: secondBestFor("coding", bestCoder) };
		assignments["debug"] = { preferred: bestReasoner, fallback: secondBestFor("reasoning", bestReasoner) };
		assignments["plan"] = { preferred: bestReasoner, fallback: secondBestFor("reasoning", bestReasoner) };
		assignments["explore"] = { preferred: bestFast, fallback: secondBestFor("speed", bestFast) };
		assignments["test"] = { preferred: bestFast, fallback: secondBestFor("speed", bestFast) };
		assignments["review"] = { preferred: bestGeneral, fallback: secondBestFor("general", bestGeneral) };
		assignments["default"] = { preferred: bestGeneral, fallback: secondBestFor("general", bestGeneral) };

		// Show what was assigned and why
		if (ctx) {
			ctx.ui.notify("📊 Model rankings applied:", "info");
			for (const role of TASK_ROLES) {
				const a = assignments[role.key];
				const p = profiles.get(a.preferred);
				const scores = p ? `(coding:${p.capabilities.coding} reasoning:${p.capabilities.reasoning} speed:${p.capabilities.speed})` : "";
				ctx.ui.notify(`  ${role.label}: ${a.preferred} ${scores}`, "info");
			}
		}

		return assignments;
	}

	// ─── MODE: Benchmark ─────────────────────────────────────────────

	async function benchmarkMode(availableModels: string[], ctx: any): Promise<Record<string, { preferred: string; fallback: string }>> {
		// Check if benchmark results already exist
		const benchmarkPath = join(phiDir, "benchmark", "results.json");
		let existingResults: any = null;
		try {
			await access(benchmarkPath);
			const content = await readFile(benchmarkPath, "utf-8");
			existingResults = JSON.parse(content);
		} catch {
			// No existing results
		}

		if (existingResults?.results?.length > 0) {
			const useExisting = await ctx.ui.confirm(
				"Use existing benchmarks?",
				`Found ${existingResults.results.length} benchmark results from a previous run. Use them?`
			);
			if (useExisting) {
				ctx.ui.notify("📊 Using existing benchmark results for model assignment.\n", "info");
				return assignFromBenchmark(existingResults.results, availableModels);
			}
		}

		// No existing results or user declined — run benchmarks now
		ctx.ui.notify("🧪 Benchmark mode: launching model tests...", "info");
		ctx.ui.notify("This tests each model with 6 coding tasks via real API calls.", "info");
		ctx.ui.notify("⏱️ Estimated time: 2-3 minutes per model.\n", "info");

		// Trigger benchmark via sendUserMessage — this runs /benchmark all
		// which saves results to the same results.json path
		ctx.sendUserMessage("/benchmark all");
		ctx.ui.notify("⏳ Benchmarks started. Once complete, run `/phi-init` again and select benchmark mode to use the results.\n", "info");
		ctx.ui.notify("💡 The benchmark runs in the background. You'll see live results in the terminal.\n", "info");

		// Return auto mode assignments as temporary defaults
		// (will be overwritten when user re-runs /phi-init with benchmark results)
		ctx.ui.notify("📋 Setting auto-mode defaults while benchmarks run...\n", "info");
		return autoMode(availableModels, ctx);
	}

	function assignFromBenchmark(results: any[], availableModels: string[]): Record<string, { preferred: string; fallback: string }> {
		const assignments: Record<string, { preferred: string; fallback: string }> = {};

		// Sort by total score
		const sorted = [...results].sort((a: any, b: any) => (b.totalScore || 0) - (a.totalScore || 0));
		const bestOverall = sorted[0]?.modelId || availableModels[0];
		const secondBest = sorted[1]?.modelId || bestOverall;

		// Find best per category
		function bestForCategory(category: string): string {
			let best = { id: bestOverall, score: 0 };
			for (const r of results) {
				const catScore = r.categories?.[category]?.score ?? 0;
				if (catScore > best.score) {
					best = { id: r.modelId, score: catScore };
				}
			}
			return best.id;
		}

		assignments["code"] = { preferred: bestForCategory("code-gen"), fallback: secondBest };
		assignments["debug"] = { preferred: bestForCategory("debug"), fallback: secondBest };
		assignments["plan"] = { preferred: bestForCategory("planning"), fallback: secondBest };
		assignments["explore"] = { preferred: bestForCategory("speed"), fallback: secondBest };
		assignments["test"] = { preferred: bestForCategory("speed"), fallback: secondBest };
		assignments["review"] = { preferred: bestForCategory("orchestration"), fallback: secondBest };
		assignments["default"] = { preferred: bestOverall, fallback: secondBest };

		return assignments;
	}

	// ─── MODE: Manual ────────────────────────────────────────────────

	async function manualMode(availableModels: string[], ctx: any): Promise<Record<string, { preferred: string; fallback: string }>> {
		ctx.ui.notify("🎛️ Manual mode: assign a model to each task category.\n", "info");

		const modelList = availableModels.map((m, i) => `  ${i + 1}. ${m}`).join("\n");
		ctx.ui.notify(`Available models:\n${modelList}\n`, "info");
		const assignments: Record<string, { preferred: string; fallback: string }> = {};

		for (const role of TASK_ROLES) {
			ctx.ui.notify(`\n**${role.label}** — ${role.desc}\nDefault: ${role.defaultModel}`, "info");
			const input = await ctx.ui.input(
				`${role.label}`,
				`Model name or # (default: ${role.defaultModel})`
			);

			let chosen = role.defaultModel;
			const trimmed = (input ?? "").trim();

			if (trimmed) {
				// Try as number
				const num = parseInt(trimmed);
				if (num >= 1 && num <= availableModels.length) {
					chosen = availableModels[num - 1];
				} else {
					// Try as model name (partial match)
					const match = availableModels.find(m => m.toLowerCase().includes(trimmed.toLowerCase()));
					if (match) chosen = match;
				}
			}

			// Fallback selection
			const fallbackDefault = availableModels.find(m => m !== chosen) || chosen;
			const fallbackInput = await ctx.ui.input(
				`Fallback for ${role.label}`,
				`Fallback model (default: ${fallbackDefault})`
			);

			let fallback = fallbackDefault;
			if ((fallbackInput ?? "").trim()) {
				const num = parseInt((fallbackInput ?? "").trim());
				if (num >= 1 && num <= availableModels.length) {
					fallback = availableModels[num - 1];
				} else {
					const match = availableModels.find(m => m.toLowerCase().includes((fallbackInput ?? "").trim().toLowerCase()));
					if (match) fallback = match;
				}
			}

			assignments[role.key] = { preferred: chosen, fallback };
			ctx.ui.notify(`  ✅ ${role.label}: ${chosen} (fallback: ${fallback})`, "info");
		}

		// Default model
		const defaultInput = await ctx.ui.input(
			"Default model",
			`Model for general tasks (default: ${availableModels[0]})`
		);
		let defaultModel = availableModels[0];
		if ((defaultInput ?? "").trim()) {
			const num = parseInt((defaultInput ?? "").trim());
			if (num >= 1 && num <= availableModels.length) {
				defaultModel = availableModels[num - 1];
			} else {
				const match = availableModels.find(m => m.toLowerCase().includes((defaultInput ?? "").trim().toLowerCase()));
				if (match) defaultModel = match;
			}
		}
		assignments["default"] = { preferred: defaultModel, fallback: availableModels[0] };

		return assignments;
	}

	// ─── Command ─────────────────────────────────────────────────────

	pi.registerCommand("phi-init", {
		description: "Initialize Phi Code — interactive setup wizard (3 modes: auto, benchmark, manual)",
		handler: async (args, ctx) => {
			try {
				ctx.ui.notify("╔══════════════════════════════════════╗", "info");
				ctx.ui.notify("║     Φ  Phi Code Setup Wizard        ║", "info");
				ctx.ui.notify("╚══════════════════════════════════════╝\n", "info");

				// 1. Detect API keys and local providers
				ctx.ui.notify("🔍 Detecting providers...", "info");
				const providers = detectProviders();

				// Probe local providers (Ollama, LM Studio)
				ctx.ui.notify("🔍 Probing local model servers...", "info");
				await detectLocalProviders(providers);

				let available = providers.filter(p => p.available);

				// If no providers found, offer interactive API key setup
				if (available.length === 0) {
					ctx.ui.notify("⚠️ No API keys detected. Let's set one up!\n", "info");
					ctx.ui.notify("**Available providers:**", "info");
					const cloudProviders = providers.filter(p => !p.local);
					cloudProviders.forEach((p, i) => {
						ctx.ui.notify(`  ${i + 1}. ${p.name}`, "info");
					});
					ctx.ui.notify(`  ${cloudProviders.length + 1}. Ollama (local)`, "info");
					ctx.ui.notify(`  ${cloudProviders.length + 2}. LM Studio (local)\n`, "info");

					const providerChoice = await ctx.ui.input(
						"Choose provider (number)",
						`1-${cloudProviders.length + 2}`
					);
					const choiceNum = parseInt(providerChoice ?? "0");

					if (choiceNum >= 1 && choiceNum <= cloudProviders.length) {
						// Cloud provider — ask for API key
						const chosen = cloudProviders[choiceNum - 1];
						ctx.ui.notify(`\n🔑 **${chosen.name}** selected.`, "info");

						const apiKey = await ctx.ui.input(
							`Enter your ${chosen.name} API key`,
							"sk-..."
						);

						if (!apiKey || apiKey.trim().length < 5) {
							ctx.ui.notify("❌ Invalid API key. Cancelled.", "error");
							return;
						}

						// Save to models.json for persistence
						const modelsJsonPath = join(agentDir, "models.json");
						let modelsConfig: any = { providers: {} };
						try {
							const existing = await readFile(modelsJsonPath, "utf-8");
							modelsConfig = JSON.parse(existing);
						} catch { /* file doesn't exist yet */ }

						// Build provider config with correct provider ID
						const providerId = chosen.name.toLowerCase().replace(/\s+/g, "-");
						modelsConfig.providers[providerId] = {
							baseUrl: chosen.baseUrl,
							api: "openai-completions",
							apiKey: apiKey.trim(),
							models: chosen.models.map((id: string) => ({
								id,
								name: id,
								reasoning: true,
								input: ["text"],
								contextWindow: 131072,
								maxTokens: 16384,
							})),
						};

						await writeFile(modelsJsonPath, JSON.stringify(modelsConfig, null, 2), "utf-8");

						// Also set in current session
						process.env[chosen.envVar] = apiKey.trim();
						chosen.available = true;

						ctx.ui.notify(`\n✅ API key saved to \`~/.phi/agent/models.json\``, "info");
						ctx.ui.notify(`   ${chosen.models.length} models configured.`, "info");
						ctx.ui.notify(`   ⚠️ **Restart phi** for models to load.\n`, "warning");
						ctx.ui.notify("Run `phi` again, then `/phi-init` to complete setup.", "info");
						return;

					} else if (choiceNum === cloudProviders.length + 1 || choiceNum === cloudProviders.length + 2) {
						const localName = choiceNum === cloudProviders.length + 1 ? "Ollama" : "LM Studio";
						const port = choiceNum === cloudProviders.length + 1 ? 11434 : 1234;
						ctx.ui.notify(`\n💡 **${localName}** selected. Make sure it's running on port ${port}.`, "info");
						ctx.ui.notify(`Then restart phi and run /phi-init again.`, "info");
						return;
					} else {
						ctx.ui.notify("❌ Invalid choice. Cancelled.", "error");
						return;
					}
				}

				ctx.ui.notify(`✅ Found ${available.length} provider(s):`, "info");
				for (const p of available) {
					const tag = p.local ? " (local)" : "";
					ctx.ui.notify(`  • ${p.name}${tag} — ${p.models.length} model(s)${p.local ? ": " + p.models.join(", ") : ""}`, "info");
				}

				const allModels = getAllAvailableModels(providers);
				ctx.ui.notify(`  Total: ${allModels.length} models available\n`, "info");

				// 2. Choose mode
				ctx.ui.notify("Choose setup mode:\n" +
					"  1. auto      — Use optimal defaults (instant)\n" +
					"  2. benchmark — Test models first, assign by results (10-15 min)\n" +
					"  3. manual    — Choose each model yourself\n", "info");

				const modeInput = await ctx.ui.input(
					"Setup mode",
					"1=auto, 2=benchmark, 3=manual"
				);

				const modeStr = (modeInput ?? "").trim().toLowerCase();
				const mode = modeStr.startsWith("2") || modeStr.startsWith("b") ? "benchmark"
					: modeStr.startsWith("3") || modeStr.startsWith("m") ? "manual"
					: "auto";

				ctx.ui.notify(`\n📋 Mode: **${mode}**\n`, "info");

				// 3. Get assignments based on mode
				let assignments: Record<string, { preferred: string; fallback: string }>;

				if (mode === "auto") {
					assignments = await autoMode(allModels, ctx);
				} else if (mode === "benchmark") {
					assignments = await benchmarkMode(allModels, ctx);
				} else {
					assignments = await manualMode(allModels, ctx);
				}

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

	// ─── API Key Management Command ─────────────────────────────────

	pi.registerCommand("api-key", {
		description: "Set or view API keys (usage: /api-key set <provider> <key> | /api-key list)",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const action = parts[0]?.toLowerCase();

			const PROVIDERS: Record<string, { envVar: string; name: string }> = {
				alibaba: { envVar: "ALIBABA_CODING_PLAN_KEY", name: "Alibaba Coding Plan" },
				dashscope: { envVar: "DASHSCOPE_API_KEY", name: "DashScope (Alibaba)" },
				openai: { envVar: "OPENAI_API_KEY", name: "OpenAI" },
				anthropic: { envVar: "ANTHROPIC_API_KEY", name: "Anthropic" },
				google: { envVar: "GOOGLE_API_KEY", name: "Google" },
				openrouter: { envVar: "OPENROUTER_API_KEY", name: "OpenRouter" },
				groq: { envVar: "GROQ_API_KEY", name: "Groq" },
				brave: { envVar: "BRAVE_API_KEY", name: "Brave Search" },
			};

			if (!action || action === "help") {
				ctx.ui.notify(`**🔑 API Key Management**

Usage:
  /api-key set <provider> <key>   — Set an API key for this session
  /api-key list                   — Show configured providers
  /api-key providers              — List all supported providers

Supported providers: ${Object.keys(PROVIDERS).join(", ")}

Example:
  /api-key set alibaba sk-sp-xxx
  /api-key set openai sk-xxx

Keys set with /api-key are active for the current session.
For persistence, set environment variables:
  • Windows: setx ALIBABA_CODING_PLAN_KEY "your-key"
  • Linux/Mac: export ALIBABA_CODING_PLAN_KEY="your-key"`, "info");
				return;
			}

			if (action === "list") {
				let found = 0;
				let msg = "**🔑 Configured API Keys:**\n";
				for (const [id, info] of Object.entries(PROVIDERS)) {
					const key = process.env[info.envVar];
					if (key) {
						const masked = key.substring(0, 6) + "..." + key.substring(key.length - 4);
						msg += `  ✅ ${info.name} (${id}): ${masked}\n`;
						found++;
					}
				}
				if (found === 0) {
					msg += "  ❌ No API keys configured\n";
					msg += "\nUse `/api-key set <provider> <key>` to add one.";
				}
				ctx.ui.notify(msg, "info");
				return;
			}

			if (action === "providers") {
				let msg = "**Supported Providers:**\n";
				for (const [id, info] of Object.entries(PROVIDERS)) {
					const status = process.env[info.envVar] ? "✅" : "⬜";
					msg += `  ${status} **${id}** — ${info.name} (${info.envVar})\n`;
				}
				ctx.ui.notify(msg, "info");
				return;
			}

			if (action === "set") {
				const provider = parts[1]?.toLowerCase();
				const key = parts.slice(2).join(" ").trim();

				if (!provider || !key) {
					ctx.ui.notify("Usage: /api-key set <provider> <key>\nExample: /api-key set alibaba sk-sp-xxx", "warning");
					return;
				}

				const info = PROVIDERS[provider];
				if (!info) {
					ctx.ui.notify(`Unknown provider "${provider}". Supported: ${Object.keys(PROVIDERS).join(", ")}`, "error");
					return;
				}

				// Set in current process environment
				process.env[info.envVar] = key;
				if (provider === "alibaba") {
					process.env.DASHSCOPE_API_KEY = key;
				}

				// Persist to models.json
				const modelsJsonPath = join(homedir(), ".phi", "agent", "models.json");
				let modelsConfig: any = { providers: {} };
				try {
					const existing = readFileSync(modelsJsonPath, "utf-8");
					modelsConfig = JSON.parse(existing);
				} catch { /* file doesn't exist yet */ }

				// Find provider config from detectProviders
				const providerDefs = detectProviders();
				const providerDef = providerDefs.find(p => p.envVar === info.envVar);
				if (providerDef) {
					const providerId = providerDef.name.toLowerCase().replace(/\s+/g, "-");
					modelsConfig.providers[providerId] = {
						baseUrl: providerDef.baseUrl,
						api: "openai-completions",
						apiKey: key,
						models: providerDef.models.map((id: string) => ({
							id, name: id, reasoning: true, input: ["text"],
							contextWindow: 131072, maxTokens: 16384,
						})),
					};
					writeFileSync(modelsJsonPath, JSON.stringify(modelsConfig, null, 2), "utf-8");
				}

				const masked = key.substring(0, 6) + "..." + key.substring(key.length - 4);
				ctx.ui.notify(`✅ **${info.name}** API key saved: ${masked}\n\n📁 Saved to \`~/.phi/agent/models.json\` (persistent)\n⚠️ **Restart phi** for the new models to load.`, "info");
				return;
			}

			ctx.ui.notify("Unknown action. Use: /api-key set|list|providers|help", "warning");
		},
	});
}
