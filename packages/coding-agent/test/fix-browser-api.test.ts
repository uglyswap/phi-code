/**
 * FIX-BROWSER regression tests for @phi-code-admin/browser: the bridge must
 * speak the real camofox-browser REST contract (server.js), not a guessed one.
 * The server process is faked (spawn mocked) and HTTP is captured with a
 * stubbed fetch, so no browser is launched.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => {
		const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => boolean };
		child.stderr = new EventEmitter();
		child.kill = () => {
			setImmediate(() => child.emit("exit", 0));
			return true;
		};
		return child;
	}),
}));

const browser = await import("../../browser/src/index.ts");

interface Call {
	method: string;
	path: string;
	body: Record<string, unknown> | undefined;
}

let calls: Call[] = [];
let responder: (call: Call) => unknown = () => ({ ok: true });

function stubFetch(): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			const url = new URL(input);
			const path = `${url.pathname}${url.search}`;
			if (path === "/health") return new Response("{}", { status: 200 });
			init?.signal?.throwIfAborted();
			const call: Call = {
				method: init?.method ?? "GET",
				path,
				body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			};
			calls.push(call);
			return new Response(JSON.stringify(responder(call)), { status: 200 });
		}),
	);
}

describe("@phi-code-admin/browser REST contract", () => {
	beforeEach(() => {
		calls = [];
		responder = () => ({ ok: true });
		stubFetch();
	});
	afterAll(async () => {
		await browser.closeAll();
		vi.unstubAllGlobals();
	});

	it("listTabs uses GET /tabs?userId= and returns its tabs", async () => {
		responder = () => ({ running: true, tabs: [{ tabId: "t1", url: "https://a.test/", title: "A" }] });
		const tabs = await browser.listTabs();
		expect(calls).toEqual([{ method: "GET", path: "/tabs?userId=phi-default", body: undefined }]);
		expect(tabs).toEqual([{ tabId: "t1", url: "https://a.test/", title: "A" }]);
	});

	it("scroll sends `amount` (pixels kept as alias) and rejects `ref`", async () => {
		await browser.scroll({ tabId: "t1", direction: "down", amount: 300 });
		await browser.scroll({ tabId: "t1", direction: "up", pixels: 120 });
		expect(calls.map((c) => c.body)).toEqual([
			{ userId: "phi-default", direction: "down", amount: 300 },
			{ userId: "phi-default", direction: "up", amount: 120 },
		]);
		await expect(browser.scroll({ tabId: "t1", direction: "down", ref: "e1" })).rejects.toThrow(/not supported/);
	});

	it("click rejects non-left buttons instead of left-clicking", async () => {
		await expect(browser.click({ tabId: "t1", ref: "e1", button: "right" })).rejects.toThrow(/left clicks/);
		expect(calls).toEqual([]);
		responder = () => ({ ok: true, url: "https://b.test/", refsAvailable: true });
		const res = await browser.click({ tabId: "t1", ref: "e1", button: "left" });
		expect(calls[0]?.body).toEqual({ userId: "phi-default", ref: "e1" });
		expect(res).toEqual({ tabId: "t1", url: "https://b.test/", refsAvailable: true });
	});

	it("type picks keyboard mode without target and maps delayMs to delay", async () => {
		await browser.type({ tabId: "t1", text: "hi" });
		await browser.type({ tabId: "t1", text: "hi", ref: "e2", pressEnter: true });
		await browser.type({ tabId: "t1", text: "hi", selector: "#q", delayMs: 50 });
		expect(calls.map((c) => c.body)).toEqual([
			{ userId: "phi-default", text: "hi", mode: "keyboard" },
			{ userId: "phi-default", text: "hi", mode: "fill", ref: "e2", pressEnter: true },
			{ userId: "phi-default", text: "hi", mode: "keyboard", selector: "#q", delay: 50 },
		]);
	});

	it("navigate reports the server url and honours waitUntil through POST /wait", async () => {
		responder = (call) =>
			call.path.endsWith("/navigate")
				? { ok: true, tabId: "t1", url: "https://final.test/", refsAvailable: true }
				: { ok: true, ready: true };
		const res = await browser.navigate({
			tabId: "t1",
			url: "https://start.test/",
			waitUntil: "networkidle",
			timeoutMs: 4000,
		});
		expect(calls.map((c) => [c.method, c.path])).toEqual([
			["POST", "/tabs/t1/navigate"],
			["POST", "/tabs/t1/wait"],
		]);
		expect(calls[1]?.body).toEqual({ userId: "phi-default", timeout: 4000, waitForNetwork: true });
		expect(res).toMatchObject({ tabId: "t1", url: "https://final.test/", refsAvailable: true, ready: true });

		calls = [];
		await browser.navigate({ tabId: "t1", url: "https://start.test/", waitUntil: "load" });
		expect(calls[1]?.body).toMatchObject({ waitForNetwork: false });
		calls = [];
		await browser.navigate({ tabId: "t1", url: "https://start.test/", waitUntil: "domcontentloaded" });
		expect(calls).toHaveLength(1);
	});

	it("snapshot forwards offset for the next chunk", async () => {
		await browser.snapshot({ tabId: "t1" });
		await browser.snapshot({ tabId: "t1", offset: 80000 });
		expect(calls.map((c) => c.path)).toEqual([
			"/tabs/t1/snapshot?userId=phi-default",
			"/tabs/t1/snapshot?userId=phi-default&offset=80000",
		]);
	});

	it("an aborted signal cancels the call", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(browser.listTabs({ signal: controller.signal })).rejects.toThrow();
		expect(calls).toEqual([]);
	});
});

describe("server runtime under Bun", () => {
	it("uses process.execPath under Node", () => {
		expect(browser.resolveNodeExecutable({ execPath: "/usr/bin/node" }, () => "/other/node")).toBe("/usr/bin/node");
	});

	it("uses node from PATH under Bun instead of relaunching the phi binary", () => {
		expect(
			browser.resolveNodeExecutable({ bun: "1.3.0", execPath: "C:/phi/phi.exe" }, () => "C:/node/node.exe"),
		).toBe("C:/node/node.exe");
	});

	it("fails with an actionable message when no node is available under Bun", () => {
		expect(() => browser.resolveNodeExecutable({ bun: "1.3.0", execPath: "/opt/phi" }, () => undefined)).toThrow(
			/Node\.js >= 22.*PATH/s,
		);
	});

	it("findNodeOnPath finds node(.exe) in PATH entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "fix-browser-node-"));
		try {
			writeFileSync(join(dir, "node.exe"), "");
			writeFileSync(join(dir, "node"), "");
			expect(browser.findNodeOnPath(`C:\\missing;"${dir}"`, "win32")).toBe(join(dir, "node.exe"));
			if (process.platform !== "win32") {
				// POSIX PATH uses ":" which a Windows drive letter would break.
				expect(browser.findNodeOnPath(`/missing:${dir}`, "linux")).toBe(join(dir, "node"));
			}
			expect(browser.findNodeOnPath("", "linux")).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
