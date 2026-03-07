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
import { writeFile, mkdir, copyFile, readdir, access } from "node:fs/promises";
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
	];

	for (const p of providers) {
		p.available = !!process.env[p.envVar];
	}

	return providers;
}

function getAllAvailableModels(providers: DetectedProvider[]): string[] {
	return providers.filter(p => p.available).flatMap(p => p.models);
}

// ─── Routing Presets ─────────────────────────────────────────────────────

const TASK_ROLES = [
	{ key: "code", label: "Code Generation", desc: "Writing and modifying code", agent: "code", defaultModel: "qwen3-coder-plus" },
	{ key: "debug", label: "Debugging", desc: "Finding and fixing bugs", agent: "code", defaultModel: "qwen3-max-2026-01-23" },
	{ key: "plan", label: "Planning", desc: "Architecture and design", agent: "plan", defaultModel: "qwen3-max-2026-01-23" },
	{ key: "explore", label: "Exploration", desc: "Code reading and analysis", agent: "explore", defaultModel: "kimi-k2.5" },
	{ key: "test", label: "Testing", desc: "Running and writing tests", agent: "test", defaultModel: "kimi-k2.5" },
	{ key: "review", label: "Code Review", desc: "Quality and security review", agent: "review", defaultModel: "qwen3.5-plus" },
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
			fallback: assignment?.fallback || "qwen3.5-plus",
			agent: role.agent,
		};
	}
	return {
		routes,
		default: { model: assignments["default"]?.preferred || "qwen3.5-plus", agent: null },
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

	function autoMode(availableModels: string[]): Record<string, { preferred: string; fallback: string }> {
		const assignments: Record<string, { preferred: string; fallback: string }> = {};

		for (const role of TASK_ROLES) {
			const preferred = availableModels.includes(role.defaultModel) ? role.defaultModel : availableModels[0];
			const fallbackModel = availableModels.includes("qwen3.5-plus") ? "qwen3.5-plus" : availableModels[0];
			assignments[role.key] = { preferred, fallback: fallbackModel };
		}
		assignments["default"] = {
			preferred: availableModels.includes("qwen3.5-plus") ? "qwen3.5-plus" : availableModels[0],
			fallback: availableModels[0],
		};

		return assignments;
	}

	// ─── MODE: Benchmark ─────────────────────────────────────────────

	async function benchmarkMode(availableModels: string[], ctx: any): Promise<Record<string, { preferred: string; fallback: string }>> {
		ctx.ui.notify("🧪 Benchmark mode: running tests on available models...", "info");
		ctx.ui.notify("This will test each model with 6 coding tasks. It may take 10-15 minutes.", "info");
		ctx.ui.notify("💡 Tip: You can run `/benchmark all` separately and use `/benchmark results` to see rankings.\n", "info");

		// Check if benchmark results already exist
		const benchmarkPath = join(phiDir, "benchmark", "results.json");
		let existingResults: any = null;
		try {
			await access(benchmarkPath);
			const content = await (await import("node:fs/promises")).readFile(benchmarkPath, "utf-8");
			existingResults = JSON.parse(content);
		} catch {
			// No existing results
		}

		if (existingResults?.results?.length > 0) {
			const useExisting = await ctx.ui.confirm(
				`Found ${existingResults.results.length} existing benchmark results. Use them instead of re-running?`
			);
			if (useExisting) {
				return assignFromBenchmark(existingResults.results, availableModels);
			}
		}

		// Run benchmarks via the /benchmark command
		ctx.ui.notify("Starting benchmarks... (this runs in the background, continue with /phi-init after /benchmark completes)\n", "info");
		ctx.ui.notify("Run: `/benchmark all` then `/phi-init` again with mode=benchmark to use results.\n", "info");

		// Fall back to auto for now
		return autoMode(availableModels);
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
		const assignments: Record<string, { preferred: string; fallback: string }> = {};

		for (const role of TASK_ROLES) {
			const input = await ctx.ui.input(
				`**${role.label}** — ${role.desc}\nDefault: ${role.defaultModel}\n\nAvailable models:\n${modelList}\n\nEnter model name or number (Enter for default):`
			);

			let chosen = role.defaultModel;
			const trimmed = input.trim();

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
				`Fallback model for ${role.label}? (Enter for ${fallbackDefault}):`
			);

			let fallback = fallbackDefault;
			if (fallbackInput.trim()) {
				const num = parseInt(fallbackInput.trim());
				if (num >= 1 && num <= availableModels.length) {
					fallback = availableModels[num - 1];
				} else {
					const match = availableModels.find(m => m.toLowerCase().includes(fallbackInput.trim().toLowerCase()));
					if (match) fallback = match;
				}
			}

			assignments[role.key] = { preferred: chosen, fallback };
			ctx.ui.notify(`  ✅ ${role.label}: ${chosen} (fallback: ${fallback})`, "info");
		}

		// Default model
		const defaultInput = await ctx.ui.input(
			`Default model for general tasks?\nAvailable:\n${modelList}\n\nEnter model name or number (Enter for ${availableModels[0]}):`
		);
		let defaultModel = availableModels[0];
		if (defaultInput.trim()) {
			const num = parseInt(defaultInput.trim());
			if (num >= 1 && num <= availableModels.length) {
				defaultModel = availableModels[num - 1];
			} else {
				const match = availableModels.find(m => m.toLowerCase().includes(defaultInput.trim().toLowerCase()));
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

				// 1. Detect API keys
				ctx.ui.notify("🔍 Detecting API keys...", "info");
				const providers = detectProviders();
				const available = providers.filter(p => p.available);

				if (available.length === 0) {
					ctx.ui.notify("❌ No API keys found. Set at least one:\n" +
						providers.map(p => `  export ${p.envVar}="your-key"  # ${p.name}`).join("\n") +
						"\n\n💡 Free option: Get an Alibaba Coding Plan key at https://help.aliyun.com/zh/model-studio/", "error");
					return;
				}

				ctx.ui.notify(`✅ Found ${available.length} provider(s):`, "info");
				for (const p of available) {
					ctx.ui.notify(`  • ${p.name} — ${p.models.length} models`, "info");
				}

				const allModels = getAllAvailableModels(providers);
				ctx.ui.notify(`  Total: ${allModels.length} models available\n`, "info");

				// 2. Choose mode
				const modeInput = await ctx.ui.input(
					"Choose setup mode:\n\n" +
					"  1. auto      — Use optimal defaults from public rankings (instant)\n" +
					"  2. benchmark — Test models with coding tasks, assign by results (10-15 min)\n" +
					"  3. manual    — Choose each model assignment yourself\n\n" +
					"Enter 1, 2, or 3:"
				);

				const mode = modeInput.trim().startsWith("2") || modeInput.trim().toLowerCase().startsWith("b") ? "benchmark"
					: modeInput.trim().startsWith("3") || modeInput.trim().toLowerCase().startsWith("m") ? "manual"
					: "auto";

				ctx.ui.notify(`\n📋 Mode: **${mode}**\n`, "info");

				// 3. Get assignments based on mode
				let assignments: Record<string, { preferred: string; fallback: string }>;

				if (mode === "auto") {
					assignments = autoMode(allModels);
					ctx.ui.notify("⚡ Auto-assigned models based on public rankings and model specializations.", "info");
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
}
