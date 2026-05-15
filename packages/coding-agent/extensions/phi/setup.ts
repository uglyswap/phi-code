/**
 * Setup Wizard Extension (/setup) - Refonte UX du wizard de configuration.
 *
 * Per Q8 strategy B: nouvelle commande /setup qui remplace /phi-init
 * (gardé en alias rétrocompat dans init.ts). UX:
 *  - Panneau de statut persistant via setWidget (providers + assignments)
 *  - Fuzzy search via ctx.ui.select (matching builtin Phi/upstream)
 *  - Ping API immédiat à la saisie de clé (validation 401/200)
 *  - Choix endpoint Alibaba (OpenAI-compat vs Anthropic-compat per Q2C)
 *  - OpenCode Go avec auto-fetch runtime des modèles (per Q4A)
 *  - Sélection séparée chat normal vs orchestration (5 phases)
 *  - Persistance atomique via ApiKeyStore (chmod 0600 Unix)
 *  - Hot-reload propagation: setKey émet "key_changed" event
 *
 * Note: ctx.ui.input ne supporte pas le masking actuellement (limitation TUI).
 * Pour compenser:
 *  - Warning explicite avant la saisie ("la clé apparaitra à l'écran")
 *  - Toutes les notifications post-saisie utilisent ApiKeyStore.maskKey()
 *  - Storage chmod 0600 garantit la sécurité au repos
 */

import { ApiKeyStore, type ExtensionAPI, type ExtensionUIContext, getApiKeyStore } from "phi-code";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	ALIBABA_ENV_VAR,
	ALIBABA_MODELS,
	ALIBABA_PROVIDERS,
	ALIBABA_RATE_LIMITS,
	buildAlibabaProviderConfig,
	pingAlibaba,
	validateAlibabaApiKey,
} from "./providers/alibaba.js";
import {
	OPENCODE_GO_AUTH_URL,
	OPENCODE_GO_ENV_VAR,
	buildOpenCodeGoProviderConfig,
	getOpenCodeGoModels,
	pingOpenCodeGo,
	validateOpenCodeGoApiKey,
} from "./providers/opencode-go.js";
import { fetchLiveModels, pingProvider, toPersistedModel } from "./providers/live-models.js";

// ─── Types ───────────────────────────────────────────────────────────────

interface ProviderEntry {
	id: string;
	displayName: string;
	envVar: string;
	baseUrl: string;
	api: string;
	staticModels: string[];
	supportsOAuth?: boolean;
	local?: boolean;
	probeUrl?: string;
	docUrl?: string;
}

interface RouteAssignment {
	preferred: string;
	fallback: string;
}

