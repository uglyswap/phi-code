/**
 * Live Models Registry - Unified runtime model fetch for every supported provider.
 *
 * Goals:
 *  - Always show the most up-to-date model list (live API call when reachable).
 *  - Survive offline / 401 / unknown errors via a versioned static fallback.
 *  - Share a single in-memory cache (TTL 1h) across phi-init, /setup, and /model.
 *  - Never throw — every public function returns a result object {models, source}.
 *
 * Each provider exposes a discovery endpoint (most are OpenAI-compatible
 * `GET /v1/models`). For exceptions:
 *  - Anthropic uses `GET /v1/models` with `x-api-key` + `anthropic-version`.
 *  - Google uses `GET /v1beta/models?key=<key>`.
 *  - OpenRouter is reachable without a key.
 *  - Ollama / LM Studio expose `GET /v1/models` locally.
 *
 * Static fallbacks below are version-pinned to the date in `LAST_VERIFIED` and
 * intentionally conservative (only models known to exist at that date). They
 * are exposed so the wizard can show *something* before the first live fetch.
 */

import {
	OPENCODE_GO_FALLBACK_MODELS,
	getOpenCodeGoModels,
	pingOpenCodeGo,
} from "./opencode-go.js";
import { ALIBABA_MODELS, ALIBABA_PROVIDERS, pingAlibaba } from "./alibaba.js";

export const LAST_VERIFIED = "2026-05-15";

export interface LiveModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

export type LiveModelSource = "live" | "cache" | "fallback" | "unsupported";

export interface LiveModelsResult {
	models: LiveModel[];
	source: LiveModelSource;
	error?: string;
}

export interface FetchOptions {
	apiKey?: string;
	forceRefresh?: boolean;
	timeoutMs?: number;
}

interface CacheEntry {
	models: LiveModel[];
	fetchedAt: number;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5_000;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<LiveModel[]>>();

function isCacheValid(entry: CacheEntry | undefined, now: number): boolean {
	return entry !== undefined && now - entry.fetchedAt < CACHE_TTL_MS;
}

async function fetchJson(
	url: string,
	headers: Record<string, string>,
	timeoutMs: number,
): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, { signal: controller.signal, headers });
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

// ─── OpenAI-style fetch (used by openai/openrouter/groq/local) ───────────────

interface OpenAIModelsResponse {
	data?: Array<{
		id?: string;
		name?: string;
		context_length?: number;
		context_window?: number;
		max_tokens?: number;
		top_provider?: { context_length?: number; max_completion_tokens?: number };
		supported_parameters?: string[];
	}>;
}

function mapOpenAIModels(data: OpenAIModelsResponse): LiveModel[] {
	const items = data.data ?? [];
	return items
		.filter((m): m is { id: string } & typeof m => typeof m?.id === "string" && m.id.length > 0)
		.map((m) => {
			const ctx = m.context_length ?? m.context_window ?? m.top_provider?.context_length;
			const maxOut = m.max_tokens ?? m.top_provider?.max_completion_tokens;
			const reasoning = (m.supported_parameters ?? []).includes("reasoning");
			return {
				id: m.id,
				name: m.name ?? m.id,
				contextWindow: typeof ctx === "number" && ctx > 0 ? ctx : undefined,
				maxTokens: typeof maxOut === "number" && maxOut > 0 ? maxOut : undefined,
				reasoning,
			};
		});
}

// ─── Anthropic fetch ─────────────────────────────────────────────────────────

interface AnthropicModelsResponse {
	data?: Array<{ id?: string; display_name?: string; type?: string }>;
}

function mapAnthropicModels(data: AnthropicModelsResponse): LiveModel[] {
	const items = data.data ?? [];
	return items
		.filter((m): m is { id: string } & typeof m => typeof m?.id === "string" && m.id.length > 0)
		.map((m) => ({
			id: m.id,
			name: m.display_name ?? m.id,
			reasoning: true,
		}));
}

// ─── Google fetch ────────────────────────────────────────────────────────────

