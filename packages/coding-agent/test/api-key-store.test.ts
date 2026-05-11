import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ApiKeyStore } from "../src/core/api-key-store.js";

describe("ApiKeyStore", () => {
	let tempDir: string;
	let configPath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `phi-test-api-key-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		configPath = join(tempDir, "models.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	test("load returns empty providers when file does not exist", () => {
		const store = new ApiKeyStore({ configPath });
		const config = store.load();
		expect(config.providers).toEqual({});
	});

	test("setKey writes file atomically and persists the key", () => {
		const store = new ApiKeyStore({ configPath });
		store.setKey("alibaba", "sk-sp-test-123", { baseUrl: "https://example.com/v1" });
		expect(existsSync(configPath)).toBe(true);
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as { providers: Record<string, { apiKey?: string; baseUrl?: string }> };
		expect(parsed.providers.alibaba?.apiKey).toBe("sk-sp-test-123");
		expect(parsed.providers.alibaba?.baseUrl).toBe("https://example.com/v1");
	});

	test("setKey emits key_changed event", () => {
		const store = new ApiKeyStore({ configPath });
		const events: Array<{ provider: string; key: string }> = [];
		store.on("key_changed", (e: { provider: string; key: string }) => events.push(e));
		store.setKey("opencode-go", "secret-abc");
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({ provider: "opencode-go", key: "secret-abc" });
	});

	test("getKey returns stored key first, falls back to env var", () => {
		const store = new ApiKeyStore({ configPath });
		store.setKey("alibaba", "from-store");
		process.env.TEST_ALIBABA_FALLBACK = "from-env";
		try {
			expect(store.getKey("alibaba", "TEST_ALIBABA_FALLBACK")).toBe("from-store");
			expect(store.getKey("unknown-provider", "TEST_ALIBABA_FALLBACK")).toBe("from-env");
			expect(store.getKey("unknown-provider")).toBeUndefined();
		} finally {
			delete process.env.TEST_ALIBABA_FALLBACK;
		}
	});

	test("getKey ignores env-var-style placeholder ($VARNAME) in store", () => {
		const store = new ApiKeyStore({ configPath });
		store.setKey("openai", "$OPENAI_API_KEY");
		process.env.TEST_OPENAI_KEY = "real-key";
		try {
			expect(store.getKey("openai", "TEST_OPENAI_KEY")).toBe("real-key");
		} finally {
			delete process.env.TEST_OPENAI_KEY;
		}
	});

	test("removeKey deletes the apiKey but preserves other provider config", () => {
		const store = new ApiKeyStore({ configPath });
		store.setKey("alibaba", "to-delete", { baseUrl: "https://example.com/v1", api: "openai-completions" });
		store.removeKey("alibaba");
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as {
			providers: Record<string, { apiKey?: string; baseUrl?: string; api?: string }>;
		};
		expect(parsed.providers.alibaba?.apiKey).toBeUndefined();
		expect(parsed.providers.alibaba?.baseUrl).toBe("https://example.com/v1");
		expect(parsed.providers.alibaba?.api).toBe("openai-completions");
	});

	test("removeKey emits key_removed event", () => {
		const store = new ApiKeyStore({ configPath });
		store.setKey("alibaba", "to-delete");
		const events: Array<{ provider: string }> = [];
		store.on("key_removed", (e: { provider: string }) => events.push(e));
		store.removeKey("alibaba");
		expect(events).toEqual([{ provider: "alibaba" }]);
	});

	test("listProviders returns all configured providers", () => {
		const store = new ApiKeyStore({ configPath });
		store.setKey("alibaba", "k1");
		store.setKey("openai", "k2");
		store.setKey("opencode-go", "k3");
		expect(store.listProviders().sort()).toEqual(["alibaba", "openai", "opencode-go"]);
	});

	test("reloadFromDisk picks up external edits", () => {
		const store = new ApiKeyStore({ configPath });
		store.setKey("alibaba", "first");
		writeFileSync(
			configPath,
			JSON.stringify({ providers: { alibaba: { apiKey: "second", baseUrl: "https://x.example/v1" } } }, null, 2),
			"utf-8",
		);
		store.reloadFromDisk();
		expect(store.getKey("alibaba")).toBe("second");
	});

	test("maskKey returns sensible masks for different key lengths", () => {
		expect(ApiKeyStore.maskKey(undefined)).toBe("(not set)");
		// "" is falsy so returns "(not set)" (consistent with undefined behavior)
		expect(ApiKeyStore.maskKey("")).toBe("(not set)");
		// "   " is truthy but trims to empty -> "(empty)"
		expect(ApiKeyStore.maskKey("   ")).toBe("(empty)");
		expect(ApiKeyStore.maskKey("short")).toBe("********");
		expect(ApiKeyStore.maskKey("sk-sp-1234567890abcdef")).toMatch(/^sk-sp-\.\.\.cdef$/);
	});

	test("setKey applies chmod 0600 on Unix (skipped on Windows)", () => {
		if (process.platform === "win32") return;
		const store = new ApiKeyStore({ configPath });
		store.setKey("alibaba", "k1");
		const mode = statSync(configPath).mode & 0o777;
		expect(mode).toBe(0o600);
	});
});
