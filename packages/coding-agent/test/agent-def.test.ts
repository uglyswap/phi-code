import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents, loadAgentDef, parseAgentMarkdown } from "../extensions/phi/providers/agent-def.js";

const BUNDLED_AGENTS = ["code", "explore", "plan", "review", "test"];

describe("agent-def shared parser", () => {
	it("parses frontmatter fields and body", () => {
		const def = parseAgentMarkdown(
			`---\nname: myagent\ndescription: Does things\ntools: read, write, bash\nmodel: default\n---\n\nYou are my agent.`,
			"/x/myagent.md",
			"project",
		);
		expect(def).not.toBeNull();
		expect(def!.name).toBe("myagent");
		expect(def!.description).toBe("Does things");
		expect(def!.tools).toEqual(["read", "write", "bash"]);
		expect(def!.model).toBe("default");
		expect(def!.systemPrompt).toBe("You are my agent.");
		expect(def!.source).toBe("project");
	});

	it("falls back to the file basename when name is missing", () => {
		const def = parseAgentMarkdown(`---\ntools: read\n---\nBody`, "/dir/fallback.md", "global");
		expect(def!.name).toBe("fallback");
	});

	it("returns null without a frontmatter block", () => {
		expect(parseAgentMarkdown("Just a markdown file", "/x/a.md", "bundled")).toBeNull();
	});

	it("handles empty tools", () => {
		const def = parseAgentMarkdown(`---\nname: a\n---\nBody`, "/x/a.md", "bundled");
		expect(def!.tools).toEqual([]);
	});
});

describe("agent-def discovery", () => {
	let tempCwd: string;

	beforeEach(() => {
		tempCwd = join(tmpdir(), `agent-def-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(tempCwd, ".phi", "agents"), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempCwd, { recursive: true, force: true });
	});

	it("finds the five bundled phase agents (any source)", () => {
		const names = discoverAgents(tempCwd).map((a) => a.name);
		for (const expected of BUNDLED_AGENTS) {
			expect(names).toContain(expected);
		}
	});

	it("project agents take precedence over global/bundled ones with the same name", () => {
		writeFileSync(
			join(tempCwd, ".phi", "agents", "plan.md"),
			`---\nname: plan\ndescription: project override\ntools: read\n---\nProject plan agent.`,
		);
		const plan = discoverAgents(tempCwd).find((a) => a.name === "plan");
		expect(plan!.source).toBe("project");
		expect(plan!.systemPrompt).toBe("Project plan agent.");

		const loaded = loadAgentDef("plan", tempCwd);
		expect(loaded!.source).toBe("project");
	});

	it("loadAgentDef resolves every bundled phase agent used by /plan", () => {
		for (const name of BUNDLED_AGENTS) {
			const def = loadAgentDef(name, tempCwd);
			expect(def, `agent ${name} must resolve`).not.toBeNull();
			expect(def!.systemPrompt.length).toBeGreaterThan(100);
			expect(def!.tools.length).toBeGreaterThan(0);
		}
	});
});
