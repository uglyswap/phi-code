import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ApiKeyStore } from "../src/core/api-key-store.ts";

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

	test("setKey emits key_changed event without leaking the raw key", () => {
		const store = new ApiKeyStore({ configPath });
		const events: Array<{ provider: string }> = [];
		store.on("key_changed", (e: { provider: string }) => events.push(e));
		store.setKey("opencode-go", "secret-abc");
		expect(events).toHaveLength(1);
		// The raw key must not be part of the event payload (read it via getKey instead).
		expect(events[0]).toEqual({ provider: "opencode-go" });
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

	test("load tolerates // comments and trailing commas (same as model-registry)", () => {
		writeFileSync(
			configPath,
			`{
				// user-edited config
				"providers": {
					"alibaba": {
						"apiKey": "sk-commented-key",
						"baseUrl": "https://example.com/v1", // inline comment
					},
				},
			}`,
			"utf-8",
		);
		const store = new ApiKeyStore({ configPath });
		expect(store.getKey("alibaba")).toBe("sk-commented-key");
		expect(store.getProvider("alibaba")?.baseUrl).toBe("https://example.com/v1");
	});

	describe("getKey resolution (resolve-config-value convention)", () => {
		test("returns literal keys as-is", () => {
			const store = new ApiKeyStore({ configPath });
			store.setKey("alibaba", "sk-literal-123");
			expect(store.getKey("alibaba")).toBe("sk-literal-123");
		});

		test("a bare NAME is a literal credential, not an env-var reference", () => {
			// pi 0.84 made "$NAME" the only environment reference. A bare name that
			// happens to match an env var must NOT be substituted: that silently
			// shadowed literal credentials.
			process.env.PHI_TEST_KEY_NAME = "resolved-from-env";
			try {
				const store = new ApiKeyStore({ configPath });
				store.setKey("alibaba", "PHI_TEST_KEY_NAME");
				expect(store.getKey("alibaba")).toBe("PHI_TEST_KEY_NAME");
			} finally {
				delete process.env.PHI_TEST_KEY_NAME;
			}
		});

		test("resolves legacy $NAME notation to the NAME env var", () => {
			process.env.PHI_TEST_DOLLAR_KEY = "resolved-dollar";
			try {
				const store = new ApiKeyStore({ configPath });
				store.setKey("alibaba", "$PHI_TEST_DOLLAR_KEY");
				expect(store.getKey("alibaba")).toBe("resolved-dollar");
			} finally {
				delete process.env.PHI_TEST_DOLLAR_KEY;
			}
		});

		test("unresolved $NAME falls back to the envVar parameter, never returned literally", () => {
			process.env.PHI_TEST_FALLBACK_VAR = "fallback-value";
			try {
				const store = new ApiKeyStore({ configPath });
				store.setKey("alibaba", "$PHI_TEST_UNSET_VAR_XYZ");
				expect(store.getKey("alibaba", "PHI_TEST_FALLBACK_VAR")).toBe("fallback-value");
				expect(store.getKey("alibaba")).toBeUndefined();
			} finally {
				delete process.env.PHI_TEST_FALLBACK_VAR;
			}
		});

		test("empty stored key falls back to the envVar parameter", () => {
			process.env.PHI_TEST_EMPTY_FALLBACK = "env-wins";
			try {
				const store = new ApiKeyStore({ configPath });
				store.setKey("alibaba", "   ");
				expect(store.getKey("alibaba", "PHI_TEST_EMPTY_FALLBACK")).toBe("env-wins");
			} finally {
				delete process.env.PHI_TEST_EMPTY_FALLBACK;
			}
		});
	});
});
