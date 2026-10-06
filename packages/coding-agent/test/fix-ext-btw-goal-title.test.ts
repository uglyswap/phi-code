import { describe, expect, it, vi } from "vitest";
import { sessionToMessages } from "../extensions/phi/btw/btw.ts";
import goalExtension, {
	buildGoalSystemPrompt,
	DEFAULT_MAX_ITERATIONS,
	iterationLimitReached,
	parseCommand,
	resolveMaxIterations,
} from "../extensions/phi/goal/index.ts";
import { cleanWords, deriveBranchSlug, deriveTitle } from "../extensions/phi/productivity.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function textOf(message: { content: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	return (content as Array<{ type: string; text?: string }>)
		.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
		.join("");
}

describe("fix-ext: /btw uses the compacted session context", () => {
	it("drops pre-compaction messages and includes the compaction summary", () => {
		const sm = SessionManager.inMemory("/tmp");
		sm.appendMessage({ role: "user", content: "OLD question before compaction", timestamp: 1 });
		const keptId = sm.appendMessage({ role: "user", content: "kept question", timestamp: 2 });
		sm.appendCompaction("SUMMARY of the old conversation", keptId, 1000);
		sm.appendMessage({ role: "user", content: "new question after compaction", timestamp: 3 });

		const texts = sessionToMessages(sm).map(textOf).join("\n");
		expect(texts).not.toContain("OLD question before compaction");
		expect(texts).toContain("SUMMARY of the old conversation");
		expect(texts).toContain("kept question");
		expect(texts).toContain("new question after compaction");
	});
});

describe("fix-ext: /goal prompt cache and iteration bound", () => {
	const baseGoal = {
		id: "g1",
		text: "ship it",
		status: "active" as const,
		startedAt: 0,
		updatedAt: 0,
		iteration: 3,
		tokenBudget: 100_000,
		tokensUsed: 10_000,
		timeUsedSeconds: 0,
		baselineTokens: 0,
	};

	it("the goal system prompt does not change when token usage changes", () => {
		const before = buildGoalSystemPrompt(baseGoal);
		const after = buildGoalSystemPrompt({ ...baseGoal, tokensUsed: 55_000, iteration: 9 });
		expect(after).toBe(before);
		expect(before).toContain("100k");
	});

	it("parses --max-iterations alongside --tokens, in any order", () => {
		expect(parseCommand("--max-iterations 7 --tokens 10k do the thing")).toEqual({
			kind: "start",
			objective: "do the thing",
			tokenBudget: 10_000,
			maxIterations: 7,
		});
		expect(parseCommand("--tokens 10k --max-iterations 7 x")).toMatchObject({
			tokenBudget: 10_000,
			maxIterations: 7,
		});
		expect(parseCommand("--max-iterations abc x")).toBe("Invalid iteration limit: abc");
	});

	it("bounds goals without a token budget by default (env-configurable, 0 = unlimited)", () => {
		const noBudget = { tokenBudget: undefined, maxIterations: undefined };
		expect(resolveMaxIterations(noBudget, {})).toBe(DEFAULT_MAX_ITERATIONS);
		expect(resolveMaxIterations(noBudget, { PHI_GOAL_MAX_ITERATIONS: "5" })).toBe(5);
		expect(resolveMaxIterations(noBudget, { PHI_GOAL_MAX_ITERATIONS: "0" })).toBeUndefined();
		expect(resolveMaxIterations({ tokenBudget: 1000, maxIterations: undefined }, {})).toBeUndefined();
		expect(resolveMaxIterations({ tokenBudget: 1000, maxIterations: 4 }, {})).toBe(4);
		expect(
			iterationLimitReached({ tokenBudget: undefined, maxIterations: 3, iteration: 5, iterationBase: 2 }, {}),
		).toBe(true);
		expect(
			iterationLimitReached({ tokenBudget: undefined, maxIterations: 3, iteration: 4, iterationBase: 2 }, {}),
		).toBe(false);
	});

	it("pauses the goal loop once the iteration limit is reached", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const sendUserMessage = vi.fn();
		const pi = {
			registerTool: vi.fn(),
			registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
				commands.set(name, command),
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
			sendUserMessage,
			appendEntry: vi.fn(),
		};
		goalExtension(pi as never);
		const notify = vi.fn();
		const ctx = {
			cwd: process.cwd(),
			ui: { confirm: async () => true, notify, setStatus: vi.fn() },
			isIdle: () => true,
			hasPendingMessages: () => false,
			sessionManager: { getBranch: () => [] },
		};

		await commands.get("goal")?.handler("--max-iterations 2 finish the task", ctx);
		expect(sendUserMessage).toHaveBeenCalledTimes(1);

		const agentEnd = handlers.get("agent_end");
		const beforeAgentStart = handlers.get("before_agent_start");
		const event = { messages: [{ role: "assistant", stopReason: "stop" }] };
		// Each run starts with the prompt that was just sent (as the session does).
		const startRun = () =>
			beforeAgentStart?.({ prompt: String(sendUserMessage.mock.lastCall?.[0] ?? ""), systemPrompt: "base" }, ctx);
		startRun();
		await agentEnd?.(event, ctx); // run 1: continuation sent
		expect(sendUserMessage).toHaveBeenCalledTimes(2);
		startRun();
		await agentEnd?.(event, ctx); // run 2: limit reached, no continuation
		expect(sendUserMessage).toHaveBeenCalledTimes(2);
		expect(notify.mock.calls.some(([message]) => String(message).includes("iteration limit 2"))).toBe(true);

		await commands.get("goal")?.handler("clear", ctx);
	});
});

describe("fix-ext: /title keeps accents", () => {
	it("keeps accented words in the title and folds them in the branch slug", () => {
		const words = cleanWords("Régler les préférences d'été `code` ```\nblock\n```");
		expect(words).toEqual(["Régler", "les", "préférences", "d", "été"]);
		expect(deriveTitle(words)).toBe("Régler les préférences d été");
		expect(deriveBranchSlug(words)).toBe("regler-les-preferences-d-ete");
	});

	it("treats a decomposed accent (NFD input) as part of the word", () => {
		expect(cleanWords("préférences")).toEqual(["préférences"]);
	});
});
