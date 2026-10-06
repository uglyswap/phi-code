import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatSkillsForPrompt, loadSkills, type Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";

function writeSkill(root: string, name: string): void {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: Bundled skill for tests.\n---\n\n# ${name}\n`,
	);
}

describe("fix2-core bundled skills location", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "fix2-core-skills-"));
		vi.stubEnv("PI_PACKAGE_DIR", "");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("loads bundled skills from getPackageDir() (Bun binary / PHI_PACKAGE_DIR), not import.meta.url", () => {
		// In a Bun binary import.meta.url points into $bunfs; the skills are staged next to the
		// executable, which getPackageDir() resolves. PHI_PACKAGE_DIR exercises that same path.
		const packageDir = join(tempRoot, "package");
		writeSkill(join(packageDir, "skills"), "fix2-bundled-skill");
		vi.stubEnv("PHI_PACKAGE_DIR", packageDir);

		const agentDir = join(tempRoot, "agent");
		const cwd = join(tempRoot, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });

		const { skills } = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
		const bundled = skills.find((skill) => skill.name === "fix2-bundled-skill");
		expect(bundled?.filePath).toBe(join(packageDir, "skills", "fix2-bundled-skill", "SKILL.md"));
	});
});

describe("fix2-core skills hint when only bash is active (#8552)", () => {
	const skill: Skill = {
		name: "demo",
		description: "Demo skill",
		filePath: "/skills/demo/SKILL.md",
		baseDir: "/skills/demo",
		sourceInfo: createSyntheticSourceInfo("/skills/demo/SKILL.md", { source: "test" }),
		disableModelInvocation: false,
	};

	it("formatSkillsForPrompt names bash instead of the read tool", () => {
		const prompt = formatSkillsForPrompt([skill], "bash");
		expect(prompt).toContain("Use bash to load a skill's file");
		expect(prompt).not.toContain("read tool");
		expect(formatSkillsForPrompt([skill])).toContain("Use the read tool to load a skill's file");
	});

	it("the system prompt lists skills with a bash hint when read is not selected", () => {
		for (const customPrompt of [undefined, "Custom prompt."]) {
			const prompt = buildSystemPrompt({ cwd: "/work", selectedTools: ["bash"], skills: [skill], customPrompt });
			expect(prompt).toContain("<name>demo</name>");
			expect(prompt).toContain("Use bash to load a skill's file");
			expect(prompt).not.toContain("Use the read tool");
		}
	});
});
