/**
 * Without a UI (print / json mode) the prompt is sent right after session_start:
 * the MCP extension must wait (bounded by PHI_MCP_STARTUP_WAIT_MS) for the eager
 * servers so their tools are part of the very first request, and report startup
 * failures on stderr since ctx.ui.notify is a no-op there.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mcpExtension, { mcpStartupWaitMs } from "../extensions/phi/mcp/index.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

const require = createRequire(import.meta.url);

/** Real stdio MCP server exposing one tool, "echo"; connects after `delayMs` (argv[2]). */
function writeServerScript(dir: string): string {
	const sdk = (path: string): string => JSON.stringify(require.resolve(`@modelcontextprotocol/sdk/${path}`));
	const script = `
const { Server } = require(${sdk("server/index.js")});
const { StdioServerTransport } = require(${sdk("server/stdio.js")});
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${sdk("types.js")});
const server = new Server({ name: "headless", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "pong" }] }));
setTimeout(() => server.connect(new StdioServerTransport()), Number(process.argv[2] ?? "0"));
`;
	const path = join(dir, "headless-server.cjs");
	writeFileSync(path, script);
	return path;
}

interface Harness {
	events: Map<string, (event: unknown, ctx: unknown) => Promise<void>>;
	active: () => string[];
}

async function loadExtension(): Promise<Harness> {
	const events: Harness["events"] = new Map();
	let active: string[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => events.set(name, handler),
		registerCommand: () => {},
		registerTool: () => {},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
		sendUserMessage: () => {},
	};
	await mcpExtension(pi as never);
	return { events, active: () => active };
}

function ctx(hasUI: boolean) {
	return { cwd: process.cwd(), isProjectTrusted: () => false, hasUI, ui: { notify: vi.fn() } };
}

let root: string;
let serverScript: string;
let stderr: ReturnType<typeof vi.spyOn>;

function writeGlobalConfig(servers: Record<string, unknown>): void {
	writeFileSync(join(root, "mcp.json"), JSON.stringify({ settings: { maxRetries: 0 }, mcpServers: servers }));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mcp-headless-"));
	serverScript = writeServerScript(root);
	vi.stubEnv(ENV_AGENT_DIR, root);
	stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("MCP eager servers without a UI", () => {
	it("session_start waits until the eager servers' tools are registered", async () => {
		writeGlobalConfig({ srv: { command: process.execPath, args: [serverScript, "300"], lifecycle: "eager" } });
		const h = await loadExtension();
		const context = ctx(false);
		await h.events.get("session_start")?.({}, context);
		expect(h.active()).toContain("mcp_srv_echo");
		await h.events.get("session_shutdown")?.({}, context);
	}, 30000);

	it("the wait is bounded by PHI_MCP_STARTUP_WAIT_MS", async () => {
		vi.stubEnv("PHI_MCP_STARTUP_WAIT_MS", "500");
		writeGlobalConfig({ srv: { command: process.execPath, args: [serverScript, "5000"], lifecycle: "eager" } });
		const h = await loadExtension();
		const context = ctx(false);
		const started = Date.now();
		await h.events.get("session_start")?.({}, context);
		expect(Date.now() - started).toBeLessThan(3000);
		expect(h.active()).not.toContain("mcp_srv_echo");
		await h.events.get("session_shutdown")?.({}, context);
	}, 30000);

	it("with a UI, session_start does not wait", async () => {
		writeGlobalConfig({ srv: { command: process.execPath, args: [serverScript, "5000"], lifecycle: "eager" } });
		const h = await loadExtension();
		const context = ctx(true);
		const started = Date.now();
		await h.events.get("session_start")?.({}, context);
		expect(Date.now() - started).toBeLessThan(1000);
		await h.events.get("session_shutdown")?.({}, context);
	}, 30000);

	it("a server that fails to start is reported on stderr", async () => {
		writeGlobalConfig({ bad: { command: "phi-mcp-headless-missing-command-xyz", lifecycle: "eager" } });
		const h = await loadExtension();
		const context = ctx(false);
		await h.events.get("session_start")?.({}, context);
		expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^\[pi-mcp\] Failed to start bad: /));
		await h.events.get("session_shutdown")?.({}, context);
	}, 30000);
});

describe("PHI_MCP_STARTUP_WAIT_MS", () => {
	it("defaults to 15000 ms and accepts any non-negative number", () => {
		expect(mcpStartupWaitMs({})).toBe(15000);
		expect(mcpStartupWaitMs({ PHI_MCP_STARTUP_WAIT_MS: "2500" })).toBe(2500);
		expect(mcpStartupWaitMs({ PHI_MCP_STARTUP_WAIT_MS: "0" })).toBe(0);
		expect(mcpStartupWaitMs({ PHI_MCP_STARTUP_WAIT_MS: "-1" })).toBe(15000);
		expect(mcpStartupWaitMs({ PHI_MCP_STARTUP_WAIT_MS: "soon" })).toBe(15000);
	});
});
