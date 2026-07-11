/**
 * Provider bootstrap — first-time, non-interactive provider configuration.
 *
 * `/keys set <id> <key>` used to refuse a provider that had no models.json
 * entry yet ("run /setup first"), which made adding a known provider (e.g. the
 * Alibaba Coding Plan) impossible outside the interactive wizard. This module
 * closes that gap: for providers phi ships a config builder for, it produces a
 * complete models.json entry (baseUrl + api + model list) from a single API
 * key, with the provider's own key-format validation applied first.
 *
 * Pure (no fs, no network) so every branch is unit-tested; keys.ts is the only
 * call site.
 */

import { ALIBABA_PROVIDERS, buildAlibabaProviderConfig, validateAlibabaApiKey } from "./alibaba.js";
import {
	buildOpenCodeGoAnthropicProviderConfig,
	buildOpenCodeGoProviderConfig,
	OPENCODE_GO_FALLBACK_MODELS,
	type OpenCodeGoModel,
	validateOpenCodeGoApiKey,
} from "./opencode-go.js";

export interface BootstrapModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: readonly ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
	compat?: Record<string, unknown>;
}

export interface BootstrapConfig {
	baseUrl: string;
	api: string;
	apiKey: string;
	models: BootstrapModel[];
}

export type BootstrapResult = { ok: true; config: BootstrapConfig; note: string } | { ok: false; error: string };

/** Provider ids `/keys set` can fully configure from just an API key. */
export const BOOTSTRAPPABLE_PROVIDERS = [
	"alibaba-codingplan",
	"alibaba-codingplan-anthropic",
	"opencode-go",
	"opencode-go-anthropic",
] as const;

export function isBootstrappableProvider(id: string): boolean {
	return (BOOTSTRAPPABLE_PROVIDERS as readonly string[]).includes(id);
}

/**
 * Build a complete first-time provider config from an API key. Validates the
 * key FORMAT (prefix/length) per provider; liveness is `/keys test`'s job.
 * The bundled model list seeds the entry — the session-start refresh and
 * `/models refresh` replace it with the live catalog afterwards.
 */
export function bootstrapProviderConfig(id: string, apiKey: string): BootstrapResult {
	const key = apiKey.trim();

	switch (id) {
		case "alibaba-codingplan":
		case "alibaba-codingplan-anthropic": {
			const invalid = validateAlibabaApiKey(key);
			if (invalid) return { ok: false, error: invalid };
			const variant = id === "alibaba-codingplan-anthropic" ? "anthropic" : "openai";
			const config: BootstrapConfig = buildAlibabaProviderConfig(variant, key);
			return {
				ok: true,
				config,
				note: `${ALIBABA_PROVIDERS[variant].displayName} — ${config.models.length} bundled model(s); a live refresh follows on next session start (or run /models refresh ${id}).`,
			};
		}
		case "opencode-go":
		case "opencode-go-anthropic": {
			const invalid = validateOpenCodeGoApiKey(key);
			if (invalid) return { ok: false, error: invalid };
			const models: OpenCodeGoModel[] = [...OPENCODE_GO_FALLBACK_MODELS];
			const config: BootstrapConfig =
				id === "opencode-go-anthropic"
					? buildOpenCodeGoAnthropicProviderConfig(key, models)
					: buildOpenCodeGoProviderConfig(key, models);
			return {
				ok: true,
				config,
				note: `OpenCode Go — ${config.models.length} bundled model(s); a live refresh follows on next session start (or run /models refresh ${id}).`,
			};
		}
		default:
			return {
				ok: false,
				error: `\`${id}\` has no bootstrap builder. Run \`/setup\` to configure it interactively, or add it to ~/.phi/agent/models.json. Bootstrappable ids: ${BOOTSTRAPPABLE_PROVIDERS.join(", ")}.`,
			};
	}
}
