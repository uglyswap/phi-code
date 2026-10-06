import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Message, type Model } from "phi-code-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { streamProxy } from "../src/proxy.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("agent loop: abort during parallel preflight (#8935)", () => {
	it("does not execute calls that were prepared before a later preflight aborted", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		const executed: string[] = [];
		const tool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "echo",
			label: "Echo",
			description: "Echo tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return { content: [{ type: "text", text: `echoed: ${params.value}` }], details: { value: params.value } };
			},
		};
		const controller = new AbortController();
		let afterToolCallRuns = 0;
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model,
			convertToLlm: identityConverter,
			toolExecution: "parallel",
			beforeToolCall: async ({ args }) => {
				// The second call's preflight aborts the run (like a tool_call hook calling ctx.abort()).
				if ((args as { value: string }).value === "second") controller.abort();
				return undefined;
			},
			afterToolCall: async () => {
				afterToolCallRuns++;
				return undefined;
			},
		};

		let llmCalls = 0;
		const stream = agentLoop(
			[{ role: "user", content: "echo both", timestamp: Date.now() }],
			context,
			config,
			controller.signal,
			() => {
				llmCalls++;
				const mockStream = new MockAssistantStream();
				queueMicrotask(() => {
					if (llmCalls > 1) {
						// Real providers report the aborted signal as an aborted message.
						const message = assistant([], "aborted");
						mockStream.push({ type: "error", reason: "aborted", error: message });
						return;
					}
					const message = assistant(
						[
							{ type: "toolCall", id: "tool-1", name: "echo", arguments: { value: "first" } },
							{ type: "toolCall", id: "tool-2", name: "echo", arguments: { value: "second" } },
						],
						"toolUse",
					);
					mockStream.push({ type: "done", reason: "toolUse", message });
				});
				return mockStream;
			},
		);

		const ends: Extract<AgentEvent, { type: "tool_execution_end" }>[] = [];
		for await (const event of stream) {
			if (event.type === "tool_execution_end") ends.push(event);
		}

		expect(executed).toEqual([]);
		expect(afterToolCallRuns).toBe(0);
		expect(ends.map((end) => end.isError)).toEqual([true, true]);
		expect(llmCalls).toBeLessThanOrEqual(2);
	});
});

describe("streamProxy: truncated responses", () => {
	it("reports an error, not a successful stop, when the stream ends without a terminal event", async () => {
		const body = [
			`data: ${JSON.stringify({ type: "start" })}\n\n`,
			`data: ${JSON.stringify({ type: "text_start", contentIndex: 0 })}\n\n`,
			`data: ${JSON.stringify({ type: "text_delta", contentIndex: 0, delta: "partial answ" })}\n\n`,
		].join("");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);

		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{ authToken: "test-token", proxyUrl: "https://proxy.example.com" },
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Connection closed by proxy server");
	});

	it("processes a final terminal event that is not newline-terminated", async () => {
		const start = `data: ${JSON.stringify({ type: "start" })}\n\n`;
		const done = `data: ${JSON.stringify({ type: "done", reason: "stop", usage })}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(start + done, { status: 200 })),
		);

		const stream = streamProxy(
			model,
			{ systemPrompt: "", messages: [] },
			{ authToken: "test-token", proxyUrl: "https://proxy.example.com" },
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.map((event) => event.type)).toEqual(["start", "done"]);
		expect(result.stopReason).toBe("stop");
	});
});
