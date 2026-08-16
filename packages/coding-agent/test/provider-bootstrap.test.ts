import { describe, expect, it } from "vitest";
import { ALIBABA_MODELS, ALIBABA_PROVIDERS } from "../extensions/phi/providers/alibaba.ts";
import {
	BOOTSTRAPPABLE_PROVIDERS,
	bootstrapProviderConfig,
	isBootstrappableProvider,
} from "../extensions/phi/providers/provider-bootstrap.ts";

describe("isBootstrappableProvider", () => {
	it("accepts the shipped builders and rejects everything else", () => {
		for (const id of BOOTSTRAPPABLE_PROVIDERS) expect(isBootstrappableProvider(id)).toBe(true);
		expect(isBootstrappableProvider("openai")).toBe(false);
		expect(isBootstrappableProvider("nonsense")).toBe(false);
	});
});

describe("bootstrapProviderConfig — Alibaba Coding Plan", () => {
	it("builds a complete OpenAI-compat entry from one key", () => {
		const r = bootstrapProviderConfig("alibaba-codingplan", "sk-sp-1234567890abcdef");
		if (!r.ok) throw new Error(r.error);
		expect(r.config.baseUrl).toBe(ALIBABA_PROVIDERS.openai.baseUrl);
		expect(r.config.api).toBe("openai-completions");
		expect(r.config.apiKey).toBe("sk-sp-1234567890abcdef");
		expect(r.config.models.length).toBe(ALIBABA_MODELS.length);
		expect(r.config.models.map((m) => m.id)).toContain("qwen3.7-plus");
		expect(r.note).toContain("refresh");
	});

	it("builds the Anthropic-compat variant with its own endpoint", () => {
		const r = bootstrapProviderConfig("alibaba-codingplan-anthropic", "sk-sp-1234567890abcdef");
		if (!r.ok) throw new Error(r.error);
		expect(r.config.baseUrl).toBe(ALIBABA_PROVIDERS.anthropic.baseUrl);
		expect(r.config.api).toBe("anthropic-messages");
	});

	it("rejects a key with the wrong prefix (format validation up front)", () => {
		const r = bootstrapProviderConfig("alibaba-codingplan", "sk-or-1234567890abcdef");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("sk-sp-");
	});

	it("rejects an empty key", () => {
		const r = bootstrapProviderConfig("alibaba-codingplan", "   ");
		expect(r.ok).toBe(false);
	});

	it("trims whitespace around the key", () => {
		const r = bootstrapProviderConfig("alibaba-codingplan", "  sk-sp-1234567890abcdef  ");
		if (!r.ok) throw new Error(r.error);
		expect(r.config.apiKey).toBe("sk-sp-1234567890abcdef");
	});
});

describe("bootstrapProviderConfig — OpenCode Go", () => {
	it("builds the OpenAI-compat entry (GLM/Kimi/DeepSeek families)", () => {
		const r = bootstrapProviderConfig("opencode-go", "sk-1234567890abcdef");
		if (!r.ok) throw new Error(r.error);
		expect(r.config.baseUrl).toContain("opencode.ai/zen/go");
		expect(r.config.api).toBe("openai-completions");
		expect(r.config.models.length).toBeGreaterThan(0);
		// Qwen/MiniMax are anthropic-endpoint models and must NOT be here.
		expect(r.config.models.some((m) => /^(qwen|minimax)/i.test(m.id))).toBe(false);
	});

	it("builds the Anthropic-compat entry with only Qwen/MiniMax", () => {
		const r = bootstrapProviderConfig("opencode-go-anthropic", "sk-1234567890abcdef");
		if (!r.ok) throw new Error(r.error);
		expect(r.config.api).toBe("anthropic-messages");
		for (const m of r.config.models) expect(/^(qwen|minimax)/i.test(m.id)).toBe(true);
	});

	it("rejects an obviously invalid key", () => {
		expect(bootstrapProviderConfig("opencode-go", "short").ok).toBe(false);
	});
});

describe("bootstrapProviderConfig — unknown provider", () => {
	it("returns a helpful error listing the bootstrappable ids", () => {
		const r = bootstrapProviderConfig("openai", "sk-whatever-123456");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toContain("/setup");
			expect(r.error).toContain("alibaba-codingplan");
		}
	});
});
