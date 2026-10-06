/**
 * Regression: the local backend of sandbox_run must honour the settings.json
 * `shellPath` like the bash tool does (global settings always, project
 * .phi/settings.json only when the project is trusted).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandResult, RunOptions } from "../extensions/phi/providers/execution.ts";
import { defaultLocalShell, readShellPathSetting, resolveSandbox } from "../extensions/phi/providers/sandbox.ts";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.ts";

describe("sandbox local backend honours settings shellPath", () => {
	let root: string;
	let agentDir: string;
	let project: string;
	let globalShell: string;
	let projectShell: string;
	let savedAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fix2-orch-shellpath-"));
		agentDir = join(root, "agent");
		project = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(project, CONFIG_DIR_NAME), { recursive: true });
		globalShell = join(root, "global-bash.exe");
		projectShell = join(root, "project-bash.exe");
		writeFileSync(globalShell, "");
		writeFileSync(projectShell, "");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: globalShell }));
		savedAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		if (savedAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = savedAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	it("reads the global shellPath, and the project one only when trusted", () => {
		expect(readShellPathSetting(project, false)).toBe(globalShell);
		writeFileSync(join(project, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ shellPath: projectShell }));
		expect(readShellPathSetting(project, false)).toBe(globalShell);
		expect(readShellPathSetting(project, true)).toBe(projectShell);
	});

	it("defaultLocalShell uses the configured path", () => {
		expect(defaultLocalShell(globalShell)).toEqual({ shell: globalShell, args: ["-c"] });
	});

	it("resolveSandbox local exec runs through the configured shell", async () => {
		const seen: Array<RunOptions | undefined> = [];
		const fake = (command: string, options?: RunOptions): CommandResult => {
			seen.push(options);
			return { command, exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false };
		};
		const sb = resolveSandbox({
			cwd: project,
			deps: {
				dockerAvailable: false,
				listFiles: () => ["package.json"],
				readConfig: () => undefined,
				runCommand: fake,
				runCommandAsync: async (command, options) => fake(command, options),
			},
		});
		expect(sb.backend).toBe("local");
		sb.exec("echo hi");
		await sb.execAsync("echo hi");
		expect(seen.map((o) => o?.shell?.shell)).toEqual([globalShell, globalShell]);
	});
});
