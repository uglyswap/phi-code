/**
 * Models Extension - `/models` command for live model catalog management.
 *
 * Subcommands:
 *   /models             : list models grouped by provider (uses cached/live data)
 *   /models list <id>   : list models for a specific provider
 *   /models refresh     : re-fetch the model catalog for every configured provider
 *                         (writes the result into ~/.phi/agent/models.json,
 *                         triggering ApiKeyStore hot-reload + ModelRegistry refresh).
 *   /models refresh <id>: refresh a single provider
 *
 * This is what keeps the model picker (/model) and the wizards (/setup,
 * /phi-init) in sync with each provider's upstream catalog — for instance
 * when OpenCode Go publishes a new model, a single `/models refresh` makes
 * it appear everywhere without restarting Phi Code.
 */

import { ApiKeyStore, type ConfigWatcher, type ExtensionAPI, getApiKeyStore, getConfigWatcher } from "phi-code";
import { getModels } from "phi-code-ai";
import {
	buildOpenCodeGoAnthropicProviderConfig,
	buildOpenCodeGoProviderConfig,
	getOpenCodeGoModels,
} from "./providers/opencode-go.js";
import { formatWindow, inferContextWindow, parseContextWindow } from "./providers/context-window.js";
import { fetchLiveModels, peekCache, resetLiveModelsCache, toPersistedModel } from "./providers/live-models.js";

const PROVIDER_DISPLAY: Record<string, string> = {
	opencode: "OpenCode Zen",
	"opencode-go": "OpenCode Go",
	"opencode-go-anthropic": "OpenCode Go (Anthropic-compat)",
	"alibaba-codingplan": "Alibaba Coding Plan (OpenAI-compat)",
	"alibaba-codingplan-anthropic": "Alibaba Coding Plan (Anthropic-compat)",
	openai: "OpenAI",
	anthropic: "Anthropic",
	google: "Google Gemini",
	openrouter: "OpenRouter",
	groq: "Groq",
	ollama: "Ollama (local)",
	"lm-studio": "LM Studio (local)",
};

/**
 * Providers the live-models dispatcher can actually re-fetch (see
 * live-models.ts dispatchFetch + refreshOpenCodeGo). Used to extend the
 * startup/manual refresh to providers that are authenticated via auth.json or
 * env vars but have no models.json entry yet — without it, a user who set a
 * key with /auth (and never ran /setup) would never see new upstream models.
 */
const REFRESHABLE_PROVIDERS: ReadonlySet<string> = new Set([
	"opencode",
	"opencode-go",
	"opencode-go-anthropic",
	"alibaba-codingplan",
	"alibaba-codingplan-anthropic",
	"openai",
	"anthropic",
	"google",
	"openrouter",
	"groq",
	"ollama",
	"lm-studio",
]);

function displayName(id: string): string {
	return PROVIDER_DISPLAY[id] ?? id;
}

/** Default discovery base URLs for providers whose models.json entry is created by a refresh. */
const DEFAULT_BASE_URLS: Record<string, string> = {
	opencode: "https://opencode.ai/zen/v1",
	"opencode-go": "https://opencode.ai/zen/go/v1",
	"alibaba-codingplan": "https://coding-intl.dashscope.aliyuncs.com/v1",
	"alibaba-codingplan-anthropic": "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic",
	openai: "https://api.openai.com/v1",
	anthropic: "https://api.anthropic.com/v1",
	google: "https://generativelanguage.googleapis.com/v1beta",
	openrouter: "https://openrouter.ai/api/v1",
	groq: "https://api.groq.com/openai/v1",
	ollama: "http://localhost:11434/v1",
	"lm-studio": "http://localhost:1234/v1",
};

/**
 * Built-in (models.generated.ts) model ids for a provider. Persisting only the
 * models NOT in this set keeps the rich built-in definitions (costs, image
 * input, thinking-level maps) authoritative — models.json carries just the
 * delta the static catalog does not know about yet.
 */
