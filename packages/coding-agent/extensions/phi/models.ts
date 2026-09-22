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
 *
 * Context windows: the footer, `/context`, `--list-models` and auto-compaction
 * all size the window from the composed model object, and a models.json entry
 * REPLACES the upstream definition of the same id (see applyModelsJson). So a
 * persisted model that upstream already publishes silently swaps its real
 * context window for an inferred guess — the "/200k" on a 1M model. Every
 * startup therefore reconciles models.json against the upstream catalog and
 * drops the entries upstream knows, which is what keeps the displayed window
 * correct for every model of every provider.
 */

import { type ApiKeyStore, type ConfigWatcher, type ExtensionAPI, getApiKeyStore, getConfigWatcher } from "phi-code";
import type { Model } from "phi-code-ai";
// Static catalog read: moved to the compat entrypoint in pi 0.84.
import { getModels } from "phi-code-ai/compat";
import { formatWindow, inferContextWindow, parseContextWindow } from "./providers/context-window.ts";
import { fetchLiveModels, peekCache, resetLiveModelsCache, toPersistedModel } from "./providers/live-models.ts";
import {
	buildOpenCodeGoAnthropicProviderConfig,
	buildOpenCodeGoProviderConfig,
	getOpenCodeGoModels,
} from "./providers/opencode-go.ts";
import {
	offlineMode,
	readOverlayCatalog,
	resolveUpstreamById,
	upstreamKnownIds,
	type UpstreamModel,
	type UpstreamOptions,
} from "./providers/upstream-catalog.ts";

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

/** Persist a provider's model catalog through the store (watcher muted: this is not a user edit). */
function writeProviderModels(
	store: ApiKeyStore,
	watcher: ConfigWatcher,
	providerId: string,
	config: { baseUrl?: string; api?: string; apiKey?: string; models: unknown[] },
): void {
	watcher.muteForWrite("models_json_changed");
	store.setKey(providerId, config.apiKey ?? "local", {
		baseUrl: config.baseUrl,
		api: config.api,
		models: config.models,
	});
}

