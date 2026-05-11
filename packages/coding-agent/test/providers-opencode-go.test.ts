import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	_resetOpenCodeGoCache,
	buildOpenCodeGoProviderConfig,
	getOpenCodeGoModels,
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
		test("produces openai-completions config with mapped models", () => {
			const cfg = buildOpenCodeGoProviderConfig("k", [
				{ id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 256000, maxTokens: 16384 },
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
			expect(cfg.models[1].name).toBe("qwen3-coder");
		});
	});

	test("OPENCODE_GO_ENV_VAR has expected name", () => {
		expect(OPENCODE_GO_ENV_VAR).toBe("OPENCODE_GO_API_KEY");
	});
});
