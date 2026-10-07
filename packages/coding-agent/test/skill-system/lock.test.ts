/**
 * Lock tests (plan §6.1): reentrance, release semantics, stale-lock reclaim,
 * and that a second batch on the same key waits for the first.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLocks } from "../../extensions/phi/skill-system/lock.ts";
import { lockKeyFor, locksDir } from "../../extensions/phi/skill-system/paths.ts";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "phi-lock-agent-"));
	process.env.PHI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	delete process.env.PHI_CODING_AGENT_DIR;
	rmSync(agentDir, { recursive: true, force: true });
});

describe("locks", () => {
	it("is reentrant within one process", async () => {
		const release1 = await acquireLocks(["skill:a"]);
		const release2 = await acquireLocks(["skill:a"]);
		release2();
		release1();
		// Still acquirable afterwards.
		const release3 = await acquireLocks(["skill:a"]);
		release3();
	});

	it("releases only once (double release is a no-op)", async () => {
		const release = await acquireLocks(["skill:b"]);
		release();
		release();
		const again = await acquireLocks(["skill:b"]);
		again();
	});

	it("waits for a foreign lock held by another process, then proceeds", async () => {
		mkdirSync(locksDir(), { recursive: true });
		const lockPath = join(locksDir(), `${lockKeyFor("skill:foreign")}.lock`);
		writeFileSync(lockPath, "4242 1"); // fresh timestamp, NOT held by this process
		let acquired = false;
		const pending = acquireLocks(["skill:foreign"]).then((releaseSecond) => {
			acquired = true;
			releaseSecond();
		});
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(acquired).toBe(false); // still blocked by the other process
		rmSync(lockPath); // the other process releases
		await pending;
		expect(acquired).toBe(true);
	});

	it("reclaims a stale lock file", async () => {
		mkdirSync(locksDir(), { recursive: true });
		const lockPath = join(locksDir(), `${lockKeyFor("skill:stale")}.lock`);
		writeFileSync(lockPath, "999999 0");
		const old = new Date(Date.now() - 10 * 60_000);
		utimesSync(lockPath, old, old);
		const release = await acquireLocks(["skill:stale"]);
		release();
	});
});
