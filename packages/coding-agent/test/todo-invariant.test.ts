/**
 * C11.7 — todo invariant test suite (vitest port of run-todo-fix-tests.mjs).
 *
 * Loads the REAL bundled extension through the REAL loader (jiti in TS-source
 * mode, tsconfig paths), so module aliases resolve exactly like in production.
 *
 * The reducer captures a reference to Date.now at module-init time, so the
 * clock is frozen BEFORE discoverAndLoadExtensions runs. Patching it afterwards
 * would be a no-op.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";

const T0 = Date.parse("2026-10-07T12:00:00.000Z");
let NOW = T0;
const realDateNow = Date.now;
// Frozen before the extension module loads: state-reducer.ts captures
// `let clock = Date.now` at init, so this is the only point that has effect.
Date.now = () => NOW;

const testDir = dirname(fileURLToPath(import.meta.url));
const TODO_DIR = join(testDir, "..", "extensions", "phi", "todo");

interface TaskLike {
	id: number;
	subject: string;
	status: string;
	activeForm?: string;
	inProgressSince?: string;
}

interface DetailsLike {
	tasks: TaskLike[];
	nextId: number;
}

type Handler = (...args: unknown[]) => Promise<unknown>;

let tool: ToolDefinition;
let handlers: Map<string, Handler[]>;
let tempAgentDir: string;
let callId = 0;

beforeAll(async () => {
	process.env.PHI_DISABLE_BUNDLED_EXTENSIONS = "1";
	process.env.PHI_DISABLE_PROJECT_EXTENSIONS = "1";
	tempAgentDir = mkdtempSync(join(tmpdir(), "phi-todo-invariant-"));
	const loaded = await discoverAndLoadExtensions([TODO_DIR], process.cwd(), tempAgentDir);
	expect(loaded.errors).toEqual([]);
	const ext = loaded.extensions[0];
	expect(ext).toBeDefined();
	const registered = ext.tools.get("todo");
	expect(registered).toBeDefined();
	tool = registered?.definition as ToolDefinition;
	handlers = new Map<string, Handler[]>();
	for (const [name, list] of ext.handlers) handlers.set(name, list as Handler[]);
});

afterAll(() => {
	Date.now = realDateNow;
	rmSync(tempAgentDir, { recursive: true, force: true });
	delete process.env.PHI_DISABLE_BUNDLED_EXTENSIONS;
	delete process.env.PHI_DISABLE_PROJECT_EXTENSIONS;
});

async function call(params: Record<string, unknown>): Promise<{ details: DetailsLike; text: string }> {
	const res = await tool.execute(`c${++callId}`, params as never, undefined, undefined, {} as never);
	const text = res.content.map((c) => ("text" in c && typeof c.text === "string" ? c.text : "")).join("\n");
	return { details: res.details as DetailsLike, text };
}

const find = (d: DetailsLike, id: number): TaskLike | undefined => d.tasks.find((t) => t.id === id);
const stateOf = (d: DetailsLike): TaskLike[] => d.tasks;

/** Inject an arbitrary state through the production path: branch replay. */
async function inject(tasks: TaskLike[], nextId: number): Promise<void> {
	const branch = [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { action: "list", params: {}, tasks, nextId },
			},
		},
	];
	const ctx = { sessionManager: { getBranch: () => branch }, hasUI: false };
	for (const h of handlers.get("session_start") ?? []) await h({ type: "session_start" }, ctx as never);
}

async function fireAgentSettled(): Promise<void> {
	for (const h of handlers.get("agent_settled") ?? []) await h({ type: "agent_settled" });
}

async function fireBeforeAgentStart(systemPrompt = "BASE"): Promise<string | undefined> {
	let result: string | undefined;
	for (const h of handlers.get("before_agent_start") ?? []) {
		const r = (await h({ type: "before_agent_start", prompt: "", systemPrompt })) as
			| { systemPrompt?: string }
			| undefined;
		if (r?.systemPrompt) result = r.systemPrompt;
	}
	return result;
}