function builtinModelIds(providerId: string): Set<string> {
	try {
		const models = getModels(providerId as Parameters<typeof getModels>[0]) as Array<{ id: string }>;
		return new Set(models.map((m) => m.id));
	} catch {
		return new Set();
	}
}

interface RefreshOutcome {
	provider: string;
	source: "live" | "cache" | "fallback" | "unsupported" | "skipped";
	count: number;
	error?: string;
}

/**
 * Refresh the OpenCode Go provider pair from the shared catalog.
 * "opencode-go" persists the OpenAI-compat models; "opencode-go-anthropic"
 * persists the Qwen/MiniMax models served over the Anthropic endpoint. Both
 * sides get family-inferred context windows via the config builders.
 */
async function refreshOpenCodeGo(
	store: ApiKeyStore,
	watcher: ConfigWatcher,
	providerId: string,
	apiKey: string | undefined,
	stored: ReturnType<ApiKeyStore["getProvider"]>,
): Promise<RefreshOutcome> {
	const { models, source } = await getOpenCodeGoModels({ apiKey, forceRefresh: true });
	const keyForBuild = apiKey ?? stored?.apiKey ?? "local";
	const config =
		providerId === "opencode-go-anthropic"
			? buildOpenCodeGoAnthropicProviderConfig(keyForBuild, models)
			: buildOpenCodeGoProviderConfig(keyForBuild, models);

	// Persist only models the built-in catalog does not know yet; built-ins stay
	// authoritative (costs, image input) and models.json carries the delta.
	const builtin = builtinModelIds(providerId);
	const newModels = config.models.filter((m) => !builtin.has(m.id));

	if (newModels.length === 0) {
		if (stored && Array.isArray(stored.models) && stored.models.length > 0) {
			// Clean up previously persisted models that have since become built-in.
			watcher.muteForWrite("models_json_changed");
			store.setKey(providerId, stored.apiKey ?? apiKey ?? "local", {
				baseUrl: stored.baseUrl ?? config.baseUrl,
				api: stored.api ?? config.api,
				models: [],
			});
		}
		return { provider: providerId, source: source === "fallback" ? "fallback" : "skipped", count: 0 };
	}

	watcher.muteForWrite("models_json_changed");
	store.setKey(providerId, stored?.apiKey ?? apiKey ?? "local", {
		baseUrl: stored?.baseUrl ?? config.baseUrl,
		api: stored?.api ?? config.api,
		models: newModels,
	});

	const outcomeSource = source === "live" ? "live" : source === "cache" ? "cache" : "fallback";
	return { provider: providerId, source: outcomeSource, count: newModels.length };
}

