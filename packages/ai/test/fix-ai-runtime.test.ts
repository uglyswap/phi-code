import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { OAuthAuth } from "../src/auth/types.ts";
import { streamSimple } from "../src/compat.ts";
import { createModels, type Provider } from "../src/models.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream, EventStream } from "../src/utils/event-stream.ts";
import { resolveHttpProxyUrlForTarget } from "../src/utils/node-http-proxy.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";
import {
	DEFAULT_MAX_AGENT_RETRY_DELAY_MS,
	isRetryableAssistantError,
	retryAssistantCall,
	retryDelayMs,
} from "../src/utils/retry.ts";

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function errorMessage(text: string, provider = "test"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider,
		model: "m",
		usage,
		stopReason: "error",
		errorMessage: text,
		timestamp: Date.now(),
	};
}

describe("OAuth refresh survives cancellation (refresh_token_invalidated)", () => {
	it("persists a refresh that started before a model refresh was cancelled", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("p1", async () => ({
			type: "oauth",
			access: "old",
			refresh: "old-refresh",
			expires: 0,
		}));
		const controller = new AbortController();
		let refreshSignal: AbortSignal | undefined;
		const oauth: OAuthAuth = {
			name: "Test OAuth",
			login: async () => {
				throw new Error("not used");
			},
			refresh: async (credential, signal) => {
				refreshSignal = signal;
				// The provider has already rotated old-refresh when the caller cancels.
				controller.abort();
				return { ...credential, access: "new", refresh: "new-refresh", expires: Date.now() + 60_000 };
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		};
		const models = createModels({ credentials });
		const unused = (): AssistantMessageEventStream => {
			throw new Error("not used");
		};
		const provider: Provider = {
			id: "p1",
			name: "p1",
			auth: { oauth },
			getModels: () => [],
			refreshModels: async () => {},
			stream: unused,
			streamSimple: unused,
		};
		models.setProvider(provider);

		expect((await models.refresh({ signal: controller.signal })).aborted).toBe(true);
		await vi.waitFor(async () => {
			expect(await credentials.read("p1")).toMatchObject({ refresh: "new-refresh" });
		});
		expect(refreshSignal?.aborted).toBe(false);
	});
});

