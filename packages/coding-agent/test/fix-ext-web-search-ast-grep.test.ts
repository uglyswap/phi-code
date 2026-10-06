import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const completeSimple = vi.fn();
vi.mock("phi-code-ai/compat", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, completeSimple: (...args: unknown[]) => completeSimple(...args) };
});

import astGrepExtension, { collectFiles, MAX_FILE_BYTES } from "../extensions/phi/ast-grep.ts";
import webSearchExtension, { condenseForContext } from "../extensions/phi/web-search.ts";

type Execute = (
	id: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: unknown,
) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean }>;

function loadTools(extension: (pi: never) => void): Map<string, Execute> {
	const tools = new Map<string, Execute>();
	const pi = {
		registerTool: (tool: { name: string; execute: Execute }) => tools.set(tool.name, tool.execute),
		registerCommand: vi.fn(),
		on: vi.fn(),
	};
	extension(pi as never);
	return tools;
}

describe("fix-ext: web-search summary goes through the session model", () => {
	afterEach(() => {
		completeSimple.mockReset();
		vi.unstubAllGlobals();
	});

	it("summarizes with ctx.model + model registry auth and reports usage (no direct HTTP call)", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.01 } };
		completeSimple.mockResolvedValue({
			content: [{ type: "text", text: "short summary" }],
			stopReason: "stop",
			usage,
		});
		const model = { provider: "chosen", id: "session-model" };
		const getApiKeyAndHeaders = vi.fn(async () => ({ ok: true, apiKey: "k", headers: { h: "1" } }));

		const result = await condenseForContext("x".repeat(7000), {
			model,
			modelRegistry: { getApiKeyAndHeaders },
		} as never);

		expect(result.mode).toBe("summary");
		expect(result.text).toBe("short summary");
		expect(result.usage).toBe(usage);
		expect(getApiKeyAndHeaders).toHaveBeenCalledWith(model);
		expect(completeSimple.mock.calls[0][0]).toBe(model);
		expect(completeSimple.mock.calls[0][2]).toMatchObject({ apiKey: "k", headers: { h: "1" } });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("falls back to deterministic truncation without a session model", async () => {
		const result = await condenseForContext("y".repeat(7000), { model: undefined } as never);
		expect(result.mode).toBe("truncated");
		expect(completeSimple).not.toHaveBeenCalled();
	});

	it("fetch_url propagates the tool abort signal to fetch and reports an error", async () => {
		const seen: AbortSignal[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: { signal: AbortSignal }) => {
				seen.push(init.signal);
				init.signal.throwIfAborted();
				throw new Error("unexpected");
			}),
		);
		const fetchUrl = loadTools(webSearchExtension as never).get("fetch_url");
		const controller = new AbortController();
		controller.abort();
		// IP literal: no DNS lookup needed for the SSRF guard.
		const result = await fetchUrl?.("t", { url: "http://93.184.216.34/" }, controller.signal, undefined, {});
		expect(seen).toHaveLength(1);
		expect(seen[0].aborted).toBe(true);
		expect(result?.isError).toBe(true);
	});

	it("web_search stops before querying providers when the call is aborted", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const webSearch = loadTools(webSearchExtension as never).get("web_search");
		const controller = new AbortController();
		controller.abort();
		const result = await webSearch?.("t", { query: "phi" }, controller.signal, undefined, {});
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(result?.isError).toBe(true);
	});
});

describe("fix-ext: ast_grep walk limits", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fix-ext-astgrep-"));
		writeFileSync(join(dir, ".gitignore"), "generated/\n*.gen.ts\n");
		mkdirSync(join(dir, "src"));
		mkdirSync(join(dir, "generated"));
		writeFileSync(join(dir, "src", "a.ts"), "console.log(1);\n");
		writeFileSync(join(dir, "src", "b.gen.ts"), "console.log(2);\n");
		writeFileSync(join(dir, "generated", "c.ts"), "console.log(3);\n");
		writeFileSync(join(dir, "src", "big.ts"), `console.log(4);\n${"//".padEnd(MAX_FILE_BYTES + 10, "x")}\n`);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("respects .gitignore, including for a sub-directory search", async () => {
		const all = await collectFiles(".", dir);
		const names = all.files.map((f) => f.slice(dir.length + 1).replaceAll("\\", "/")).sort();
		expect(names).toEqual(["src/a.ts", "src/big.ts"]);
		const sub = await collectFiles("src", dir);
		expect(sub.files.map((f) => f.slice(dir.length + 1).replaceAll("\\", "/")).sort()).toEqual([
			"src/a.ts",
			"src/big.ts",
		]);
	});

	it("skips oversized files, finds matches with the fixed findAll typing, and honors abort", async () => {
		const astGrep = loadTools(astGrepExtension as never).get("ast_grep");
		const result = await astGrep?.("t", { pattern: "console.log($X)" }, undefined, undefined, { cwd: dir });
		expect(result?.isError).toBeUndefined();
		expect(result?.content[0].text).toContain("a.ts:1: console.log(1)");
		expect(result?.content[0].text).not.toContain("console.log(4)");
		expect(result?.details.skippedLarge).toBe(1);

		const controller = new AbortController();
		controller.abort();
		await expect(
			astGrep?.("t", { pattern: "console.log($X)" }, controller.signal, undefined, { cwd: dir }),
		).rejects.toThrow();
	});
});
