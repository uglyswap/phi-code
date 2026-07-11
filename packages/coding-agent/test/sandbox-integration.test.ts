import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import orchestratorExtension from "../extensions/phi/orchestrator.js";

/**
 * Integration of the sandbox wiring — the `sandbox_run` tool and the `/sandbox`
 * command — against a simulated Pi runtime. The tool run uses the LOCAL backend
 * (an empty project has nothing to containerize) so it executes a real, fast,
 * deterministic command without needing Docker in CI.
 */

interface Captured {
	commands: Map<string, (args: string, ctx: any) => Promise<void> | void>;
	tools: Map<string, { execute: (id: string, params: any, signal: any, onUpdate: any, ctx: any) => Promise<any> }>;
	events: Map<string, (event: any, ctx: any) => Promise<void> | void>;
	notifications: string[];
}

function makeFakePi(cap: Captured) {
	return {
		registerCommand: (name: string, def: { handler: (a: string, c: any) => any }) =>
			cap.commands.set(name, def.handler),
		registerTool: (def: any) => cap.tools.set(def.name, def),
		on: (event: string, handler: (e: any, c: any) => any) => cap.events.set(event, handler),
		getActiveTools: () => ["read", "write", "edit", "bash"],
		setActiveTools: () => {},
		setModel: async () => true,
		sendUserMessage: () => {},
		events: { emit: () => {} },
	} as any;
}

const ctxFor = (cap: Captured, cwd: string) => ({ ui: { notify: (m: string) => cap.notifications.push(m) }, cwd });

describe("sandbox wiring integration", () => {
	let tempDir: string;
	let cap: Captured;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "sbx-int-"));
		cap = { commands: new Map(), tools: new Map(), events: new Map(), notifications: [] };
		orchestratorExtension(makeFakePi(cap));
	});
	afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

	it("registers the sandbox_run tool and the /sandbox command", () => {
		expect(cap.tools.has("sandbox_run")).toBe(true);
		expect(cap.commands.has("sandbox")).toBe(true);
	});

	it("sandbox_run executes a real command and returns a structured, honest verdict", async () => {
		const tool = cap.tools.get("sandbox_run")!;
		const res = await tool.execute(
			"c1",
			{ command: `node -e "process.stdout.write('sandbox-tool-ok')"` },
			undefined,
			undefined,
			ctxFor(cap, tempDir),
		);
		expect(res.details.passed).toBe(true);
		expect(res.details.verdict).toBe("PASS");
		expect(res.details.exitCode).toBe(0);
		expect(JSON.stringify(res.content)).toContain("sandbox-tool-ok");
	});

	it("sandbox_run reports a non-zero exit as not-passing (no fabricated pass)", async () => {
		const tool = cap.tools.get("sandbox_run")!;
		const res = await tool.execute(
			"c2",
			{ command: `node -e "process.exit(5)"` },
			undefined,
			undefined,
			ctxFor(cap, tempDir),
		);
		expect(res.details.passed).toBe(false);
		expect(res.details.verdict).toBe("FAIL");
		expect(res.details.exitCode).toBe(5);
	});

	it("/sandbox status reports the detected recipe for a node project", async () => {
		writeFileSync(join(tempDir, "package.json"), JSON.stringify({ name: "x" }));
		await cap.commands.get("sandbox")!("status", ctxFor(cap, tempDir));
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("Sandbox status");
		expect(notes).toContain("node:20-slim");
		expect(notes).toMatch(/npm (ci|install)/);
	});

	it("/sandbox run executes a command and shows the exit verdict", async () => {
		await cap.commands.get("sandbox")!(`run node -e "process.stdout.write('ran-in-sandbox')"`, ctxFor(cap, tempDir));
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("ran-in-sandbox");
		expect(notes).toMatch(/PASS/);
	});

	it("/sandbox status warns honestly when there is a Dockerfile but reports the backend", async () => {
		mkdirSync(join(tempDir, ".phi"), { recursive: true });
		writeFileSync(join(tempDir, "requirements.txt"), "requests\n");
		await cap.commands.get("sandbox")!("status", ctxFor(cap, tempDir));
		const notes = cap.notifications.join("\n");
		expect(notes).toContain("python:3.12-slim");
		expect(notes).toMatch(/Backend: `(docker|local|unavailable)`/);
	});
});
