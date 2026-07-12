import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import orchestratorExtension from "../extensions/phi/orchestrator.js";

/**
 * End-to-end integration of the /debug and /build linear driver against a
 * simulated Pi runtime. Deterministic: phase outcomes are scripted, so the whole
 * chain (command → phase send → agent_end → verdict resolution → next phase →
 * completion / BLOCKED halt) runs in CI without a live model. It also guards
 * that /debug and /build never engage /plan's review-fix path.
 */

interface Captured {
	commands: Map<string, (args: string, ctx: any) => Promise<void> | void>;
	tools: Map<string, { execute: (id: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any> }>;
	events: Map<string, (event: any, ctx: any) => Promise<void> | void>;
	sentMessages: string[];
	setModelCalls: any[];
	notifications: string[];
}

function makeFakePi(cap: Captured) {
	return {
		registerCommand: (name: string, def: { handler: (args: string, ctx: any) => Promise<void> | void }) => {
			cap.commands.set(name, def.handler);
		},
		registerTool: (def: any) => {
			cap.tools.set(def.name, def);
		},
		on: (event: string, handler: (event: any, ctx: any) => Promise<void> | void) => {
			cap.events.set(event, handler);
		},
		getActiveTools: () => ["read", "write", "edit", "bash"],
		setActiveTools: (_tools: string[]) => {},
		setModel: async (model: any) => {
			cap.setModelCalls.push(model);
			return true;
		},
		sendUserMessage: (text: string, _opts?: any) => {
			cap.sentMessages.push(text);
		},
		events: { emit: () => {} },
	} as any;
}

function makeCtx(cap: Captured, cwd: string) {
	return {
		ui: { notify: (msg: string) => cap.notifications.push(msg) },
		modelRegistry: { getAvailable: () => [{ id: "default", provider: "test" }] },
		model: { id: "default", provider: "test" },
		cwd,
		abort: () => {},
		getContextUsage: () => undefined,
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const phaseMessages = (): unknown[] => [
	{ role: "assistant", content: "working", stopReason: "stop" },
	{ role: "toolResult", name: "write", content: "wrote patch" },
];

describe("/debug + /build integration", () => {
	let tempDir: string;
	let prevCwd: string;
	let cap: Captured;

	beforeEach(() => {
		prevCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "dbg-int-"));
		mkdirSync(join(tempDir, ".phi", "plans"), { recursive: true });
		process.chdir(tempDir);
		cap = {
			commands: new Map(),
			tools: new Map(),
			events: new Map(),
			sentMessages: [],
			setModelCalls: [],
			notifications: [],
		};
		orchestratorExtension(makeFakePi(cap));
	});
	afterEach(() => {
		process.chdir(prevCwd);
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function finishPhase(structured?: { verdict?: string; handoff?: string; blocking?: string }) {
		if (structured) {
			const tool = cap.tools.get("phase_result")!;
			await tool.execute("c", structured, undefined, undefined, makeCtx(cap, tempDir));
		}
		await cap.events.get("agent_end")!({ messages: phaseMessages() }, makeCtx(cap, tempDir));
		await sleep(700);
	}

	it("registers /debug and /build", () => {
		expect(cap.commands.has("debug")).toBe(true);
		expect(cap.commands.has("build")).toBe(true);
	});

	it("/debug with no args shows usage and does not start", async () => {
		await cap.commands.get("debug")!("", makeCtx(cap, tempDir));
		expect(cap.notifications.join("\n")).toContain("Usage:");
		expect(cap.sentMessages.length).toBe(0);
	});

	it("/debug runs REPRODUCE → LOCALIZE → FIX → VERIFY and finishes on a green verdict", async () => {
		await cap.commands.get("debug")!("pytest tests/test_x.py::test_y", makeCtx(cap, tempDir));
		await sleep(300);
		expect(cap.sentMessages[0]).toContain("REPRODUCE agent");
		expect(cap.sentMessages[0]).toContain("pytest tests/test_x.py::test_y");

		await finishPhase({ verdict: "PASS", handoff: "reproduced: assertion error" }); // REPRODUCE → LOCALIZE
		expect(cap.sentMessages[1]).toContain("LOCALIZE agent");

		await finishPhase({ handoff: "fault at x.py:42" }); // LOCALIZE → FIX
		expect(cap.sentMessages[2]).toContain("FIX agent");

		await finishPhase({ handoff: "patched x.py" }); // FIX → VERIFY
		expect(cap.sentMessages[3]).toContain("VERIFY agent");

		await finishPhase({ verdict: "PASS", handoff: "repro passes, suite green" }); // VERIFY → done
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("debug summary");
		expect(notes).toContain("finished");
	});

	it("/debug retries a BLOCKED REPRODUCE once on the fallback, then halts honestly", async () => {
		await cap.commands.get("debug")!("pytest tests/test_x.py::test_y", makeCtx(cap, tempDir));
		await sleep(300);
		const before = cap.sentMessages.length;

		// First BLOCKED → one second chance: the SAME phase is re-sent (fallback model).
		await finishPhase({ verdict: "BLOCKED", handoff: "cannot reproduce — passes on current code" });
		expect(cap.notifications.join("\n")).toContain("retrying once on the fallback model");
		expect(cap.sentMessages.length).toBe(before + 1);
		expect(cap.sentMessages[before]).toContain("REPRODUCE agent");

		// Second BLOCKED → honest halt, nothing further sent.
		await finishPhase({ verdict: "BLOCKED", handoff: "still passes on current code" });
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("confirmed on retry");
		expect(notes).toContain("stopped: BLOCKED");
		expect(cap.sentMessages.length).toBe(before + 1);
	});

	it("/debug proceeds to LOCALIZE when the BLOCKED retry succeeds", async () => {
		await cap.commands.get("debug")!("pytest tests/test_x.py::test_y", makeCtx(cap, tempDir));
		await sleep(300);
		await finishPhase({ verdict: "BLOCKED", handoff: "flaky env" }); // → retry REPRODUCE
		await finishPhase({ verdict: "PASS", handoff: "reproduced on retry" }); // → LOCALIZE
		expect(cap.sentMessages.at(-1)).toContain("LOCALIZE agent");
	});

	it("/debug retries once on a transient provider error instead of advancing", async () => {
		await cap.commands.get("debug")!("pytest tests/test_x.py::test_y", makeCtx(cap, tempDir));
		await sleep(300);
		const before = cap.sentMessages.length;
		// A phase that ends on a 502-looking failure must be retried, not treated
		// as a completed REPRODUCE.
		await cap.events.get("agent_end")!(
			{ messages: [{ role: "assistant", content: "upstream error 502 bad gateway", stopReason: "stop" }] },
			makeCtx(cap, tempDir),
		);
		await sleep(700);
		expect(cap.notifications.join("\n")).toContain("Transient provider error");
		expect(cap.sentMessages.length).toBe(before + 1);
		expect(cap.sentMessages[before]).toContain("REPRODUCE agent");
	});

	it("/build runs EXPLORE → … → BUILD-VERIFY and reports honestly", async () => {
		await cap.commands.get("build")!("a REST API for user auth with JWT", makeCtx(cap, tempDir));
		await sleep(300);
		expect(cap.sentMessages[0]).toContain("EXPLORE agent");

		await finishPhase({ handoff: "mapped repo" }); // EXPLORE → PLAN
		expect(cap.sentMessages[1]).toContain("PLAN agent");
		await finishPhase({ handoff: "task list" }); // PLAN → CODE
		expect(cap.sentMessages[2]).toContain("CODE agent");
		await finishPhase({ handoff: "implemented" }); // CODE → BUILD-VERIFY
		expect(cap.sentMessages[3]).toContain("BUILD-VERIFY agent");

		await finishPhase({ verdict: "PASS", handoff: "runs, acceptance met" }); // BUILD-VERIFY → done
		expect(cap.notifications.join("\n")).toContain("build summary");
	});

	it("/fix finishes GREEN at single-shot cost when the oracle passes (real local run)", async () => {
		// The repro command is runnable in the temp dir on the LOCAL sandbox
		// backend — the driver-level oracle actually executes it.
		await cap.commands.get("fix")!(`node -e "process.exit(0)"`, makeCtx(cap, tempDir));
		await sleep(300);
		expect(cap.sentMessages[0]).toContain("single shot");
		const before = cap.sentMessages.length;

		await finishPhase({ verdict: "PASS", handoff: "patched" }); // single shot done → oracle runs
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("/fix oracle");
		expect(notes).toContain("finished GREEN at single-shot cost");
		expect(cap.sentMessages.length).toBe(before); // no escalation phases sent
	});

	it("/fix escalates to the full /debug pipeline when the oracle stays red (real local run)", async () => {
		await cap.commands.get("fix")!(`node -e "process.exit(3)"`, makeCtx(cap, tempDir));
		await sleep(300);
		const before = cap.sentMessages.length;

		await finishPhase({ verdict: "PASS", handoff: "patched (wrongly)" }); // oracle: exit 3 → red → escalate
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("/fix escalating");
		expect(notes).toContain("exit 3");
		// REPRODUCE is SKIPPED (the oracle just ran the red reproduction):
		// LOCALIZE is dispatched directly, seeded with the red run's command.
		expect(cap.sentMessages.length).toBe(before + 1);
		expect(cap.sentMessages[before]).toContain("LOCALIZE agent");
		expect(cap.sentMessages[before]).toContain("process.exit(3)");

		// The inherited pipeline then completes normally.
		await finishPhase({ handoff: "fault found" }); // LOCALIZE → FIX
		expect(cap.sentMessages.at(-1)).toContain("FIX agent");
		await finishPhase({ handoff: "patched" }); // → VERIFY
		await finishPhase({ verdict: "PASS", handoff: "green" }); // → done (oracle must NOT re-run)
		expect(cap.notifications.join("\n")).toContain("/fix summary");
	});

	it("/fix uses the shot-declared REPRO-CMD as its oracle on prose input (red → escalates)", async () => {
		await cap.commands.get("fix")!("the widget renders wrong somehow", makeCtx(cap, tempDir));
		await sleep(300);
		const before = cap.sentMessages.length;
		// The single shot wrote its own reproduction and declared it — still red.
		await finishPhase({ verdict: "PASS", handoff: `patched\nREPRO-CMD: node -e "process.exit(5)"` });
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("Shot-declared reproduction registered");
		expect(notes).toContain("/fix escalating");
		expect(cap.sentMessages[before]).toContain("LOCALIZE agent");
	});

	it("/fix escalates when the shot made NO changes in a git repo (nothing to verify)", async () => {
		gitSetup(tempDir); // clean tree, real git repo
		await cap.commands.get("fix")!("the widget renders wrong somehow", makeCtx(cap, tempDir));
		await sleep(300);
		const before = cap.sentMessages.length;
		// The shot ends without editing anything and without declaring a repro.
		await finishPhase({ verdict: "PASS", handoff: "here is my analysis (no edits)" });
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("the single shot made NO changes");
		expect(cap.sentMessages[before]).toContain("REPRODUCE agent");
	});

	it("/fix reports UNVERIFIED honestly when nothing is runnable", async () => {
		await cap.commands.get("fix")!("the button label is wrong somewhere", makeCtx(cap, tempDir));
		await sleep(300);
		await finishPhase({ verdict: "PASS", handoff: "changed the label" });
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("UNVERIFIED");
		expect(notes).not.toContain("finished GREEN");
	});

	// ─── Multi-candidate: diversity proposes, a REAL run disposes ───────
	function gitSetup(dir: string) {
		const g = (a: string) => execSync(`git ${a}`, { cwd: dir, stdio: "pipe" });
		g("init -q");
		g("config user.email t@t.t");
		g("config user.name t");
		writeFileSync(join(dir, "app.js"), `module.exports = () => "bug";\n`);
		writeFileSync(join(dir, "check.js"), `process.exit(require("./app.js")() === "ok" ? 0 : 1);\n`);
		g("add -A");
		g("commit -qm init");
	}

	it("/debug --candidates 2 arbitrates with real runs and applies the minimal passing candidate", async () => {
		gitSetup(tempDir);
		await cap.commands.get("debug")!("--candidates 2 node check.js", makeCtx(cap, tempDir));
		await sleep(300);
		expect(cap.notifications.join("\n")).toContain("multi-candidate ×2");

		await finishPhase({ verdict: "PASS", handoff: "REPRO-CMD: node check.js" }); // REPRODUCE
		await finishPhase({ handoff: "fault in app.js" }); // LOCALIZE → FIX candidate 1

		// Candidate 1: WRONG and bigger (still returns non-"ok", extra noise line).
		writeFileSync(join(tempDir, "app.js"), `// noise\n// more noise\nmodule.exports = () => "wrong";\n`);
		await finishPhase({ handoff: "candidate 1 done" });
		// Tree was reset for candidate 2 — the wrong edit must be gone.
		expect(readFileSync(join(tempDir, "app.js"), "utf-8")).toContain(`"bug"`);

		// Candidate 2: CORRECT and minimal.
		writeFileSync(join(tempDir, "app.js"), `module.exports = () => "ok";\n`);
		await finishPhase({ handoff: "candidate 2 done" }); // queue empty → arbitration runs real `node check.js`

		const notes = cap.notifications.join("\n");
		expect(notes).toContain("Arbitrating 2 candidate(s)");
		expect(notes).toContain("FIXED by candidate arbitration");
		// The winning (correct) patch is left applied on disk.
		expect(readFileSync(join(tempDir, "app.js"), "utf-8")).toContain(`"ok"`);
	}, 60000);

	it("/debug --candidates 2 leaves an UNVERIFIED draft when no candidate passes (never a blank page)", async () => {
		gitSetup(tempDir);
		await cap.commands.get("debug")!("--candidates 2 node check.js", makeCtx(cap, tempDir));
		await sleep(300);
		await finishPhase({ verdict: "PASS", handoff: "REPRO-CMD: node check.js" });
		await finishPhase({ handoff: "fault in app.js" });

		writeFileSync(join(tempDir, "app.js"), `// try 1\nmodule.exports = () => "nope1";\n`);
		await finishPhase({ handoff: "c1" });
		writeFileSync(join(tempDir, "app.js"), `module.exports = () => "nope2";\n`);
		await finishPhase({ handoff: "c2" }); // arbitration: both red

		const notes = cap.notifications.join("\n");
		expect(notes).toContain("no candidate passed arbitration");
		expect(notes).toContain("UNVERIFIED draft");
		// The smallest candidate remains on disk as an honest draft.
		expect(readFileSync(join(tempDir, "app.js"), "utf-8")).toContain("nope2");
	}, 60000);

	it("/debug --candidates falls back to single-candidate over a dirty tree (non-deletion policy)", async () => {
		gitSetup(tempDir);
		writeFileSync(join(tempDir, "uncommitted.txt"), "user work in progress");
		await cap.commands.get("debug")!("--candidates 3 node check.js", makeCtx(cap, tempDir));
		await sleep(300);
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("uncommitted changes");
		expect(notes).not.toContain("multi-candidate ×3");
		// The user's file is untouched.
		expect(readFileSync(join(tempDir, "uncommitted.txt"), "utf-8")).toContain("user work");
	});

	it("writes one telemetry line per run to .phi/runs.jsonl", async () => {
		await cap.commands.get("debug")!("pytest tests/test_x.py::test_y", makeCtx(cap, tempDir));
		await sleep(300);
		await finishPhase({ verdict: "PASS", handoff: "reproduced" });
		await finishPhase({ handoff: "localized" });
		await finishPhase({ handoff: "patched" });
		await finishPhase({ verdict: "PASS", handoff: "green" }); // → finished

		const lines = readFileSync(join(tempDir, ".phi", "runs.jsonl"), "utf-8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(1);
		const rec = JSON.parse(lines[0]);
		expect(rec.mode).toBe("debug");
		expect(rec.phases.map((p: { key: string }) => p.key)).toEqual(["reproduce", "localize", "fix", "verify"]);
		expect(rec.completedPhases).toBe(4);
		expect(rec.durationMs).toBeGreaterThan(0);
		expect(rec.outcome).toContain("finished");
	});

	it("/debug never opens /plan's review-fix cycle", async () => {
		await cap.commands.get("debug")!("node repro.js", makeCtx(cap, tempDir));
		await sleep(300);
		await finishPhase({ verdict: "PASS" }); // REPRODUCE
		await finishPhase(); // LOCALIZE
		await finishPhase(); // FIX
		await finishPhase({ verdict: "FAIL", blocking: "- x:1 still broken" }); // VERIFY FAIL — must NOT spawn a re-review
		const notes = cap.notifications.join("\n");
		expect(notes).not.toContain("re-review cycle");
		expect(notes).not.toContain("REVIEW found BLOCKING");
	});
});
