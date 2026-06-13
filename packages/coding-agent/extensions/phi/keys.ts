/**
 * Keys Extension - /keys command for managing API keys + file watcher hot-reload.
 *
 * Per Q5 strategy C: explicit /keys command AND file watcher on
 * ~/.phi/agent/models.json + routing.json.
 *
 * Subcommands:
 *   /keys            : list configured providers with masked keys
 *   /keys set <id> <key>  : set or update a provider key
 *   /keys remove <id>     : remove a provider key (preserves the rest of config)
 *   /keys test <id>       : ping the provider API to validate the key
 *   /keys reload          : force reload from disk (triggers store_reloaded event)
 *
 * File watcher (started at session_start) reloads automatically when the
 * user edits ~/.phi/agent/models.json or routing.json with their text editor.
 * The smart-router and orchestrator listen for these events to invalidate
 * their internal caches.
 *
 * Security (Q6): keys are stored in plain text in ~/.phi/agent/models.json
 * with chmod 0600 on Unix. The user is warned in /setup and on `set`.
 */

import { ApiKeyStore, type ExtensionAPI, getApiKeyStore, getConfigWatcher } from "phi-code";

interface ProviderPingFn {
	(key: string, timeoutMs?: number): Promise<{ ok: boolean; error?: string }>;
}

const PROVIDER_PING_REGISTRY: Record<string, ProviderPingFn> = {};

/**
 * Public helper for other extensions to register a ping function for a provider.
 * Used by alibaba.ts / opencode-go.ts to expose validation.
 */
export function registerProviderPing(providerId: string, ping: ProviderPingFn): void {
	PROVIDER_PING_REGISTRY[providerId] = ping;
}

export default function keysExtension(pi: ExtensionAPI) {
	const store = getApiKeyStore();
	const watcher = getConfigWatcher();

	pi.registerCommand("keys", {
		description: "Manage API keys (list / set / remove / test / reload)",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = tokens[0]?.toLowerCase() ?? "";

			try {
				if (sub === "" || sub === "list") {
					const providers = store.listProviders();
					if (providers.length === 0) {
						ctx.ui.notify(
							"No providers configured. Use `/keys set <provider-id> <key>` or `/setup` to add one.",
							"info",
						);
						return;
					}
					let out = `**API Keys (${providers.length} providers)**\n\n`;
					out += `Storage: \`${store.configPath}\` (chmod 0600 on Unix)\n\n`;
					for (const id of providers) {
						const cfg = store.getProvider(id);
						const masked = ApiKeyStore.maskKey(cfg?.apiKey);
						const url = cfg?.baseUrl ?? "(no baseUrl)";
						out += `  **${id}** : \`${masked}\` -> ${url}\n`;
					}
					out += `\nCommands: \`/keys set <id> <key>\`, \`/keys remove <id>\`, \`/keys test <id>\`, \`/keys reload\``;
					ctx.ui.notify(out, "info");
					return;
				}

				if (sub === "set") {
					const id = tokens[1];
					const key = tokens.slice(2).join(" ");
					if (!id || !key) {
						ctx.ui.notify("Usage: `/keys set <provider-id> <api-key>`", "warning");
						return;
					}
					// A bare `set` only updates the key; it cannot supply baseUrl/api/models.
					// For a never-configured id this would persist an unusable provider
					// (apiKey but no endpoint), so require an existing entry with a baseUrl.
					const existing = store.getProvider(id);
					if (!existing?.baseUrl) {
						ctx.ui.notify(
							`\`${id}\` is not a configured provider (no baseUrl on file). ` +
								`Run \`/setup\` to add it with an endpoint and models first; ` +
								`\`/keys set\` only updates the key of an already-configured provider.`,
							"warning",
						);
						return;
					}
					watcher.muteForWrite("models_json_changed");
					store.setKey(id, key);
					ctx.ui.notify(
						`Key set for \`${id}\` (\`${ApiKeyStore.maskKey(key)}\`). Stored in ${store.configPath}.\n` +
							`Hot-reload will propagate to providers using this key.\n` +
							`Use \`/keys test ${id}\` to validate.`,
						"info",
					);
					return;
				}

				if (sub === "remove" || sub === "rm" || sub === "delete") {
					const id = tokens[1];
					if (!id) {
						ctx.ui.notify("Usage: `/keys remove <provider-id>`", "warning");
						return;
					}
					const before = store.getKey(id);
					if (!before) {
						ctx.ui.notify(`No key configured for \`${id}\`. Nothing to remove.`, "info");
						return;
					}
					watcher.muteForWrite("models_json_changed");
					store.removeKey(id);
					ctx.ui.notify(`Key removed for \`${id}\` (provider config retained).`, "info");
					return;
				}

				if (sub === "test") {
					const id = tokens[1];
					if (!id) {
						ctx.ui.notify("Usage: `/keys test <provider-id>`", "warning");
						return;
					}
					const key = store.getKey(id);
					if (!key) {
						ctx.ui.notify(`No key configured for \`${id}\`.`, "warning");
						return;
					}
					const ping = PROVIDER_PING_REGISTRY[id];
					if (!ping) {
						ctx.ui.notify(
							`No ping handler registered for \`${id}\`. Built-in pings exist for: ${Object.keys(PROVIDER_PING_REGISTRY).join(", ") || "(none)"}.`,
							"warning",
						);
						return;
					}
					ctx.ui.notify(`Pinging \`${id}\`...`, "info");
					const result = await ping(key);
					if (result.ok) {
						ctx.ui.notify(`\`${id}\`: API key valid (200 OK).`, "info");
					} else {
						ctx.ui.notify(`\`${id}\`: ${result.error ?? "ping failed"}`, "error");
					}
					return;
				}

				if (sub === "reload") {
					store.reloadFromDisk();
					ctx.ui.notify("Reloaded keys from disk. Listeners notified.", "info");
					return;
				}

				ctx.ui.notify(
					"Unknown subcommand. Use: `/keys [list|set|remove|test|reload]`",
					"warning",
				);
			} catch (err) {
				ctx.ui.notify(`/keys error: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			store.load();
		} catch {
			// Empty/missing models.json on first run is normal
		}

		watcher.start();
		watcher.on("models_json_changed", () => {
			try {
				store.reloadFromDisk();
				ctx.ui.notify("Detected change in `models.json`. Keys reloaded.", "info");
			} catch (err) {
				ctx.ui.notify(`Failed to reload models.json: ${err}`, "warning");
			}
		});
		watcher.on("routing_json_changed", () => {
			ctx.ui.notify("Detected change in `routing.json`. Smart-router will reload on next input.", "info");
			pi.events.emit("routing_json_changed", { source: "watcher" });
		});
		watcher.on("watcher_error", (data: unknown) => {
			const d = data as { path: string; error: unknown };
			ctx.ui.notify(`Config watcher error on ${d.path}: ${d.error}`, "warning");
		});

		const providers = store.listProviders();
		if (providers.length > 0) {
			ctx.ui.notify(
				`Loaded ${providers.length} provider key(s) from \`~/.phi/agent/models.json\` (chmod 0600). ` +
					`Use \`/keys\` to list/manage. Editing this file in your editor will hot-reload.`,
				"info",
			);
		}
	});
}
