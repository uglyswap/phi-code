/**
 * The Chrome bridge serves chrome_* tools, which need an interactive `/chrome authorize`.
 * Without a UI it must not take the machine-wide bridge port (unless PHI_CHROME_BRIDGE=1),
 * and stopping it must close open connections: a companion extension long-polling /next
 * over keep-alive used to keep a finished `phi -p` process alive indefinitely.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type Handler = (...args: unknown[]) => unknown;
type ChromeExtension = (pi: unknown) => void;

const agentDir = mkdtempSync(join(tmpdir(), "chrome-bridge-headless-"));
let port = 0;
let chromeExtension: ChromeExtension;

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

/** Resolves true when something accepts a TCP connection on the bridge port. */
async function portIsOpen(): Promise<boolean> {
	return await new Promise((resolveOpen) => {
		const socket = net.connect(port, "127.0.0.1");
		socket.once("connect", () => {
			socket.destroy();
			resolveOpen(true);
		});
		socket.once("error", () => resolveOpen(false));
	});
}

function load(): { events: Map<string, Handler> } {
	const events = new Map<string, Handler>();
	chromeExtension({
		on: (name: string, handler: Handler) => events.set(name, handler),
		registerCommand: vi.fn(),
		registerTool: vi.fn(),
		getActiveTools: () => [],
		setActiveTools: vi.fn(),
		exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
	});
	return { events };
}

function ctx(hasUI: boolean) {
	return {
		hasUI,
		ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } },
		sessionManager: {},
		cwd: agentDir,
	};
}

beforeAll(async () => {
	port = await freePort();
	vi.stubEnv("PI_CHROME_BRIDGE_PORT", String(port));
	vi.stubEnv("PHI_CODING_AGENT_DIR", agentDir);
	chromeExtension = (await import("../extensions/phi/chrome/index.ts")).default as ChromeExtension;
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("PI_CHROME_BRIDGE_PORT", String(port));
	vi.stubEnv("PHI_CODING_AGENT_DIR", agentDir);
});

afterAll(() => {
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("Chrome bridge without a UI", () => {
	it("does not listen on the bridge port nor write a bridge token", async () => {
		const { events } = load();
		const context = ctx(false);
		await events.get("session_start")?.({}, context);
		expect(await portIsOpen()).toBe(false);
		expect(existsSync(join(agentDir, "chrome-bridge.token"))).toBe(false);
		await events.get("session_shutdown")?.({}, context);
	});

	it("starts when PHI_CHROME_BRIDGE=1", async () => {
		vi.stubEnv("PHI_CHROME_BRIDGE", "1");
		const { events } = load();
		const context = ctx(false);
		await events.get("session_start")?.({}, context);
		expect(await portIsOpen()).toBe(true);
		await events.get("session_shutdown")?.({}, context);
	});
});

describe("Chrome bridge shutdown", () => {
	it("closes a keep-alive connection that long-polls /next", async () => {
		const { events } = load();
		const context = ctx(true);
		await events.get("session_start")?.({}, context);

		// Companion-extension-like client: polls /next again as soon as an answer arrives.
		const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
		const poll = (): Promise<void> =>
			new Promise((resolvePoll, reject) => {
				http
					.get(
						{
							host: "127.0.0.1",
							port,
							path: "/next?name=headless-test",
							headers: { origin: "chrome-extension://headlesstest" },
							agent,
						},
						(response) => {
							response.resume();
							response.on("end", () => resolvePoll());
						},
					)
					.on("error", reject);
			});
		let pollError: unknown;
		const polling = (async () => {
			try {
				for (;;) await poll();
			} catch (error) {
				pollError = error;
			}
		})();
		await new Promise((r) => setTimeout(r, 300));

		await events.get("session_shutdown")?.({}, context);
		const stopped = await Promise.race([
			polling.then(() => true),
			new Promise<boolean>((r) => setTimeout(() => r(false), 2000)),
		]);
		agent.destroy();
		expect(stopped).toBe(true);
		expect(pollError).toBeInstanceOf(Error);
		expect(await portIsOpen()).toBe(false);
	}, 10000);
});
