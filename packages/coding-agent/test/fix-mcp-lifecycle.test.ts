import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyConfig, type McpConfig, type ServerConfig } from "../extensions/phi/mcp/config.ts";
import { McpError } from "../extensions/phi/mcp/errors.ts";
import mcpExtension from "../extensions/phi/mcp/index.ts";
import { ServerManager } from "../extensions/phi/mcp/server-manager.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

/** A command that cannot be spawned: every connection attempt fails fast. */
const MISSING_COMMAND = "phi-fix-mcp-missing-command-xyz";

function stdioServer(): ServerConfig {
	return { command: MISSING_COMMAND, args: [], transport: "stdio", lifecycle: "eager" };
}

function configWith(servers: Record<string, ServerConfig>, maxRetries: number): McpConfig {
	const config = createEmptyConfig();
	config.settings.maxRetries = maxRetries;
	config.mcpServers = servers;
	return config;
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 10));
	}
}

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "fix-mcp-agent-"));
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(agentDir, { recursive: true, force: true });
});

describe("fix-mcp: ServerManager retries", () => {
	it("stopServer cancels a pending retry and the chain never reconnects", async () => {
		const manager = new ServerManager(configWith({ bad: stdioServer() }, 5));
		const started = Date.now();
		const pending = manager.startServer("bad", process.cwd());
		const server = manager.getServer("bad");
		await waitFor(() => server?.retryTimer != null);
		expect(server?.state).toBe("starting");

		await manager.stopServer("bad");
		await expect(pending).resolves.toBeUndefined();
		// Cancelled right away instead of waiting out the retry schedule (1+3+5+10+30 s).
		expect(Date.now() - started).toBeLessThan(3000);
		expect(server?.state).toBe("stopped");
		expect(server?.retryTimer).toBeNull();
		await new Promise((r) => setTimeout(r, 1200));
		expect(server?.state).toBe("stopped");
		expect(server?.retryCount).toBe(1);
	});

	it("startServer rejects when every attempt failed", async () => {
		const manager = new ServerManager(configWith({ bad: stdioServer() }, 0));
		const error = await manager.startServer("bad", process.cwd()).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(McpError);
		expect((error as McpError).code).toBe("connection");
		expect(manager.getServer("bad")?.state).toBe("stopped");
	});

	it("an OAuth server without tokens is marked auth-required without opening a browser", async () => {
		const onAuthRequired = vi.fn();
		const oauthServer: ServerConfig = {
			args: [],
			transport: "streamable-http",
			url: "http://127.0.0.1:9/mcp",
			auth: { type: "oauth" },
			lifecycle: "eager",
		};
		const manager = new ServerManager(configWith({ secure: oauthServer }, 5), { onAuthRequired });
		const error = await manager.startServer("secure", process.cwd()).catch((e: unknown) => e);
		expect((error as McpError).code).toBe("auth");
		expect((error as McpError).message).toContain("/mcp:auth secure");
		expect(onAuthRequired).toHaveBeenCalledTimes(1);
		expect(manager.getServer("secure")?.retryCount).toBe(0);
		expect(manager.getServerLogs("secure")).toContain("no stderr");
	});
});

interface Handlers {
	events: Map<string, (event: unknown, ctx: unknown) => Promise<void>>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
}

async function loadExtension(): Promise<Handlers> {
	const events: Handlers["events"] = new Map();
	const commands: Handlers["commands"] = new Map();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => events.set(name, handler),
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, options),
		registerTool: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
		sendUserMessage: () => {},
	};
	await mcpExtension(pi as never);
	return { events, commands };
}

function fakeCtx(notify: (message: string, level?: string) => void) {
	return { cwd: process.cwd(), isProjectTrusted: () => false, hasUI: false, ui: { notify } };
}

describe("fix-mcp: extension wiring", () => {
	it("keeps /mcp available and reports an invalid config", async () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { x: { type: "http" } } }));
		const { commands } = await loadExtension();
		expect(commands.has("mcp")).toBe(true);
		expect(commands.has("mcp:import")).toBe(true);
		const notify = vi.fn();
		await commands.get("mcp")?.handler("", fakeCtx(notify));
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("config error"), "error");
	});

	it("session_start does not wait for eager servers to connect", async () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				settings: { maxRetries: 5 },
				mcpServers: { bad: { command: MISSING_COMMAND, lifecycle: "eager" } },
			}),
		);
		const { events, commands } = await loadExtension();
		const notify = vi.fn();
		const ctx = fakeCtx(notify);
		const started = Date.now();
		await events.get("session_start")?.({}, ctx);
		expect(Date.now() - started).toBeLessThan(1000);

		// /mcp:start on a server that is already retrying does not claim success.
		await commands.get("mcp:start")?.handler("bad", ctx);
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Started bad"), "info");

		// Shutdown cancels the background retries; no failure is reported to the old session.
		await events.get("session_shutdown")?.({}, ctx);
		await new Promise((r) => setTimeout(r, 50));
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Failed to start"), "error");
	});

	it("/mcp:start reports a failure instead of Started", async () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({ settings: { maxRetries: 0 }, mcpServers: { bad: { command: MISSING_COMMAND } } }),
		);
		const { commands } = await loadExtension();
		const notify = vi.fn();
		await commands.get("mcp:start")?.handler("bad", fakeCtx(notify));
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Failed to start bad"), "error");
		expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Started bad"), "info");
	});
});
