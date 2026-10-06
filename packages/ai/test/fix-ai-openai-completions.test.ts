import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";

interface CapturedParams {
	messages: Array<{ role: string; content: unknown }>;
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedParams | undefined,
	usage: undefined as Record<string, unknown> | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedParams) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ delta: { content: "ok" }, finish_reason: null }],
							};
							yield {
								id: "chatcmpl-test",
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: mockState.usage,
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

function createModel(overrides?: Partial<Model<"openai-completions">>): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test model",
		api: "openai-completions",
		provider: "test-provider",
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		...overrides,
	};
}

describe("openai-completions fixes", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.usage = undefined;
	});

	// #9797: some OpenAI-compatible providers reject empty text parts next to an image.
	it("omits empty text parts from multimodal user messages", async () => {
		mockState.usage = { prompt_tokens: 1, completion_tokens: 1 };
		await streamOpenAICompletions(
			createModel(),
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "" },
							{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test-key" },
		).result();

		const user = mockState.lastParams?.messages.find((message) => message.role === "user");
		expect(user?.content).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }]);
	});

	// #8075: Kimi reports cache hits as top-level usage.cached_tokens.
	it("counts top-level cached_tokens as cache reads", async () => {
		mockState.usage = { prompt_tokens: 1000, completion_tokens: 10, cached_tokens: 800 };
		const result = await streamOpenAICompletions(
			createModel({ provider: "moonshotai", baseUrl: "https://api.moonshot.ai/v1" }),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-key" },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.usage.cacheRead).toBe(800);
		expect(result.usage.input).toBe(200);
	});

	it("still prefers prompt_tokens_details.cached_tokens when present", async () => {
		mockState.usage = {
			prompt_tokens: 1000,
			completion_tokens: 10,
			cached_tokens: 5,
			prompt_tokens_details: { cached_tokens: 600 },
		};
		const result = await streamOpenAICompletions(
			createModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test-key" },
		).result();

		expect(result.usage.cacheRead).toBe(600);
		expect(result.usage.input).toBe(400);
	});
});
