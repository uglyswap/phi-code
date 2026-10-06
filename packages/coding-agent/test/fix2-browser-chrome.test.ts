/**
 * FIX2-BROWSER regressions for the Chrome bridge:
 * - /chrome revoke must make the companion service worker forget the tabs it
 *   instruments for early console/network capture (chrome.storage.session).
 * - onboarding copies the extension path with pbcopy over stdin, never through a shell.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const agentDir = mkdtempSync(join(tmpdir(), "fix2-browser-chrome-"));

async function freePort(): Promise<number> {
	return await new Promise((resolvePort, reject) => {
		const server = net.createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => resolvePort(typeof address === "object" && address ? address.port : 0));
		});
	});
}

type Handler = (...args: unknown[]) => unknown;

describe("fix2-browser: /chrome revoke clears early-capture tabs", () => {
	const events = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	let port = 0;
	const ctx = {
		ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } },
		sessionManager: {},
		cwd: agentDir,
	};

	beforeAll(async () => {
		port = await freePort();
		process.env.PI_CHROME_BRIDGE_PORT = String(port);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PHI_CODING_AGENT_DIR = agentDir;
		const extension = (await import("../extensions/phi/chrome/index.ts")).default;
		extension({
			on: (name: string, handler: Handler) => events.set(name, handler),
			registerCommand: (name: string, command: { handler: Handler }) => commands.set(name, command),
			registerTool: vi.fn(),
			getActiveTools: () => [],
			setActiveTools: vi.fn(),
			exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
		} as never);
		await events.get("session_start")?.({}, ctx);
	});

	afterAll(() => {
		events.get("session_shutdown")?.({}, ctx);
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("queues a capture.clear command for the extension", async () => {
		await commands.get("chrome")?.handler("revoke", ctx);
		const response = await fetch(`http://127.0.0.1:${port}/next?name=test`, {
			headers: { origin: "chrome-extension://fix2test" },
		});
		const payload = (await response.json()) as { type: string; command?: { action: string } };
		expect(payload.type).toBe("command");
		expect(payload.command?.action).toBe("capture.clear");
	});
});

describe("fix2-browser: service worker capture.clear", () => {
	it("empties the in-memory set and chrome.storage.session", async () => {
		const session = new Map<string, unknown>();
		const listener = { addListener: () => undefined };
		const chrome = {
			runtime: {
				id: "fix2",
				getManifest: () => ({ version: "0" }),
				onInstalled: listener,
				onStartup: listener,
			},
			alarms: { onAlarm: listener, create: () => undefined, get: async () => undefined, clear: async () => true },
			action: { onClicked: listener },
			storage: {
				session: {
					get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
					set: async (items: Record<string, unknown>) => {
						for (const [k, v] of Object.entries(items)) session.set(k, v);
					},
					remove: async (key: string) => {
						session.delete(key);
					},
				},
			},
			tabs: { onRemoved: listener, get: async () => ({ id: 7, groupId: 1 }) },
			tabGroups: { get: async () => ({ id: 1, title: "Pi Session: x" }) },
		};
		const context = vm.createContext({
			chrome,
			console,
			setInterval: () => 0,
			clearInterval: () => undefined,
			setTimeout,
			clearTimeout,
			fetch: () => new Promise(() => undefined),
			navigator: { userAgent: "test" },
			URL,
		});
		const source = readFileSync(
			join(import.meta.dirname, "../extensions/phi/chrome/browser-extension/service_worker.js"),
			"utf8",
		);
		vm.runInContext(source, context);
		const sw = context as unknown as {
			requestEarlyCapture: (tabId: number) => Promise<void>;
			shouldEarlyCapture: (tabId: number) => Promise<boolean>;
			dispatch: (action: string, params: Record<string, unknown>) => Promise<unknown>;
		};

		await sw.requestEarlyCapture(7);
		expect(await sw.shouldEarlyCapture(7)).toBe(true);
		expect(session.get("piEarlyCaptureTabs")).toEqual([7]);

		await expect(sw.dispatch("capture.clear", {})).resolves.toEqual({ cleared: true });
		expect(await sw.shouldEarlyCapture(7)).toBe(false);
		expect(session.has("piEarlyCaptureTabs")).toBe(false);
	});
});

describe("fix2-browser: copyToMacClipboard", () => {
	it("spawns pbcopy without a shell and writes the text verbatim on stdin", async () => {
		const { copyToMacClipboard } = await import("../extensions/phi/chrome/index.ts");
		const tricky = '/Users/x/$(touch pwned)/`id`/"q"/browser-extension';
		let written = "";
		const spawnFn = vi.fn((_cmd: string, _args: string[], _opts: unknown) => {
			const child = new EventEmitter() as EventEmitter & { stdin: Writable; kill: () => boolean };
			child.kill = () => true;
			child.stdin = new Writable({
				write(chunk, _enc, cb) {
					written += chunk.toString();
					cb();
				},
				final(cb) {
					cb();
					setImmediate(() => child.emit("close", 0));
				},
			});
			return child;
		});
		await copyToMacClipboard(tricky, 1_000, spawnFn as never);
		expect(spawnFn).toHaveBeenCalledTimes(1);
		const [cmd, args, opts] = spawnFn.mock.calls[0];
		expect(cmd).toBe("pbcopy");
		expect(args).toEqual([]);
		expect(opts).toMatchObject({ shell: false });
		expect(written).toBe(tricky);
	});

	it("resolves instead of throwing when pbcopy is missing", async () => {
		const { copyToMacClipboard } = await import("../extensions/phi/chrome/index.ts");
		const spawnFn = vi.fn(() => {
			const child = new EventEmitter() as EventEmitter & { stdin: Writable; kill: () => boolean };
			child.kill = () => true;
			child.stdin = new Writable({ write: (_c, _e, cb) => cb() });
			setImmediate(() => child.emit("error", new Error("spawn pbcopy ENOENT")));
			return child;
		});
		await expect(copyToMacClipboard("x", 1_000, spawnFn as never)).resolves.toBeUndefined();
	});
});
