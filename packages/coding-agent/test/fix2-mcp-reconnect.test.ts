import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpError } from "../extensions/phi/mcp/errors.ts";
import mcpExtension from "../extensions/phi/mcp/index.ts";
import { type PiExtensionAPI, ToolBridge } from "../extensions/phi/mcp/tool-bridge.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

const require = createRequire(import.meta.url);

/**
 * Real stdio MCP server (low-level SDK Server, no zod schemas): tools "echo" and
 * "die" (answers, then exits so the next health check fails).
 */
function writeServerScript(dir: string): string {
	const sdk = (path: string): string => JSON.stringify(require.resolve(`@modelcontextprotocol/sdk/${path}`));
	const script = `
const { Server } = require(${sdk("server/index.js")});
const { StdioServerTransport } = require(${sdk("server/stdio.js")});
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${sdk("types.js")});
const server = new Server({ name: "fix2", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{ name: "echo", inputSchema: { type: "object" } },
		{ name: "die", inputSchema: { type: "object" } },
	],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
	if (req.params.name === "die") setTimeout(() => process.exit(0), 20);
	return { content: [{ type: "text", text: "pong:" + req.params.name }] };
});
server.connect(new StdioServerTransport());
`;
	const path = join(dir, "fix2-server.cjs");
	writeFileSync(path, script);
	return path;
}

interface Tool {
	execute: (...args: unknown[]) => Promise<{ content: { type: string; text?: string }[] }>;
}

interface Harness {
	events: Map<string, (event: unknown, ctx: unknown) => Promise<void>>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	tools: Map<string, Tool>;
	active: () => string[];
}

async function loadExtension(): Promise<Harness> {
	const events: Harness["events"] = new Map();
	const commands: Harness["commands"] = new Map();
	const tools = new Map<string, Tool>();
	let active: string[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => events.set(name, handler),
		registerCommand: (name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, options),
		registerTool: (tool: Tool & { name: string }) => tools.set(tool.name, tool),
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
		sendUserMessage: () => {},
	};
	await mcpExtension(pi as never);
	return { events, commands, tools, active: () => active };
}

function ctxFor(cwd: string, trusted: boolean) {
	return { cwd, isProjectTrusted: () => trusted, hasUI: false, ui: { notify: vi.fn() } };
}

async function waitFor(condition: () => boolean, timeoutMs = 10000): Promise<void> {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
		await new Promise((r) => setTimeout(r, 20));
	}
}

let root: string;
let agentDir: string;
let project: string;
let serverScript: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fix2-mcp-"));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(project, ".phi"), { recursive: true });
	serverScript = writeServerScript(root);
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

function writeGlobalConfig(server: Record<string, unknown>, settings: Record<string, unknown> = {}): void {
	writeFileSync(
		join(agentDir, "mcp.json"),
		JSON.stringify({ settings, mcpServers: { srv: { command: process.execPath, args: [serverScript], ...server } } }),
	);
}

describe("fix2-mcp: toolPrefix from a reloaded config", () => {
	it("registers tools under the new prefix and deactivates the old names", async () => {
		writeGlobalConfig({});
		writeFileSync(join(project, ".phi", "mcp.json"), JSON.stringify({ settings: { toolPrefix: "zz" } }));
		const h = await loadExtension();

		// Untrusted project: same config as at load time, default prefix.
		const untrusted = ctxFor(project, false);
		await h.events.get("session_start")?.({}, untrusted);
		await h.commands.get("mcp:start")?.handler("srv", untrusted);
		expect(h.active()).toContain("mcp_srv_echo");

		// Trusted project: its settings override the prefix.
		const trusted = ctxFor(project, true);
		await h.events.get("session_start")?.({}, trusted);
		expect(h.active().filter((n) => n.startsWith("mcp_"))).toEqual([]);
		await h.commands.get("mcp:start")?.handler("srv", trusted);
		expect(h.active().sort()).toEqual(["zz_srv_die", "zz_srv_echo"]);
		const result = await h.tools.get("zz_srv_echo")?.execute("id", {});
		expect(result?.content[0]?.text).toBe("pong:echo");

		await h.events.get("session_shutdown")?.({}, trusted);
	}, 30000);

	it("ToolBridge.updateSettings keeps tools when the prefix is unchanged", () => {
		let active = ["mcp_a_x"];
		const pi = {
			registerTool: () => {},
			getActiveTools: () => active,
			setActiveTools: (names: string[]) => {
				active = names;
			},
		} as unknown as PiExtensionAPI;
		const bridge = new ToolBridge({ toolPrefix: "mcp", requestTimeoutMs: 1000, maxRetries: 0 }, pi);
		bridge.updateSettings({ toolPrefix: "mcp", requestTimeoutMs: 5000, maxRetries: 1 });
		expect(active).toEqual(["mcp_a_x"]);
	});
});

describe("fix2-mcp: failed health check", () => {
	it("tools fail with an explicit error while reconnecting, then come back", async () => {
		writeGlobalConfig({ healthCheckIntervalMs: 100 }, { maxRetries: 2 });
		const h = await loadExtension();
		const ctx = ctxFor(project, false);
		await h.events.get("session_start")?.({}, ctx);
		await h.commands.get("mcp:start")?.handler("srv", ctx);
		expect(h.active()).toContain("mcp_srv_echo");

		await h.tools.get("mcp_srv_die")?.execute("id", {});
		await waitFor(() => !h.active().includes("mcp_srv_echo"));
		const error = await h.tools
			.get("mcp_srv_echo")
			?.execute("id", {})
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(McpError);
		expect((error as McpError).code).toBe("connection");
		expect((error as McpError).message).toMatch(/"srv" is disconnected.*reconnecting/);

		// The retry (1 s) spawns a fresh process: tools are active and work again.
		await waitFor(() => h.active().includes("mcp_srv_echo"));
		const result = await h.tools.get("mcp_srv_echo")?.execute("id", {});
		expect(result?.content[0]?.text).toBe("pong:echo");

		await h.events.get("session_shutdown")?.({}, ctx);
	}, 30000);
});
