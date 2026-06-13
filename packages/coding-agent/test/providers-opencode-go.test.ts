import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	_resetOpenCodeGoCache,
	buildOpenCodeGoAnthropicProviderConfig,
	buildOpenCodeGoProviderConfig,
	getOpenCodeGoModels,
	inferOpenCodeGoContextWindow,
	OPENCODE_GO_ENV_VAR,
	OPENCODE_GO_FALLBACK_MODELS,
	pingOpenCodeGo,
	validateOpenCodeGoApiKey,
} from "../extensions/phi/providers/opencode-go.js";

describe("providers/opencode-go", () => {
	const originalFetch = global.fetch;

	beforeEach(() => {
		_resetOpenCodeGoCache();
		global.fetch = vi.fn();
	});

	afterEach(() => {
		global.fetch = originalFetch;
	});

	describe("validateOpenCodeGoApiKey", () => {
		test("rejects empty key", () => {
			expect(validateOpenCodeGoApiKey("")).toBe("API key is empty");
		});

		test("rejects too short key", () => {
			expect(validateOpenCodeGoApiKey("123")).toBe("API key too short");
		});

		test("accepts well-formed key", () => {
			expect(validateOpenCodeGoApiKey("1234567890abcdef")).toBeNull();
		});
	});

	describe("getOpenCodeGoModels", () => {
		test("returns live models when fetch succeeds", async () => {
			(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ data: [{ id: "kimi-k2.6" }, { id: "qwen3-coder" }] }),
			} as Response);
			const { models, source } = await getOpenCodeGoModels({ forceRefresh: true });
			expect(source).toBe("live");
			expect(models.map((m) => m.id)).toEqual(["kimi-k2.6", "qwen3-coder"]);
		});

		test("uses cache on second call within TTL", async () => {
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ data: [{ id: "kimi-k2.6" }] }),
			} as Response);
			global.fetch = fetchMock;
			await getOpenCodeGoModels({ forceRefresh: true });
			const { source } = await getOpenCodeGoModels();
			expect(source).toBe("cache");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		test("falls back to static list when network fails on cold cache", async () => {
			(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ECONNREFUSED"));
			const { models, source } = await getOpenCodeGoModels({ forceRefresh: true });
			expect(source).toBe("fallback");
			expect(models.length).toBe(OPENCODE_GO_FALLBACK_MODELS.length);
		});

		test("returns cached list when network fails on warm cache", async () => {
			(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ data: [{ id: "live-model" }] }),
			} as Response);
			await getOpenCodeGoModels({ forceRefresh: true });
			(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network down"));
			const { models, source } = await getOpenCodeGoModels({ forceRefresh: true });
			expect(source).toBe("cache");
			expect(models[0].id).toBe("live-model");
		});

		test("passes apiKey as Bearer when provided", async () => {
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ data: [] }),
			} as Response);
			global.fetch = fetchMock;
			await getOpenCodeGoModels({ apiKey: "secret-token", forceRefresh: true });
			const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer secret-token");
		});
	});

	describe("pingOpenCodeGo", () => {
		test("returns ok=true on 200", async () => {
			(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200 } as Response);
			expect((await pingOpenCodeGo("key")).ok).toBe(true);
		});

		test("returns 401 error on auth failure", async () => {
			(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401 } as Response);
			const result = await pingOpenCodeGo("bad");
			expect(result.ok).toBe(false);
			expect(result.error).toContain("401");
		});
	});

	describe("buildOpenCodeGoProviderConfig", () => {
		test("produces openai-completions config and excludes Qwen/MiniMax (Anthropic-routed)", () => {
			const cfg = buildOpenCodeGoProviderConfig("k", [
				{ id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 256000, maxTokens: 16384 },
				{ id: "glm-5", name: "GLM 5" },
				{ id: "qwen3-coder" },
			]);
			expect(cfg.baseUrl).toBe("https://opencode.ai/zen/go/v1");
			expect(cfg.api).toBe("openai-completions");
			expect(cfg.apiKey).toBe("k");
			expect(cfg.models[0]).toMatchObject({
				id: "kimi-k2.6",
				name: "Kimi K2.6",
				contextWindow: 256000,
			});
			expect(cfg.models[1].name).toBe("GLM 5");
			// Qwen/MiniMax are routed to the Anthropic-compatible endpoint, not here.
			expect(cfg.models.find((m) => m.id === "qwen3-coder")).toBeUndefined();
		});
	});

	describe("buildOpenCodeGoAnthropicProviderConfig", () => {
		test("routes Qwen/MiniMax and infers their 1M context window when missing", () => {
			const cfg = buildOpenCodeGoAnthropicProviderConfig("k", [
				{ id: "qwen3.7-plus" },
				{ id: "minimax-m2.7" },
				{ id: "kimi-k2.6", name: "Kimi K2.6" },
			]);
			expect(cfg.api).toBe("anthropic-messages");
			expect(cfg.models.map((m) => m.id)).toEqual(["qwen3.7-plus", "minimax-m2.7"]);
			// qwen3.7-plus has no contextWindow from the API; it must not collapse to 128k.
			expect(cfg.models.find((m) => m.id === "qwen3.7-plus")?.contextWindow).toBe(1_000_000);
		});
	});

	describe("inferOpenCodeGoContextWindow", () => {
		test("keeps a provided positive window", () => {
			expect(inferOpenCodeGoContextWindow("qwen3.7-plus", 262_144)).toBe(262_144);
		});
		test("infers by model family when missing", () => {
			expect(inferOpenCodeGoContextWindow("qwen3.7-plus")).toBe(1_000_000);
			expect(inferOpenCodeGoContextWindow("minimax-m2.7")).toBe(1_000_000);
			expect(inferOpenCodeGoContextWindow("kimi-k2.6")).toBe(256_000);
			expect(inferOpenCodeGoContextWindow("glm-5.1")).toBe(200_000);
			expect(inferOpenCodeGoContextWindow("mimo-v2-pro")).toBe(200_000);
			expect(inferOpenCodeGoContextWindow("deepseek-v4-pro")).toBe(128_000);
			expect(inferOpenCodeGoContextWindow("unknown-model", 0)).toBe(128_000);
		});
	});

	test("OPENCODE_GO_ENV_VAR has expected name", () => {
		expect(OPENCODE_GO_ENV_VAR).toBe("OPENCODE_GO_API_KEY");
	});
});
