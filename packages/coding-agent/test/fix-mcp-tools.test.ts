import { readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { applicationType, McpOAuthProvider } from "../extensions/phi/mcp/oauth-provider.ts";
import {
	buildToolName,
	convertMcpContent,
	limitMcpContent,
	MCP_OUTPUT_MAX_BYTES,
	type PiExtensionAPI,
	ToolBridge,
} from "../extensions/phi/mcp/tool-bridge.ts";

const SETTINGS = { toolPrefix: "mcp", requestTimeoutMs: 1000, maxRetries: 0 };

interface RegisteredTool {
	name: string;
	label: string;
	execute: (...args: unknown[]) => Promise<{ content: unknown[]; details: unknown }>;
}

function fakePi(): { pi: PiExtensionAPI; tools: Map<string, RegisteredTool> } {
	const tools = new Map<string, RegisteredTool>();
	let active: string[] = [];
	const pi = {
		registerTool: (tool: RegisteredTool) => {
			tools.set(tool.name, tool);
		},
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => {
			active = names;
		},
	} as unknown as PiExtensionAPI;
	return { pi, tools };
}

/** Minimal client: tools/list returns `names`, tools/call returns `callResult`. */
function fakeClient(names: string[], callResult: unknown = { content: [] }): Client {
	return {
		request: async (req: { method: string }) => {
			if (req.method === "tools/list") {
				return { tools: names.map((name) => ({ name, inputSchema: { type: "object" } })) };
			}
			return callResult;
		},
	} as unknown as Client;
}

describe("fix-mcp: unique tool names", () => {
	it("gives colliding sanitized names a hash suffix instead of overwriting", async () => {
		const { pi, tools } = fakePi();
		const bridge = new ToolBridge(SETTINGS, pi);
		await bridge.refreshTools("my-srv", fakeClient(["read-file", "read_file"]));
		await bridge.refreshTools("my_srv", fakeClient(["read-file"]));

		expect(tools.size).toBe(3);
		const labels = [...tools.values()].map((t) => t.label).sort();
		expect(labels).toEqual(["read-file", "read-file", "read_file"]);
		expect(tools.has("mcp_my_srv_read_file")).toBe(true);
		for (const name of tools.keys()) expect(name).toMatch(/^[A-Za-z0-9_]{1,64}$/);
	});

	it("keeps the same names when a server refreshes its tools", async () => {
		const { pi, tools } = fakePi();
		const bridge = new ToolBridge(SETTINGS, pi);
		await bridge.refreshTools("s", fakeClient(["a-b", "a_b"]));
		const first = [...tools.keys()].sort();
		await bridge.refreshTools("s", fakeClient(["a-b", "a_b"]));
		expect([...tools.keys()].sort()).toEqual(first);
		expect(first).toHaveLength(2);
	});

	it("hashes long names deterministically within 64 characters", () => {
		const long = "x".repeat(80);
		const a = buildToolName("mcp", "server", long);
		expect(a.length).toBeLessThanOrEqual(64);
		expect(buildToolName("mcp", "server", long)).toBe(a);
		expect(buildToolName("mcp", "server", `${long}y`)).not.toBe(a);
	});
});

describe("fix-mcp: tool result content", () => {
	it("passes supported images as image blocks and keeps placeholders for others", () => {
		const content = convertMcpContent([
			{ type: "text", text: "hi" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "image", data: "AAAA", mimeType: "image/tiff" },
			{ type: "audio", data: "AAAA", mimeType: "audio/wav" },
			{ type: "resource", resource: { uri: "file:///a.jpg", mimeType: "image/jpeg", blob: "BBBB" } },
		]);
		expect(content[0]).toEqual({ type: "text", text: "hi" });
		expect(content[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
		expect(content[2]?.type).toBe("text");
		expect(content[3]?.type).toBe("text");
		expect(content[4]).toEqual({ type: "image", data: "BBBB", mimeType: "image/jpeg" });
	});

	it("leaves small results untouched", async () => {
		const content = [{ type: "text" as const, text: "small" }];
		const result = await limitMcpContent(content, async () => {
			throw new Error("must not save");
		});
		expect(result.content).toBe(content);
		expect(result.fullOutputPath).toBeUndefined();
	});

	it("truncates long text and saves the full output to an owner-only temp file", async () => {
		const big = `START${"é".repeat(MCP_OUTPUT_MAX_BYTES)}END`;
		const result = await limitMcpContent([
			{ type: "text", text: big },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
		const first = result.content[0];
		expect(first?.type).toBe("text");
		const text = first?.type === "text" ? first.text : "";
		expect(Buffer.byteLength(text, "utf8")).toBeLessThan(MCP_OUTPUT_MAX_BYTES + 500);
		expect(text.startsWith("START")).toBe(true);
		expect(text).toContain("bytes omitted");
		expect(text).toContain("END");
		expect(result.content[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
		expect(result.fullOutputPath).toBeDefined();
		const path = result.fullOutputPath as string;
		expect(text).toContain(path);
		expect(readFileSync(path, "utf8")).toBe(big);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		rmSync(dirname(path), { recursive: true, force: true });
	});

	it("returns image blocks from tool calls", async () => {
		const { pi, tools } = fakePi();
		const bridge = new ToolBridge(SETTINGS, pi);
		const callResult = { content: [{ type: "image", data: "AAAA", mimeType: "image/webp" }] };
		await bridge.refreshTools("img", fakeClient(["shot"], callResult));
		const tool = tools.get("mcp_img_shot");
		const out = await tool?.execute("id", {}, undefined, undefined, undefined);
		expect(out?.content).toEqual([{ type: "image", data: "AAAA", mimeType: "image/webp" }]);
	});
});

describe("fix-mcp: OAuth client metadata", () => {
	it("declares application_type native for loopback redirects", () => {
		const provider = new McpOAuthProvider("srv", "https://mcp.example.com", { type: "oauth" });
		expect((provider.clientMetadata as { application_type?: string }).application_type).toBe("native");
		expect(applicationType(["https://app.example.com/callback"])).toBe("web");
		expect(applicationType(["http://localhost:8080/cb"])).toBe("native");
		expect(applicationType(["myapp:/callback"])).toBe("native");
	});
});
