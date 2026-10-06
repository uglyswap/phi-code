/**
 * Regression: on timeout the explore / candidate fan-outs must kill the WHOLE
 * sub-phi process tree (taskkill /T on Windows, process group on POSIX), not
 * just the direct child: proc.kill() left the sub-phi's own children orphaned.
 *
 * The sub-phi is faked by pointing process.argv[1] (what getPiInvocation
 * re-invokes) at a script that spawns a long-lived grandchild, records its pid,
 * emits a partial assistant message, then hangs. On Windows the grandchild is
 * detached: libuv already kills non-detached descendants with the root (job
 * object), so only a tree kill (taskkill /T) reaches the detached one. On POSIX
 * it stays in the sub-phi's process group, which SIGTERM alone does not reach.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runOneCandidate } from "../extensions/phi/providers/candidate-fanout.ts";
import { runExplorer } from "../extensions/phi/providers/explore-fanout.ts";

const FAKE_SUB_PHI = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
	stdio: "ignore",
	detached: process.platform === "win32",
});
writeFileSync(process.env.FIX2_ORCH_PID_FILE, String(grandchild.pid));
const msg = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } };
process.stdout.write(JSON.stringify(msg) + "\\n");
setInterval(() => {}, 1000);
`;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForPid(file: string): Promise<number> {
	for (let i = 0; i < 100; i++) {
		if (existsSync(file)) {
			const raw = readFileSync(file, "utf-8").trim();
			if (raw) return Number(raw);
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("fake sub-phi never recorded its grandchild pid");
}

async function waitDead(pid: number): Promise<boolean> {
	for (let i = 0; i < 40; i++) {
		if (!isAlive(pid)) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
}

describe("fan-out timeout kills the whole sub-phi tree", () => {
	let dir: string;
	let pidFile: string;
	let savedArgv1: string | undefined;
	let grandchildPid: number | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fix2-orch-fanout-"));
		const script = join(dir, "fake-sub-phi.cjs");
		writeFileSync(script, FAKE_SUB_PHI);
		pidFile = join(dir, "grandchild.pid");
		process.env.FIX2_ORCH_PID_FILE = pidFile;
		savedArgv1 = process.argv[1];
		process.argv[1] = script;
		grandchildPid = undefined;
	});

	afterEach(() => {
		process.argv[1] = savedArgv1 as string;
		delete process.env.FIX2_ORCH_PID_FILE;
		if (grandchildPid && isAlive(grandchildPid)) {
			try {
				process.kill(grandchildPid, "SIGKILL");
			} catch {
				/* already gone */
			}
		}
		rmSync(dir, { recursive: true, force: true });
	});

	it("runExplorer: grandchild is killed and the run is reported as a timeout", async () => {
		const result = await runExplorer({ focus: "f", prompt: "p" }, { cwd: dir, timeoutMs: 1500 });
		grandchildPid = await waitForPid(pidFile);
		expect(await waitDead(grandchildPid)).toBe(true);
		// The partial text must not count as a successful exploration.
		expect(result.ok).toBe(false);
		expect(result.error).toBe("timeout");
	}, 20_000);

	it("runOneCandidate: grandchild is killed on timeout", async () => {
		const outcome = await runOneCandidate(dir, { model: "m", instruction: "i" }, 1500);
		grandchildPid = await waitForPid(pidFile);
		expect(await waitDead(grandchildPid)).toBe(true);
		expect(outcome.ok).toBe(false);
	}, 20_000);
});
