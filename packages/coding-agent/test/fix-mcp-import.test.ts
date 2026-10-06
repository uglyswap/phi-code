import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { splitCommandLine } from "../extensions/phi/mcp/command-line.ts";
import { loadConfig } from "../extensions/phi/mcp/config.ts";
import {
	convertExternalEntry,
	importExternalMcpConfigs,
	parseCodexServers,
} from "../extensions/phi/mcp/import-configs.ts";
import { parseToml } from "../extensions/phi/mcp/toml.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

describe("fix-mcp: convertExternalEntry", () => {
	it("converts Claude/VS Code/Cursor http entries to streamable-http", () => {
		const result = convertExternalEntry({ type: "http", url: "https://mcp.example.com/mcp" }, "claude");
		expect(result.entry).toEqual({ transport: "streamable-http", url: "https://mcp.example.com/mcp" });
		expect(convertExternalEntry({ url: "https://x.example/mcp" }, "cursor").entry).toEqual({
			transport: "streamable-http",
			url: "https://x.example/mcp",
		});
		expect(convertExternalEntry({ type: "sse", url: "https://x.example/sse" }, "vscode").entry?.transport).toBe(
			"sse",
		);
	});

	it("maps Gemini httpUrl to streamable-http and url to sse", () => {
		expect(convertExternalEntry({ httpUrl: "https://g.example/mcp", timeout: 5000 }, "gemini").entry).toEqual({
			transport: "streamable-http",
			url: "https://g.example/mcp",
			requestTimeoutMs: 5000,
		});
		expect(convertExternalEntry({ url: "https://g.example/sse" }, "gemini").entry?.transport).toBe("sse");
	});

	it("keeps stdio entries and stringifies scalar env values", () => {
		const result = convertExternalEntry({ command: "npx", args: ["-y", "pkg"], env: { PORT: 3000 } }, "codex");
		expect(result.entry).toEqual({ command: "npx", args: ["-y", "pkg"], env: { PORT: "3000" } });
	});

	it("rejects VS Code input-variable entries and invalid entries with a reason", () => {
		const input = convertExternalEntry({ type: "stdio", command: "x", env: { KEY: `\${input:key}` } }, "vscode");
		expect(input.entry).toBeUndefined();
		expect(input.error).toContain("input:");
		expect(convertExternalEntry({ type: "http" }, "claude").error).toContain("url");
		expect(convertExternalEntry({ type: "websocket", url: "wss://x" }, "claude").error).toContain("unsupported");
		expect(convertExternalEntry("nope", "claude").error).toBeDefined();
	});

	it("warns about dropped settings and unexpanded placeholders", () => {
		const result = convertExternalEntry({ command: "x", cwd: "/tmp", env: { TOKEN: `\${TOKEN}` } }, "claude");
		expect(result.entry).toBeDefined();
		expect(result.warnings.join("\n")).toContain("cwd");
		expect(result.warnings.join("\n")).toContain("placeholders");
	});
});

describe("fix-mcp: Codex TOML", () => {
	it("nests [mcp_servers.X.env] under X instead of creating a server named X.env", () => {
		const servers = parseCodexServers(
			[
				"model = 'o3' # comment",
				"[mcp_servers.fs]",
				'command = "npx"',
				"args = [",
				'  "-y",',
				"  '@modelcontextprotocol/server-filesystem', # trailing comment",
				"]",
				"[mcp_servers.fs.env]",
				'API_KEY = "a \\"quoted\\" value"',
				"[mcp_servers.remote]",
				'url = "https://r.example/mcp"',
				'http_headers = { Authorization = "Bearer x" }',
				"tool_timeout_sec = 12",
			].join("\r\n"),
		);
		expect(Object.keys(servers)).toEqual(["fs", "remote"]);
		expect(servers.fs).toEqual({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-filesystem"],
			env: { API_KEY: 'a "quoted" value' },
		});
		expect(convertExternalEntry(servers.remote, "codex").entry).toEqual({
			transport: "streamable-http",
			url: "https://r.example/mcp",
			headers: { Authorization: "Bearer x" },
			requestTimeoutMs: 12000,
		});
	});

	it("parses quoted keys, arrays of tables and rejects prototype keys", () => {
		const doc = parseToml('[a."b.c"]\nx = true\n[[list]]\nn = 1\n[[list]]\nn = 2.5\n');
		expect(doc).toEqual({ a: { "b.c": { x: true } }, list: [{ n: 1 }, { n: 2.5 }] });
		expect(() => parseToml("[mcp_servers.__proto__]\nx = 1\n")).toThrow(/forbidden key/);
		expect(() => parseToml('x = "unterminated\n')).toThrow(/line 1/);
	});
});

