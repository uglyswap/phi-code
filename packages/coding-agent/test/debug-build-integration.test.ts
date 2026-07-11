import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

	it("/debug halts honestly when REPRODUCE reports BLOCKED (no fabricated fix)", async () => {
		await cap.commands.get("debug")!("pytest tests/test_x.py::test_y", makeCtx(cap, tempDir));
		await sleep(300);
		const before = cap.sentMessages.length;

		await finishPhase({ verdict: "BLOCKED", handoff: "cannot reproduce — passes on current code" });
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("BLOCKED");
		expect(notes).toContain("stopped: BLOCKED");
		// No LOCALIZE/FIX/VERIFY were sent after the halt.
		expect(cap.sentMessages.length).toBe(before);
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
