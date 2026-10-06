/**
 * FIX2-BROWSER regression: ensureServer() must fail fast when the camofox-browser
 * child dies (or cannot be spawned) during startup, instead of polling /health
 * for the full 30 s timeout. spawn is mocked; /health never answers.
 */
import { EventEmitter } from "node:events";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

type FakeChild = EventEmitter & {
	stderr: EventEmitter & { readableEnded?: boolean };
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	kill: () => boolean;
};

const state = vi.hoisted(() => ({ behaviour: "crash" as "crash" | "spawn-error" }));

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => {
		const child = new EventEmitter() as FakeChild;
		child.stderr = new EventEmitter();
		child.exitCode = null;
		child.signalCode = null;
		child.kill = () => true;
		setTimeout(() => {
			if (state.behaviour === "spawn-error") {
				child.emit("error", Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" }));
				return;
			}
			child.stderr.emit("data", Buffer.from("Error: Cannot find module 'express'\n"));
			child.exitCode = 1;
			child.emit("exit", 1, null);
			child.stderr.emit("end");
		}, 20);
		return child;
	}),
}));

const browser = await import("../../browser/src/index.ts");

describe("fix2-browser: ensureServer boot failures", () => {
	beforeEach(() => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);
	});
	afterAll(async () => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		await browser.closeAll();
	});

	it("rejects as soon as the child exits, with the exit code and its stderr", async () => {
		state.behaviour = "crash";
		const started = Date.now();
		const error = await browser.ensureServer().then(
			() => undefined,
			(err: unknown) => err as Error,
		);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(error?.message).toMatch(/exited during startup \(code 1\)/);
		expect(error?.message).toContain("Cannot find module 'express'");
	});

	it("rejects when the runtime cannot be spawned, and a later call can retry", async () => {
		state.behaviour = "spawn-error";
		await expect(browser.ensureServer()).rejects.toThrow(/failed to start .*ENOENT/);
		state.behaviour = "crash";
		await expect(browser.ensureServer()).rejects.toThrow(/exited during startup/);
	});
});