interface RoutingConfigOut {
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

const ORCHESTRATION_ROLES = [
	{ key: "explore", label: "Explore", desc: "Read-only analysis", agent: "explore", keywords: ["read", "analyze", "explain", "understand", "find", "search", "look", "show", "what", "how"] },
	{ key: "plan", label: "Plan", desc: "Architecture and design", agent: "plan", keywords: ["plan", "design", "architect", "spec", "structure", "organize", "strategy", "approach"] },
	{ key: "code", label: "Code", desc: "Implementation", agent: "code", keywords: ["implement", "create", "build", "refactor", "write", "add", "modify", "update", "generate"] },
	{ key: "test", label: "Test", desc: "Validation and tests", agent: "test", keywords: ["test", "verify", "validate", "check", "assert", "coverage"] },
	{ key: "review", label: "Review", desc: "Quality and security review", agent: "review", keywords: ["review", "audit", "quality", "security", "improve", "optimize"] },
] as const;

const DEBUG_KEYWORDS = ["fix", "bug", "error", "debug", "crash", "broken", "failing", "issue", "troubleshoot"];

// ─── Provider catalog ────────────────────────────────────────────────────

function getProviderCatalog(): ProviderEntry[] {
	return [
		{
			id: "alibaba-codingplan",
			displayName: "Alibaba Coding Plan",
			envVar: ALIBABA_ENV_VAR,
			baseUrl: ALIBABA_PROVIDERS.openai.baseUrl,
			api: "openai-completions",
			staticModels: ALIBABA_MODELS.map((m) => m.id),
			docUrl: "https://www.alibabacloud.com/help/en/model-studio/coding-plan",
		},
		{
			id: "opencode-go",
			displayName: "OpenCode Go (zen)",
			envVar: OPENCODE_GO_ENV_VAR,
			baseUrl: "https://opencode.ai/zen/go/v1",
			api: "openai-completions",
			staticModels: [],
			docUrl: OPENCODE_GO_AUTH_URL,
		},
		{
			id: "openai",
			displayName: "OpenAI",
			envVar: "OPENAI_API_KEY",
			baseUrl: "https://api.openai.com/v1",
			api: "openai-completions",
			staticModels: ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini", "gpt-5"],
			supportsOAuth: true,
		},
		{
			id: "anthropic",
			displayName: "Anthropic",
			envVar: "ANTHROPIC_API_KEY",
			baseUrl: "https://api.anthropic.com/v1",
			api: "anthropic-messages",
			staticModels: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-3-5-haiku-20241022"],
			supportsOAuth: true,
		},
		{
			id: "google",
			displayName: "Google Gemini",
			envVar: "GOOGLE_API_KEY",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			api: "google",
			staticModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
			supportsOAuth: true,
		},
		{
			id: "openrouter",
			displayName: "OpenRouter",
			envVar: "OPENROUTER_API_KEY",
			baseUrl: "https://openrouter.ai/api/v1",
			api: "openai-completions",
			staticModels: [],
		},
		{
			id: "groq",
			displayName: "Groq",
			envVar: "GROQ_API_KEY",
			baseUrl: "https://api.groq.com/openai/v1",
			api: "openai-completions",
			staticModels: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"],
		},
		{
			id: "ollama",
			displayName: "Ollama (local)",
			envVar: "OLLAMA",
			baseUrl: "http://localhost:11434/v1",
			api: "openai-completions",
			staticModels: [],
			local: true,
			probeUrl: "http://localhost:11434/v1/models",
		},
		{
			id: "lm-studio",
			displayName: "LM Studio (local)",
			envVar: "LM_STUDIO",
			baseUrl: "http://localhost:1234/v1",
			api: "openai-completions",
			staticModels: [],
			local: true,
			probeUrl: "http://localhost:1234/v1/models",
		},
	];
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function probeLocalProvider(provider: ProviderEntry): Promise<string[]> {
	if (!provider.local) return [];
	const result = await fetchLiveModels(provider.id, { forceRefresh: true, timeoutMs: 2_500 });
	return result.source === "live" ? result.models.map((m) => m.id) : [];
}

function buildStatusWidget(
	store: ApiKeyStore,
	available: Map<string, { source: "key" | "env" | "local"; modelCount: number }>,
	assignments: { default?: string; orchestration: Record<string, RouteAssignment> },
): string[] {
	const lines: string[] = [];
	lines.push("─── Phi Code Setup ───");
	lines.push("");
	lines.push("Providers:");
	const catalog = getProviderCatalog();
	for (const p of catalog) {
		const state = available.get(p.id);
		const icon = state ? "[ok]" : "[--]";
		const note = state ? ` (${state.modelCount} models, ${state.source})` : "";
		lines.push(`  ${icon} ${p.displayName}${note}`);
	}
	lines.push("");
	lines.push("Assignments:");
	lines.push(`  Default chat   : ${assignments.default ?? "(not set)"}`);
	for (const role of ORCHESTRATION_ROLES) {
		const a = assignments.orchestration[role.key];
		const preferred = a?.preferred ?? "(not set)";
		const fallback = a?.fallback ?? "(none)";
		lines.push(`  ${role.label.padEnd(8)} : ${preferred} / ${fallback}`);
	}
	lines.push("");
	lines.push(`Keys file : ${store.configPath} (chmod 0600 on Unix)`);
	return lines;
}

function maskKeyForDisplay(key: string | undefined): string {
	return ApiKeyStore.maskKey(key);
}

function buildRoutingConfig(
	defaultModel: string,
	orchestration: Record<string, RouteAssignment>,
): RoutingConfigOut {
	const routes: RoutingConfigOut["routes"] = {};
	for (const role of ORCHESTRATION_ROLES) {
		const a = orchestration[role.key] ?? { preferred: defaultModel, fallback: defaultModel };
		routes[role.key] = {
			description: role.desc,
			keywords: [...role.keywords],
			preferredModel: a.preferred,
			fallback: a.fallback,
			agent: role.agent,
		};
	}
	routes.debug = {
		description: "Debugging, fixing, error resolution",
		keywords: [...DEBUG_KEYWORDS],
		preferredModel: orchestration.code?.preferred ?? defaultModel,
		fallback: orchestration.code?.fallback ?? defaultModel,
		agent: "code",
	};
	return {
		routes,
		default: { model: defaultModel, agent: null },
	};
}

async function writeRoutingConfig(routing: RoutingConfigOut): Promise<string> {
	const dir = join(homedir(), ".phi", "agent");
	await mkdir(dir, { recursive: true });
	const path = join(dir, "routing.json");
	await writeFile(path, `${JSON.stringify({ ...routing, $schema: "./routing.schema.json", version: 1 }, null, 2)}\n`, "utf-8");
	return path;
}

// ─── Provider configuration sub-flow ─────────────────────────────────────

async function configureAlibaba(
	ui: ExtensionUIContext,
	store: ApiKeyStore,
): Promise<{ providerId: string; modelCount: number } | undefined> {
	ui.notify(
		`**Alibaba Coding Plan** (${ALIBABA_RATE_LIMITS.subscriptionType})\n` +
			`Rate limits: ${ALIBABA_RATE_LIMITS.per5Hours}/5h | ${ALIBABA_RATE_LIMITS.perWeek}/week | ${ALIBABA_RATE_LIMITS.perMonth}/month\n` +
			`Both variants share the SAME API key (env var ${ALIBABA_ENV_VAR}, format sk-sp-xxxxx).`,
		"info",
	);

	const variantChoice = await ui.select("Which Alibaba endpoint to configure?", [
		"OpenAI-compat (/v1) - legacy, broad compat",
		"Anthropic-compat (/apps/anthropic) - ~99.7% prompt cache hit (recommended)",
		"Both endpoints (configure once, register both)",
		"Cancel",
	]);
	if (!variantChoice || variantChoice === "Cancel") return undefined;

	ui.notify(
		"WARNING: the key you type will be visible on screen during input. " +
			"It will be stored chmod 0600 in ~/.phi/agent/models.json.",
		"warning",
	);
	const apiKey = await ui.input("Paste your Alibaba Coding Plan API key", "sk-sp-...");
	if (!apiKey || apiKey.trim().length === 0) {
		ui.notify("No key provided. Skipped.", "warning");
		return undefined;
	}

	const trimmed = apiKey.trim();
	const validationError = validateAlibabaApiKey(trimmed);
	if (validationError) {
		const proceed = await ui.confirm("Invalid key format", `${validationError}. Save anyway?`);
		if (!proceed) return undefined;
	}

	ui.setStatus("setup-ping", "Pinging Alibaba endpoint...");
	const pingResult = await pingAlibaba(trimmed);
	ui.setStatus("setup-ping", undefined);

	if (!pingResult.ok) {
		const proceed = await ui.confirm(
			"Ping failed",
			`Alibaba ping failed: ${pingResult.error ?? "unknown"}. Save key anyway?`,
		);
		if (!proceed) return undefined;
	} else {
		ui.notify("Alibaba ping OK (200).", "info");
	}

	let modelCount = 0;
	let lastProviderId = "alibaba-codingplan";

	const installVariant = (variant: "openai" | "anthropic"): void => {
		const provider = ALIBABA_PROVIDERS[variant];
		const config = buildAlibabaProviderConfig(variant, trimmed);
		store.setKey(provider.id, trimmed, {
			baseUrl: config.baseUrl,
			api: config.api,
			models: config.models,
		});
		modelCount += config.models.length;
		lastProviderId = provider.id;
	};

	if (variantChoice.startsWith("OpenAI-compat")) installVariant("openai");
	else if (variantChoice.startsWith("Anthropic-compat")) installVariant("anthropic");
	else {
		installVariant("openai");
		installVariant("anthropic");
	}

	ui.notify(
		`Alibaba configured: \`${maskKeyForDisplay(trimmed)}\` -> ${variantChoice.split(" -")[0]}\n` +
			`${modelCount} model entries saved to ~/.phi/agent/models.json.`,
		"info",
	);
	return { providerId: lastProviderId, modelCount };
}

async function configureOpenCodeGo(
	ui: ExtensionUIContext,
	store: ApiKeyStore,
): Promise<{ providerId: string; modelCount: number } | undefined> {
	ui.notify(
		`**OpenCode Go (zen)** - subscribe at ${OPENCODE_GO_AUTH_URL} ($5 first month, $10/month).\n` +
			`After subscribing, paste your API key below.`,
		"info",
	);

	ui.notify("WARNING: the key you type will be visible on screen during input.", "warning");
	const apiKey = await ui.input("Paste your OpenCode Go API key", "...");
	if (!apiKey || apiKey.trim().length === 0) {
		ui.notify("No key provided. Skipped.", "warning");
		return undefined;
	}

	const trimmed = apiKey.trim();
	const validationError = validateOpenCodeGoApiKey(trimmed);
	if (validationError) {
		const proceed = await ui.confirm("Invalid key format", `${validationError}. Save anyway?`);
		if (!proceed) return undefined;
	}

	ui.setStatus("setup-ping", "Pinging OpenCode Go...");
	const pingResult = await pingOpenCodeGo(trimmed);
	ui.setStatus("setup-ping", undefined);

	if (!pingResult.ok) {
		const proceed = await ui.confirm(
			"Ping failed",
			`OpenCode Go ping failed: ${pingResult.error ?? "unknown"}. Save key anyway?`,
		);
		if (!proceed) return undefined;
	} else {
		ui.notify("OpenCode Go ping OK (200).", "info");
	}

	ui.setStatus("setup-fetch", "Fetching live OpenCode Go model list...");
	const { models, source } = await getOpenCodeGoModels({ apiKey: trimmed, forceRefresh: true });
	ui.setStatus("setup-fetch", undefined);

	ui.notify(`Fetched ${models.length} OpenCode Go models (source: ${source}).`, "info");
	const config = buildOpenCodeGoProviderConfig(trimmed, models);
	store.setKey("opencode-go", trimmed, {
		baseUrl: config.baseUrl,
		api: config.api,
		models: config.models,
	});

	ui.notify(
		`OpenCode Go configured: \`${maskKeyForDisplay(trimmed)}\` (${models.length} models)`,
		"info",
	);
	return { providerId: "opencode-go", modelCount: models.length };
}

async function configureGenericCloud(
	ui: ExtensionUIContext,
	store: ApiKeyStore,
	provider: ProviderEntry,
): Promise<{ providerId: string; modelCount: number } | undefined> {
	if (provider.supportsOAuth) {
		const authChoice = await ui.select(`Auth method for ${provider.displayName}`, [
			"API Key (paste your key)",
			"OAuth (run /login after setup)",
			"Cancel",
		]);
		if (!authChoice || authChoice === "Cancel") return undefined;
		if (authChoice.startsWith("OAuth")) {
			ui.notify(
				`Run \`/login ${provider.id}\` after setup to authenticate via OAuth.`,
				"info",
			);
			store.setKey(provider.id, "$OAUTH", {
				baseUrl: provider.baseUrl,
				api: provider.api,
			});
			return { providerId: provider.id, modelCount: provider.staticModels.length };
		}
	}

	ui.notify("WARNING: the key you type will be visible on screen during input.", "warning");
	const apiKey = await ui.input(`Paste your ${provider.displayName} API key`, "...");
	if (!apiKey || apiKey.trim().length === 0) {
		ui.notify("No key provided. Skipped.", "warning");
		return undefined;
	}

	const trimmed = apiKey.trim();
	if (trimmed.length < 8) {
		const proceed = await ui.confirm("Suspiciously short key", "Save anyway?");
		if (!proceed) return undefined;
	}

	// Persist the key immediately so a downstream fetch failure cannot lose user input.
	store.setKey(provider.id, trimmed, {
		baseUrl: provider.baseUrl,
		api: provider.api,
	});

	// Optional ping for early auth diagnostics.
	ui.setStatus("setup-ping", `Pinging ${provider.displayName}...`);
	const ping = await pingProvider(provider.id, trimmed, 5_000).catch((err) => ({
		ok: false,
		error: err instanceof Error ? err.message : String(err),
	}));
	ui.setStatus("setup-ping", undefined);
	if (ping.ok) {
		ui.notify(`${provider.displayName} ping OK (200).`, "info");
	} else {
		ui.notify(
			`${provider.displayName} ping failed: ${ping.error ?? "unknown"}. Key saved; you can retry with \`/keys test ${provider.id}\`.`,
			"warning",
		);
	}

	// Live-fetch the model catalog (falls back to the static list when offline).
	ui.setStatus("setup-fetch", `Fetching ${provider.displayName} model list...`);
	const live = await fetchLiveModels(provider.id, {
		apiKey: trimmed,
		forceRefresh: true,
		timeoutMs: 6_000,
	});
	ui.setStatus("setup-fetch", undefined);

	const models = (live.models.length > 0
		? live.models
		: provider.staticModels.map((id) => ({ id, name: id, reasoning: true }))
	).map(toPersistedModel);

	store.setKey(provider.id, trimmed, {
		baseUrl: provider.baseUrl,
		api: provider.api,
		models,
	});

	ui.notify(
		`${provider.displayName} configured: \`${maskKeyForDisplay(trimmed)}\` (${models.length} models, source: ${live.source}${live.error ? `, ${live.error}` : ""})`,
		"info",
	);
	return { providerId: provider.id, modelCount: models.length };
}

async function configureLocal(
	ui: ExtensionUIContext,
	store: ApiKeyStore,
	provider: ProviderEntry,
): Promise<{ providerId: string; modelCount: number } | undefined> {
	ui.setStatus("setup-probe", `Probing ${provider.displayName}...`);
	const models = await probeLocalProvider(provider);
	ui.setStatus("setup-probe", undefined);

	if (models.length === 0) {
		ui.notify(
			`${provider.displayName} not reachable at ${provider.baseUrl}. ` +
				`Start the server and re-run /setup, or skip.`,
			"warning",
		);
		return undefined;
	}

	store.setKey(provider.id, "local", {
		baseUrl: provider.baseUrl,
		api: provider.api,
		models: models.map((id) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"] as const,
		})),
	});
	ui.notify(`${provider.displayName} configured: ${models.length} models discovered.`, "info");
	return { providerId: provider.id, modelCount: models.length };
}

