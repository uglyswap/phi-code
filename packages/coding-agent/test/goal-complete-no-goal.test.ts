/**
 * goal_complete without an active /goal must not end the run: it used to answer
 * "unknown goal" with terminate: true, so a model that "concluded" with this tool
 * stopped the run without a final answer. It now reports a tool error instead.
 */
import { describe, expect, it, vi } from "vitest";
import goalExtension from "../extensions/phi/goal/index.ts";

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: unknown;
	isError?: boolean;
	terminate?: boolean;
}
type Execute = (
	id: string,
	params: { summary: string },
	signal: undefined,
	onUpdate: undefined,
	ctx: unknown,
) => Promise<ToolResult>;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

function load() {
	let execute: Execute | undefined;
	const commands = new Map<string, { handler: CommandHandler }>();
	const appendEntry = vi.fn();
	const pi = {
		registerTool: (tool: { name: string; execute: Execute }) => {
			if (tool.name === "goal_complete") execute = tool.execute;
		},
		registerCommand: (name: string, options: { handler: CommandHandler }) => commands.set(name, options),
		on: vi.fn(),
		sendUserMessage: vi.fn(),
		appendEntry,
	};
	goalExtension(pi as never);
	if (!execute) throw new Error("goal_complete is not registered");
	return { execute, commands, appendEntry };
}

function context() {
	return {
		cwd: process.cwd(),
		ui: { confirm: async () => true, notify: vi.fn(), setStatus: vi.fn() },
		isIdle: () => true,
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => [] },
	};
}

describe("goal_complete", () => {
	it("without an active goal, reports an error and does not end the run", async () => {
		const { execute } = load();
		const result = await execute("call-1", { summary: "done" }, undefined, undefined, context());
		expect(result.isError).toBe(true);
		expect(result.terminate).toBeUndefined();
		expect(result.content[0]?.text).toBe(
			"No /goal is active: there is nothing to complete. Finish your answer normally.",
		);
	});

	it("with an active goal, completes it and ends the run as before", async () => {
		const { execute, commands, appendEntry } = load();
		const ctx = context();
		await commands.get("goal")?.handler("ship the release", ctx);
		const result = await execute("call-2", { summary: "released" }, undefined, undefined, ctx);
		expect(result.isError).toBeUndefined();
		expect(result.terminate).toBe(true);
		expect(result.content[0]?.text).toBe("Goal complete: released");
		expect(appendEntry).toHaveBeenCalledWith("goal-state", {
			goal: expect.objectContaining({ text: "ship the release", status: "complete" }),
		});
	});
});
