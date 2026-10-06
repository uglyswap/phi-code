#!/usr/bin/env node
// Minimal stdio MCP server used by the install smoke test.
// Usage: node mcp-test-server.mjs <dir that resolves @modelcontextprotocol/sdk>
// It deliberately uses the MCP SDK installed WITH phi (no extra install).
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const fromDir = process.argv[2];
if (!fromDir) {
	console.error("Usage: mcp-test-server.mjs <phi package dir>");
	process.exit(2);
}
const req = createRequire(join(fromDir, "package.json"));
const load = (spec) => import(pathToFileURL(req.resolve(spec)).href);
const { McpServer } = await load("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = await load("@modelcontextprotocol/sdk/server/stdio.js");
const zodModule = await import(pathToFileURL(createRequire(req.resolve("@modelcontextprotocol/sdk/server/mcp.js")).resolve("zod")).href);
const z = zodModule.z ?? zodModule.default ?? zodModule;

const server = new McpServer({ name: "phi-install-smoke", version: "1.0.0" });
server.registerTool(
	"echo",
	{ description: "Echoes the given text back, prefixed with 'echo:'", inputSchema: { text: z.string() } },
	async ({ text }) => ({ content: [{ type: "text", text: `echo:${text}` }] }),
);
await server.connect(new StdioServerTransport());
