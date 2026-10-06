import type { AgentMessage, AgentTool } from "phi-code-agent";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "phi-code-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InputEvent } from "../src/core/extensions/index.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

type SessionInternals = {
	_checkCompaction: (assistantMessage: AssistantMessage) => Promise<boolean>;
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function seedCompactableSession(harness: Harness): void {
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "x".repeat(500) }],
		timestamp: 1,
	});
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("y".repeat(200), { timestamp: 2 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...zeroUsage(), input: 100, totalTokens: 100 },
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function runAutoCompaction(harness: Harness): Promise<boolean> {
	return (harness.session as unknown as SessionInternals)._runAutoCompaction("threshold", false);
}

function waitTool(onRun: () => Promise<void>): AgentTool {
	return {
		name: "wait",
		label: "Wait",
		description: "Wait for a background task",
		parameters: Type.Object({}),
		execute: async () => {
			await onRun();
			return { content: [{ type: "text", text: "tool done" }], details: {} };
		},
	};
}

describe("fix-session: AgentSession", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function harnessWith(options: Parameters<typeof createHarness>[0]): Promise<Harness> {
		const harness = await createHarness(options);
		harnesses.push(harness);
		return harness;
	}

	// #9178
	it("rejects tree navigation while a manual compaction is running", async () => {
		const compactionStarted = createDeferred();
		const compactionReleased = createDeferred();
		const harness = await harnessWith({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactionStarted.resolve();
						await compactionReleased.promise;
						return {
							compaction: {
								summary: "summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});

		harness.sessionManager.appendMessage(userMsg("first user"));
		const navigationTargetId = harness.sessionManager.appendMessage(assistantMsg("first assistant"));
		harness.sessionManager.appendMessage(userMsg("second user"));
		const originalLeafId = harness.sessionManager.appendMessage(assistantMsg("second assistant"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const compactionPromise = harness.session.compact();
		await compactionStarted.promise;
		try {
			await expect(harness.session.navigateTree(navigationTargetId, { summarize: false })).rejects.toThrow(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
			expect(harness.sessionManager.getLeafId()).toBe(originalLeafId);
		} finally {
			compactionReleased.resolve();
		}
		await compactionPromise;

		expect(harness.sessionManager.getEntries().at(-1)).toMatchObject({
			type: "compaction",
			parentId: originalLeafId,
		});
		expect(harness.session.messages.map(getMessageText)).toContain("second assistant");
	});

	// #9178
	it("rejects a second tree navigation while the first one is pending", async () => {
		const navigationStarted = createDeferred();
		const navigationReleased = createDeferred();
		const harness = await harnessWith({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						navigationStarted.resolve();
						await navigationReleased.promise;
					});
				},
			],
		});

		const secondTargetId = harness.sessionManager.appendMessage(userMsg("first user"));
		const firstTargetId = harness.sessionManager.appendMessage(assistantMsg("first assistant"));
		harness.sessionManager.appendMessage(userMsg("second user"));
		harness.sessionManager.appendMessage(assistantMsg("second assistant"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const firstNavigation = harness.session.navigateTree(firstTargetId, { summarize: false });
		await navigationStarted.promise;
		const secondNavigation = harness.session.navigateTree(secondTargetId, { summarize: false });
		navigationReleased.resolve();

		await expect(secondNavigation).rejects.toThrow("Wait for the current compaction or tree navigation");
		await firstNavigation;
		expect(harness.sessionManager.getLeafId()).toBe(firstTargetId);
	});

	// #8328
	it("auto-compacts from the message estimate when the provider reports no usage", async () => {
		const harness = await harnessWith({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 20 }],
			settings: { compaction: { enabled: true, reserveTokens: 10 } },
		});
		const model = harness.getModel();
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		const internals = harness.session as unknown as SessionInternals;
		const spy = vi.spyOn(internals, "_runAutoCompaction").mockResolvedValue(false);

		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "short" }], timestamp: Date.now() - 1 },
			assistant,
		];
		await internals._checkCompaction(assistant);
		expect(spy).not.toHaveBeenCalled();

		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "x".repeat(400) }], timestamp: Date.now() - 1 },
			assistant,
		];
		await internals._checkCompaction(assistant);
		expect(spy).toHaveBeenCalledWith("threshold", false);
	});

	// #9340
	it("does not start a post-run auto-compaction after abort", async () => {
		const harness = await harnessWith({
			models: [{ id: "faux-1", contextWindow: 200, maxTokens: 50 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 50, keepRecentTokens: 1 },
				retry: { enabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		seedCompactableSession(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic network failure" }),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				void harness.session.abort();
			}
		});

		await harness.session.prompt("z".repeat(1000));

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	// #9340 + retry.maxAgentDelayMs (60 s default cap)
	it("caps the retry backoff and cancels the retry on abort without continuing", async () => {
		const harness = await harnessWith({
			settings: { retry: { enabled: true, maxRetries: 5, baseDelayMs: 10_000_000 } },
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "529 overloaded" }),
			fauxAssistantMessage("must not be requested"),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") void harness.session.abort();
		});

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([60_000]);
		expect(harness.eventsOfType("auto_retry_end").at(-1)).toMatchObject({
			success: false,
			finalError: "Retry cancelled",
		});
		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	// #9777
	it("honors abortCompaction() issued synchronously from compaction_start", async () => {
		const harness = await harnessWith({ settings: { compaction: { keepRecentTokens: 1 } } });
		seedCompactableSession(harness);
		const getAuth = vi.spyOn(harness.session.modelRuntime, "getAuth");
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") harness.session.abortCompaction();
		});

		await runAutoCompaction(harness);

		expect(harness.faux.state.callCount).toBe(0);
		expect(getAuth).not.toHaveBeenCalled();
		expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
	});

	// #9777
	it.each([
		["matching error text", () => new Error("Compaction cancelled")],
		["an unrelated AbortError", () => Object.assign(new Error("auth failed"), { name: "AbortError" })],
	] as const)("reports %s from auth as a failure, not a cancellation", async (_label, createError) => {
		const harness = await harnessWith({ settings: { compaction: { keepRecentTokens: 1 } } });
		seedCompactableSession(harness);
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockRejectedValue(createError());

		await runAutoCompaction(harness);

		const event = harness.eventsOfType("compaction_end").at(-1);
		expect(event?.aborted).toBe(false);
		expect(event?.errorMessage).toContain(createError().message);
	});

	it("reports an extension cancellation of auto-compaction as aborted", async () => {
		const harness = await harnessWith({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		seedCompactableSession(harness);

		await runAutoCompaction(harness);

		expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
	});

	// #8920
	it("abort() cancels a running manual compaction and waits for it to settle", async () => {
		const compactionStarted = createDeferred();
		const harness = await harnessWith({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactionStarted.resolve();
						await new Promise<void>((resolve) => event.signal.addEventListener("abort", () => resolve()));
						return undefined;
					});
				},
			],
		});
		seedCompactableSession(harness);

		const compaction = harness.session.compact();
		const compactionSettled = compaction.catch((error: unknown) => error);
		await compactionStarted.promise;
		expect(harness.session.isIdle).toBe(false);

		await harness.session.abort();

		expect(harness.session.isCompacting).toBe(false);
		expect(harness.session.isIdle).toBe(true);
		expect(await compactionSettled).toBeInstanceOf(Error);
		expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	// #8537
	it("appends a context-only custom message after the turn's tool results", async () => {
		let notify: (() => Promise<void>) | undefined;
		const harness = await harnessWith({ tools: [waitTool(async () => await notify?.())] });
		notify = () =>
			harness.session.sendCustomMessage(
				{ customType: "subagent-reply", content: "subagent replied", display: true },
				{ triggerTurn: false },
			);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("second turn"),
		]);

		await harness.session.prompt("hi");

		const roles = (messages: AgentMessage[]) => messages.map((message) => message.role);
		expect(roles(harness.session.messages)).toEqual(["user", "assistant", "toolResult", "custom", "assistant"]);
		const entryKinds = harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "message" ? [entry.message.role] : entry.type === "custom_message" ? ["custom"] : [],
			);
		expect(entryKinds).toEqual(["user", "assistant", "toolResult", "custom", "assistant"]);
		const messageStarts = harness.events.flatMap((event) =>
			event.type === "message_start" ? [event.message.role] : [],
		);
		expect(messageStarts).toEqual(["user", "assistant", "toolResult", "custom", "assistant"]);

		await harness.session.prompt("and now?");
		const openToolCallIds = new Set<string>();
		for (const message of convertToLlm(harness.session.messages)) {
			if (message.role === "assistant") {
				openToolCallIds.clear();
				for (const block of message.content) {
					if (block.type === "toolCall") openToolCallIds.add(block.id);
				}
				continue;
			}
			if (message.role === "toolResult") {
				expect(openToolCallIds.has(message.toolCallId)).toBe(true);
				openToolCallIds.delete(message.toolCallId);
				continue;
			}
			openToolCallIds.clear();
		}
	});

	// #8718
	it("runs input handlers for steer() and followUp()", async () => {
		const inputs: InputEvent[] = [];
		let queue: (() => Promise<void>) | undefined;
		const harness = await harnessWith({
			tools: [waitTool(async () => await queue?.())],
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputs.push(event);
						if (event.text === "drop me") return { action: "handled" };
						return { action: "transform", text: `[${event.source}] ${event.text}` };
					});
				},
			],
		});
		queue = async () => {
			await harness.session.steer("steer me", undefined, { source: "rpc" });
			await harness.session.followUp("drop me");
		};
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hi");

		expect(inputs.map((event) => [event.text, event.source, event.streamingBehavior])).toEqual([
			["hi", "interactive", undefined],
			["steer me", "rpc", "steer"],
			["drop me", "interactive", "followUp"],
		]);
		const userTexts = harness.session.messages
			.filter((message) => message.role === "user")
			.map((message) => getMessageText(message));
		expect(userTexts).toEqual(["[interactive] hi", "[rpc] steer me"]);
	});

	// #6879
	it("compacts between tool execution and the next request when tool results cross the threshold", async () => {
		const bigTool: AgentTool = {
			name: "big",
			label: "Big",
			description: "Return a large result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "r".repeat(4000) }], details: {} }),
		};
		const harness = await harnessWith({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 200, keepRecentTokens: 1 } },
			tools: [bigTool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: `${event.reason} summary`,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("big", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer"),
		]);

		await harness.session.prompt("read the big file");

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		const entries = harness.sessionManager.getEntries();
		const compactionIndex = entries.findIndex((entry) => entry.type === "compaction");
		const finalAnswerIndex = entries.findIndex(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				getMessageText(entry.message) === "final answer",
		);
		expect(compactionIndex).toBeGreaterThan(-1);
		expect(finalAnswerIndex).toBeGreaterThan(compactionIndex);
		// The request after the tool ran started from the compacted context.
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
		// The working indicator is restored by turn_start after the mid-run compaction.
		const turnStarts = harness.events
			.map((event, index) => ({ event, index }))
			.filter(({ event }) => event.type === "turn_start");
		const compactionEnd = harness.events.findIndex((event) => event.type === "compaction_end");
		expect(turnStarts.some(({ index }) => index > compactionEnd)).toBe(true);
	});

	it("does not compact mid-run after a final turn without tool results", async () => {
		const harness = await harnessWith({
			models: [{ id: "faux-1", contextWindow: 1000, maxTokens: 100 }],
			settings: { compaction: { enabled: false, reserveTokens: 200, keepRecentTokens: 1 } },
		});
		harness.setResponses([fauxAssistantMessage("answer")]);
		await harness.session.prompt("p".repeat(4000));
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});
});
