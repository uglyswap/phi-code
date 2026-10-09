/**
 * The models extension refreshes the provider catalogs at session_start. Headless
 * runs (print / json mode) must not call provider APIs nor rewrite models.json
 * unless PHI_MODELS_REFRESH=1. A refresh must never write a resolved API key into
 * models.json: a key that comes from the environment is referenced as "$NAME".
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import modelsExtension from "../extensions/phi/models.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { _resetApiKeyStore } from "../src/core/api-key-store.ts";
import { _resetConfigWatcher } from "../src/core/config-watcher.ts";

const KEY = "sk-test-resolved-0123456789";
let agentDir: string;

type Handler = (...args: unknown[]) => Promise<void>;

function load(): { commands: Map<string, { handler: Handler }>; events: Map<string, Handler> } {
	const commands = new Map<string, { handler: Handler }>();
	const events = new Map<string, Handler>();
	modelsExtension({
		registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options),
		on: (name: string, handler: Handler) => events.set(name, handler),
		events: { emit: vi.fn() },
		setModel: vi.fn(),
	} as never);
	return { commands, events };
}

function registry(available: Array<{ provider: string }>) {
	return {
		getAvailable: vi.fn(() => available),
		getApiKeyForProvider: vi.fn(async () => KEY),
		find: vi.fn(() => undefined),
		refresh: vi.fn(async () => undefined),
	};
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "models-headless-"));
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	_resetApiKeyStore();
	_resetConfigWatcher();
});

afterEach(() => {
	_resetConfigWatcher();
	_resetApiKeyStore();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("models extension without a UI", () => {
	it("does not refresh the catalogs at session_start", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const { events } = load();
		const reg = registry([{ provider: "opencode-go" }]);
		await events.get("session_start")?.({}, { hasUI: false, modelRegistry: reg, ui: { notify: vi.fn() } });
		expect(reg.getAvailable).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("refreshes when PHI_MODELS_REFRESH=1", async () => {
		vi.stubEnv("PHI_MODELS_REFRESH", "1");
		const { events } = load();
		const reg = registry([]);
		await events.get("session_start")?.({}, { hasUI: false, modelRegistry: reg, ui: { notify: vi.fn() } });
		expect(reg.getAvailable).toHaveBeenCalled();
	});
});

describe("/models refresh opencode-go", () => {
	it("references the environment variable instead of writing the resolved key", async () => {
		vi.stubEnv("PI_OFFLINE", undefined);
		vi.stubEnv("PHI_OFFLINE", undefined);
		vi.stubEnv("OPENCODE_API_KEY", KEY);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				if (String(input).startsWith("https://opencode.ai/zen/go/v1/models")) {
					return new Response(JSON.stringify({ data: [{ id: "zz-phibot-test-model" }] }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response("not found", { status: 404 });
			}),
		);
		const { commands } = load();
		const reg = registry([{ provider: "opencode-go" }]);
		await commands.get("models")?.handler("refresh opencode-go", {
			ui: { notify: vi.fn(), setStatus: vi.fn() },
			modelRegistry: reg,
			model: undefined,
		});

		const written = readFileSync(join(agentDir, "models.json"), "utf8");
		expect(written).toContain("zz-phibot-test-model");
		expect(written).not.toContain(KEY);
		const providers = (JSON.parse(written) as { providers: Record<string, { apiKey?: string }> }).providers;
		expect(providers["opencode-go"]?.apiKey).toBe("$OPENCODE_API_KEY");
	});
});
