/**
 * OpenCode Go (zen) Provider - Runtime auto-fetch of available models.
 *
 * Per Q4 strategy A:
 *  - Fetch live list from https://opencode.ai/zen/go/v1/models at runtime
 *  - Cache TTL 1 hour in memory + refresh background
 *  - Fallback to bundled static list versioned (last sync date) on network failure
 *
 * Authentication is API-key only (no OAuth device code per opencode.ai docs).
 * Users get key from https://opencode.ai/auth after subscribing to Go ($5 first month).
 *
 * Provider id: opencode-go (already a KnownProvider in phi-code-ai).
 * Endpoints:
 *  - Models list: https://opencode.ai/zen/go/v1/models
 *  - OpenAI-compat: https://opencode.ai/zen/go/v1/chat/completions
 *  - Anthropic-compat: https://opencode.ai/zen/go/v1/messages
 *
 * Model IDs follow format: opencode-go/<model-id> (e.g., opencode-go/kimi-k2.6).
 */

import { inferContextWindow } from "./context-window.js";

export const OPENCODE_GO_ENV_VAR = "OPENCODE_GO_API_KEY";
export const OPENCODE_GO_AUTH_URL = "https://opencode.ai/auth";
export const OPENCODE_GO_MODELS_URL = "https://opencode.ai/zen/go/v1/models";
export const OPENCODE_GO_OPENAI_URL = "https://opencode.ai/zen/go/v1/chat/completions";
export const OPENCODE_GO_ANTHROPIC_URL = "https://opencode.ai/zen/go/v1/messages";
// Base URL for the Anthropic SDK (which appends "/v1/messages"). Qwen and
// MiniMax models on OpenCode Go are ONLY served via this Anthropic-compatible
// endpoint; the OpenAI shim returns 401 "not supported for format oa-compat".
export const OPENCODE_GO_ANTHROPIC_BASE_URL = "https://opencode.ai/zen/go";

export interface OpenCodeGoModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
}

interface OpenCodeGoModelsResponse {
	data?: Array<{
		id: string;
		name?: string;
		context_length?: number;
		max_tokens?: number;
		context_window?: number;
	}>;
}

/**
 * Fallback static list of OpenCode Go models.
 * Last verified: 2026-05-15 (15 models, sourced from the live /v1/models endpoint).
 * Used when network unreachable or auth fails before configuration.
 *
 * Refresh with: `curl -s https://opencode.ai/zen/go/v1/models | jq '.data[].id'`
 */
export const OPENCODE_GO_FALLBACK_MODELS: readonly OpenCodeGoModel[] = [
	{ id: "minimax-m2.7", name: "MiniMax M2.7", contextWindow: 1_000_000, maxTokens: 16_384 },
	{ id: "minimax-m2.5", name: "MiniMax M2.5", contextWindow: 1_000_000, maxTokens: 16_384 },
	{ id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 256_000, maxTokens: 16_384 },
	{ id: "kimi-k2.5", name: "Kimi K2.5", contextWindow: 256_000, maxTokens: 16_384 },
	{ id: "glm-5.1", name: "GLM 5.1", contextWindow: 200_000, maxTokens: 128_000 },
	{ id: "glm-5", name: "GLM 5", contextWindow: 200_000, maxTokens: 128_000 },
	{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 128_000, maxTokens: 8_192 },
	{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 128_000, maxTokens: 8_192 },
	{ id: "qwen3.7-plus", name: "Qwen 3.7 Plus", contextWindow: 1_000_000, maxTokens: 16_384 },
	{ id: "qwen3.6-plus", name: "Qwen 3.6 Plus", contextWindow: 1_000_000, maxTokens: 16_384 },
	{ id: "qwen3.5-plus", name: "Qwen 3.5 Plus", contextWindow: 1_000_000, maxTokens: 16_384 },
	{ id: "mimo-v2-pro", name: "MiMo V2 Pro", contextWindow: 200_000, maxTokens: 16_384 },
	{ id: "mimo-v2-omni", name: "MiMo V2 Omni", contextWindow: 200_000, maxTokens: 16_384 },
	{ id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", contextWindow: 200_000, maxTokens: 16_384 },
	{ id: "mimo-v2.5", name: "MiMo V2.5", contextWindow: 200_000, maxTokens: 16_384 },
	{ id: "hy3-preview", name: "Hy3 Preview", contextWindow: 128_000, maxTokens: 16_384 },
] as const;

interface CacheEntry {
	models: OpenCodeGoModel[];
	fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let cache: CacheEntry | null = null;
// Inflight fetches keyed by apiKey so a keyless probe never leaks its
// (possibly 401/reduced) result to a caller that passed a real key.
const inflightFetch = new Map<string, Promise<OpenCodeGoModel[]>>();

function isCacheValid(now: number): boolean {
	return cache !== null && now - cache.fetchedAt < CACHE_TTL_MS;
}

async function fetchModelsRaw(apiKey: string | undefined, timeoutMs: number): Promise<OpenCodeGoModel[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const res = await fetch(OPENCODE_GO_MODELS_URL, { signal: controller.signal, headers });
		clearTimeout(timeout);
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
		const json = (await res.json()) as OpenCodeGoModelsResponse;
		const data = json.data ?? [];
		return data.map((m) => ({
			id: m.id,
			name: m.name ?? m.id,
			contextWindow: m.context_length ?? m.context_window,
			maxTokens: m.max_tokens,
		}));
	} catch (err) {
		clearTimeout(timeout);
		throw err;
	}
}

/**
 * Get OpenCode Go models. Uses cache (TTL 1h) when fresh,
 * else fetches live with fallback to static list on failure.
 */
export async function getOpenCodeGoModels(options?: {
	apiKey?: string;
	forceRefresh?: boolean;
	timeoutMs?: number;
}): Promise<{ models: OpenCodeGoModel[]; source: "cache" | "live" | "fallback" }> {
	const now = Date.now();
	const force = options?.forceRefresh === true;
	const timeoutMs = options?.timeoutMs ?? 5_000;

	if (!force && isCacheValid(now)) {
		return { models: cache!.models, source: "cache" };
	}

	const inflightKey = options?.apiKey ?? "";

	if (!force) {
		const existing = inflightFetch.get(inflightKey);
		if (existing) {
			try {
				const models = await existing;
				return { models, source: "live" };
			} catch {
				// fall through to fresh attempt
			}
		}
	}

	const promise = fetchModelsRaw(options?.apiKey, timeoutMs);
	inflightFetch.set(inflightKey, promise);
	try {
		const models = await promise;
		cache = { models, fetchedAt: Date.now() };
		return { models, source: "live" };
	} catch {
		if (cache) {
			return { models: cache.models, source: "cache" };
		}
		return { models: [...OPENCODE_GO_FALLBACK_MODELS], source: "fallback" };
	} finally {
		// Only clear the slot we created; a concurrent fetch for the same key
		// may have replaced it (e.g. force=true overwriting a pending entry).
		if (inflightFetch.get(inflightKey) === promise) inflightFetch.delete(inflightKey);
	}
}

/**
 * Validate OpenCode Go API key by hitting /models with auth.
 * No standardized key prefix is documented, so we only check non-empty.
 */
export function validateOpenCodeGoApiKey(key: string): string | null {
	const trimmed = key.trim();
	if (trimmed.length === 0) return "API key is empty";
	if (trimmed.length < 10) return "API key too short";
	return null;
}

/**
 * Ping the OpenCode Go API with a given key.
 */
export async function pingOpenCodeGo(apiKey: string, timeoutMs = 5_000): Promise<{ ok: boolean; error?: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(OPENCODE_GO_MODELS_URL, {
			signal: controller.signal,
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		});
		clearTimeout(timeout);
		if (res.ok) return { ok: true };
		if (res.status === 401) return { ok: false, error: "Invalid API key (401)" };
		return { ok: false, error: `HTTP ${res.status}` };
	} catch (err) {
		clearTimeout(timeout);
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: msg };
	}
}

