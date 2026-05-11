import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ConfigWatcher } from "../src/core/config-watcher.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ConfigWatcher", () => {
	let tempDir: string;
	let watcher: ConfigWatcher;

	beforeEach(() => {
		tempDir = join(tmpdir(), `phi-test-config-watcher-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		watcher = new ConfigWatcher({ debounceMs: 50, agentDir: tempDir });
	});

	afterEach(() => {
		watcher.stop();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	test("start does not throw if watched files do not exist yet", () => {
		expect(() => watcher.start()).not.toThrow();
	});

	test("emits models_json_changed when models.json is created", async () => {
		const events: string[] = [];
		watcher.on("models_json_changed", () => events.push("models"));
		watcher.start();
		writeFileSync(join(tempDir, "models.json"), JSON.stringify({ providers: {} }), "utf-8");
		await wait(200);
		expect(events.length).toBeGreaterThan(0);
	});

	test("emits routing_json_changed when routing.json is modified", async () => {
		writeFileSync(
			join(tempDir, "routing.json"),
			JSON.stringify({ routes: {}, default: { model: "default" } }),
			"utf-8",
		);
		const events: string[] = [];
		watcher.on("routing_json_changed", () => events.push("routing"));
		watcher.start();
		await wait(50);
		writeFileSync(join(tempDir, "routing.json"), JSON.stringify({ routes: {}, default: { model: "x" } }), "utf-8");
		await wait(200);
		expect(events.length).toBeGreaterThan(0);
	});

	test("debounces burst writes (multiple writes -> one event)", async () => {
		const events: number[] = [];
		watcher.on("models_json_changed", () => events.push(Date.now()));
		watcher.start();
		for (let i = 0; i < 5; i++) {
			writeFileSync(join(tempDir, "models.json"), `{"v":${i}}`, "utf-8");
			await wait(5);
		}
		await wait(150);
		expect(events.length).toBeLessThanOrEqual(2);
	});

	test("muteForWrite suppresses the next event window", async () => {
		watcher.start();
		const events: number[] = [];
		watcher.on("models_json_changed", () => events.push(Date.now()));
		watcher.muteForWrite("models_json_changed");
		writeFileSync(join(tempDir, "models.json"), `{"x":1}`, "utf-8");
		await wait(200);
		expect(events.length).toBe(0);
	});

	test("stop closes watchers without error", () => {
		watcher.start();
		expect(() => watcher.stop()).not.toThrow();
	});
});
