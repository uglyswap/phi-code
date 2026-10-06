import type { AgentMessage, StreamFn } from "phi-code-agent";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "phi-code-ai/compat";
import { describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	findCutPoint,
	generateBranchSummary,
	prepareCompaction,
	resolveSummaryUnion,
} from "../src/core/compaction/index.ts";
import { formatFileOperations, stripFileOperations } from "../src/core/compaction/utils.ts";
import type { SessionEntry, SessionMessageEntry } from "../src/core/session-manager.ts";

function usage(): Usage {
	return {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function model(maxTokens = 8192): Model<"anthropic-messages"> {
	return {
		id: "summary-model",
		name: "Summary Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens,
	};
}

function response(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "## Goal\nsummary" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "summary-model",
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

interface Call {
	context: Context;
	options: SimpleStreamOptions | undefined;
}

function stubStream(responses: AssistantMessage[]): { streamFn: StreamFn; calls: Call[] } {
	const calls: Call[] = [];
	const streamFn = (async (_model: Model<string>, context: Context, options?: SimpleStreamOptions) => {
		calls.push({ context, options });
		const next = responses.shift() ?? response({});
		return { result: async () => next };
	}) as unknown as StreamFn;
	return { streamFn, calls };
}

function promptText(call: Call): string {
	const content = call.context.messages[0]?.content;
	if (!Array.isArray(content)) return String(content);
	return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

let counter = 0;
function entry(message: AgentMessage, parentId: string | null = null): SessionMessageEntry {
	return { type: "message", id: `e-${counter++}`, parentId, timestamp: new Date().toISOString(), message };
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function preparation(overrides: Partial<CompactionPreparation> = {}): CompactionPreparation {
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: [user("old work")],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 1000,
		previousSummary: undefined,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: DEFAULT_COMPACTION_SETTINGS,
		...overrides,
	};
}

describe("fix-session: compaction", () => {
	// #9740
	it("keeps the tool call when trailing tool results alone exceed the retained budget", () => {
		const oldUser = entry(user("old history"));
		const oldAssistant = entry(response({ content: [{ type: "text", text: "old answer" }] }));
		const currentUser = entry(user("read the large file"));
		const toolCall = entry(
			response({
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "big.txt" } }],
				stopReason: "toolUse",
			}),
		);
		const toolResult = entry({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(8000) }],
			isError: false,
			timestamp: Date.now(),
		});
		const entries: SessionEntry[] = [oldUser, oldAssistant, currentUser, toolCall, toolResult];

		expect(findCutPoint(entries, 0, entries.length, 1000)).toEqual({
			firstKeptEntryIndex: 3,
			turnStartIndex: 2,
			isSplitTurn: true,
		});
		const prepared = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1000 });
		expect(prepared?.firstKeptEntryId).toBe(toolCall.id);
		expect(prepared?.messagesToSummarize).toEqual([oldUser.message, oldAssistant.message]);
		expect(prepared?.turnPrefixMessages).toEqual([currentUser.message]);
	});

	// #7048
	it("rejects a summary truncated by the token cap instead of persisting it", async () => {
		const { streamFn } = stubStream([response({ stopReason: "length" })]);
		await expect(
			compact(preparation(), model(), "key", undefined, undefined, undefined, undefined, streamFn),
		).rejects.toThrow("Summarization failed: generation hit the token cap and the summary is incomplete");
	});

	it("rejects a summary response that calls a tool", async () => {
		const { streamFn } = stubStream([
			response({ content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }], stopReason: "toolUse" }),
		]);
		await expect(
			compact(preparation(), model(), "key", undefined, undefined, undefined, undefined, streamFn),
		).rejects.toThrow("Summarization attempted to call a tool");
	});

	it("rejects a truncated turn-prefix summary", async () => {
		const { streamFn } = stubStream([response({}), response({ stopReason: "length" })]);
		await expect(
			compact(
				preparation({ isSplitTurn: true, turnPrefixMessages: [user("prefix")] }),
				model(),
				"key",
				undefined,
				undefined,
				undefined,
				undefined,
				streamFn,
			),
		).rejects.toThrow("Turn prefix summarization failed: generation hit the token cap");
	});

	// #9652 + previous checkpoint kept for an empty history
	it("uses a Markdown boundary for the turn prefix and keeps the previous summary", async () => {
		const { streamFn, calls } = stubStream([response({ content: [{ type: "text", text: "prefix checkpoint" }] })]);
		const previousSummary = `previous checkpoint${formatFileOperations(["src/a.ts"], [])}`;
		const result = await compact(
			preparation({
				messagesToSummarize: [],
				isSplitTurn: true,
				turnPrefixMessages: [user("read the large file")],
				previousSummary,
			}),
			model(),
			"key",
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);

		expect(calls).toHaveLength(1);
		const prompt = promptText(calls[0]);
		expect(prompt.startsWith("# Conversation\n")).toBe(true);
		expect(prompt).toContain("\n\n# Instructions\nThe messages above are earlier context");
		expect(prompt).not.toContain("<conversation>");
		expect(prompt).not.toContain("PREFIX");
		expect(result.summary.startsWith("previous checkpoint")).toBe(true);
		expect(result.summary).toContain("prefix checkpoint");
		expect(result.summary).not.toContain("<read-files>");
	});

	// Branch summary: cap 4096 clamped to the model, #7048, tool call rejection
	it("caps branch summaries at 4096 tokens and rejects truncated or tool-calling answers", async () => {
		const entries: SessionEntry[] = [entry(user("explore")), entry(response({}))];
		const signal = new AbortController().signal;

		const ok = stubStream([response({})]);
		await generateBranchSummary(entries, { model: model(), apiKey: "key", streamFn: ok.streamFn, signal });
		expect(ok.calls[0]?.options?.maxTokens).toBe(4096);

		const small = stubStream([response({})]);
		await generateBranchSummary(entries, { model: model(1000), apiKey: "key", streamFn: small.streamFn, signal });
		expect(small.calls[0]?.options?.maxTokens).toBe(1000);

		const truncated = stubStream([response({ stopReason: "length" })]);
		expect(
			await generateBranchSummary(entries, { model: model(), apiKey: "key", streamFn: truncated.streamFn, signal }),
		).toEqual({
			error: "Branch summarization failed: generation hit the token cap and the summary is incomplete",
		});

		const tool = stubStream([
			response({ content: [{ type: "toolCall", id: "t", name: "read", arguments: {} }], stopReason: "toolUse" }),
		]);
		expect(
			await generateBranchSummary(entries, { model: model(), apiKey: "key", streamFn: tool.streamFn, signal }),
		).toEqual({
			error: "Branch summarization attempted to call a tool",
		});
	});

	// Anti-drift guard: file lists appended by compact() are not summary content
	it("ignores <read-files>/<modified-files> blocks when checking for summary drift", () => {
		const body = "## Goal\nRefactor src/core/alpha.ts and keep tests green.";
		const previous = `${body}${formatFileOperations(["src/one.ts", "src/two.ts", "docs/three.md"], ["src/core/alpha.ts"])}`;
		const next = "## Goal\nRefactor src/core/alpha.ts, tests are green now.";
		expect(resolveSummaryUnion(previous, next)).toBe(next);

		// A path dropped from the summary body itself still triggers the union, without the file lists.
		const dropped = "## Goal\nRefactoring done, tests are green now and merged.";
		const union = resolveSummaryUnion(previous, dropped);
		expect(union).toContain("## Updated Summary");
		expect(union).toContain("src/core/alpha.ts");
		expect(union).not.toContain("<read-files>");
	});

	it("strips only the file-operation blocks", () => {
		const summary = `Keep me.${formatFileOperations(["a.ts"], ["b.ts"])}`;
		expect(stripFileOperations(summary)).toBe("Keep me.");
		expect(stripFileOperations("no lists here")).toBe("no lists here");
	});
});
