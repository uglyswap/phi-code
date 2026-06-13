/**
 * Shared context-window resolver for all phi providers.
 *
 * Provider `/models` endpoints are inconsistent: some report the context window
 * (under `context_length`, `context_window`, `inputTokenLimit`, ...), many omit
 * it entirely (OpenCode Go for newer Qwen models, Alibaba, ...). A flat default
 * badly under-reports large-context families and surfaces as a wrong "/128k" in
 * the footer. This resolver layers the sources:
 *   1. the value reported by the provider API (if present and positive);
 *   2. a curated per-family heuristic (keeps large-context models correct);
 *   3. a generic default.
 *
 * Family values mirror the bundled static specs (OPENCODE_GO_FALLBACK_MODELS,
 * default-models.json, live-models static specs).
 */

const DEFAULT_CONTEXT_WINDOW = 128_000;

export function inferContextWindow(modelId: string, apiValue?: number, providerId?: string): number {
	if (typeof apiValue === "number" && apiValue > 0) return apiValue;

	const id = (modelId ?? "").toLowerCase();
	if (id.includes("qwen") || id.includes("minimax")) return 1_000_000;
	if (id.includes("gemini")) return id.includes("flash") ? 1_000_000 : 2_000_000;
	if (id.includes("kimi")) return 256_000;
	if (id.includes("glm") || id.includes("mimo")) return 200_000;
	if (id.includes("gpt-5")) return 400_000;
	if (id.includes("claude")) return 200_000;

	// Provider-level hint when the model id is opaque.
	const provider = (providerId ?? "").toLowerCase();
	if (provider.includes("google") || provider.includes("gemini")) return 2_000_000;

	return DEFAULT_CONTEXT_WINDOW;
}