interface GoogleModelsResponse {
	models?: Array<{
		name?: string;
		displayName?: string;
		inputTokenLimit?: number;
		outputTokenLimit?: number;
		supportedGenerationMethods?: string[];
	}>;
}

function mapGoogleModels(data: GoogleModelsResponse): LiveModel[] {
	const items = data.models ?? [];
	return items
		.filter((m): m is { name: string } & typeof m => typeof m?.name === "string")
		.filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
		.map((m) => ({
			id: m.name.replace(/^models\//, ""),
			name: m.displayName ?? m.name,
			contextWindow: m.inputTokenLimit,
			maxTokens: m.outputTokenLimit,
			reasoning: true,
		}));
}

// ─── Static fallbacks ────────────────────────────────────────────────────────

const STATIC_OPENAI: LiveModel[] = [
	{ id: "gpt-5.4", name: "GPT-5.4", contextWindow: 400_000, maxTokens: 128_000, reasoning: true },
	{ id: "gpt-5", name: "GPT-5", contextWindow: 400_000, maxTokens: 128_000, reasoning: true },
	{ id: "gpt-5-mini", name: "GPT-5 Mini", contextWindow: 400_000, maxTokens: 64_000, reasoning: true },
	{ id: "gpt-4o", name: "GPT-4o", contextWindow: 128_000, maxTokens: 16_384 },
	{ id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128_000, maxTokens: 16_384 },
	{ id: "o3", name: "o3", contextWindow: 200_000, maxTokens: 100_000, reasoning: true },
	{ id: "o3-mini", name: "o3 Mini", contextWindow: 200_000, maxTokens: 100_000, reasoning: true },
	{ id: "o1", name: "o1", contextWindow: 200_000, maxTokens: 100_000, reasoning: true },
];

const STATIC_ANTHROPIC: LiveModel[] = [
	{ id: "claude-opus-4-7", name: "Claude Opus 4.7", reasoning: true },
	{ id: "claude-opus-4-6", name: "Claude Opus 4.6", reasoning: true },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true },
	{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true },
	{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: true },
	{ id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", reasoning: false },
];

const STATIC_GOOGLE: LiveModel[] = [
	{ id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", contextWindow: 2_000_000, reasoning: true },
	{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 2_000_000, reasoning: true },
	{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1_000_000, reasoning: true },
];

const STATIC_GROQ: LiveModel[] = [
	{ id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", contextWindow: 128_000 },
	{ id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B", contextWindow: 128_000 },
	{ id: "moonshotai/kimi-k2-instruct", name: "Kimi K2 Instruct", contextWindow: 128_000 },
	{ id: "qwen/qwen3-32b", name: "Qwen 3 32B", contextWindow: 131_000 },
];

const STATIC_OPENROUTER: LiveModel[] = [
	{ id: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7", reasoning: true },
	{ id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true },
	{ id: "openai/gpt-5.4", name: "GPT-5.4", reasoning: true },
	{ id: "moonshotai/kimi-k2.6", name: "Kimi K2.6", reasoning: true },
	{ id: "z-ai/glm-5", name: "GLM 5", reasoning: true },
	{ id: "minimax/MiniMax-M2.7", name: "MiniMax M2.7", reasoning: true },
];

function staticFallbackFor(providerId: string): LiveModel[] {
	switch (providerId) {
		case "opencode-go":
			return OPENCODE_GO_FALLBACK_MODELS.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				reasoning: true,
			}));
		case "alibaba-codingplan":
		case "alibaba-codingplan-anthropic":
			return ALIBABA_MODELS.map((m) => ({
				id: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				reasoning: m.reasoning,
			}));
		case "openai":
			return STATIC_OPENAI;
		case "anthropic":
			return STATIC_ANTHROPIC;
		case "google":
			return STATIC_GOOGLE;
		case "groq":
			return STATIC_GROQ;
		case "openrouter":
			return STATIC_OPENROUTER;
		default:
			return [];
	}
}

// ─── Per-provider fetchers ───────────────────────────────────────────────────

async function fetchOpenAI(apiKey: string, timeoutMs: number): Promise<LiveModel[]> {
	const raw = (await fetchJson(
		"https://api.openai.com/v1/models",
		{ Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		timeoutMs,
	)) as OpenAIModelsResponse;
	return mapOpenAIModels(raw);
}

async function fetchAnthropic(apiKey: string, timeoutMs: number): Promise<LiveModel[]> {
	const raw = (await fetchJson(
		"https://api.anthropic.com/v1/models?limit=100",
		{
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			Accept: "application/json",
		},
		timeoutMs,
	)) as AnthropicModelsResponse;
	return mapAnthropicModels(raw);
}

async function fetchGoogle(apiKey: string, timeoutMs: number): Promise<LiveModel[]> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`;
	const raw = (await fetchJson(url, { Accept: "application/json" }, timeoutMs)) as GoogleModelsResponse;
	return mapGoogleModels(raw);
}

async function fetchOpenRouter(apiKey: string | undefined, timeoutMs: number): Promise<LiveModel[]> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const raw = (await fetchJson("https://openrouter.ai/api/v1/models", headers, timeoutMs)) as OpenAIModelsResponse;
	return mapOpenAIModels(raw);
}

async function fetchGroq(apiKey: string, timeoutMs: number): Promise<LiveModel[]> {
	const raw = (await fetchJson(
		"https://api.groq.com/openai/v1/models",
		{ Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		timeoutMs,
	)) as OpenAIModelsResponse;
	return mapOpenAIModels(raw);
}

async function fetchAlibaba(apiKey: string, timeoutMs: number): Promise<LiveModel[]> {
	const raw = (await fetchJson(
		`${ALIBABA_PROVIDERS.openai.baseUrl}/models`,
		{ Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		timeoutMs,
	)) as OpenAIModelsResponse;
	const live = mapOpenAIModels(raw);
	// Alibaba does not return contextWindow/maxTokens; enrich from the static spec when possible.
	const specById = new Map(ALIBABA_MODELS.map((m) => [m.id, m] as const));
	return live.map((m) => {
		const spec = specById.get(m.id);
		return spec
			? {
					...m,
					name: m.name ?? spec.name,
					contextWindow: m.contextWindow ?? spec.contextWindow,
					maxTokens: m.maxTokens ?? spec.maxTokens,
					reasoning: m.reasoning ?? spec.reasoning,
				}
			: m;
	});
}

async function fetchLocal(baseUrl: string, timeoutMs: number, label: string): Promise<LiveModel[]> {
	const raw = (await fetchJson(
		`${baseUrl}/models`,
		{ Authorization: `Bearer ${label}`, Accept: "application/json" },
		timeoutMs,
	)) as OpenAIModelsResponse;
	return mapOpenAIModels(raw).map((m) => ({ ...m, reasoning: m.reasoning ?? false }));
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

async function dispatchFetch(providerId: string, options: FetchOptions): Promise<LiveModel[]> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const apiKey = options.apiKey;

	switch (providerId) {
		case "opencode-go": {
			const result = await getOpenCodeGoModels({
				apiKey,
				forceRefresh: options.forceRefresh,
				timeoutMs,
			});
			return result.models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				reasoning: true,
			}));
		}
		case "alibaba-codingplan":
		case "alibaba-codingplan-anthropic":
			if (!apiKey) throw new Error("Alibaba requires an API key for live listing");
			return await fetchAlibaba(apiKey, timeoutMs);
		case "openai":
			if (!apiKey) throw new Error("OpenAI requires an API key for live listing");
			return await fetchOpenAI(apiKey, timeoutMs);
		case "anthropic":
			if (!apiKey) throw new Error("Anthropic requires an API key for live listing");
			return await fetchAnthropic(apiKey, timeoutMs);
		case "google":
			if (!apiKey) throw new Error("Google requires an API key for live listing");
			return await fetchGoogle(apiKey, timeoutMs);
		case "openrouter":
			return await fetchOpenRouter(apiKey, timeoutMs);
		case "groq":
			if (!apiKey) throw new Error("Groq requires an API key for live listing");
			return await fetchGroq(apiKey, timeoutMs);
		case "ollama":
			return await fetchLocal("http://localhost:11434/v1", timeoutMs, "ollama");
		case "lm-studio":
			return await fetchLocal("http://localhost:1234/v1", timeoutMs, "lm-studio");
		default:
			return [];
	}
}

/**
 * Live-fetch the model catalog for a provider. Never throws.
 * Resolution order:
 *  1. Fresh in-process cache (TTL 1h) unless `forceRefresh` is true.
 *  2. Live API call (may need apiKey for authenticated providers).
 *  3. Previous cache entry, if any (even if stale).
 *  4. Static fallback (versioned).
 */
export async function fetchLiveModels(
	providerId: string,
	options: FetchOptions = {},
): Promise<LiveModelsResult> {
	const now = Date.now();
	const force = options.forceRefresh === true;

	const cached = cache.get(providerId);
	if (!force && isCacheValid(cached, now)) {
		return { models: cached!.models, source: "cache" };
	}

	// Coalesce concurrent fetches for the same provider.
	const inflightKey = `${providerId}:${options.apiKey ?? ""}`;
	let promise = inflight.get(inflightKey);
	if (!promise) {
		promise = dispatchFetch(providerId, options);
		inflight.set(inflightKey, promise);
	}

	try {
		const models = await promise;
		if (models.length === 0) {
			const fallback = staticFallbackFor(providerId);
			return fallback.length > 0
				? { models: fallback, source: "fallback" }
				: { models: [], source: "unsupported" };
		}
		cache.set(providerId, { models, fetchedAt: now });
		return { models, source: "live" };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (cached) {
			return { models: cached.models, source: "cache", error: message };
		}
		const fallback = staticFallbackFor(providerId);
		if (fallback.length > 0) {
			return { models: fallback, source: "fallback", error: message };
		}
		return { models: [], source: "unsupported", error: message };
	} finally {
		inflight.delete(inflightKey);
	}
}

/**
 * Ping a provider's auth endpoint to confirm the API key is valid before saving.
 * Returns `{ok: true}` on success, `{ok: false, error}` on any failure.
 *
 * Falls back to a HEAD on the models endpoint for providers without a dedicated ping.
 */
export async function pingProvider(
	providerId: string,
	apiKey: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string }> {
	switch (providerId) {
		case "opencode-go":
			return await pingOpenCodeGo(apiKey, timeoutMs);
		case "alibaba-codingplan":
		case "alibaba-codingplan-anthropic":
			return await pingAlibaba(apiKey, timeoutMs);
		default: {
			try {
				const models = await dispatchFetch(providerId, { apiKey, timeoutMs, forceRefresh: true });
				return models.length > 0
					? { ok: true }
					: { ok: false, error: "no models returned" };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		}
	}
}

/**
 * Map a LiveModel to the persisted models.json model shape (used by ApiKeyStore.setKey).
 * Reasonable defaults are applied when the upstream API omits a field.
 */
export function toPersistedModel(m: LiveModel): {
	id: string;
	name: string;
	reasoning: boolean;
	input: readonly ["text"];
	contextWindow: number;
	maxTokens: number;
} {
	return {
		id: m.id,
		name: m.name ?? m.id,
		reasoning: m.reasoning ?? true,
		input: ["text"] as const,
		contextWindow: m.contextWindow ?? 128_000,
		maxTokens: m.maxTokens ?? 16_384,
	};
}

/**
 * Reset the in-memory cache. Useful for tests and `/models refresh`.
 */
export function resetLiveModelsCache(providerId?: string): void {
	if (providerId) {
		cache.delete(providerId);
		for (const key of inflight.keys()) {
			if (key.startsWith(`${providerId}:`)) inflight.delete(key);
		}
	} else {
		cache.clear();
		inflight.clear();
	}
}

/**
 * Inspect what's currently in cache for a provider (returns undefined when cold).
 * Exposed for diagnostics and the /models refresh command.
 */
export function peekCache(providerId: string): { models: LiveModel[]; ageMs: number } | undefined {
	const entry = cache.get(providerId);
	if (!entry) return undefined;
	return { models: entry.models, ageMs: Date.now() - entry.fetchedAt };
}
