import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectContextFiles } from "../src/core/resource-loader.ts";

describe("blank context files", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "phi-ctx-blank-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("ignores an empty AGENTS.md but keeps non-empty ones", () => {
		const project = join(root, "project");
		mkdirSync(project, { recursive: true });
		writeFileSync(join(root, "AGENTS.md"), "   \n");
		writeFileSync(join(project, "AGENTS.md"), "project rules");
		const files = loadProjectContextFiles({ cwd: project, agentDir: join(root, "agent") });
		const ours = files.filter((f) => f.path.startsWith(root));
		expect(ours.map((f) => f.content)).toEqual(["project rules"]);
	});

	it("an empty AGENTS.override.md still hides AGENTS.md in the same directory", () => {
		writeFileSync(join(root, "AGENTS.override.md"), "");
		writeFileSync(join(root, "AGENTS.md"), "hidden");
		const files = loadProjectContextFiles({ cwd: root, agentDir: join(root, "agent") });
		expect(files.filter((f) => f.path.startsWith(root))).toEqual([]);
	});
});