// ─── Assignment sub-flow ─────────────────────────────────────────────────

async function pickModelFromCatalog(
	ui: ExtensionUIContext,
	prompt: string,
	allModelIds: string[],
): Promise<string | undefined> {
	if (allModelIds.length === 0) {
		ui.notify("No models available. Configure a provider first.", "warning");
		return undefined;
	}
	const options = ["(keep default)", ...allModelIds];
	const choice = await ui.select(prompt, options);
	if (!choice || choice === options[0]) return undefined;
	return choice;
}

async function configureAssignments(
	ui: ExtensionUIContext,
	allModelIds: string[],
): Promise<{ defaultModel: string; orchestration: Record<string, RouteAssignment> }> {
	if (allModelIds.length === 0) {
		ui.notify("No models available for assignment. Configure a provider first.", "warning");
		return { defaultModel: "default", orchestration: {} };
	}

	const defaultModel =
		(await pickModelFromCatalog(ui, "Default chat model (used when no orchestration is active)", allModelIds)) ??
		allModelIds[0];

	const orchestration: Record<string, RouteAssignment> = {};
	for (const role of ORCHESTRATION_ROLES) {
		const preferred =
			(await pickModelFromCatalog(ui, `${role.label} - preferred model (${role.desc})`, allModelIds)) ??
			defaultModel;
		const fallbackOptions = allModelIds.filter((m) => m !== preferred);
		const fallback = fallbackOptions.length > 0
			? (await pickModelFromCatalog(ui, `${role.label} - fallback model`, fallbackOptions)) ?? preferred
			: preferred;
		orchestration[role.key] = { preferred, fallback };
		ui.notify(`  ${role.label}: ${preferred} / ${fallback}`, "info");
	}

	return { defaultModel, orchestration };
}

