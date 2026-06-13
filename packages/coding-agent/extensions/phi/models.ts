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
import {
	buildOpenCodeGoAnthropicProviderConfig,
	buildOpenCodeGoProviderConfig,
	getOpenCodeGoModels,
} from "./providers/opencode-go.js";
import { fetchLiveModels, peekCache, resetLiveModelsCache, toPersistedModel } from "./providers/live-models.js";

const PROVIDER_DISPLAY: Record<string, string> = {
	"opencode-go": "OpenCode Go",
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

function displayName(id: string): string {
	return PROVIDER_DISPLAY[id] ?? id;
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

	if (config.models.length === 0) {
		return { provider: providerId, source: source === "fallback" ? "fallback" : "skipped", count: 0 };
	}

	watcher.muteForWrite("models_json_changed");
	store.setKey(providerId, stored?.apiKey ?? apiKey ?? "local", {
		baseUrl: stored?.baseUrl ?? config.baseUrl,
		api: stored?.api ?? config.api,
		models: config.models,
	});

	const outcomeSource = source === "live" ? "live" : source === "cache" ? "cache" : "fallback";
	return { provider: providerId, source: outcomeSource, count: config.models.length };
}

async function refreshOne(
	store: ApiKeyStore,
	watcher: ConfigWatcher,
	providerId: string,
): Promise<RefreshOutcome> {
	const stored = store.getProvider(providerId);
	const apiKey = stored?.apiKey && !stored.apiKey.startsWith("$") && stored.apiKey !== "local"
		? stored.apiKey
		: undefined;

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

	const persisted = result.models.map(toPersistedModel);
	if (persisted.length === 0) {
		return { provider: providerId, source: result.source, count: 0, error: result.error };
	}

	// Preserve baseUrl/api/apiKey/headers from existing config; only models change.
	const baseUrl =
		stored?.baseUrl ??
		(providerId === "opencode-go"
			? "https://opencode.ai/zen/go/v1"
			: providerId === "alibaba-codingplan"
				? "https://coding-intl.dashscope.aliyuncs.com/v1"
				: providerId === "alibaba-codingplan-anthropic"
					? "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic"
					: providerId === "openai"
						? "https://api.openai.com/v1"
						: providerId === "anthropic"
							? "https://api.anthropic.com/v1"
							: providerId === "google"
								? "https://generativelanguage.googleapis.com/v1beta"
								: providerId === "openrouter"
									? "https://openrouter.ai/api/v1"
									: providerId === "groq"
										? "https://api.groq.com/openai/v1"
										: providerId === "ollama"
											? "http://localhost:11434/v1"
											: providerId === "lm-studio"
												? "http://localhost:1234/v1"
												: undefined);

	if (!baseUrl) {
		return { provider: providerId, source: "skipped", count: 0, error: "unknown baseUrl" };
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

	// Background refresh on session_start so every new Phi Code session reflects
	// the latest provider catalogs without the user typing `/models refresh`.
	// Failures are silent — startup must never be blocked by upstream API hiccups.
	pi.on("session_start", async (_event, ctx) => {
		try {
			store.load();
		} catch {
			// no models.json yet
		}
		const providers = store.listProviders();
		if (providers.length === 0) return;

		// Fire-and-forget. Hot-reload via models_json_changed event surfaces results.
		void (async () => {
			let changed = 0;
			for (const id of providers) {
				const outcome = await refreshOne(store, watcher, id).catch(() => undefined);
				if (outcome && outcome.source === "live" && outcome.count > 0) changed++;
			}
			if (changed > 0) {
				try {
					ctx.ui.notify(
						`Refreshed ${changed}/${providers.length} provider catalog(s) in the background.`,
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
		ctx: { ui: { notify: (m: string, t?: "info" | "warning" | "error") => void; setStatus?: (k: string, v?: string) => void } },
	): Promise<void> {
		const providers = target ? [target] : store.listProviders();
		if (providers.length === 0) {
			ctx.ui.notify("No providers configured.", "warning");
			return;
		}
		ctx.ui.notify(`Refreshing ${providers.length} provider(s)...`, "info");
		ctx.ui.setStatus?.("models-refresh", "Fetching live model catalogs...");

		const outcomes: RefreshOutcome[] = [];
		for (const id of providers) {
			const outcome = await refreshOne(store, watcher, id).catch((err) => ({
				provider: id,
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
			out += `  ${icon} ${displayName(o.provider)} \`${o.provider}\` — ${o.count} model(s) (${o.source}${o.error ? `, ${o.error}` : ""})\n`;
		}
		out += `\nModels persisted to \`${store.configPath}\`. \`/model\` picker now reflects this catalog.`;
		ctx.ui.notify(out, "info");
		pi.events.emit("models_json_changed", { source: "models-refresh" });
	}
}
