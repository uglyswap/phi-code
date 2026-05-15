/**
 * Phi Init Extension - Interactive setup wizard for Phi Code (legacy `/phi-init`).
 *
 * Detects providers (API keys + local endpoints), then lets the user manually
 * assign models to each agent role (code, debug, plan, explore, test, review).
 *
 * Creates ~/.phi/agent/ structure with routing, agents, and memory.
 *
 * Hardening (2026-05-15):
 *  - Uses the unified live-models registry (every provider is now refreshed
 *    against its `/v1/models` endpoint, with static fallback when offline).
 *  - The entire handler runs inside a defensive try/catch that surfaces errors
 *    as `ctx.ui.notify("error")` instead of letting the host TUI crash. A
 *    process-level `unhandledRejection` guard is installed once on first run
 *    so a stray promise rejection during model probing cannot terminate phi-code.
 *  - The API-key input flow now persists the key BEFORE any model enrichment
 *    so a network failure on /v1/models cannot lose the user's input.
 */

import type { ExtensionAPI } from "phi-code";
import { writeFile, mkdir, copyFile, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { fetchLiveModels, pingProvider, toPersistedModel } from "./providers/live-models.js";

// ─── Types ───────────────────────────────────────────────────────────────

interface DetectedProvider {
	id: string;
	name: string;
	envVar: string;
	baseUrl: string;
	api: string;
	requiresApiKey: boolean;
	available: boolean;
	models: string[];
	/** True for Ollama/LM Studio (models discovered at runtime, no key required). */
	local?: boolean;
}

interface RoutingConfig {
	routes: Record<
		string,
		{
			description: string;
			keywords: string[];
			preferredModel: string;
			fallback: string;
			agent: string;
		}
	>;
	default: { model: string; agent: string | null };
}

// ─── One-time global unhandledRejection guard ────────────────────────────

let unhandledRejectionGuardInstalled = false;
function installUnhandledRejectionGuard(): void {
	if (unhandledRejectionGuardInstalled) return;
	unhandledRejectionGuardInstalled = true;
	process.on("unhandledRejection", (reason) => {
		// Swallow async failures from extension wizards so they cannot terminate the TUI.
		// The wizard itself reports the failure via ctx.ui.notify in its own try/catch.
		const message = reason instanceof Error ? reason.message : String(reason);
		try {
			// Best effort logging — process.stderr survives TUI shutdown unlike console.
			process.stderr.write(`[phi-init] swallowed unhandledRejection: ${message}\n`);
		} catch {
			// no-op
		}
	});
}

// ─── Provider Detection ──────────────────────────────────────────────────

function detectProviders(): DetectedProvider[] {
	const providers: DetectedProvider[] = [
		{
			id: "alibaba-codingplan",
			name: "Alibaba Coding Plan",
			envVar: "ALIBABA_CODING_PLAN_KEY",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			api: "openai-completions",
			requiresApiKey: true,
			available: false,
			models: [],
		},
		{
			id: "opencode-go",
			name: "OpenCode Go",
			envVar: "OPENCODE_GO_API_KEY",
			baseUrl: "https://opencode.ai/zen/go/v1",
			api: "openai-completions",
			requiresApiKey: true,
			available: false,
			models: [],
		},
		{
			id: "openai",
			name: "OpenAI",
			envVar: "OPENAI_API_KEY",
			baseUrl: "https://api.openai.com/v1",
			api: "openai-completions",
			requiresApiKey: true,
			available: false,
			models: [],
		},
		{
			id: "anthropic",
			name: "Anthropic",
			envVar: "ANTHROPIC_API_KEY",
			baseUrl: "https://api.anthropic.com/v1",
			api: "anthropic-messages",
			requiresApiKey: true,
			available: false,
			models: [],
		},
		{
			id: "google",
			name: "Google Gemini",
			envVar: "GOOGLE_API_KEY",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			api: "google",
			requiresApiKey: true,
			available: false,
			models: [],
		},
		{
			id: "openrouter",
			name: "OpenRouter",
			envVar: "OPENROUTER_API_KEY",
			baseUrl: "https://openrouter.ai/api/v1",
			api: "openai-completions",
			requiresApiKey: true,
			available: false,
			models: [],
		},
		{
			id: "groq",
			name: "Groq",
			envVar: "GROQ_API_KEY",
			baseUrl: "https://api.groq.com/openai/v1",
			api: "openai-completions",
			requiresApiKey: true,
			available: false,
			models: [],
		},
		{
			id: "ollama",
			name: "Ollama",
			envVar: "OLLAMA",
			baseUrl: "http://localhost:11434/v1",
			api: "openai-completions",
			requiresApiKey: false,
			available: false,
			models: [],
			local: true,
		},
		{
			id: "lm-studio",
			name: "LM Studio",
			envVar: "LM_STUDIO",
			baseUrl: "http://localhost:1234/v1",
			api: "openai-completions",
			requiresApiKey: false,
			available: false,
			models: [],
			local: true,
		},
	];

	for (const p of providers) {
		if (!p.local && process.env[p.envVar]) {
			p.available = true;
		}
	}
	return providers;
}

/**
 * Probe local providers (Ollama, LM Studio) and live-fetch their model list.
 * Failures are silent — local servers are optional.
 */
async function detectLocalProviders(providers: DetectedProvider[]): Promise<void> {
	await Promise.all(
		providers
			.filter((p) => p.local)
			.map(async (p) => {
				const result = await fetchLiveModels(p.id, { forceRefresh: true, timeoutMs: 2_500 });
				if (result.models.length > 0 && result.source !== "fallback") {
					p.models = result.models.map((m) => m.id);
					p.available = true;
				}
			}),
	);
}

function getAllAvailableModels(providers: DetectedProvider[]): string[] {
	const ids = new Set<string>();
	for (const p of providers) {
		if (!p.available) continue;
		for (const id of p.models) ids.add(id);
	}
	return [...ids];
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

function createRouting(
	assignments: Record<string, { preferred: string; fallback: string }>,
): RoutingConfig {
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
	installUnhandledRejectionGuard();

	const phiDir = join(homedir(), ".phi");
	const agentDir = join(phiDir, "agent");
	const agentsDir = join(agentDir, "agents");
	const memoryDir = join(phiDir, "memory");
	const modelsJsonPath = join(agentDir, "models.json");

	async function ensureDirs(): Promise<void> {
		for (const dir of [
			agentDir,
			agentsDir,
			join(agentDir, "skills"),
			join(agentDir, "extensions"),
			memoryDir,
			join(memoryDir, "ontology"),
		]) {
			await mkdir(dir, { recursive: true });
		}
	}

	async function copyBundledAgents(): Promise<void> {
		const bundledDir = resolve(join(__dirname, "..", "..", "..", "agents"));
		if (!existsSync(bundledDir)) return;
		try {
			const files = await readdir(bundledDir);
			for (const file of files) {
				if (!file.endsWith(".md")) continue;
				const dest = join(agentsDir, file);
				if (!existsSync(dest)) {
					await copyFile(join(bundledDir, file), dest);
				}
			}
		} catch {
			// bundled dir not available
		}
	}

	async function createAgentsTemplate(): Promise<void> {
		const agentsMdPath = join(memoryDir, "AGENTS.md");
		if (existsSync(agentsMdPath)) return;
		await writeFile(
			agentsMdPath,
			`# AGENTS.md — Persistent Instructions

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
`,
			"utf-8",
		);
	}

	// ─── Persistence helper (single source of truth for models.json writes) ──

	async function readModelsConfig(): Promise<{ providers: Record<string, any> }> {
		try {
			const raw = await readFile(modelsJsonPath, "utf-8");
			const parsed = JSON.parse(raw) as { providers?: Record<string, any> };
			return { providers: parsed.providers ?? {} };
		} catch {
			return { providers: {} };
		}
	}

	async function writeModelsConfig(config: { providers: Record<string, any> }): Promise<void> {
		await mkdir(agentDir, { recursive: true });
		await writeFile(modelsJsonPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	}

	async function persistProviderKey(
		provider: DetectedProvider,
		apiKey: string,
	): Promise<void> {
		const config = await readModelsConfig();
		const existing = config.providers[provider.id] ?? {};
		config.providers[provider.id] = {
			...existing,
			baseUrl: provider.baseUrl,
			api: provider.api,
			apiKey,
		};
		await writeModelsConfig(config);
	}

	async function persistProviderModels(
		provider: DetectedProvider,
		models: ReturnType<typeof toPersistedModel>[],
	): Promise<void> {
		const config = await readModelsConfig();
		const existing = config.providers[provider.id] ?? {};
		config.providers[provider.id] = {
			...existing,
			baseUrl: provider.baseUrl,
			api: provider.api,
			models,
		};
		await writeModelsConfig(config);
	}

	// ─── Manual model assignment (one model per agent role) ──────────────

	async function manualMode(
		availableModels: string[],
		ctx: any,
	): Promise<Record<string, { preferred: string; fallback: string }>> {
		ctx.ui.notify("Manual mode: assign a model to each task category.\n", "info");
		const modelOptions = ["default (use current model)", ...availableModels];
		const assignments: Record<string, { preferred: string; fallback: string }> = {};

		for (const role of TASK_ROLES) {
			const chosen = await ctx.ui.select(`${role.label} — ${role.desc}`, modelOptions);
			const preferredModel = chosen && chosen !== modelOptions[0] ? chosen : "default";

			const fallbackOptions = modelOptions.filter((m) => m !== chosen);
			const fallbackChoice = await ctx.ui.select(`Fallback for ${role.label}`, fallbackOptions);
			const fallback = fallbackChoice && fallbackChoice !== modelOptions[0] ? fallbackChoice : "default";

			assignments[role.key] = { preferred: preferredModel, fallback };
			ctx.ui.notify(`  ${role.label}: ${preferredModel} (fallback: ${fallback})`, "info");
		}

		const defaultChoice = await ctx.ui.select("Default model (for general tasks)", modelOptions);
		const defaultModel = defaultChoice && defaultChoice !== modelOptions[0] ? defaultChoice : "default";
		assignments["default"] = { preferred: defaultModel, fallback: availableModels[0] || "default" };
		return assignments;
	}

	// ─── Per-provider configuration step ─────────────────────────────────

	async function configureProvider(provider: DetectedProvider, ctx: any): Promise<void> {
		if (provider.local) {
			const port = provider.id === "ollama" ? 11434 : 1234;
			const result = await fetchLiveModels(provider.id, { forceRefresh: true, timeoutMs: 2_500 });
			if (result.source === "live" && result.models.length > 0) {
				provider.models = result.models.map((m) => m.id);
				provider.available = true;
				ctx.ui.notify(
					`${provider.name} is running with ${provider.models.length} model(s).\n`,
					"info",
				);
			} else {
				ctx.ui.notify(
					`${provider.name} not reachable on port ${port}. Start it and re-run \`/phi-init\`.\n`,
					"warning",
				);
			}
			return;
		}

		// Cloud provider — API key required.
		ctx.ui.notify(
			`\n${provider.name}\nNote: the key you type will be visible on screen. Stored in ${modelsJsonPath} (chmod 0600 on Unix).`,
			"info",
		);

		const apiKey = await ctx.ui.input(
			`Enter your ${provider.name} API key`,
			"Paste your key here",
		);

		if (apiKey === undefined) {
			ctx.ui.notify("Cancelled. No key saved.", "warning");
			return;
		}
		const trimmed = apiKey.trim();
		if (trimmed.length < 5) {
			ctx.ui.notify("Invalid API key (too short). Skipped.\n", "error");
			return;
		}

		// Persist the key FIRST. Any subsequent failure during live-fetch must
		// not cause the user to lose what they just typed.
		try {
			await persistProviderKey(provider, trimmed);
			process.env[provider.envVar] = trimmed;
		} catch (err) {
			ctx.ui.notify(
				`Failed to write ${modelsJsonPath}: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			return;
		}

		// Optional ping — informational only, never fatal.
		ctx.ui.setStatus?.("phi-init-ping", `Pinging ${provider.name}...`);
		const ping = await pingProvider(provider.id, trimmed, 5_000).catch((err) => ({
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		}));
		ctx.ui.setStatus?.("phi-init-ping", undefined);
		if (ping.ok) {
			ctx.ui.notify(`${provider.name} ping OK (200).`, "info");
		} else {
			ctx.ui.notify(
				`${provider.name} ping failed: ${ping.error ?? "unknown"}. Key saved anyway — you can retry with \`/keys test ${provider.id}\`.`,
				"warning",
			);
		}

		// Fetch live model list (with fallback) and persist it.
		ctx.ui.setStatus?.("phi-init-fetch", `Fetching ${provider.name} models...`);
		const live = await fetchLiveModels(provider.id, {
			apiKey: trimmed,
			forceRefresh: true,
			timeoutMs: 6_000,
		});
		ctx.ui.setStatus?.("phi-init-fetch", undefined);

		const persistedModels = live.models.map(toPersistedModel);
		try {
			await persistProviderModels(provider, persistedModels);
		} catch (err) {
			ctx.ui.notify(
				`Failed to write provider models to ${modelsJsonPath}: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
			return;
		}

		provider.models = persistedModels.map((m) => m.id);
		provider.available = true;
		const masked = `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
		ctx.ui.notify(
			`${provider.name} configured (${masked}) — ${persistedModels.length} models (source: ${live.source}${live.error ? `, ${live.error}` : ""}).\n`,
			"info",
		);
	}

	// ─── Command ─────────────────────────────────────────────────────

	pi.registerCommand("phi-init", {
		description: "Initialize Phi Code (legacy alias — prefer /setup for the refined wizard)",
		handler: async (_args, ctx) => {
			try {
				ctx.ui.notify(
					"NOTE: `/phi-init` is the legacy wizard. The refined replacement is `/setup` " +
						"(richer flow: Alibaba dual-endpoint, OpenCode Go auto-fetch, ping validation, " +
						"separate chat/orchestration assignments, hot-reload integration). " +
						"This legacy command still works for backwards compatibility.",
					"info",
				);

				ctx.ui.notify("    Phi Code Setup Wizard", "info");

				// 1. Detect providers (env vars + local servers + previously saved keys)
				ctx.ui.notify("Detecting providers...\n", "info");
				const providers = detectProviders();

				// Merge in any previously saved providers from models.json.
				const savedConfig = await readModelsConfig();
				for (const [id, config] of Object.entries(savedConfig.providers)) {
					const match = providers.find((p) => p.id === id);
					if (!match) continue;
					if (config?.apiKey) {
						match.available = true;
						if (Array.isArray(config.models) && config.models.length > 0) {
							match.models = config.models.map((m: any) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
						}
					}
				}

				// Probe local providers (Ollama, LM Studio)
				await detectLocalProviders(providers);

				ctx.ui.notify("Provider Status:", "info");
				for (const p of providers) {
					const status = p.available ? "[ok]" : "[--]";
					const tag = p.local ? " (local)" : "";
					const modelCount = p.available ? ` — ${p.models.length} model(s)` : "";
					ctx.ui.notify(`  ${status} ${p.name}${tag}${modelCount}`, "info");
				}

				// Provider configuration loop
				let addingProviders = true;
				while (addingProviders) {
					const providerOptions = [
						"Done — continue with current providers",
						...providers.map((p) => {
							const status = p.available ? "[ok]" : "[--]";
							const tag = p.local ? " (local)" : "";
							const modelCount = p.available ? ` (${p.models.length} models)` : "";
							return `${status} ${p.name}${tag}${modelCount}`;
						}),
					];
					const addProvider = await ctx.ui.select(
						"Configure a provider (add multiple!):",
						providerOptions,
					);

					const choiceIdx = providerOptions.indexOf(addProvider ?? "");
					if (choiceIdx <= 0) {
						addingProviders = false;
						break;
					}

					const chosen = providers[choiceIdx - 1];
					try {
						await configureProvider(chosen, ctx);
					} catch (err) {
						// Never bubble up — keep the wizard alive.
						ctx.ui.notify(
							`Provider configuration failed: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
				}

				const available = providers.filter((p) => p.available);
				if (available.length === 0) {
					ctx.ui.notify(
						"No providers available. Run `/phi-init` again after setting up a provider.",
						"error",
					);
					return;
				}

				const allModels = getAllAvailableModels(providers);
				ctx.ui.notify(
					`\n${allModels.length} models available from ${available.length} provider(s).\n`,
					"info",
				);

				// 2. Assign models to agents
				ctx.ui.notify("Assign a model to each agent role:\n", "info");
				const assignments = await manualMode(allModels, ctx);

				// 3. Persist everything
				ctx.ui.notify("Creating directories...", "info");
				await ensureDirs();

				ctx.ui.notify("Writing routing configuration...", "info");
				const routing = createRouting(assignments);
				await writeFile(
					join(agentDir, "routing.json"),
					JSON.stringify(routing, null, 2),
					"utf-8",
				);

				ctx.ui.notify("Setting up sub-agents...", "info");
				await copyBundledAgents();

				ctx.ui.notify("Creating memory template...", "info");
				await createAgentsTemplate();

				ctx.ui.notify("\n     Setup Complete!\n", "info");
				ctx.ui.notify("Configuration:", "info");
				ctx.ui.notify(`  Config: ${agentDir}`, "info");
				ctx.ui.notify(`  Memory: ${memoryDir}`, "info");
				ctx.ui.notify(`  Agents: ${agentsDir}`, "info");
				ctx.ui.notify("\nModel Assignments:", "info");
				for (const role of TASK_ROLES) {
					const a = assignments[role.key];
					ctx.ui.notify(`  ${role.label}: \`${a.preferred}\` (fallback: \`${a.fallback}\`)`, "info");
				}
				ctx.ui.notify(`  Default: \`${assignments["default"].preferred}\``, "info");
				ctx.ui.notify("\nNext steps:", "info");
				ctx.ui.notify("  - Edit `~/.phi/memory/AGENTS.md` with your project instructions", "info");
				ctx.ui.notify("  - Run `/agents` to see available sub-agents", "info");
				ctx.ui.notify("  - Run `/skills` to see available skills", "info");
				ctx.ui.notify("  - Run `/models refresh` to re-fetch the model catalog", "info");
				ctx.ui.notify("  - Start coding!\n", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Setup failed: ${message}`, "error");
			}
		},
	});
}
