import { existsSync, type FSWatcher, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventsWatcher, MAX_TIMER_DELAY_MS, type OneShotEvent } from "../src/events.ts";
import type { SlackBot, SlackEvent } from "../src/slack.ts";

describe("EventsWatcher", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mom-events-"));
	});

	afterEach(() => {
		vi.useRealTimers();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// Ported from upstream pi f3a2c9d05 (#3564).
	it("retries the events fs watcher 5 seconds after an async error", async () => {
		vi.useFakeTimers();
		const slack = { enqueueEvent: vi.fn((_event: SlackEvent) => true) } as unknown as SlackBot;
		const watcher = new EventsWatcher(join(tempDir, "events"), slack);

		try {
			watcher.start();
			const internals = watcher as unknown as { watcher: FSWatcher | null };
			const originalWatcher = internals.watcher;
			expect(originalWatcher).not.toBeNull();
			expect(originalWatcher?.listenerCount("error")).toBeGreaterThan(0);

			originalWatcher?.emit("error", new Error("simulated EMFILE"));
			expect(internals.watcher).toBeNull();

			await vi.advanceTimersByTimeAsync(4999);
			expect(internals.watcher).toBeNull();

			await vi.advanceTimersByTimeAsync(1);
			expect(internals.watcher).not.toBeNull();
			expect(internals.watcher).not.toBe(originalWatcher);
		} finally {
			watcher.stop();
		}
	});

	it("does not fire a one-shot event scheduled beyond the 32-bit timer limit early", async () => {
		vi.useFakeTimers();
		const enqueueEvent = vi.fn((_event: SlackEvent) => true);
		const slack = { enqueueEvent } as unknown as SlackBot;
		const watcher = new EventsWatcher(join(tempDir, "events"), slack);
		// Drive the scheduler directly: real file reads do not progress under fake timers.
		const internals = watcher as unknown as { handleOneShot(filename: string, event: OneShotEvent): void };

		const delay = MAX_TIMER_DELAY_MS + 60 * 60 * 1000; // ~24.9 days
		const at = new Date(Date.now() + delay).toISOString();
		try {
			internals.handleOneShot("later.json", { type: "one-shot", channelId: "C1", text: "x", at });

			await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
			expect(enqueueEvent).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(delay - MAX_TIMER_DELAY_MS);
			expect(enqueueEvent).toHaveBeenCalledTimes(1);
		} finally {
			watcher.stop();
		}
	});
});
