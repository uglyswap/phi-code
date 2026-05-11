/**
 * Alibaba Coding Plan Provider - Source of truth for Alibaba config.
 *
 * Provides 2 variants:
 *  - alibaba-codingplan          : OpenAI-compat (/v1) — legacy, works everywhere
 *  - alibaba-codingplan-anthropic: Anthropic-compat (/apps/anthropic) — ~99.7% prompt cache hit
 *
 * Both share ALIBABA_CODING_PLAN_KEY env var (format: sk-sp-xxxxx).
 *
 * Models are STATIC versioned (no public listing endpoint).
 * To refresh: run `npx tsx scripts/refresh-alibaba-models.ts` (Q3 strategy C).
 *
 * Rate limits (Pro Plan, $50/month):
 *  - 6,000 requests / 5-hour sliding window
 *  - 45,000 requests / week (resets Mon 00:00 UTC+8)
 *  - 90,000 requests / month (resets on subscription anniversary)
 */

export const ALIBABA_ENV_VAR = "ALIBABA_CODING_PLAN_KEY";
export const ALIBABA_API_KEY_PREFIX = "sk-sp-";

export const ALIBABA_PROVIDERS = {
	openai: {
		id: "alibaba-codingplan",
		displayName: "Alibaba Coding Plan (OpenAI-compat)",
		baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
		api: "openai-completions" as const,
	},
	anthropic: {
		id: "alibaba-codingplan-anthropic",
		displayName: "Alibaba Coding Plan (Anthropic-compat, native prompt cache)",
		baseUrl: "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic",
		api: "anthropic-messages" as const,
	},
} as const;

export interface AlibabaModelSpec {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
}

/**
 * Bundled Alibaba models. Refresh via `scripts/refresh-alibaba-models.ts`.
 * Last verified: 2026-05-10.
 */
export const ALIBABA_MODELS: readonly AlibabaModelSpec[] = [
	{ id: "qwen3.5-plus", name: "Qwen 3.5 Plus", contextWindow: 1_000_000, maxTokens: 16_384, reasoning: true },
	{ id: "qwen3-max-2026-01-23", name: "Qwen 3 Max", contextWindow: 262_144, maxTokens: 16_384, reasoning: true },
	{ id: "qwen3-coder-plus", name: "Qwen 3 Coder Plus", contextWindow: 1_000_000, maxTokens: 16_384, reasoning: true },
	{ id: "qwen3-coder-next", name: "Qwen 3 Coder Next", contextWindow: 1_000_000, maxTokens: 16_384, reasoning: true },
	{ id: "kimi-k2.5", name: "Kimi K2.5", contextWindow: 262_144, maxTokens: 16_384, reasoning: true },
	{ id: "glm-5", name: "GLM 5", contextWindow: 200_000, maxTokens: 128_000, reasoning: true },
	{ id: "glm-4.7", name: "GLM 4.7", contextWindow: 200_000, maxTokens: 128_000, reasoning: true },
	{ id: "MiniMax-M2.5", name: "MiniMax M2.5", contextWindow: 1_000_000, maxTokens: 16_384, reasoning: true },
] as const;

export const ALIBABA_RATE_LIMITS = {
	per5Hours: 6_000,
	perWeek: 45_000,
	perMonth: 90_000,
	weekResetUTC: "Mon 00:00 UTC+8",
	subscriptionType: "Pro Plan ($50/month)",
} as const;

/**
 * Validate Alibaba Coding Plan API key format.
 * Returns null if valid, error message otherwise.
 */
export function validateAlibabaApiKey(key: string): string | null {
	const trimmed = key.trim();
	if (trimmed.length === 0) return "API key is empty";
	if (trimmed.length < 10) return "API key too short";
	if (!trimmed.startsWith(ALIBABA_API_KEY_PREFIX)) {
		return `API key should start with "${ALIBABA_API_KEY_PREFIX}" (Coding Plan prefix)`;
	}
	return null;
}

/**
 * Build a models.json provider entry for one variant.
 * Used by init.ts/setup.ts when user picks Alibaba.
 */
export function buildAlibabaProviderConfig(variant: "openai" | "anthropic", apiKey: string) {
	const provider = ALIBABA_PROVIDERS[variant];
	const isAnthropic = variant === "anthropic";
	return {
		baseUrl: provider.baseUrl,
		api: provider.api,
		apiKey,
		models: ALIBABA_MODELS.map((m) => ({
			id: m.id,
			name: isAnthropic ? `${m.name} (Anthropic-compat)` : m.name,
			reasoning: m.reasoning,
			input: ["text"] as const,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			...(isAnthropic ? { compat: { supportsLongCacheRetention: true } } : {}),
		})),
	};
}

/**
 * Test an Alibaba API key by hitting /v1/models (lightweight).
 * Returns true if 200, false otherwise.
 */
export async function pingAlibaba(apiKey: string, timeoutMs = 5_000): Promise<{ ok: boolean; error?: string }> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${ALIBABA_PROVIDERS.openai.baseUrl}/models`, {
			signal: controller.signal,
			headers: { Authorization: `Bearer ${apiKey}` },
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