describe("todo invariant (C11.7)", () => {
	it("1. a second in_progress demotes the first, visibly", async () => {
		await call({ action: "clear" });
		await call({ action: "create", subject: "A" }); // #1
		await call({ action: "create", subject: "B" }); // #2
		await call({ action: "create", subject: "C" }); // #3
		await call({ action: "update", id: 1, status: "in_progress", activeForm: "doing A" });
		const r = await call({ action: "update", id: 3, status: "in_progress", activeForm: "doing C" });
		expect(find(r.details, 1)?.status).toBe("pending");
		expect(find(r.details, 3)?.status).toBe("in_progress");
		expect(stateOf(r.details).filter((t) => t.status === "in_progress")).toHaveLength(1);
		expect(r.text).toMatch(/#1 moved back to pending/);
	});

	it("2. two demotions in a row accumulate", async () => {
		await call({ action: "clear" });
		await call({ action: "create", subject: "A" });
		await call({ action: "create", subject: "B" });
		await call({ action: "create", subject: "C" });
		await call({ action: "update", id: 1, status: "in_progress" });
		const r2 = await call({ action: "update", id: 2, status: "in_progress" });
		expect(r2.text).toMatch(/#1 moved back/);
		const r3 = await call({ action: "update", id: 3, status: "in_progress" });
		expect(r3.text).toMatch(/#2 moved back/);
		expect(find(r3.details, 1)?.status).toBe("pending");
		expect(find(r3.details, 2)?.status).toBe("pending");
		expect(find(r3.details, 3)?.status).toBe("in_progress");
	});

	it("3. an activeForm-only refresh does NOT reset the clock", async () => {
		await call({ action: "clear" });
		await call({ action: "create", subject: "A" });
		const a = await call({ action: "update", id: 1, status: "in_progress", activeForm: "first" });
		const stamp1 = find(a.details, 1)?.inProgressSince;
		NOW += 5 * 60_000;
		const b = await call({ action: "update", id: 1, activeForm: "second" });
		const stamp2 = find(b.details, 1)?.inProgressSince;
		expect(stamp2).toBe(stamp1);
		expect(find(b.details, 1)?.activeForm).toBe("second");
	});

	it("4. leaving in_progress clears the timestamp", async () => {
		await call({ action: "clear" });
		await call({ action: "create", subject: "A" });
		await call({ action: "update", id: 1, status: "in_progress" });
		const r = await call({ action: "update", id: 1, status: "completed" });
		expect(find(r.details, 1)?.inProgressSince).toBeUndefined();
		expect(find(r.details, 1)?.status).toBe("completed");
	});

	it("5. re-entering in_progress stamps a new time", async () => {
		await call({ action: "clear" });
		await call({ action: "create", subject: "A" });
		const a = await call({ action: "update", id: 1, status: "in_progress" });
		const s1 = find(a.details, 1)?.inProgressSince;
		await call({ action: "update", id: 1, status: "pending" });
		NOW += 60_000;
		const b = await call({ action: "update", id: 1, status: "in_progress" });
		const s2 = find(b.details, 1)?.inProgressSince;
		expect(s2).toBeDefined();
		expect(s2).not.toBe(s1);
	});

	it("6. list warns when a legacy state violates the invariant", async () => {
		await inject(
			[
				{ id: 1, subject: "A", status: "in_progress", inProgressSince: new Date(NOW).toISOString() },
				{ id: 2, subject: "B", status: "in_progress", inProgressSince: new Date(NOW).toISOString() },
			],
			3,
		);
		const r = await call({ action: "list" });
		expect(r.text.startsWith("WARNING: 2 tasks are in_progress")).toBe(true);
	});

	it("7. list marks a 22-minute task as stale", async () => {
		await call({ action: "clear" });
		await call({ action: "create", subject: "A" });
		await call({ action: "update", id: 1, status: "in_progress" });
		NOW += 22 * 60_000;
		const r = await call({ action: "list" });
		expect(r.text).toMatch(/⚠ stale/);
	});

	it("8. list shows the age of a 3-minute task", async () => {
		await call({ action: "clear" });
		await call({ action: "create", subject: "A" });
		NOW = T0;
		await call({ action: "update", id: 1, status: "in_progress" });
		NOW = T0 + 3 * 60_000;
		const r = await call({ action: "list" });
		expect(r.text).toMatch(/⏳ 3m/);
	});

	it("9. agent_settled with a stale task arms a one-shot reminder", async () => {
		await call({ action: "clear" });
		await call({ action: "create", subject: "Stale task" });
		NOW = T0;
		await call({ action: "update", id: 1, status: "in_progress" });
		NOW = T0 + 30 * 60_000;
		await fireAgentSettled();
		const sp = await fireBeforeAgentStart("BASE");
		expect(typeof sp).toBe("string");
		expect(sp).toContain("[todo]");
		expect(sp).toContain("Stale task");
	});

	it("10. the reminder is consumed by the next turn only", async () => {
		const sp2 = await fireBeforeAgentStart("BASE");
		expect(sp2?.includes("[todo]") ?? false).toBe(false);
	});

	it("11. agent_settled with nothing open arms no reminder", async () => {
		await call({ action: "clear" });
		await call({ action: "create", subject: "Done" });
		await call({ action: "update", id: 1, status: "completed" });
		await fireAgentSettled();
		const sp = await fireBeforeAgentStart("BASE");
		expect(sp?.includes("[todo]") ?? false).toBe(false);
	});

	it("12. renderWidget does not mutate display state", () => {
		const src = readFileSync(join(TODO_DIR, "todo-overlay.ts"), "utf8");
		const renderBody = src.slice(src.indexOf("private renderWidget("));
		const nextMember = renderBody.indexOf("\n\tprivate ", 1);
		const body = nextMember > 0 ? renderBody.slice(0, nextMember) : renderBody;
		expect(body).not.toMatch(/completedTaskIdsPendingHide\.add/);
		expect(src).toMatch(/this\.markCompletedAsPendingHide\(visible\)/);
	});

	it("13. a replayed legacy task without a timestamp is stale", async () => {
		NOW = T0 + 60 * 60_000;
		await inject([{ id: 1, subject: "Legacy", status: "in_progress" }], 2);
		const r = await call({ action: "list" });
		expect(r.text).toMatch(/⚠ stale/);
	});

	it("14. the frozen clock makes timestamps deterministic", async () => {
		await call({ action: "clear" });
		await call({ action: "create", subject: "A" });
		NOW = T0 + 1234;
		const r = await call({ action: "update", id: 1, status: "in_progress" });
		expect(find(r.details, 1)?.inProgressSince).toBe(new Date(T0 + 1234).toISOString());
	});
});