async function refreshOne(
	store: ApiKeyStore,
	watcher: ConfigWatcher,
	providerId: string,
	resolvedApiKey?: string,
): Promise<RefreshOutcome> {
	const stored = store.getProvider(providerId);
	const storedKey = stored?.apiKey && !stored.apiKey.startsWith("$") && stored.apiKey !== "local"
		? stored.apiKey
		: undefined;
	// Prefer the key stored in models.json, else the one resolved from
	// auth.json/env by the model registry (providers set up via /auth only).
	const apiKey = storedKey ?? resolvedApiKey;

	// OpenCode Go is a provider pair the generic fetchLiveModels path can't express
	// (and never handled the Anthropic side), so refresh it from the shared catalog.
	if (providerId === "opencode-go" || providerId === "opencode-go-anthropic") {
		return await refreshOpenCodeGo(store, watcher, providerId, apiKey, stored);
	}

	resetLiveModelsCache(providerId);
	const result = await fetchLiveModels(providerId, {
		apiKey,
		forceRefresh: true,
		timeoutMs: 8_000,
	});

	if (result.source === "unsupported") {
		return { provider: providerId, source: "skipped", count: 0, error: result.error };
	}

	// Persist only the delta the built-in catalog does not know yet (see
	// builtinModelIds). Built-in definitions keep their costs/capabilities.
	const builtin = builtinModelIds(providerId);
	const persisted = result.models.map(toPersistedModel).filter((m) => !builtin.has(m.id));

	// Preserve baseUrl/api/apiKey/headers from existing config; only models change.
	const baseUrl = stored?.baseUrl ?? DEFAULT_BASE_URLS[providerId];
	if (!baseUrl) {
		return { provider: providerId, source: "skipped", count: 0, error: "unknown baseUrl" };
	}

	if (persisted.length === 0) {
		if (stored && Array.isArray(stored.models) && stored.models.length > 0) {
			// Clean up previously persisted models that have since become built-in.
			watcher.muteForWrite("models_json_changed");
			store.setKey(providerId, stored.apiKey ?? "local", {
				baseUrl,
				api: stored.api,
				models: [],
			});
		}
		return { provider: providerId, source: result.source, count: 0, error: result.error };
	}

	// Mute the config watcher so it does not echo this programmatic write back
	// as a models_json_changed event (which would trigger a spurious reload +
	// "Keys reloaded" notification). Mute per-write because refresh loops can
	// exceed the ignore window between providers (cf. keys.ts).
	watcher.muteForWrite("models_json_changed");
	store.setKey(providerId, stored?.apiKey ?? "local", {
		baseUrl,
		api: stored?.api,
		models: persisted,
	});

	return { provider: providerId, source: result.source, count: persisted.length, error: result.error };
}