describe("fix-mcp: importExternalMcpConfigs", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "fix-mcp-home-"));
		agentDir = join(home, "agent");
		cwd = join(home, "project");
		mkdirSync(cwd, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("writes a config that phi loads, skipping only the invalid entry", async () => {
		writeFileSync(
			join(home, ".claude.json"),
			JSON.stringify({
				mcpServers: {
					remote: { type: "http", url: "https://mcp.example.com/mcp", headers: { "X-Key": "k" } },
					local: { command: "node", args: ["server.js"] },
					broken: { type: "http" },
				},
			}),
		);
		mkdirSync(join(home, ".codex"));
		writeFileSync(
			join(home, ".codex", "config.toml"),
			'[mcp_servers.codexsrv]\ncommand = "uvx"\nargs = ["srv"]\n[mcp_servers.codexsrv.env]\nA = "1"\n',
		);
		mkdirSync(join(cwd, ".vscode"));
		writeFileSync(
			join(cwd, ".vscode", "mcp.json"),
			JSON.stringify({ servers: { gh: { type: "http", url: "https://gh.example/mcp" } } }),
		);

		const result = importExternalMcpConfigs(cwd);
		expect(result.imported.sort()).toEqual(
			[
				"codexsrv (~/.codex/config.toml)",
				"gh (.vscode/mcp.json)",
				"local (~/.claude.json)",
				"remote (~/.claude.json)",
			].sort(),
		);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]).toContain("broken");

		const config = await loadConfig(cwd, { includeProject: false });
		expect(Object.keys(config.mcpServers).sort()).toEqual(["codexsrv", "gh", "local", "remote"]);
		expect(config.mcpServers.remote?.transport).toBe("streamable-http");
		expect(config.mcpServers.codexsrv?.env).toEqual({ A: "1" });
		if (process.platform !== "win32") {
			const { statSync } = await import("node:fs");
			expect(statSync(join(agentDir, "mcp.json")).mode & 0o777).toBe(0o600);
		}
	});

	it("never rewrites a phi config it cannot parse", () => {
		mkdirSync(agentDir, { recursive: true });
		const target = join(agentDir, "mcp.json");
		writeFileSync(target, "{ not json");
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "x" } } }));
		const result = importExternalMcpConfigs(cwd);
		expect(result.imported).toEqual([]);
		expect(result.errors[0]).toContain("Refusing to import");
		expect(readFileSync(target, "utf8")).toBe("{ not json");
	});

	it("does not overwrite existing entries", () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { a: { command: "mine" } } }));
		writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "theirs" } } }));
		const result = importExternalMcpConfigs(cwd);
		expect(result.skipped).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")).mcpServers.a.command).toBe("mine");
	});
});

describe("fix-mcp: splitCommandLine", () => {
	it("respects quotes and keeps Windows backslashes", () => {
		expect(splitCommandLine('"C:\\Program Files\\srv\\server.exe" --root "my dir" \'a b\' plain')).toEqual([
			"C:\\Program Files\\srv\\server.exe",
			"--root",
			"my dir",
			"a b",
			"plain",
		]);
		expect(splitCommandLine('npx  -y   pkg ""')).toEqual(["npx", "-y", "pkg", ""]);
		expect(splitCommandLine('say "a \\"b\\""')).toEqual(["say", 'a "b"']);
		expect(() => splitCommandLine('npx "open')).toThrow(/Unterminated/);
	});
});
