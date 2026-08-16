import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import orchestratorExtension from "../extensions/phi/orchestrator.ts";

/**
 * End-to-end integration test of the /plan orchestrator.
 *
 * It loads the REAL orchestrator extension against a simulated Pi runtime and
 * drives a full multi-phase run — proving the whole chain works together
 * (command → phase send → agent_end → structured phase_result resolution →
 * next phase → handoff propagation → review-fix cycle → completion), not just
 * the pure decision function. Deterministic: phase outcomes are scripted, so it
 * runs in CI without a live model.
 */

type Notify = (msg: string, level?: string) => void;

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
	const notify: Notify = (msg) => cap.notifications.push(msg);
	return {
		ui: { notify },
		modelRegistry: { getAvailable: () => [{ id: "default", provider: "test" }] },
		model: { id: "default", provider: "test" },
		cwd,
		abort: () => {},
		getContextUsage: () => undefined,
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A realistic phase message list: memory tools + a write, so analysis is clean.
function phaseMessages(): unknown[] {
	return [
		{ role: "assistant", content: "working", stopReason: "stop" },
		{ role: "toolResult", name: "memory_search", content: "no prior context" },
		{ role: "toolResult", name: "write", content: "Successfully wrote 200 bytes to out.ts" },
		{ role: "toolResult", name: "memory_write", content: "saved" },
	];
}

describe("orchestrator /plan integration", () => {
	let tempDir: string;
	let prevCwd: string;
	let cap: Captured;

	beforeEach(() => {
		prevCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "orch-int-"));
		mkdirSync(join(tempDir, ".phi", "plans"), { recursive: true });
		// plansDir is captured from process.cwd() at extension init.
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

	async function startPlan() {
		const handler = cap.commands.get("plan")!;
		await handler("Build a small TODO CLI", makeCtx(cap, tempDir));
		await sleep(300); // first-phase send is behind a 200ms timer + async model switch
	}

	// Emit a finished phase: optionally set a structured phase_result, then fire agent_end.
	async function finishPhase(structured?: { verdict?: string; blocking?: string; handoff?: string }) {
		if (structured) {
			const tool = cap.tools.get("phase_result")!;
			await tool.execute("call-1", structured, undefined, undefined, makeCtx(cap, tempDir));
		}
		const agentEnd = cap.events.get("agent_end")!;
		await agentEnd({ messages: phaseMessages() }, makeCtx(cap, tempDir));
		await sleep(700); // next-phase send is behind a 500ms timer + async model switch
	}

	it("registers /plan and the phase_result tool", () => {
		expect(cap.commands.has("plan")).toBe(true);
		expect(cap.tools.has("phase_result")).toBe(true);
		expect(cap.events.has("agent_end")).toBe(true);
	});

	it("runs all five phases and propagates each structured handoff to the next", async () => {
		await startPlan();
		// Phase 1 (EXPLORE) instruction was sent.
		expect(cap.sentMessages.length).toBe(1);
		expect(cap.sentMessages[0]).toContain("EXPLORE agent");

		// EXPLORE finishes with a structured handoff → PLAN starts and sees it.
		await finishPhase({ handoff: "State: mapped the repo\nNext: design the CLI" });
		expect(cap.sentMessages.length).toBe(2);
		expect(cap.sentMessages[1]).toContain("PLAN agent");
		expect(cap.sentMessages[1]).toContain("design the CLI"); // handoff propagated

		// PLAN → CODE
		await finishPhase({ handoff: "State: task list ready\nNext: implement commands" });
		expect(cap.sentMessages[2]).toContain("CODE agent");
		expect(cap.sentMessages[2]).toContain("implement commands");

		// CODE → TEST
		await finishPhase({ handoff: "State: implemented add/list/done\nNext: run the tests" });
		expect(cap.sentMessages[3]).toContain("TEST agent");
		expect(cap.sentMessages[3]).toContain("run the tests");

		// TEST (PASS) → REVIEW
		await finishPhase({ verdict: "PASS", handoff: "State: all green\nNext: final review" });
		expect(cap.sentMessages[4]).toContain("REVIEW agent");
		expect(cap.sentMessages[4]).toContain("final review");

		// REVIEW (PASS) → completion
		await finishPhase({ verdict: "PASS", handoff: "State: shipped" });
		const summary = cap.notifications.join("\n");
		expect(summary).toContain("Orchestration Summary");
		expect(summary).toMatch(/5\/5/);
	});

	it("opens exactly one fix + re-review cycle on a structured REVIEW FAIL", async () => {
		await startPlan();
		await finishPhase({ handoff: "explore done" }); // EXPLORE → PLAN
		await finishPhase({ handoff: "plan done" }); // PLAN → CODE
		await finishPhase({ handoff: "code done" }); // CODE → TEST
		await finishPhase({ verdict: "PASS", handoff: "tests pass" }); // TEST → REVIEW
		const before = cap.sentMessages.length;

		// REVIEW returns FAIL with blocking findings → fix + re-review get queued.
		await finishPhase({ verdict: "FAIL", blocking: "- out.ts:5 unhandled null" });
		const fixMsg = cap.sentMessages[before];
		expect(fixMsg).toContain("REVIEW found BLOCKING");
		expect(fixMsg).toContain("unhandled null"); // structured blocking propagated into the fix instruction

		await finishPhase(); // fix (CODE) done → re-review sent
		expect(cap.sentMessages[before + 1]).toContain("REVIEW agent");

		// Re-review PASS → completion; only ONE cycle happened.
		await finishPhase({ verdict: "PASS", handoff: "clean now" });
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("one targeted fix + re-review cycle");
		expect(notes).toContain("Orchestration Summary");
	});

	it("pauses the run on a structured BLOCKED verdict", async () => {
		await startPlan();
		await finishPhase({ handoff: "explore done" }); // → PLAN
		const before = cap.sentMessages.length;

		await finishPhase({ verdict: "BLOCKED", handoff: "cannot proceed: missing API key" });
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("BLOCKED");
		expect(notes).toContain("Pausing /plan");
		// No further phase was sent after the pause.
		expect(cap.sentMessages.length).toBe(before);
	});

	it("does not leak a structured result from one run into the next (F1)", async () => {
		// Run 1 ends in BLOCKED at the PLAN phase (a stale verdict that must NOT
		// carry over). Same extension instance / closure across both runs.
		await startPlan();
		await finishPhase({ handoff: "explore done" }); // EXPLORE → PLAN
		await finishPhase({ verdict: "BLOCKED", handoff: "blocked run 1" }); // PLAN BLOCKED → pause
		expect(cap.notifications.join("\n")).toContain("Pausing /plan");

		// Run 2: EXPLORE never calls phase_result. If the stale BLOCKED leaked,
		// the run would abort at EXPLORE. It must proceed to PLAN instead.
		const sentBefore = cap.sentMessages.length;
		await startPlan();
		expect(cap.sentMessages[sentBefore]).toContain("EXPLORE agent");
		await finishPhase(); // EXPLORE finishes with NO structured result
		expect(cap.sentMessages[sentBefore + 1]).toContain("PLAN agent"); // advanced, not aborted
	});

	it("merges structured fields across multiple phase_result calls in one phase (F2)", async () => {
		await startPlan();
		await finishPhase({ handoff: "explore done" }); // → PLAN
		await finishPhase({ handoff: "plan done" }); // → CODE
		await finishPhase({ handoff: "code done" }); // → TEST
		await finishPhase({ verdict: "PASS", handoff: "tests pass" }); // → REVIEW
		const before = cap.sentMessages.length;

		// REVIEW emits its result across TWO calls: verdict first, then handoff.
		// The second call must not erase the FAIL verdict → fix cycle still fires.
		const tool = cap.tools.get("phase_result")!;
		await tool.execute(
			"c1",
			{ verdict: "FAIL", blocking: "- x.ts:1 bug" },
			undefined,
			undefined,
			makeCtx(cap, tempDir),
		);
		await tool.execute("c2", { handoff: "needs a fix" }, undefined, undefined, makeCtx(cap, tempDir));
		const agentEnd = cap.events.get("agent_end")!;
		await agentEnd({ messages: phaseMessages() }, makeCtx(cap, tempDir));
		await sleep(700);

		expect(cap.sentMessages[before]).toContain("REVIEW found BLOCKING");
		expect(cap.sentMessages[before]).toContain("x.ts:1 bug");
	});

	it("phase_result is a no-op outside orchestration", async () => {
		// A fresh extension with no active /plan run.
		const cap2: Captured = {
			commands: new Map(),
			tools: new Map(),
			events: new Map(),
			sentMessages: [],
			setModelCalls: [],
			notifications: [],
		};
		orchestratorExtension(makeFakePi(cap2));
		const tool = cap2.tools.get("phase_result")!;
		const res = await tool.execute("x", { verdict: "PASS" }, undefined, undefined, makeCtx(cap2, tempDir));
		expect(JSON.stringify(res)).toContain("only used during /plan");
	});
});