// ─── Extension ───────────────────────────────────────────────────────────

// One-time global guard so a stray async rejection inside the wizard never kills the TUI.
let setupUnhandledGuard = false;
function installSetupUnhandledRejectionGuard(): void {
	if (setupUnhandledGuard) return;
	setupUnhandledGuard = true;
	process.on("unhandledRejection", (reason) => {
		const message = reason instanceof Error ? reason.message : String(reason);
		try {
			process.stderr.write(`[phi-setup] swallowed unhandledRejection: ${message}\n`);
		} catch {
			// no-op
		}
	});
}

export default function setupExtension(pi: ExtensionAPI) {
	installSetupUnhandledRejectionGuard();
	pi.registerCommand("setup", {
		description: "Phi Code setup wizard (refonte UX, replaces /phi-init)",
		handler: async (_args, ctx) => {
			const ui = ctx.ui;
			const store = getApiKeyStore();
			try {
				store.load();
			} catch {
				// empty file or missing, fine
			}

			try {
			ui.notify(
				"**φ Phi Code Setup Wizard**\n\n" +
					"This wizard configures providers and assigns models to agent roles.\n" +
					"Keys are stored in `~/.phi/agent/models.json` (chmod 0600 on Unix).\n" +
					"Edit that file directly later to hot-reload (no restart needed).",
				"info",
			);

			const available = new Map<string, { source: "key" | "env" | "local"; modelCount: number }>();
			const assignments: { default?: string; orchestration: Record<string, RouteAssignment> } = {
				orchestration: {},
			};

			const refreshAvailable = (): void => {
				const catalog = getProviderCatalog();
				available.clear();
				for (const p of catalog) {
					const stored = store.getProvider(p.id);
					if (stored?.apiKey) {
						const source = stored.apiKey === "$OAUTH" ? "key" : stored.apiKey === "local" ? "local" : "key";
						const modelCount = Array.isArray(stored.models) ? stored.models.length : p.staticModels.length;
						available.set(p.id, { source, modelCount });
						continue;
					}
					if (!p.local && process.env[p.envVar]) {
						available.set(p.id, { source: "env", modelCount: p.staticModels.length });
					}
				}
				ui.setWidget("setup-status", buildStatusWidget(store, available, assignments));
			};

			refreshAvailable();

			let done = false;
			while (!done) {
				const catalog = getProviderCatalog();
				const choices: string[] = [];
				for (const p of catalog) {
					const state = available.get(p.id);
					const tag = state ? "[ok]" : "[--]";
					const modelTag = state ? ` (${state.modelCount} models)` : "";
					choices.push(`${tag} ${p.displayName}${modelTag}`);
				}
				choices.push("---");
				choices.push("Assign models to agent roles");
				choices.push("Finish and save");
				choices.push("Quit without saving");

				const action = await ui.select("Phi Code Setup - choose an action", choices);
				if (!action) {
					done = true;
					break;
				}

				if (action === "Quit without saving") {
					const confirm = await ui.confirm("Quit", "Discard all in-memory assignments? (provider keys already saved are kept)");
					if (confirm) {
						ui.setWidget("setup-status", undefined);
						ui.notify("Setup cancelled (saved provider keys are unchanged).", "warning");
						return;
					}
					continue;
				}

				if (action === "Finish and save") {
					if (!assignments.default || Object.keys(assignments.orchestration).length === 0) {
						const proceed = await ui.confirm(
							"Assignments incomplete",
							"You have not assigned all roles. Save current state anyway?",
						);
						if (!proceed) continue;
					}
					done = true;
					break;
				}

				if (action === "Assign models to agent roles") {
					const allModelIds: string[] = [];
					for (const p of catalog) {
						const stored = store.getProvider(p.id);
						if (!stored) continue;
						const models = Array.isArray(stored.models) ? stored.models : [];
						for (const m of models) {
							const id = (m as { id?: string }).id;
							if (typeof id === "string" && !allModelIds.includes(id)) allModelIds.push(id);
						}
					}
					const { defaultModel, orchestration } = await configureAssignments(ui, allModelIds);
					assignments.default = defaultModel;
					assignments.orchestration = orchestration;
					refreshAvailable();
					continue;
				}

				if (action === "---") continue;

				const providerIndex = choices.indexOf(action);
				if (providerIndex < 0 || providerIndex >= catalog.length) continue;
				const provider = catalog[providerIndex];

				let result: { providerId: string; modelCount: number } | undefined;
				try {
					if (provider.id === "alibaba-codingplan") {
						result = await configureAlibaba(ui, store);
					} else if (provider.id === "opencode-go") {
						result = await configureOpenCodeGo(ui, store);
					} else if (provider.local) {
						result = await configureLocal(ui, store, provider);
					} else {
						result = await configureGenericCloud(ui, store, provider);
					}
				} catch (err) {
					ui.notify(
						`Provider configuration failed: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}

				if (result) refreshAvailable();
			}

			// Save routing if assignments were made
			if (assignments.default) {
				try {
					const routing = buildRoutingConfig(assignments.default, assignments.orchestration);
					const routingPath = await writeRoutingConfig(routing);
					ui.notify(`Routing config written to \`${routingPath}\`.`, "info");
				} catch (err) {
					ui.notify(`Failed to write routing.json: ${err}`, "error");
				}
			}

			ui.setWidget("setup-status", undefined);
			ui.notify(
				"**Setup complete.**\n\n" +
					"Next steps:\n" +
					"  - `/keys` to list/manage saved keys\n" +
					"  - `/models refresh` to re-fetch the catalog from each provider's API\n" +
					"  - `/routing` to inspect routing\n" +
					"  - `/agents` to list sub-agents\n" +
					"  - `/skills` to list skills\n" +
					"  - Edit `~/.phi/agent/models.json` or `routing.json` directly: hot-reload kicks in",
				"info",
			);
			} catch (err) {
				ui.setWidget("setup-status", undefined);
				ui.notify(
					`Setup wizard error: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});
}
