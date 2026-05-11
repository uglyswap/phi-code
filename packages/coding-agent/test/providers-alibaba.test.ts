import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	ALIBABA_ENV_VAR,
	ALIBABA_MODELS,
	ALIBABA_PROVIDERS,
	buildAlibabaProviderConfig,
	pingAlibaba,
	validateAlibabaApiKey,
} from "../extensions/phi/providers/alibaba.js";

describe("providers/alibaba", () => {
	describe("validateAlibabaApiKey", () => {
		test("rejects empty key", () => {
			expect(validateAlibabaApiKey("")).toBe("API key is empty");
			expect(validateAlibabaApiKey("   ")).toBe("API key is empty");
		});

		test("rejects too short key", () => {
			expect(validateAlibabaApiKey("sk-sp-")).toBe("API key too short");
		});

		test("rejects key without sk-sp- prefix", () => {
			const err = validateAlibabaApiKey("sk-or-1234567890abcdef");
			expect(err).toContain("sk-sp-");
		});

		test("accepts well-formed key", () => {
			expect(validateAlibabaApiKey("sk-sp-1234567890abcdef")).toBeNull();
		});
	});

	describe("buildAlibabaProviderConfig", () => {
		test("openai variant returns OpenAI-compat config", () => {
			const cfg = buildAlibabaProviderConfig("openai", "sk-sp-test");
			expect(cfg.baseUrl).toBe(ALIBABA_PROVIDERS.openai.baseUrl);
			expect(cfg.api).toBe("openai-completions");
			expect(cfg.apiKey).toBe("sk-sp-test");
			expect(cfg.models.length).toBe(ALIBABA_MODELS.length);
			expect(cfg.models[0]).not.toHaveProperty("compat");
		});

		test("anthropic variant returns Anthropic-compat config with supportsLongCacheRetention", () => {
			const cfg = buildAlibabaProviderConfig("anthropic", "sk-sp-test");
			expect(cfg.baseUrl).toBe(ALIBABA_PROVIDERS.anthropic.baseUrl);
			expect(cfg.api).toBe("anthropic-messages");
			expect(cfg.models[0].compat).toEqual({ supportsLongCacheRetention: true });
			expect(cfg.models[0].name).toMatch(/Anthropic-compat/);
		});

		test("both variants contain the same model ids", () => {
			const openai = buildAlibabaProviderConfig("openai", "k");
			const anthropic = buildAlibabaProviderConfig("anthropic", "k");
			const openaiIds = openai.models.map((m) => m.id).sort();
			const anthropicIds = anthropic.models.map((m) => m.id).sort();
			expect(openaiIds).toEqual(anthropicIds);
		});
	});

	describe("pingAlibaba", () => {
		const originalFetch = global.fetch;

		beforeEach(() => {
			global.fetch = vi.fn();
		});

		afterEach(() => {
			global.fetch = originalFetch;
		});

		test("returns ok=true on 200", async () => {
			(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200 } as Response);
			const result = await pingAlibaba("sk-sp-test");
			expect(result.ok).toBe(true);
		});

		test("returns 401 error explicitly", async () => {
			(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401 } as Response);
			const result = await pingAlibaba("bad-key");
			expect(result.ok).toBe(false);
			expect(result.error).toContain("401");
		});

		test("returns network error message", async () => {
			(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ECONNREFUSED"));
			const result = await pingAlibaba("sk-sp-test");
			expect(result.ok).toBe(false);
			expect(result.error).toBe("ECONNREFUSED");
		});

		test("uses Authorization Bearer header", async () => {
			const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
			global.fetch = fetchMock;
			await pingAlibaba("sk-sp-secret");
			const callArgs = fetchMock.mock.calls[0];
			expect(callArgs[0]).toContain("/v1/models");
			expect((callArgs[1] as RequestInit).headers).toMatchObject({
				Authorization: "Bearer sk-sp-secret",
			});
		});
	});

	describe("constants", () => {
		test("ALIBABA_ENV_VAR is exported", () => {
			expect(ALIBABA_ENV_VAR).toBe("ALIBABA_CODING_PLAN_KEY");
		});

		test("ALIBABA_MODELS has at least 8 models with required fields", () => {
			expect(ALIBABA_MODELS.length).toBeGreaterThanOrEqual(8);
			for (const m of ALIBABA_MODELS) {
				expect(m.id).toBeTruthy();
				expect(m.contextWindow).toBeGreaterThan(0);
				expect(m.maxTokens).toBeGreaterThan(0);
			}
		});
	});
});
