import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decide, loadPolicy, resetPolicyCache } from "../src/core/permissions/policy.ts";
import { tierForTool } from "../src/core/permissions/tiers.ts";

let dir: string;
let home: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "phi-perm-proj-"));
	home = mkdtempSync(join(tmpdir(), "phi-perm-home-"));
	process.env.HOME = home;
	resetPolicyCache();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
	resetPolicyCache();
});

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
		const policy = loadPolicy(dir);
		expect(policy.legacyAllowAll).toBe(false);
		expect(decide(policy, "read", { path: "x" }).decision).toBe("allow");
		expect(decide(policy, "edit", { path: "x" }).decision).toBe("prompt");
		expect(decide(policy, "bash", { command: "ls" }).decision).toBe("deny");
	});

	it("matches pattern rules before tier fallback", () => {
		writeProjectConfig({
			exec: "prompt",
			rules: [
				{ tool: "bash", pattern: "git *", decision: "allow" },
				{ tool: "bash", pattern: "rm -rf /*", decision: "deny" },
			],
		});
		const policy = loadPolicy(dir);
		expect(decide(policy, "bash", { command: "git status" }).decision).toBe("allow");
		expect(decide(policy, "bash", { command: "rm -rf /tmp/x" }).decision).toBe("deny");
		expect(decide(policy, "bash", { command: "make build" }).decision).toBe("prompt");
	});

	it("project rules are evaluated before user rules", () => {
		mkdirSync(join(home, ".phi", "agent"), { recursive: true });
		writeFileSync(
			join(home, ".phi", "agent", "permissions.json"),
			JSON.stringify({ rules: [{ tool: "bash", pattern: "git *", decision: "deny" }] }),
		);
		writeProjectConfig({ rules: [{ tool: "bash", pattern: "git *", decision: "allow" }] });
		const policy = loadPolicy(dir);
		expect(decide(policy, "bash", { command: "git push" }).decision).toBe("allow");
	});
});
