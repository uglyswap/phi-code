import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { runMigrations } from "../src/migrations.ts";

import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("config value env var syntax migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
		vi.restoreAllMocks();
	});

	function createAgentDir(): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-value-migration-test-"));
		tempDirs.push(agentDir);
		return agentDir;
	}

	function withAgentDir(agentDir: string, fn: () => void): void {
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			fn();
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = previousAgentDir;
			}
		}
	}

	it("leaves uppercase auth.json API key values unchanged", () => {
		const agentDir = createAgentDir();
		fs.writeFileSync(
			path.join(agentDir, "auth.json"),
			`${JSON.stringify(
				{
					anthropic: { type: "api_key", key: "ANTHROPIC_API_KEY" },
					openai: { type: "api_key", key: "$OPENAI_API_KEY" },
					opencode: { type: "api_key", key: "public" },
					github: { type: "oauth", access: "ACCESS_TOKEN", refresh: "REFRESH_TOKEN", expires: 1 },
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		withAgentDir(agentDir, () => runMigrations(agentDir));

		const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8")) as Record<
			string,
			Record<string, unknown>
		>;
		expect(migrated.anthropic.key).toBe("ANTHROPIC_API_KEY");
		expect(migrated.openai.key).toBe("$OPENAI_API_KEY");
		expect(migrated.opencode.key).toBe("public");
		expect(migrated.github.access).toBe("ACCESS_TOKEN");
		expect(logSpy).not.toHaveBeenCalled();
	});

	it.each([
		["malformed", '{\n  "providers": {\n'],
		["blank", ""],
	])("does not throw on %s models.json during migrations", async (_name, content) => {
		const agentDir = createAgentDir();
		const modelsPath = path.join(agentDir, "models.json");
		fs.writeFileSync(modelsPath, content, "utf-8");

		withAgentDir(agentDir, () => expect(() => runMigrations(agentDir)).not.toThrow());

		expect(fs.readFileSync(modelsPath, "utf-8")).toBe(content);
		const registry = await createModelRegistry(AuthStorage.create(path.join(agentDir, "auth.json")), modelsPath);
		const loadError = registry.getError();
		expect(loadError).toContain("Failed to parse models.json");
		expect(loadError).toContain(`File: ${modelsPath}`);
	});

	it("leaves uppercase models.json API key and header values unchanged", async () => {
		const agentDir = createAgentDir();
		const envKeys = ["CUSTOM_API_KEY", "HEADER_API_KEY", "MODEL_API_KEY", "OVERRIDE_API_KEY"];
		const savedEnv: Record<string, string | undefined> = {};
		for (const key of envKeys) {
			savedEnv[key] = process.env[key];
			process.env[key] = `env-${key}`;
		}

		try {
			fs.writeFileSync(
				path.join(agentDir, "models.json"),
				`${JSON.stringify(
					{
						providers: {
							"custom-provider": {
								baseUrl: "https://example.com/v1",
								apiKey: "CUSTOM_API_KEY",
								api: "openai-completions",
								headers: {
									"x-api-key": "HEADER_API_KEY",
									"x-literal": "literal",
								},
								models: [
									{
										id: "model-a",
										headers: { "x-model-key": "MODEL_API_KEY" },
									},
								],
								modelOverrides: {
									"model-b": { headers: { "x-override-key": "OVERRIDE_API_KEY" } },
								},
							},
						},
					},
					null,
					2,
				)}\n`,
				"utf-8",
			);
			const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

			withAgentDir(agentDir, () => runMigrations(agentDir));

			const migrated = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf-8")) as {
				providers: Record<
					string,
					{
						apiKey?: string;
						headers?: Record<string, string>;
						models?: Array<{ headers?: Record<string, string> }>;
						modelOverrides?: Record<string, { headers?: Record<string, string> }>;
					}
				>;
			};
			const provider = migrated.providers["custom-provider"]!;
			expect(provider.apiKey).toBe("CUSTOM_API_KEY");
			expect(provider.headers?.["x-api-key"]).toBe("HEADER_API_KEY");
			expect(provider.headers?.["x-literal"]).toBe("literal");
			expect(provider.models?.[0]?.headers?.["x-model-key"]).toBe("MODEL_API_KEY");
			expect(provider.modelOverrides?.["model-b"]?.headers?.["x-override-key"]).toBe("OVERRIDE_API_KEY");
			expect(logSpy).not.toHaveBeenCalled();

			const registry = await createModelRegistry(
				AuthStorage.create(path.join(agentDir, "auth.json")),
				path.join(agentDir, "models.json"),
			);
			const model = registry.find("custom-provider", "model-a");
			expect(model).toBeDefined();
			expect(await registry.getApiKeyForProvider("custom-provider")).toBe("CUSTOM_API_KEY");
			expect(await registry.getApiKeyAndHeaders(model!)).toMatchObject({
				ok: true,
				apiKey: "CUSTOM_API_KEY",
				headers: {
					"x-api-key": "HEADER_API_KEY",
					"x-literal": "literal",
					"x-model-key": "MODEL_API_KEY",
				},
			});
		} finally {
			for (const key of envKeys) {
				if (savedEnv[key] === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = savedEnv[key];
				}
			}
		}
	});
});

describe("colliding provider endpoint migration", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	function createAgentDir(): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "phi-provider-endpoint-migration-"));
		tempDirs.push(agentDir);
		return agentDir;
	}

	function withAgentDir(agentDir: string, fn: () => void): void {
		const previous = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			fn();
		} finally {
			if (previous === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previous;
		}
	}

	function readModels(agentDir: string) {
		return JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf-8")) as {
			providers: Record<string, { baseUrl?: string; api?: string; models?: Array<Record<string, unknown>> }>;
		};
	}

	it("moves a provider-level endpoint onto the models the entry declares", () => {
		const agentDir = createAgentDir();
		fs.writeFileSync(
			path.join(agentDir, "models.json"),
			`${JSON.stringify(
				{
					providers: {
						"opencode-go": {
							baseUrl: "https://opencode.ai/zen/go/v1",
							api: "openai-completions",
							apiKey: "sk-test",
							models: [{ id: "glm-5.2" }, { id: "kimi-k2.6", baseUrl: "https://custom.example/v1" }],
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);

		withAgentDir(agentDir, () => runMigrations(agentDir));

		const entry = readModels(agentDir).providers["opencode-go"];
		// Provider level is cleared: it also captured the built-in Anthropic-compat
		// models of the same provider and sent them to ".../zen/go/v1/v1/messages".
		expect(entry.baseUrl).toBeUndefined();
		expect(entry.api).toBeUndefined();
		expect(entry.models?.[0]).toMatchObject({
			id: "glm-5.2",
			baseUrl: "https://opencode.ai/zen/go/v1",
			api: "openai-completions",
		});
		// A model that already declared its own endpoint keeps it.
		expect(entry.models?.[1]).toMatchObject({ id: "kimi-k2.6", baseUrl: "https://custom.example/v1" });
	});

	it("leaves an already-migrated entry untouched", () => {
		const agentDir = createAgentDir();
		const content = `${JSON.stringify(
			{
				providers: {
					"opencode-go": {
						apiKey: "sk-test",
						models: [{ id: "glm-5.2", baseUrl: "https://opencode.ai/zen/go/v1", api: "openai-completions" }],
					},
				},
			},
			null,
			2,
		)}\n`;
		fs.writeFileSync(path.join(agentDir, "models.json"), content, "utf-8");

		withAgentDir(agentDir, () => runMigrations(agentDir));

		expect(fs.readFileSync(path.join(agentDir, "models.json"), "utf-8")).toBe(content);
	});

	it("does not touch providers that have no built-in counterpart", () => {
		const agentDir = createAgentDir();
		fs.writeFileSync(
			path.join(agentDir, "models.json"),
			`${JSON.stringify(
				{
					providers: {
						"alibaba-codingplan": {
							baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
							api: "openai-completions",
							models: [{ id: "qwen3.7-plus" }],
						},
					},
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);

		withAgentDir(agentDir, () => runMigrations(agentDir));

		const entry = readModels(agentDir).providers["alibaba-codingplan"];
		expect(entry.baseUrl).toBe("https://coding-intl.dashscope.aliyuncs.com/v1");
		expect(entry.models?.[0]).not.toHaveProperty("baseUrl");
	});
});
