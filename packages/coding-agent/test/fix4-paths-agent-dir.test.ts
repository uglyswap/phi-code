import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Two distinct throwaway directories: a fake home (what os.homedir() returns)
// and a custom agent dir (PHI_CODING_AGENT_DIR). Extensions must use the agent
// dir; nothing may land in <home>/.phi/agent.
const { fakeHome, customAgentDir } = vi.hoisted(() => {
	const os = require("node:os") as typeof import("node:os");
	const fs = require("node:fs") as typeof import("node:fs");
	const path = require("node:path") as typeof import("node:path");
	return {
		fakeHome: fs.mkdtempSync(path.join(os.tmpdir(), "fix4-paths-home-")),
		customAgentDir: fs.mkdtempSync(path.join(os.tmpdir(), "fix4-paths-agent-")),
	};
});
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => fakeHome, default: { ...actual, homedir: () => fakeHome } };
});

import { ENV_AGENT_DIR } from "../src/config.ts";

const prevAgentDir = process.env[ENV_AGENT_DIR];
process.env[ENV_AGENT_DIR] = customAgentDir;

afterAll(() => {
	if (prevAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = prevAgentDir;
	rmSync(fakeHome, { recursive: true, force: true });
	rmSync(customAgentDir, { recursive: true, force: true });
});

interface FakePi {
	pi: unknown;
	commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
}

function makeFakePi(): FakePi {
	const fake: FakePi = { pi: undefined, commands: new Map(), handlers: new Map() };
	fake.pi = {
		registerTool: () => {},
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) =>
			fake.commands.set(name, def.handler),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = fake.handlers.get(event) ?? [];
			list.push(handler);
			fake.handlers.set(event, list);
		},
		events: { emit: () => {}, on: () => () => {} },
		setModel: async () => true,
	};
	return fake;
}

const legacyAgentDir = () => join(fakeHome, ".phi", "agent");

describe("fix4-paths: phi extensions honor PHI_CODING_AGENT_DIR", () => {
	it("agent-def searches <agentDir>/agents for global agents", async () => {
		const { agentSearchDirs } = await import("../extensions/phi/providers/agent-def.ts");
		const global = agentSearchDirs("/some/project").find((d) => d.source === "global");
		expect(global?.dir).toBe(join(customAgentDir, "agents"));
	});

	it("learn writes promoted skills into <agentDir>/skills", async () => {
		const { managedSkillsDir } = await import("../extensions/phi/learn.ts");
		expect(managedSkillsDir()).toBe(join(customAgentDir, "skills"));
	});

	it("setup writes routing.json into the agent dir", async () => {
		const { writeRoutingConfig } = await import("../extensions/phi/setup.ts");
		const path = await writeRoutingConfig({ routes: {}, default: { model: "m", agent: null } } as never);
		expect(path).toBe(join(customAgentDir, "routing.json"));
		expect(existsSync(path)).toBe(true);
		expect(existsSync(join(legacyAgentDir(), "routing.json"))).toBe(false);
	});

	it("smart-router loads routing.json from the agent dir", async () => {
		const { SmartRouter } = await import("sigma-agents");
		const config = SmartRouter.defaultConfig();
		const [firstRoute] = Object.keys(config.routes) as Array<keyof typeof config.routes>;
		config.routes[firstRoute].preferredModel = "fix4-paths/sentinel-model";
		writeFileSync(join(customAgentDir, "routing.json"), JSON.stringify(config));
		const { default: smartRouter } = await import("../extensions/phi/smart-router.ts");
		const fake = makeFakePi();
		smartRouter(fake.pi as never);
		for (const h of fake.handlers.get("session_start") ?? []) await h({}, {});
		const notes: string[] = [];
		await fake.commands.get("routing")?.("", { ui: { notify: (msg: string) => notes.push(msg) } });
		expect(notes.join("\n")).toContain("fix4-paths/sentinel-model");
	});

	it("skill-loader lists global skills from <agentDir>/skills", async () => {
		const skillDir = join(customAgentDir, "skills", "fix4-paths-probe");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: fix4-paths-probe\ndescription: probe skill for the agent dir test\n---\n\nBody.\n",
		);
		const { default: skillLoader } = await import("../extensions/phi/skill-loader.ts");
		const fake = makeFakePi();
		skillLoader(fake.pi as never);
		const notes: string[] = [];
		const ctx = { isProjectTrusted: () => false, ui: { notify: (msg: string) => notes.push(msg) } };
		await fake.commands.get("skills")?.("", ctx);
		const listing = notes.join("\n");
		expect(listing).toContain("fix4-paths-probe");
		expect(listing).toContain(skillDir);
	});

	it("no phi extension (except browser.ts, out of scope) hardcodes homedir()/.phi/agent", () => {
		const root = join(__dirname, "..", "extensions", "phi");
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const full = join(dir, name);
				if (statSync(full).isDirectory()) walk(full);
				else if (name.endsWith(".ts") && name !== "browser.ts") {
					const src = readFileSync(full, "utf-8");
					if (/homedir\(\)\s*,\s*["']\.phi["']\s*,\s*["']agent["']/.test(src))
						offenders.push(relative(root, full));
				}
			}
		};
		walk(root);
		expect(offenders).toEqual([]);
	});
});
