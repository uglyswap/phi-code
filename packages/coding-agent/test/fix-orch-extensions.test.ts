import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SmartRouter } from "sigma-agents";
import { afterAll, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

// Every extension under test resolves ~ through os.homedir(): point it at a
// throwaway directory so nothing touches the real ~/.phi.
const { fakeHome } = vi.hoisted(() => {
	const os = require("node:os") as typeof import("node:os");
	const fs = require("node:fs") as typeof import("node:fs");
	const path = require("node:path") as typeof import("node:path");
	return { fakeHome: fs.mkdtempSync(path.join(os.tmpdir(), "fix-orch-home-")) };
});
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => fakeHome, default: { ...actual, homedir: () => fakeHome } };
});

import { ENV_AGENT_DIR } from "../src/config.ts";
import { _resetConfigWatcher, getConfigWatcher } from "../src/core/config-watcher.ts";

const agentDir = join(fakeHome, ".phi", "agent");
mkdirSync(agentDir, { recursive: true });
const prevAgentDir = process.env[ENV_AGENT_DIR];
process.env[ENV_AGENT_DIR] = agentDir;

afterAll(() => {
	if (prevAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = prevAgentDir;
	_resetConfigWatcher();
	rmSync(fakeHome, { recursive: true, force: true });
});

interface FakePi {
	pi: any;
	tools: Map<string, any>;
	commands: Map<string, (args: string, ctx: any) => Promise<void>>;
	handlers: Map<string, Array<(event: any, ctx: any) => any>>;
	busSubscriptions: number;
	setModelCalls: any[];
}

function makeFakePi(): FakePi {
	const fake: FakePi = {
		pi: undefined,
		tools: new Map(),
		commands: new Map(),
		handlers: new Map(),
		busSubscriptions: 0,
		setModelCalls: [],
	};
	fake.pi = {
		registerTool: (def: any) => fake.tools.set(def.name, def),
		registerCommand: (name: string, def: any) => fake.commands.set(name, def.handler),
		on: (event: string, handler: any) => {
			const list = fake.handlers.get(event) ?? [];
			list.push(handler);
			fake.handlers.set(event, list);
		},
		events: {
			emit: () => {},
			on: () => {
				fake.busSubscriptions++;
				return () => {
					fake.busSubscriptions--;
				};
			},
		},
		setModel: async (model: any) => {
			fake.setModelCalls.push(model);
			return true;
		},
	};
	return fake;
}

async function emit(fake: FakePi, event: string, payload: any, ctx: any): Promise<any[]> {
	const out: any[] = [];
	for (const h of fake.handlers.get(event) ?? []) out.push(await h(payload, ctx));
	return out;
}

const uiCtx = (extra: Record<string, unknown> = {}) => ({
	ui: { notify: () => {} },
	cwd: process.cwd(),
	...extra,
});

describe("FIX-ORCH: learn writes valid YAML frontmatter where the docs say", () => {
	it("quotes a description containing ':' and writes to ~/.phi/agent/skills", async () => {
		const { default: learnExtension } = await import("../extensions/phi/learn.ts");
		const fake = makeFakePi();
		learnExtension(fake.pi);
		const r = await fake.tools
			.get("learn")
			.execute(
				"c",
				{ name: "Retry flaky npm", lesson: "Fix: run npm ci twice # when ETIMEDOUT\nsteps..." },
				undefined,
				undefined,
				undefined,
			);
		expect(r.details.promoted).toBe(false);
		const r2 = await fake.tools.get("learn").execute(
			"c",
			{
				name: "Retry flaky npm",
				lesson: "Fix: run npm ci twice # when ETIMEDOUT\nsteps...",
				promote_to_skill: true,
			},
			undefined,
			undefined,
			undefined,
		);
		expect(r2.details.promoted).toBe(true);
		const file = join(fakeHome, ".phi", "agent", "skills", "retry-flaky-npm", "SKILL.md");
		const content = readFileSync(file, "utf-8");
		const fm = parseYaml(content.split("---")[1]) as { name: string; description: string };
		expect(fm.name).toBe("retry-flaky-npm");
		expect(fm.description).toBe("Fix: run npm ci twice # when ETIMEDOUT");
		// The tool's own description no longer points at a directory it never writes.
		expect(JSON.stringify(fake.tools.get("learn").parameters)).not.toContain("managed-skills");
	});
});

describe("FIX-ORCH: skill-loader reads project skill folders only for trusted projects", () => {
	it("hints a .claude/skills skill only when ctx.isProjectTrusted() is true", async () => {
		const project = mkdtempSync(join(fakeHome, "project-"));
		const skillDir = join(project, ".claude", "skills", "zorblaxquux");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\ndescription: zorblaxquux deployment procedure\n---\n\n# Zorblaxquux\n\n- zorblaxquux steps\n",
		);
		const prevCwd = process.cwd();
		process.chdir(project);
		try {
			const { default: skillLoaderExtension } = await import("../extensions/phi/skill-loader.ts");
			const fake = makeFakePi();
			skillLoaderExtension(fake.pi);
			const input = { source: "interactive", text: "please run the zorblaxquux zorblaxquux procedure" };

			const [untrusted] = await emit(fake, "input", input, uiCtx({ isProjectTrusted: () => false }));
			expect(untrusted.action).toBe("continue");

			const [trusted] = await emit(fake, "input", input, uiCtx({ isProjectTrusted: () => true }));
			expect(trusted.action).toBe("transform");
			expect(trusted.text).toContain("zorblaxquux");
		} finally {
			process.chdir(prevCwd);
		}
	});
});