describe("retry classification and backoff", () => {
	it("retries capacity, high-demand, 520 and cancelled HTTP/2 stream errors", () => {
		for (const text of [
			"The model is at capacity. Please try again later.",
			"We are currently experiencing high demand. Please retry.",
			"520 status code (no body)",
			"The pending stream has been canceled (caused by: ...)",
		]) {
			expect(isRetryableAssistantError(errorMessage(text)), text).toBe(true);
		}
	});

	it("keeps the phi word boundaries on HTTP status codes", () => {
		expect(isRetryableAssistantError(errorMessage("Invalid model qwen-5200-pro"))).toBe(false);
		expect(isRetryableAssistantError(errorMessage("request id req_15204 rejected: invalid schema"))).toBe(false);
		expect(isRetryableAssistantError(errorMessage("HTTP 503 Service Unavailable"))).toBe(true);
		// Non-retryable account limits still win over a retryable status code.
		expect(isRetryableAssistantError(errorMessage("429 GoUsageLimitError: Monthly usage limit reached"))).toBe(false);
	});

	it("caps agent retry delays at maxAgentDelayMs (default 60 s)", () => {
		expect(retryDelayMs({ baseDelayMs: 2000 }, 1)).toBe(2000);
		expect(retryDelayMs({ baseDelayMs: 2000 }, 3)).toBe(8000);
		expect(retryDelayMs({ baseDelayMs: 2000 }, 20)).toBe(DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
		expect(retryDelayMs({ baseDelayMs: 1000, maxAgentDelayMs: 5000 }, 4)).toBe(5000);
		expect(retryDelayMs({ baseDelayMs: 1000 }, 5000)).toBe(DEFAULT_MAX_AGENT_RETRY_DELAY_MS);
	});

	it("applies the cap inside retryAssistantCall", async () => {
		vi.useFakeTimers();
		try {
			const delays: number[] = [];
			const produce = vi
				.fn<() => Promise<AssistantMessage>>()
				.mockResolvedValueOnce(errorMessage("503 overloaded"))
				.mockResolvedValueOnce(errorMessage("503 overloaded"))
				.mockResolvedValue({ ...errorMessage(""), stopReason: "stop", errorMessage: undefined });
			const result = retryAssistantCall(
				produce,
				{ enabled: true, maxRetries: 3, baseDelayMs: 4000, maxAgentDelayMs: 5000 },
				undefined,
				{ onRetryScheduled: (_attempt, _max, delayMs) => void delays.push(delayMs) },
			);
			await vi.runAllTimersAsync();
			expect((await result).stopReason).toBe("stop");
			expect(delays).toEqual([4000, 5000]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("falls back to exponential backoff when Retry-After is unparseable", async () => {
		vi.useFakeTimers();
		try {
			const error = Object.assign(new Error("Provider error: 429"), {
				status: 429,
				headers: new Headers({ "retry-after": "soon-ish" }),
			});
			const request = vi.fn<() => Promise<string>>().mockRejectedValueOnce(error).mockResolvedValue("ok");
			const result = retryProviderRequest(request, { maxRetries: 1 });
			// Backoff for the first retry is 500 ms minus up to 25 % jitter: never immediate.
			await vi.advanceTimersByTimeAsync(300);
			expect(request).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(300);
			await expect(result).resolves.toBe("ok");
			expect(request).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("EventStream FIFO queue (#9055)", () => {
	it("delivers a large buffered backlog in order and interleaves with waiting consumers", async () => {
		const stream = new EventStream<number, number>(
			(event) => event < 0,
			(event) => event,
		);
		const count = 50_000;
		for (let i = 0; i < count; i++) stream.push(i);
		const received: number[] = [];
		const iterator = stream[Symbol.asyncIterator]();
		for (let i = 0; i < count; i++) {
			const next = await iterator.next();
			received.push(next.value as number);
		}
		const pending = iterator.next();
		stream.push(count);
		expect((await pending).value).toBe(count);
		stream.push(-1);
		expect((await iterator.next()).value).toBe(-1);
		expect((await iterator.next()).done).toBe(true);
		expect(await stream.result()).toBe(-1);
		expect(received.every((value, index) => value === index)).toBe(true);
	});
});

describe("context overflow detection", () => {
	it("recognizes z.ai prompt-too-long errors (#9805, #10208)", () => {
		expect(isContextOverflow(errorMessage('{"code":"1261","message":"Prompt too long"}', "zai"))).toBe(true);
		expect(isContextOverflow(errorMessage('{"code":"1261","message":"Prompt exceeds max length"}', "zai"))).toBe(
			true,
		);
		expect(isContextOverflow(errorMessage("prompt is too long: 213462 tokens > 200000 maximum"))).toBe(true);
	});

	it("treats body-less 400/413 as overflow only for Cerebras (#9482)", () => {
		expect(isContextOverflow(errorMessage("400 status code (no body)", "cerebras"))).toBe(true);
		expect(isContextOverflow(errorMessage("413 status code (no body)", "cerebras"))).toBe(true);
		expect(isContextOverflow(errorMessage("400 status code (no body)", "opencode-go"))).toBe(false);
		expect(isContextOverflow(errorMessage("413 (no body)", "custom-provider"))).toBe(false);
	});
});

describe("NO_PROXY matching (#8737)", () => {
	const keys = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"] as const;
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	afterEach(() => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it("handles root domains, subdomains, wildcards, IPv6 and ports", () => {
		for (const key of keys) delete process.env[key];
		process.env.HTTPS_PROXY = "http://proxy.example:8080";
		process.env.NO_PROXY = "example.com, .wildcard.org, *.star.net, ::1, [2001:db8::1], 127.0.0.1:8080";

		expect(resolveHttpProxyUrlForTarget("https://example.com")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://api.example.com")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://wildcard.org")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://api.wildcard.org")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://star.net")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://api.star.net")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://notexample.com")?.toString()).toBe("http://proxy.example:8080/");
		expect(resolveHttpProxyUrlForTarget("https://[::1]:80")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://[2001:db8::1]")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://127.0.0.1:8080")).toBeUndefined();
		expect(resolveHttpProxyUrlForTarget("https://127.0.0.1:3000")?.toString()).toBe("http://proxy.example:8080/");
	});
});

describe("OpenAI Responses unfinished tool calls (#9974)", () => {
	const model: Model<"openai-responses"> = {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
	const output = (): AssistantMessage => ({
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: structuredClone(usage),
		stopReason: "pending" as AssistantMessage["stopReason"],
		timestamp: Date.now(),
	});

	async function* unfinishedToolCall(): AsyncIterable<ResponseStreamEvent> {
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "" },
			},
			{
				type: "response.function_call_arguments.delta",
				output_index: 0,
				item_id: "fc_1",
				delta: '{"command":"rm -rf /tmp/build',
			},
			{ type: "response.completed", response: { id: "resp_unfinished", status: "completed" } },
		];
		for (const event of events) yield event as unknown as ResponseStreamEvent;
	}

	// llama.cpp omits output_index and sends both done events after all deltas.
	async function* parallelWithoutOutputIndex(): AsyncIterable<ResponseStreamEvent> {
		const call = (n: string) => ({ type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: "bash" });
		const events = [
			{ type: "response.output_item.added", item: { ...call("a"), arguments: "" } },
			{ type: "response.function_call_arguments.delta", item_id: "fc_a", delta: '{"command":"echo a"}' },
			{ type: "response.output_item.added", item: { ...call("b"), arguments: "" } },
			{ type: "response.function_call_arguments.delta", item_id: "fc_b", delta: '{"command":"echo b"}' },
			{ type: "response.output_item.done", item: { ...call("a"), arguments: '{"command":"echo a"}' } },
			{ type: "response.output_item.done", item: { ...call("b"), arguments: '{"command":"echo b"}' } },
			{ type: "response.completed", response: { id: "resp_no_output_index", status: "completed" } },
		];
		for (const event of events) yield event as unknown as ResponseStreamEvent;
	}

	it("rejects a completed stream whose tool call never received output_item.done", async () => {
		await expect(
			processResponsesStream(unfinishedToolCall(), output(), new AssistantMessageEventStream(), model),
		).rejects.toThrow("OpenAI Responses stream completed with an unfinished tool call: bash (call_1|fc_1)");
	});

	it("rejects parallel tool calls without output_index instead of running mixed-up calls", async () => {
		await expect(
			processResponsesStream(parallelWithoutOutputIndex(), output(), new AssistantMessageEventStream(), model),
		).rejects.toThrow("OpenAI Responses stream completed with an unfinished tool call: bash (call_a|fc_a)");
	});
});

describe("OpenCode qwen3.8-flash empty thinking signatures (#10047)", () => {
	interface AnthropicPayload {
		messages?: Array<{ role: string; content: Array<{ type: string; signature?: string }> }>;
	}

	async function capture(provider: string, id: string): Promise<AnthropicPayload> {
		const model: Model<"anthropic-messages"> = {
			id,
			name: id,
			api: "anthropic-messages",
			provider,
			baseUrl: "http://127.0.0.1:9/zen/go",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 1024,
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "internal reasoning", thinkingSignature: "" }],
			provider,
			api: "anthropic-messages",
			model: id,
			timestamp: Date.now(),
			usage,
			stopReason: "stop",
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "first", timestamp: Date.now() },
				assistant,
				{ role: "user", content: "second", timestamp: Date.now() },
			],
		};
		let captured: AnthropicPayload | undefined;
		await streamSimple(model, context, {
			apiKey: "fake-key",
			onPayload: (payload) => {
				captured = payload as AnthropicPayload;
				throw new Error("payload captured");
			},
		}).result();
		if (!captured) throw new Error("Expected payload capture");
		return captured;
	}

	it("replays the thinking block with an empty signature for OpenCode Go and Zen", async () => {
		for (const provider of ["opencode-go", "opencode"]) {
			const payload = await capture(provider, "qwen3.8-flash");
			expect(payload.messages?.[1]?.content[0]).toMatchObject({ type: "thinking", signature: "" });
		}
	});

	it("keeps converting unsigned thinking to text for other models", async () => {
		const payload = await capture("opencode-go", "minimax-m3");
		expect(payload.messages?.[1]?.content[0]?.type).toBe("text");
	});
});