/**
 * Build a models.json provider entry from a fetched/fallback model list.
 * OpenCode Go is a KnownProvider in phi-code-ai, so this is only used
 * when the user wants to override defaults (e.g., add a new model
 * not yet in models.generated.ts).
 */
/**
 * On OpenCode Go, Qwen and MiniMax models are only served via the Anthropic-
 * compatible Messages endpoint (/v1/messages); GLM, Kimi, DeepSeek, Mimo and Hy3
 * use the OpenAI-compatible shim (/v1/chat/completions). Calling a Qwen/MiniMax
 * model through the OpenAI format yields a 401 "not supported for format oa-compat".
 */
export function isOpenCodeGoAnthropicModel(id: string): boolean {
	return /^(qwen|minimax)/i.test(id);
}

/**
 * Infer a model's context window by family when the OpenCode Go API does not
 * report one (it omits it for some newer models, e.g. qwen3.7-plus). Delegates
 * to the shared resolver so every provider applies the same family heuristics.
 */
export function inferOpenCodeGoContextWindow(id: string, provided?: number): number {
	return inferContextWindow(id, provided, "opencode-go");
}

function toPersistedOpenCodeGoModel(m: OpenCodeGoModel) {
	return {
		id: m.id,
		name: m.name ?? m.id,
		reasoning: true,
		input: ["text"] as const,
		contextWindow: inferOpenCodeGoContextWindow(m.id, m.contextWindow),
		maxTokens: m.maxTokens ?? 16_384,
	};
}

/**
 * OpenAI-compatible provider entry (GLM / Kimi / DeepSeek / Mimo / Hy3).
 * Qwen/MiniMax are intentionally excluded — see buildOpenCodeGoAnthropicProviderConfig.
 */
export function buildOpenCodeGoProviderConfig(apiKey: string, models: OpenCodeGoModel[]) {
	return {
		baseUrl: "https://opencode.ai/zen/go/v1",
		api: "openai-completions" as const,
		apiKey,
		models: models.filter((m) => !isOpenCodeGoAnthropicModel(m.id)).map(toPersistedOpenCodeGoModel),
	};
}

/**
 * Anthropic-compatible provider entry for OpenCode Go's Qwen / MiniMax models.
 * `models` is empty when the list contains none.
 */
export function buildOpenCodeGoAnthropicProviderConfig(apiKey: string, models: OpenCodeGoModel[]) {
	return {
		baseUrl: OPENCODE_GO_ANTHROPIC_BASE_URL,
		api: "anthropic-messages" as const,
		apiKey,
		models: models.filter((m) => isOpenCodeGoAnthropicModel(m.id)).map(toPersistedOpenCodeGoModel),
	};
}

/**
 * Reset the in-memory cache. Useful for tests.
 */
export function _resetOpenCodeGoCache(): void {
	cache = null;
	inflightFetch.clear();
}