export default function modelsExtension(pi: ExtensionAPI) {
	const store = getApiKeyStore();
	const watcher = getConfigWatcher();

	pi.registerCommand("models", {
		description: "List or refresh the live model catalog (use `/models refresh` after a provider adds a new model)",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = tokens[0]?.toLowerCase() ?? "";
			const target = tokens[1];

			try {
				if (sub === "" || sub === "list") {
					await listCommand(target, ctx);
					return;
				}
				if (sub === "refresh") {
					await refreshCommand(target, ctx);
					return;
				}
				ctx.ui.notify(
					"Unknown subcommand. Use: `/models [list|refresh] [provider-id]`",
					"warning",
				);
			} catch (err) {
				ctx.ui.notify(
					`/models error: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("context", {
		description:
			"Show or set the active model's context window (e.g. `/context 256k`, `/context 1M`, `/context auto`). Drives when the conversation auto-compacts.",
		handler: async (args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No active model. Select one with `/model` first.", "warning");
				return;
			}
			const provider = model.provider;
			const modelId = model.id;
			const arg = args.trim();

			const readOverrideWindow = (): number | undefined => {
				const overrides = store.getProvider(provider)?.modelOverrides as
					| Record<string, { contextWindow?: number }>
					| undefined;
				return overrides?.[modelId]?.contextWindow;
			};

			const writeOverrides = (overrides: Record<string, unknown>): void => {
				const stored = store.getProvider(provider) ?? {};
				watcher.muteForWrite("models_json_changed");
				store.setKey(provider, stored.apiKey ?? "local", { modelOverrides: overrides });
			};

			try {
				if (arg === "") {
					const source = readOverrideWindow() !== undefined ? "manual override" : "provider / inferred";
					ctx.ui.notify(
						`**${modelId}** (\`${provider}\`) context window: \`${formatWindow(model.contextWindow)}\` (${source}).\n` +
							"Set the real value with `/context 256k`, `/context 1M`, or `/context 200000`. " +
							"Reset to the detected value with `/context auto`.\n" +
							"This is what determines when the conversation auto-compacts.",
						"info",
					);
					return;
				}

				if (arg.toLowerCase() === "auto" || arg.toLowerCase() === "reset") {
					const stored = store.getProvider(provider) ?? {};
					const overrides = { ...((stored.modelOverrides as Record<string, unknown>) ?? {}) };
					const entry = overrides[modelId];
					if (entry && typeof entry === "object") {
						const next = { ...(entry as Record<string, unknown>) };
						delete next.contextWindow;
						if (Object.keys(next).length === 0) delete overrides[modelId];
						else overrides[modelId] = next;
					}
					writeOverrides(overrides);

					// Revert the active model to the persisted/inferred window.
					const persistedModels = (store.getProvider(provider)?.models as
						| Array<{ id?: string; contextWindow?: number }>
						| undefined) ?? [];
					const persisted = persistedModels.find((m) => m?.id === modelId)?.contextWindow;
					const reverted = persisted && persisted > 0 ? persisted : inferContextWindow(modelId, undefined, provider);
					await pi.setModel({ ...model, contextWindow: reverted });
					ctx.ui.notify(`Cleared context override for **${modelId}**. Reverted to \`${formatWindow(reverted)}\`.`, "info");
					return;
				}

				const value = parseContextWindow(arg);
				if (!value) {
					ctx.ui.notify("Invalid value. Use e.g. `256k`, `1M`, or `200000`.", "warning");
					return;
				}

				// Immediate effect: the footer and auto-compaction use the new window right away.
				await pi.setModel({ ...model, contextWindow: value });

				// Persist as a per-model override so it survives restarts and the background
				// refresh (which rewrites `models` but leaves `modelOverrides` untouched).
				const stored = store.getProvider(provider) ?? {};
				const overrides = { ...((stored.modelOverrides as Record<string, unknown>) ?? {}) };
				const existing = (overrides[modelId] as Record<string, unknown> | undefined) ?? {};
				overrides[modelId] = { ...existing, contextWindow: value };
				writeOverrides(overrides);

				ctx.ui.notify(
					`Context window for **${modelId}** set to \`${formatWindow(value)}\` (saved). ` +
						`Auto-compaction now triggers near ${formatWindow(value)}.`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`/context error: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	async function listCommand(target: string | undefined, ctx: { ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }): Promise<void> {
		const providers = target ? [target] : store.listProviders();
		if (providers.length === 0) {
			ctx.ui.notify(
				"No providers configured. Run `/setup` or `/phi-init` to add one.",
				"info",
			);
			return;
		}

		let out = `**Model catalog (${providers.length} provider(s))**\n\n`;
		for (const id of providers) {
			const stored = store.getProvider(id);
			const cached = peekCache(id);
			const models = (Array.isArray(stored?.models) ? stored?.models : []) as Array<{ id?: string; name?: string }>;
			const ageMin = cached ? Math.round(cached.ageMs / 60_000) : undefined;

			out += `  **${displayName(id)}** \`${id}\``;
			out += ` — ${models.length} model(s) persisted`;
			if (ageMin !== undefined) out += ` (cache age: ${ageMin}m)`;
			out += "\n";
			if (models.length > 0) {
				const ids = models.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
				out += `    ${ids.join(", ")}\n`;
			}
		}
		out += `\nUse \`/models refresh\` to re-fetch from each provider's API.`;
		ctx.ui.notify(out, "info");
	}

	interface RefreshTarget {
		id: string;
		resolvedApiKey?: string;
	}

	/**
	 * Providers to refresh: every provider persisted in models.json, plus every
	 * refreshable provider that is authenticated (auth.json / env vars) but has
	 * no models.json entry yet. API keys are resolved through the registry so
	 * providers configured via /auth alone still get authenticated listings.
	 */
	async function resolveRefreshTargets(registry: {
		getAvailable(): Array<{ provider: string }>;
		getApiKeyForProvider(provider: string): Promise<string | undefined>;
	}): Promise<RefreshTarget[]> {
		const targets = new Map<string, RefreshTarget>();
		for (const id of store.listProviders()) {
			targets.set(id, { id });
		}
		try {
			for (const model of registry.getAvailable()) {
				const id = model.provider;
				if (!targets.has(id) && REFRESHABLE_PROVIDERS.has(id)) {
					targets.set(id, { id });
				}
			}
		} catch {
			// registry unavailable — fall back to models.json providers only
		}
		for (const target of targets.values()) {
			try {
				target.resolvedApiKey = await registry.getApiKeyForProvider(target.id);
			} catch {
				// no resolvable key — refreshOne will try the stored/keyless path
			}
		}
		return [...targets.values()];
	}

	// Background refresh on session_start so every new Phi Code session reflects
	// the latest provider catalogs without the user typing `/models refresh`.
	// Failures are silent — startup must never be blocked by upstream API hiccups.
	pi.on("session_start", async (_event, ctx) => {
		if (process.env.PI_OFFLINE) return;
		try {
			store.load();
		} catch {
			// no models.json yet
		}
		const targets = await resolveRefreshTargets(ctx.modelRegistry);
		if (targets.length === 0) return;

		// Fire-and-forget. Hot-reload via models_json_changed event surfaces results.
		void (async () => {
			let discovered = 0;
			let changedProviders = 0;
			for (const target of targets) {
				const outcome = await refreshOne(store, watcher, target.id, target.resolvedApiKey).catch(() => undefined);
				if (outcome && outcome.source === "live" && outcome.count > 0) {
					changedProviders++;
					discovered += outcome.count;
				}
			}
			if (changedProviders > 0) {
				try {
					ctx.ui.notify(
						`Discovered ${discovered} new model(s) across ${changedProviders} provider(s). See /model.`,
						"info",
					);
				} catch {
					// notify may fail if the TUI is mid-shutdown — ignore
				}
				pi.events.emit("models_json_changed", { source: "session-start-refresh" });
			}
		})();
	});

	async function refreshCommand(
		target: string | undefined,
		ctx: {
			ui: { notify: (m: string, t?: "info" | "warning" | "error") => void; setStatus?: (k: string, v?: string) => void };
			modelRegistry: {
				getAvailable(): Array<{ provider: string }>;
				getApiKeyForProvider(provider: string): Promise<string | undefined>;
			};
		},
	): Promise<void> {
		const targets = target ? [{ id: target } as RefreshTarget] : await resolveRefreshTargets(ctx.modelRegistry);
		if (target) {
			try {
				targets[0].resolvedApiKey = await ctx.modelRegistry.getApiKeyForProvider(target);
			} catch {
				// keep undefined
			}
		}
		if (targets.length === 0) {
			ctx.ui.notify("No providers configured.", "warning");
			return;
		}
		ctx.ui.notify(`Refreshing ${targets.length} provider(s)...`, "info");
		ctx.ui.setStatus?.("models-refresh", "Fetching live model catalogs...");

		const outcomes: RefreshOutcome[] = [];
		for (const t of targets) {
			const outcome = await refreshOne(store, watcher, t.id, t.resolvedApiKey).catch((err) => ({
				provider: t.id,
				source: "skipped" as const,
				count: 0,
				error: err instanceof Error ? err.message : String(err),
			}));
			outcomes.push(outcome);
		}
		ctx.ui.setStatus?.("models-refresh", undefined);

		let out = "**Refresh report:**\n";
		for (const o of outcomes) {
			const icon = o.source === "live" ? "[ok]" : o.source === "fallback" ? "[fb]" : o.source === "cache" ? "[c]" : "[--]";
			out += `  ${icon} ${displayName(o.provider)} \`${o.provider}\` — ${o.count} new model(s) (${o.source}${o.error ? `, ${o.error}` : ""})\n`;
		}
		out += `\nOnly models missing from the built-in catalog are persisted to \`${store.configPath}\`;\n`;
		out += `built-in models stay available either way. \`/model\` picker reflects the merged catalog.`;
		ctx.ui.notify(out, "info");
		pi.events.emit("models_json_changed", { source: "models-refresh" });
	}
}
