import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importExternalMcpConfigs, normalizeProjectPath } from "../extensions/phi/mcp/import-configs.ts";
import { McpOAuthProvider } from "../extensions/phi/mcp/oauth-provider.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

describe("fix2-mcp: OAuth state", () => {
	it("generates a random state when none was set, stable for the provider", async () => {
		const a = new McpOAuthProvider("srv", "https://a.example/mcp", { type: "oauth" });
		const b = new McpOAuthProvider("srv", "https://a.example/mcp", { type: "oauth" });
		const stateA = await a.state();
		expect(stateA).toMatch(/^[0-9a-f]{64}$/);
		expect(await a.state()).toBe(stateA);
		expect(await b.state()).not.toBe(stateA);
	});

	it("keeps the state set by the /mcp:auth flow", async () => {
		const provider = new McpOAuthProvider("srv", "https://a.example/mcp", { type: "oauth" });
		provider.setState("registered-state");
		expect(await provider.state()).toBe("registered-state");
	});
});

describe("fix2-mcp: normalizeProjectPath", () => {
	it("ignores case, separators and trailing slashes on Windows", () => {
		expect(normalizeProjectPath("C:\\Users\\Quent\\proj\\", "win32")).toBe(
			normalizeProjectPath("c:/users/quent/proj", "win32"),
		);
		expect(normalizeProjectPath("C:\\", "win32")).toBe("c:/");
	});

	it("is exact (case-sensitive) elsewhere", () => {
		expect(normalizeProjectPath("/home/u/proj/", "linux")).toBe("/home/u/proj");
		expect(normalizeProjectPath("/home/u/Proj", "linux")).not.toBe(normalizeProjectPath("/home/u/proj", "linux"));
		expect(normalizeProjectPath("/", "linux")).toBe("/");
	});
});

describe("fix2-mcp: ~/.claude.json project servers", () => {
	let home: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "fix2-mcp-home-"));
		agentDir = join(home, "agent");
		cwd = join(home, "project");
		mkdirSync(cwd, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	/** How Claude Code may spell the cwd as a `projects` key on this platform. */
	function projectKey(path: string): string {
		return process.platform === "win32" ? path.replace(/\\/g, "/").toUpperCase() : path;
	}

	it("imports the current project's servers and reports a clash with a global one", () => {
		writeFileSync(
			join(home, ".claude.json"),
			JSON.stringify({
				mcpServers: { shared: { command: "global-cmd" } },
				projects: {
					[projectKey(cwd)]: {
						mcpServers: {
							local: { type: "http", url: "https://local.example/mcp" },
							shared: { command: "project-cmd" },
						},
					},
					[join(home, "other")]: { mcpServers: { foreign: { command: "nope" } } },
				},
			}),
		);

		const result = importExternalMcpConfigs(cwd);
		expect(result.imported).toEqual([
			"shared (~/.claude.json)",
			`local (~/.claude.json (project ${projectKey(cwd)}))`,
		]);
		expect(result.skipped).toHaveLength(1);
		expect(result.skipped[0]).toContain("conflicts with shared from ~/.claude.json");
		expect(result.warnings.join("\n")).toContain("shared: defined in both");

		const written = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8")).mcpServers;
		expect(Object.keys(written).sort()).toEqual(["local", "shared"]);
		expect(written.shared.command).toBe("global-cmd");
		expect(written.local).toEqual({ transport: "streamable-http", url: "https://local.example/mcp" });
	});
});
