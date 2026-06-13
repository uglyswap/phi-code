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

// Default when nothing is known. 256k matches the majority of current high-end
// models. Note the asymmetry: over-reporting risks a hard "context exceeded" on a
// genuinely smaller model (caught late by the overflow safety net), while
// under-reporting only compacts a little early. Use `/context` to set the real
// window for a model whose value is unknown.
const DEFAULT_CONTEXT_WINDOW = 256_000;

export function inferContextWindow(modelId: string, apiValue?: number, providerId?: string): number {
	if (typeof apiValue === "number" && apiValue > 0) return apiValue;

	const id = (modelId ?? "").toLowerCase();
	// Large-context families that provider /models endpoints often omit.
	if (id.includes("qwen") || id.includes("minimax")) return 1_000_000;
	if (id.includes("gemini")) return id.includes("flash") ? 1_000_000 : 2_000_000;
	if (id.includes("gpt-5")) return 400_000;
	if (id.includes("kimi")) return 256_000;
	if (id.includes("glm") || id.includes("mimo")) return 200_000;
	if (id.includes("claude")) return 200_000;
	// Known 128k families: pin them so the larger default does not over-report them.
	if (id.includes("deepseek") || id.includes("llama") || id.includes("gpt-4") || id.includes("hy3")) return 128_000;

	// Provider-level hint when the model id is opaque.
	const provider = (providerId ?? "").toLowerCase();
	if (provider.includes("google") || provider.includes("gemini")) return 2_000_000;

	return DEFAULT_CONTEXT_WINDOW;
}

/** Parse a context-window value like "256k", "1M", "1.5m", or "200000". */
export function parseContextWindow(input: string): number | undefined {
	const m = input.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
	if (!m) return undefined;
	const n = Number.parseFloat(m[1]);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	const mult = m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1;
	const value = Math.round(n * mult);
	return value > 0 ? value : undefined;
}

/** Format a token count as a compact "256k" / "1M" label. */
export function formatWindow(n: number): string {
	if (n >= 1_000_000) {
		const v = n / 1_000_000;
		return `${Number.isInteger(v) ? v : v.toFixed(1)}M`;
	}
	return `${Math.round(n / 1_000)}k`;
}
