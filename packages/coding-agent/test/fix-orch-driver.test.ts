import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as phiCode from "phi-code";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import orchestratorExtension from "../extensions/phi/orchestrator.ts";
import { isGreenOutcome } from "../extensions/phi/providers/telemetry.ts";

/**
 * FIX-ORCH regressions for the /debug /build /fix generic driver: honest final
 * verdicts (FAIL / missing VERIFY verdict are not "finished" green), prompt
 * composition for phase agents, forced tools, async oracle, --parallel
 * parsing and the announced /fix shot budget.
 */

interface Captured {
	commands: Map<string, (args: string, ctx: any) => Promise<void> | void>;
	tools: Map<string, { execute: (id: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any> }>;
	events: Map<string, (event: any, ctx: any) => Promise<any> | any>;
	sentMessages: string[];
	notifications: string[];
	activeToolSets: string[][];
}

function makeFakePi(cap: Captured) {
	return {
		registerCommand: (name: string, def: { handler: (args: string, ctx: any) => Promise<void> | void }) => {
			cap.commands.set(name, def.handler);
		},
		registerTool: (def: any) => {
			cap.tools.set(def.name, def);
		},
		on: (event: string, handler: (event: any, ctx: any) => Promise<any> | any) => {
			cap.events.set(event, handler);
		},
		getActiveTools: () => ["read", "write", "edit", "bash"],
		setActiveTools: (tools: string[]) => {
			cap.activeToolSets.push([...tools]);
		},
		setModel: async () => true,
		sendUserMessage: (text: string) => {
			cap.sentMessages.push(text);
		},
		events: { emit: () => {}, on: () => () => {} },
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

describe("FIX-ORCH: generic driver", () => {
	let tempDir: string;
	let prevCwd: string;
	let cap: Captured;

	beforeEach(() => {
		prevCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "fix-orch-"));
		mkdirSync(join(tempDir, ".phi", "plans"), { recursive: true });
		process.chdir(tempDir);
		cap = {
			commands: new Map(),
			tools: new Map(),
			events: new Map(),
			sentMessages: [],
			notifications: [],
			activeToolSets: [],
		};
		orchestratorExtension(makeFakePi(cap));
	});
	afterEach(() => {
		process.chdir(prevCwd);
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function finishPhase(structured?: { verdict?: string; handoff?: string }) {
		if (structured) {
			await cap.tools.get("phase_result")!.execute("c", structured, undefined, undefined, makeCtx(cap, tempDir));
		}
		await cap.events.get("agent_end")!({ messages: phaseMessages() }, makeCtx(cap, tempDir));
		await sleep(700);
	}

	async function runDebugTo(verifyResult: { verdict?: string; handoff?: string } | undefined) {
		await cap.commands.get("debug")!("pytest tests/test_x.py::test_y", makeCtx(cap, tempDir));
		await sleep(300);
		await finishPhase({ verdict: "PASS", handoff: "reproduced" }); // REPRODUCE
		await finishPhase({ handoff: "fault at x.py:1" }); // LOCALIZE
		await finishPhase({ handoff: "patched" }); // FIX
		expect(cap.sentMessages.at(-1)).toContain("VERIFY agent");
		await finishPhase(verifyResult); // VERIFY -> end of queue
	}

	function lastRunOutcome(): string {
		const lines = readFileSync(join(tempDir, ".phi", "runs.jsonl"), "utf-8")
			.trim()
			.split("\n");
		return JSON.parse(lines.at(-1)!).outcome as string;
	}

	it("a VERIFY FAIL ends as 'finished with FAIL', never as a green finish", async () => {
		await runDebugTo({ verdict: "FAIL", handoff: "repro still red" });
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("finished with FAIL");
		expect(notes).not.toContain("✅ **/debug finished.**");
		expect(isGreenOutcome(lastRunOutcome())).toBe(false);
	});

	it("a VERIFY phase without any verdict ends UNVERIFIED", async () => {
		await runDebugTo(undefined);
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("finished UNVERIFIED");
		expect(isGreenOutcome(lastRunOutcome())).toBe(false);
	});

	it("a VERIFY PASS is still a green finish", async () => {
		await runDebugTo({ verdict: "PASS", handoff: "green" });
		expect(cap.notifications.join("\n")).toContain("✅ **/debug finished.**");
		expect(isGreenOutcome(lastRunOutcome())).toBe(true);
	});

	it("phase agents keep the base system prompt (persona composed, not replacing it)", async () => {
		await cap.commands.get("debug")!("pytest tests/test_x.py::test_y", makeCtx(cap, tempDir));
		await sleep(300);
		const result = await cap.events.get("before_agent_start")!(
			{ type: "before_agent_start", prompt: "x", systemPrompt: "BASE PROMPT with AGENTS.md and skills" },
			makeCtx(cap, tempDir),
		);
		expect(result.systemPrompt).toContain("BASE PROMPT with AGENTS.md and skills");
		// The bundled test agent persona is appended after the base prompt.
		expect(result.systemPrompt.indexOf("BASE PROMPT")).toBe(0);
		expect(result.systemPrompt.length).toBeGreaterThan("BASE PROMPT with AGENTS.md and skills".length + 50);
	});

	it("phase tool allowlists include ontology_batch_add and lsp", async () => {
		await cap.commands.get("debug")!("pytest tests/test_x.py::test_y", makeCtx(cap, tempDir));
		await sleep(300);
		const restricted = cap.activeToolSets.find((set) => set.includes("phase_result"));
		expect(restricted).toBeDefined();
		expect(restricted).toContain("ontology_batch_add");
		expect(restricted).toContain("lsp");
	});

	it("the /fix oracle runs asynchronously: timers fire while it runs", async () => {
		await cap.commands.get("fix")!(`node -e "setTimeout(() => process.exit(0), 1500)"`, makeCtx(cap, tempDir));
		await sleep(300);
		await cap.tools
			.get("phase_result")!
			.execute("c", { verdict: "PASS", handoff: "patched" }, undefined, undefined, makeCtx(cap, tempDir));
		let timerFired = false;
		const t = setTimeout(() => {
			timerFired = true;
		}, 300);
		// agent_end awaits the oracle; with a sync spawn the timer could only fire
		// AFTER the handler returned (and after this check).
		await cap.events.get("agent_end")!({ messages: phaseMessages() }, makeCtx(cap, tempDir));
		const firedDuringOracle = timerFired;
		clearTimeout(t);
		expect(cap.notifications.join("\n")).toContain("finished GREEN at single-shot cost");
		expect(firedDuringOracle).toBe(true);
	}, 30_000);

	it("announces the /fix shot budget that actually applies (25 min)", async () => {
		await cap.commands.get("fix")!("pytest tests/test_x.py::test_y", makeCtx(cap, tempDir));
		const budget = cap.notifications.find((n) => n.includes("Shot budget"));
		expect(budget).toContain("25 min");
	});

	it("--parallel is recognized anywhere in the arguments and stripped from the failing state", async () => {
		// Not a git repo: --candidates falls back to 1, but --parallel must still
		// be parsed and removed from what REPRODUCE receives.
		await cap.commands.get("debug")!("node check.js --parallel", makeCtx(cap, tempDir));
		await sleep(300);
		expect(cap.sentMessages[0]).toContain("node check.js");
		expect(cap.sentMessages[0]).not.toContain("--parallel");
	});

	it.skipIf(typeof (phiCode as unknown as { isDestructiveCommand?: unknown }).isDestructiveCommand !== "function")(
		"sandbox_run applies the bash destructive-command gate during orchestration (local backend)",
		async () => {
			await cap.commands.get("debug")!("pytest tests/test_x.py::test_y", makeCtx(cap, tempDir));
			await sleep(300);
			const r = await cap.tools
				.get("sandbox_run")!
				.execute("c", { command: "git push --force origin main" }, undefined, undefined, makeCtx(cap, tempDir));
			// The gate only covers host runs (local backend).
			if (r.details?.backend !== undefined && r.details.backend !== "local") return;
			expect(r.details.verdict).toBe("BLOCKED_BY_GUARD");
			expect(r.isError).toBe(true);
		},
	);
});