describe("FIX-ORCH: smart-router", () => {
	it("auto-switch resolves provider/id refs from routing.json", async () => {
		const config = SmartRouter.defaultConfig();
		config.routes.code.preferredModel = "prov/model-x";
		config.routes.code.fallback = "prov/model-y";
		writeFileSync(join(fakeHome, ".phi", "agent", "routing.json"), JSON.stringify(config));

		const { default: smartRouterExtension } = await import("../extensions/phi/smart-router.ts");
		const fake = makeFakePi();
		smartRouterExtension(fake.pi);
		const ctx = uiCtx({
			modelRegistry: {
				getAvailable: () => [
					{ provider: "other", id: "current" },
					{ provider: "prov", id: "model-x" },
				],
			},
			model: { provider: "other", id: "current" },
		});
		await fake.commands.get("routing")!("reload", ctx);
		await fake.commands.get("routing")!("autoswitch on", ctx);
		await emit(fake, "input", { source: "interactive", text: "implement a new function and class" }, ctx);
		expect(fake.setModelCalls).toEqual([{ provider: "prov", id: "model-x" }]);
	});

	it("registers its routing_json_changed listener once across session switches", async () => {
		const { default: smartRouterExtension } = await import("../extensions/phi/smart-router.ts");
		const fake = makeFakePi();
		smartRouterExtension(fake.pi);
		await emit(fake, "session_start", { type: "session_start" }, uiCtx());
		await emit(fake, "session_start", { type: "session_start" }, uiCtx());
		await emit(fake, "session_start", { type: "session_start" }, uiCtx());
		expect(fake.busSubscriptions).toBe(1);
		await emit(fake, "session_shutdown", { type: "session_shutdown" }, uiCtx());
		expect(fake.busSubscriptions).toBe(0);
	});
});

describe("FIX-ORCH: keys watcher listeners", () => {
	it("are registered once and follow the current session's UI", async () => {
		const { default: keysExtension } = await import("../extensions/phi/keys.ts");
		const watcher = getConfigWatcher();
		const before = watcher.listenerCount("models_json_changed");
		const fake = makeFakePi();
		keysExtension(fake.pi);
		const seen: string[] = [];
		const ctxA = uiCtx({ ui: { notify: (m: string) => seen.push(`A:${m}`) } });
		const ctxB = uiCtx({ ui: { notify: (m: string) => seen.push(`B:${m}`) } });
		await emit(fake, "session_start", { type: "session_start" }, ctxA);
		await emit(fake, "session_start", { type: "session_start" }, ctxB);
		expect(watcher.listenerCount("models_json_changed")).toBe(before + 1);
		seen.length = 0;
		watcher.emit("routing_json_changed");
		expect(seen).toHaveLength(1);
		expect(seen[0].startsWith("B:")).toBe(true);
		await emit(fake, "session_shutdown", { type: "session_shutdown" }, ctxB);
		expect(watcher.listenerCount("models_json_changed")).toBe(before);
		watcher.stop();
	});
});

describe("FIX-ORCH: /permissions shows the effective (merged) tiers", () => {
	it("reflects a trusted project file that tightens a tier", async () => {
		writeFileSync(join(agentDir, "permissions.json"), JSON.stringify({ exec: "allow", write: "allow" }));
		const project = mkdtempSync(join(fakeHome, "perm-"));
		mkdirSync(join(project, ".phi"), { recursive: true });
		writeFileSync(join(project, ".phi", "permissions.json"), JSON.stringify({ exec: "deny" }));
		const { default: permissionsExtension } = await import("../extensions/phi/permissions.ts");
		const fake = makeFakePi();
		permissionsExtension(fake.pi);
		const notes: string[] = [];
		const ctx = (trusted: boolean) => ({
			ui: { notify: (m: string) => notes.push(m) },
			cwd: project,
			isProjectTrusted: () => trusted,
		});
		await fake.commands.get("permissions")!("", ctx(true));
		expect(notes.at(-1)).toContain("exec=deny");
		expect(notes.at(-1)).toContain("write=allow");
		await fake.commands.get("permissions")!("", ctx(false));
		expect(notes.at(-1)).toContain("exec=allow");
		expect(notes.at(-1)).toContain("ignored (untrusted project)");
	});
});