function modelIdsOf(models: unknown[]): string[] {
	return models
		.map((entry) =>
			typeof entry === "string" ? entry : ((entry as { id?: unknown } | null)?.id as string | undefined),
		)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * Drop models.json entries whose model the runtime already composes upstream.
 * Kept entries are genuine upstream-unknown models; their windows are refreshed
 * by the live pass below. Returns the number of entries removed.
 */
function reconcileShadowedModels(
	store: ApiKeyStore,
	watcher: ConfigWatcher,
	providerId: string,
	known: ReadonlySet<string>,
): number {
	const stored = store.getProvider(providerId);
	const models = Array.isArray(stored?.models) ? stored.models : [];
	if (models.length === 0) return 0;

	const survivors = models.filter((entry) => {
		const id = typeof entry === "string" ? entry : (entry as { id?: unknown } | null)?.id;
		return typeof id !== "string" || !known.has(id);
	});
	if (survivors.length === models.length) return 0;

	writeProviderModels(store, watcher, providerId, {
		baseUrl: stored?.baseUrl,
		api: stored?.api,
		apiKey: stored?.apiKey,
		models: survivors,
	});
	return models.length - survivors.length;
}

/**
 * Replace inferred windows/max-out values with metadata another provider's
 * catalog publishes for the same model id (ids are global). Only consulted for
 * models no provider-specific catalog describes.
 */
async function applyCrossProviderMetadata<T extends { id: string; contextWindow: number; maxTokens: number }>(
	persisted: T[],
	providerId: string,
	options: UpstreamOptions,
): Promise<T[]> {
	const unknown = new Set(persisted.map((model) => model.id));
	if (unknown.size === 0) return persisted;

	const resolved: Map<string, UpstreamModel> = await resolveUpstreamById(unknown, [providerId], options);
	if (resolved.size === 0) return persisted;

	return persisted.map((model) => {
		const upstream = resolved.get(model.id);
		if (!upstream) return model;
		return {
			...model,
			contextWindow: upstream.contextWindow ?? model.contextWindow,
			maxTokens: upstream.maxTokens ?? model.maxTokens,
		};
	});
}

interface RefreshOutcome {
	provider: string;
	source: "live" | "cache" | "fallback" | "unsupported" | "skipped";
	count: number;
	error?: string;
}

interface ProviderSyncResult {
	outcome: RefreshOutcome;
	/** models.json entries dropped because the runtime composes them upstream. */
	reconciled: number;
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
	known: ReadonlySet<string>,
	options: UpstreamOptions,
): Promise<RefreshOutcome> {
	const { models, source } = await getOpenCodeGoModels({ apiKey, forceRefresh: true });
	const previouslyPersisted = new Set(modelIdsOf(Array.isArray(stored?.models) ? stored.models : []));
	const keyForBuild = apiKey ?? stored?.apiKey ?? "local";
	const config =
		providerId === "opencode-go-anthropic"
			? buildOpenCodeGoAnthropicProviderConfig(keyForBuild, models)
			: buildOpenCodeGoProviderConfig(keyForBuild, models);

	// Persist only models the runtime does not already compose upstream; those
	// definitions (window, max-out, costs, image input) stay authoritative and
	// models.json carries just the delta.
	const delta = config.models.filter((m) => !known.has(m.id));
	const persisted = await applyCrossProviderMetadata(delta, providerId, options);

	if (persisted.length === 0) {
		if (stored && Array.isArray(stored.models) && stored.models.length > 0) {
			// Clean up previously persisted models that upstream now describes.
			writeProviderModels(store, watcher, providerId, {
				baseUrl: stored.baseUrl ?? config.baseUrl,
				api: stored.api ?? config.api,
				apiKey: stored.apiKey ?? apiKey,
				models: [],
			});
		}
		return { provider: providerId, source: source === "fallback" ? "fallback" : "skipped", count: 0 };
	}

	writeProviderModels(store, watcher, providerId, {
		baseUrl: stored?.baseUrl ?? config.baseUrl,
		api: stored?.api ?? config.api,
		apiKey: stored?.apiKey ?? apiKey,
		models: persisted,
	});

	const outcomeSource = source === "live" ? "live" : source === "cache" ? "cache" : "fallback";
	return {
		provider: providerId,
		source: outcomeSource,
		count: persisted.filter((model) => !previouslyPersisted.has(model.id)).length,
	};
}

async function refreshOne(
	store: ApiKeyStore,
	watcher: ConfigWatcher,
	providerId: string,
	resolvedApiKey: string | undefined,
	known: ReadonlySet<string>,
	options: UpstreamOptions,
): Promise<RefreshOutcome> {
	const stored = store.getProvider(providerId);
	const previouslyPersisted = new Set(modelIdsOf(Array.isArray(stored?.models) ? stored.models : []));
	// Prefer the key stored in models.json (resolved through the store: env-var
	// names and "!cmd" values yield a usable key, "local" is a sentinel, an
	// unresolved "$NAME" yields undefined), else the one resolved from
	// auth.json/env by the model registry (providers set up via /auth only).
	const storedKey = stored?.apiKey && stored.apiKey !== "local" ? store.getKey(providerId) : undefined;
	const apiKey = storedKey ?? resolvedApiKey;

	// OpenCode Go is a provider pair the generic fetchLiveModels path can't express
	// (and never handled the Anthropic side), so refresh it from the shared catalog.
	if (providerId === "opencode-go" || providerId === "opencode-go-anthropic") {
		return await refreshOpenCodeGo(store, watcher, providerId, apiKey, stored, known, options);
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

	// Persist only the delta the runtime does not compose upstream (see
	// upstreamKnownIds). Upstream definitions keep their costs/capabilities.
	const delta = result.models.map(toPersistedModel).filter((m) => !known.has(m.id));
	const persisted = await applyCrossProviderMetadata(delta, providerId, options);

	// Preserve baseUrl/api/apiKey/headers from existing config; only models change.
	const baseUrl = stored?.baseUrl ?? DEFAULT_BASE_URLS[providerId];
	if (!baseUrl) {
		return { provider: providerId, source: "skipped", count: 0, error: "unknown baseUrl" };
	}

	if (persisted.length === 0) {
		if (stored && Array.isArray(stored.models) && stored.models.length > 0) {
			// Clean up previously persisted models that upstream now describes.
			writeProviderModels(store, watcher, providerId, {
				baseUrl,
				api: stored.api,
				apiKey: stored.apiKey,
				models: [],
			});
		}
		return { provider: providerId, source: result.source, count: 0, error: result.error };
	}

	// Mute the config watcher so it does not echo this programmatic write back
	// as a models_json_changed event (which would trigger a spurious reload +
	// "Keys reloaded" notification). Mute per-write because refresh loops can
	// exceed the ignore window between providers (cf. keys.ts).
	writeProviderModels(store, watcher, providerId, {
		baseUrl,
		api: stored?.api,
		apiKey: stored?.apiKey,
		models: persisted,
	});

	return {
		provider: providerId,
		source: result.source,
		count: persisted.filter((model) => !previouslyPersisted.has(model.id)).length,
		error: result.error,
	};
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
				ctx.ui.notify("Unknown subcommand. Use: `/models [list|refresh] [provider-id]`", "warning");
			} catch (err) {
				ctx.ui.notify(`/models error: ${err instanceof Error ? err.message : String(err)}`, "error");
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

			/** Window of the persisted models.json entry, when the provider has one. */
			const readPersistedWindow = (): number | undefined => {
				const models = store.getProvider(provider)?.models as
					| Array<{ id?: string; contextWindow?: number }>
					| undefined;
				const entry = (models ?? []).find((m) => m?.id === modelId);
				return typeof entry?.contextWindow === "number" ? entry.contextWindow : undefined;
			};

			/**
			 * Window the runtime composes for this model today: the pi.dev overlay
			 * (synced from the runtime's own models-store) wins over the bundled
			 * catalog, and both outrank any models.json guess.
			 */
			const composedWindow = (): number | undefined => {
				const overlay = readOverlayCatalog(provider, store.configPath).models.find((m) => m.id === modelId);
				if (overlay?.contextWindow !== undefined) return overlay.contextWindow;
				try {
					const bundled = getModels(provider as Parameters<typeof getModels>[0]) as Array<{
						id: string;
						contextWindow?: number;
					}>;
					return bundled.find((m) => m.id === modelId)?.contextWindow;
				} catch {
					return undefined;
				}
			};

			const writeOverrides = (overrides: Record<string, unknown>): void => {
				const stored = store.getProvider(provider) ?? {};
				watcher.muteForWrite("models_json_changed");
				store.setKey(provider, stored.apiKey ?? "local", { modelOverrides: overrides });
			};

			try {
				if (arg === "") {
					const window = readOverrideWindow() ?? readPersistedWindow() ?? composedWindow();
					const source =
						readOverrideWindow() !== undefined
							? "manual override"
							: readPersistedWindow() !== undefined
								? "persisted (upstream does not describe this model; value is inferred)"
								: "upstream catalog";
					ctx.ui.notify(
						`**${modelId}** (\`${provider}\`) context window: \`${formatWindow(window ?? model.contextWindow)}\` (${source}).\n` +
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

					// Revert the active model to the composed window: the persisted delta
					// when upstream does not describe the model, else the upstream value.
					const reverted =
						readPersistedWindow() ?? composedWindow() ?? inferContextWindow(modelId, undefined, provider);
					await pi.setModel({ ...model, contextWindow: reverted });
					ctx.ui.notify(
						`Cleared context override for **${modelId}**. Reverted to \`${formatWindow(reverted)}\`.`,
						"info",
					);
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

	async function listCommand(
		target: string | undefined,
		ctx: { ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } },
	): Promise<void> {
		const providers = target ? [target] : store.listProviders();
		if (providers.length === 0) {
			ctx.ui.notify("No providers configured. Run `/setup` or `/phi-init` to add one.", "info");
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
				out += `    ${modelIdsOf(models).join(", ")}\n`;
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

	/**
	 * One provider pass: drop models.json entries the runtime already composes
	 * upstream — their windows/max-out would shadow the real definition — then
	 * refresh the remaining delta from the provider's live catalog.
	 */
	async function syncProvider(target: RefreshTarget, options: UpstreamOptions): Promise<ProviderSyncResult> {
		const known = await upstreamKnownIds(target.id, options);
		const reconciled = reconcileShadowedModels(store, watcher, target.id, known);
		if (options.offline) {
			// No network: the stored overlay still decides what upstream knows, so the
			// context windows get corrected, but the live catalogs cannot be re-fetched.
			return { outcome: { provider: target.id, source: "skipped", count: 0 }, reconciled };
		}
		const outcome = await refreshOne(store, watcher, target.id, target.resolvedApiKey, known, options).catch(
			(err) => ({
				provider: target.id,
				source: "skipped" as const,
				count: 0,
				error: err instanceof Error ? err.message : String(err),
			}),
		);
		return { outcome, reconciled };
	}

	/**
	 * Re-point the active model at the freshly composed definition so the footer,
	 * `/context` and auto-compaction use the corrected window in THIS session
	 * instead of the object captured at startup.
	 */
	async function alignActiveModelWindow(
		current: Model<any> | undefined,
		find: (provider: string, modelId: string) => Model<any> | undefined,
	): Promise<void> {
		if (!current) return;
		const refreshed = find(current.provider, current.id);
		if (!refreshed || refreshed.contextWindow === current.contextWindow) return;
		await pi.setModel(refreshed);
	}

	function upstreamOptions(): UpstreamOptions {
		return { modelsJsonPath: store.configPath, offline: offlineMode() };
	}

	// Reconcile and refresh on session_start so every new Phi Code session shows
	// the upstream context window for every model of every provider, without the
	// user typing `/models refresh`. Failures are silent — startup must never be
	// blocked by upstream API hiccups.
	pi.on("session_start", async (_event, ctx) => {
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
			let reconciled = 0;
			const options = upstreamOptions();
			for (const target of targets) {
				const { outcome, reconciled: removed } = await syncProvider(target, options);
				reconciled += removed;
				discovered += outcome.count;
			}
			if (reconciled === 0 && discovered === 0) return;

			if (reconciled > 0) {
				// models.json no longer shadows upstream, so recompose before aligning:
				// the active model must pick up the upstream window immediately.
				try {
					await ctx.modelRegistry.refresh({ allowNetwork: false });
					await alignActiveModelWindow(ctx.model, (provider, modelId) =>
						ctx.modelRegistry.find(provider, modelId),
					);
				} catch {
					// registry unavailable — next startup still composes correctly
				}
			}

			const parts: string[] = [];
			if (reconciled > 0) parts.push(`restored the upstream context window for ${reconciled} model(s)`);
			if (discovered > 0) parts.push(`discovered ${discovered} new model(s)`);
			try {
				ctx.ui.notify(`Model catalog: ${parts.join(", ")}. See /model.`, "info");
			} catch {
				// notify may fail if the TUI is mid-shutdown — ignore
			}
			pi.events.emit("models_json_changed", { source: "session-start-refresh" });
		})();
	});

	async function refreshCommand(
		target: string | undefined,
		ctx: {
			ui: {
				notify: (m: string, t?: "info" | "warning" | "error") => void;
				setStatus?: (k: string, v?: string) => void;
			};
			model?: Model<any>;
			modelRegistry: {
				getAvailable(): Array<{ provider: string }>;
				getApiKeyForProvider(provider: string): Promise<string | undefined>;
				find(provider: string, modelId: string): Model<any> | undefined;
				refresh(options?: { allowNetwork?: boolean }): Promise<unknown>;
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
		let reconciled = 0;
		const options: UpstreamOptions = { ...upstreamOptions(), force: true };
		for (const t of targets) {
			const { outcome, reconciled: removed } = await syncProvider(t, options);
			outcomes.push(outcome);
			reconciled += removed;
		}
		ctx.ui.setStatus?.("models-refresh", undefined);

		if (reconciled > 0) {
			try {
				await ctx.modelRegistry.refresh({ allowNetwork: false });
				await alignActiveModelWindow(ctx.model, (provider, modelId) =>
					ctx.modelRegistry.find(provider, modelId),
				);
			} catch {
				// registry unavailable — the next startup composes correctly
			}
		}

		let out = "**Refresh report:**\n";
		for (const o of outcomes) {
			const icon =
				o.source === "live" ? "[ok]" : o.source === "fallback" ? "[fb]" : o.source === "cache" ? "[c]" : "[--]";
			out += `  ${icon} ${displayName(o.provider)} \`${o.provider}\` — ${o.count} new model(s) (${o.source}${o.error ? `, ${o.error}` : ""})\n`;
		}
		if (reconciled > 0) {
			out += `  [ctx] dropped ${reconciled} persisted model(s) the upstream catalog describes better ` +
				"(their real context window now comes from upstream).\n";
		}
		out += `\nOnly models the bundled catalog and the pi.dev catalog do not describe are persisted to \`${store.configPath}\`;\n`;
		out += `every other model keeps its upstream context window. \`/model\` picker reflects the merged catalog.`;
		ctx.ui.notify(out, "info");
		pi.events.emit("models_json_changed", { source: "models-refresh" });
	}
}
