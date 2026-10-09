/**
 * PHI_MCP_CONFIG names an MCP config file supplied by the program that launched
 * phi (same format as <agentDir>/mcp.json). It is merged right after the global
 * config with the "add only" rule; a missing or unusable file is reported on
 * stderr and ignored, never fatal.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../extensions/phi/mcp/config.ts";
import mcpExtension from "../extensions/phi/mcp/index.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

const require = createRequire(import.meta.url);

let root: string;
let agentDir: string;
let project: string;
let stderr: ReturnType<typeof vi.spyOn>;

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mcp-caller-config-"));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(project, ".phi"), { recursive: true });
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("PHI_MCP_CONFIG", () => {
	it("adds the servers of the caller's file after the global config, never replacing a global one", async () => {
		writeJson(join(agentDir, "mcp.json"), { mcpServers: { a: { command: "global-a" } } });
		const callerPath = join(root, "run-mcp.json");
		writeJson(callerPath, {
			mcpServers: { a: { command: "caller-a" }, b: { command: "caller-b", lifecycle: "eager" } },
		});
		vi.stubEnv("PHI_MCP_CONFIG", callerPath);

		const config = await loadConfig(project, { includeProject: false });
		expect(Object.keys(config.mcpServers).sort()).toEqual(["a", "b"]);
		expect(config.mcpServers.a?.command).toBe("global-a");
		expect(config.mcpServers.b?.command).toBe("caller-b");
		expect(config.mcpServers.b?.lifecycle).toBe("eager");
	});

	it("is used alone when there is no global config", async () => {
		const callerPath = join(root, "run-mcp.json");
		writeJson(callerPath, { mcpServers: { b: { command: "caller-b" } } });
		vi.stubEnv("PHI_MCP_CONFIG", callerPath);

		const config = await loadConfig(project, { includeProject: false });
		expect(Object.keys(config.mcpServers)).toEqual(["b"]);
	});

	it("keeps its servers when a trusted project redefines them", async () => {
		const callerPath = join(root, "run-mcp.json");
		writeJson(callerPath, { mcpServers: { b: { command: "caller-b" } } });
		writeJson(join(project, ".phi", "mcp.json"), { mcpServers: { b: { command: "project-b" } } });
		vi.stubEnv("PHI_MCP_CONFIG", callerPath);

		const config = await loadConfig(project, { includeProject: true });
		expect(config.mcpServers.b?.command).toBe("caller-b");
	});

	it("reports a missing file on stderr and ignores it", async () => {
		writeJson(join(agentDir, "mcp.json"), { mcpServers: { a: { command: "global-a" } } });
		const missing = join(root, "missing-mcp.json");
		vi.stubEnv("PHI_MCP_CONFIG", missing);

		const config = await loadConfig(project, { includeProject: false });
		expect(Object.keys(config.mcpServers)).toEqual(["a"]);
		expect(stderr).toHaveBeenCalledWith(
			`[pi-mcp] PHI_MCP_CONFIG: ${missing} does not exist; its MCP servers are ignored.`,
		);
	});

	it("reports an invalid file on stderr and ignores it", async () => {
		writeJson(join(agentDir, "mcp.json"), { mcpServers: { a: { command: "global-a" } } });
		const invalid = join(root, "invalid-mcp.json");
		writeFileSync(invalid, "{ not json");
		vi.stubEnv("PHI_MCP_CONFIG", invalid);

		const config = await loadConfig(project, { includeProject: false });
		expect(Object.keys(config.mcpServers)).toEqual(["a"]);
		expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`[pi-mcp] PHI_MCP_CONFIG: cannot use ${invalid} (`));
	});

	it("connects the caller's eager servers before a headless session starts", async () => {
		const sdk = (path: string): string => JSON.stringify(require.resolve(`@modelcontextprotocol/sdk/${path}`));
		const serverScript = join(root, "caller-server.cjs");
		writeFileSync(
			serverScript,
			`
const { Server } = require(${sdk("server/index.js")});
const { StdioServerTransport } = require(${sdk("server/stdio.js")});
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${sdk("types.js")});
const server = new Server({ name: "caller", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "ping", inputSchema: { type: "object" } }] }));
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "pong" }] }));
server.connect(new StdioServerTransport());
`,
		);
		const callerPath = join(root, "run-mcp.json");
		writeJson(callerPath, {
			mcpServers: { paperclip: { command: process.execPath, args: [serverScript], lifecycle: "eager" } },
		});
		vi.stubEnv("PHI_MCP_CONFIG", callerPath);

		const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
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
		const ctx = { cwd: project, isProjectTrusted: () => false, hasUI: false, ui: { notify: vi.fn() } };
		await events.get("session_start")?.({}, ctx);
		expect(active).toContain("mcp_paperclip_ping");
		await events.get("session_shutdown")?.({}, ctx);
	}, 30000);
});
