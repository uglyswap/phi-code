import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

interface ParsedGitSource {
	type: string;
}

interface PackageManagerInternals {
	getPackageManagerName(): string;
	getGitDependencyInstallArgs(): string[];
	parseSource(source: string): ParsedGitSource;
	getGitInstallPath(source: ParsedGitSource, scope: string): string;
}

interface PackageManagerCommands {
	runCommand(...args: unknown[]): Promise<void>;
	runCommandCapture(...args: unknown[]): Promise<string>;
}

function commands(manager: DefaultPackageManager): PackageManagerCommands {
	return manager as unknown as PackageManagerCommands;
}

const OFFLINE_KEYS = ["PI_OFFLINE", "PHI_OFFLINE"] as const;

function normalizeForMatch(value: string): string {
	return value.replace(/\\/g, "/");
}

describe("fix-core package manager", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;
	const savedEnv: Partial<Record<(typeof OFFLINE_KEYS)[number], string>> = {};

	beforeEach(() => {
		for (const key of OFFLINE_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = join(tmpdir(), `phi-fix-core-pm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
	});

	afterEach(() => {
		for (const key of OFFLINE_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeInstalledExample(version: string): void {
		const installedPath = join(tempDir, CONFIG_DIR_NAME, "npm", "node_modules", "example");
		mkdirSync(installedPath, { recursive: true });
		writeFileSync(join(installedPath, "package.json"), JSON.stringify({ name: "example", version }));
		settingsManager.setProjectPackages(["npm:example"]);
	}

	it("does not downgrade an npm package newer than the registry (#8226)", async () => {
		writeInstalledExample("2.0.0");
		vi.spyOn(commands(packageManager), "runCommandCapture").mockResolvedValue('"1.9.0"');
		const runCommandSpy = vi.spyOn(commands(packageManager), "runCommand").mockResolvedValue(undefined);

		await packageManager.update("npm:example");
		expect(runCommandSpy).not.toHaveBeenCalled();
		expect(await packageManager.checkForAvailableUpdates()).toEqual([]);
	});

	it("still reports a strictly newer registry version", async () => {
		writeInstalledExample("1.0.0");
		vi.spyOn(commands(packageManager), "runCommandCapture").mockResolvedValue('"1.1.0"');
		const updates = await packageManager.checkForAvailableUpdates();
		expect(updates).toHaveLength(1);
	});

	it("discovers nested Markdown skills in .agents/skills but not root files (#8255)", async () => {
		const agentsSkillsDir = join(tempDir, ".agents", "skills");
		mkdirSync(join(agentsSkillsDir, "third-party", "vendor", "pack"), { recursive: true });
		const rootSkill = join(agentsSkillsDir, "root-file.md");
		const nestedMarkdownSkill = join(agentsSkillsDir, "third-party", "child-skill.md");
		const deepSkill = join(agentsSkillsDir, "third-party", "vendor", "pack", "deep-skill.md");
		writeFileSync(rootSkill, "---\nname: root-file\ndescription: Root markdown file\n---\n");
		writeFileSync(nestedMarkdownSkill, "---\nname: child-skill\ndescription: Nested markdown skill\n---\n");
		writeFileSync(deepSkill, "---\nname: deep-skill\ndescription: Deep markdown skill\n---\n");
		mkdirSync(join(tempDir, "work"), { recursive: true });

		const pm = new DefaultPackageManager({ cwd: join(tempDir, "work"), agentDir, settingsManager });
		const result = await pm.resolve();
		expect(result.skills.some((r) => r.path === rootSkill)).toBe(false);
		expect(result.skills.some((r) => r.path === nestedMarkdownSkill && r.enabled)).toBe(true);
		expect(result.skills.some((r) => r.path === deepSkill && r.enabled)).toBe(true);
	});

	it("uses a distinct temporary checkout per pinned git ref (#9982)", () => {
		const internals = packageManager as unknown as PackageManagerInternals;
		const oldParsed = internals.parseSource("git:github.com/example/repo@aaaaaaa");
		const newParsed = internals.parseSource("git:github.com/example/repo@bbbbbbb");
		const unpinned = internals.parseSource("git:github.com/example/repo");
		const oldPath = internals.getGitInstallPath(oldParsed, "temporary");
		const newPath = internals.getGitInstallPath(newParsed, "temporary");
		expect(oldPath).not.toBe(newPath);
		expect(internals.getGitInstallPath(unpinned, "temporary")).not.toBe(oldPath);
		expect(normalizeForMatch(newPath).endsWith("example/repo")).toBe(true);
	});

	it("installs git package dependencies without auto-installing peers (#9863)", () => {
		const cases: Array<{ npmCommand?: string[]; name: string; args: string[] }> = [
			{ name: "npm", args: ["install", "--omit=dev", "--legacy-peer-deps"] },
			{ npmCommand: ["bun"], name: "bun", args: ["install", "--omit=dev", "--omit=peer"] },
			{
				npmCommand: ["npm", "exec", "--", "pnpm"],
				name: "pnpm",
				args: [
					"install",
					"--prod",
					"--config.auto-install-peers=false",
					"--config.strict-peer-dependencies=false",
					"--config.strict-dep-builds=false",
				],
			},
			{
				npmCommand: ["corepack", "pnpm"],
				name: "pnpm",
				args: [
					"install",
					"--prod",
					"--config.auto-install-peers=false",
					"--config.strict-peer-dependencies=false",
					"--config.strict-dep-builds=false",
				],
			},
		];
		for (const { npmCommand, name, args } of cases) {
			const manager = new DefaultPackageManager({
				cwd: tempDir,
				agentDir,
				settingsManager: SettingsManager.inMemory(npmCommand ? { npmCommand } : {}),
			}) as unknown as PackageManagerInternals;
			expect(manager.getPackageManagerName()).toBe(name);
			expect(manager.getGitDependencyInstallArgs()).toEqual(args);
		}
	});
});
