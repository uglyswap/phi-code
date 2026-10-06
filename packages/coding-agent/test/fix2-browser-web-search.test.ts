/**
 * FIX2-BROWSER regression: web-search must never buffer an unbounded HTTP body.
 * fetch_url used `response.text()`, so a huge (or endless) page exhausted memory.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import webSearchExtension, { MAX_RESPONSE_BYTES, readBodyCapped } from "../extensions/phi/web-search.ts";

type Execute = (
	id: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: unknown,
) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean }>;

function loadTools(): Map<string, Execute> {
	const tools = new Map<string, Execute>();
	const pi = {
		registerTool: (tool: { name: string; execute: Execute }) => tools.set(tool.name, tool.execute),
		registerCommand: vi.fn(),
		on: vi.fn(),
	};
	webSearchExtension(pi as never);
	return tools;
}

/** An endless body of 64 KiB chunks; records how much was pulled and whether it was cancelled. */
function endlessBody(): { stream: ReadableStream<Uint8Array>; pulled: () => number; cancelled: () => boolean } {
	const chunk = new TextEncoder().encode("a".repeat(64 * 1024));
	let pulled = 0;
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled += chunk.byteLength;
			controller.enqueue(chunk);
		},
		cancel() {
			cancelled = true;
		},
	});
	return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

describe("fix2-browser: bounded response bodies in web-search", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("readBodyCapped stops at the cap, cancels the stream and flags truncation", async () => {
		const body = endlessBody();
		const result = await readBodyCapped(new Response(body.stream), 200_000);
		expect(result.truncated).toBe(true);
		expect(result.text.length).toBe(200_000);
		expect(body.cancelled()).toBe(true);
		expect(body.pulled()).toBeLessThan(200_000 + 4 * 64 * 1024);
	});

	it("readBodyCapped returns small bodies untouched, multi-byte characters included", async () => {
		const result = await readBodyCapped(new Response("héllo wörld ✓"));
		expect(result).toEqual({ text: "héllo wörld ✓", truncated: false });
	});

	it("fetch_url reads at most MAX_RESPONSE_BYTES of an endless page and says so", async () => {
		const body = endlessBody();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body.stream, { status: 200, headers: { "content-type": "text/plain" } })),
		);
		const fetchUrl = loadTools().get("fetch_url");
		// IP literal: no DNS lookup needed for the SSRF guard.
		const result = await fetchUrl?.(
			"t",
			{ url: "http://93.184.216.34/", max_length: 1000 },
			undefined,
			undefined,
			{},
		);
		expect(result?.isError).toBeUndefined();
		expect(result?.details.bodyTruncated).toBe(true);
		expect(result?.content[0].text).toContain(`page body exceeded ${MAX_RESPONSE_BYTES} bytes`);
		expect(body.cancelled()).toBe(true);
		expect(body.pulled()).toBeLessThan(MAX_RESPONSE_BYTES + 4 * 64 * 1024);
	});
});
