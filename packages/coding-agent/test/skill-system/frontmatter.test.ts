/**
 * Frontmatter parser/serializer tests (plan §6.1): round-trip, `:`/`#` in
 * quoted values, multi-line scalars, lists, BOM, unclosed frontmatter.
 */

import { describe, expect, it } from "vitest";
import { parseFrontmatter, serializeFrontmatter, stripBom } from "../../extensions/phi/skill-system/frontmatter.ts";

describe("frontmatter", () => {
	it("round-trips data + body", () => {
		const data = {
			name: "docker-deploy",
			description: "Deploy a container to staging in one command.",
			version: "0.1.0",
			author: "Phi Agent",
			license: "MIT",
			platforms: ["linux", "macos"],
			metadata: { phi: { tags: ["Docker", "Deployment"], category: "devops" } },
		};
		const body = "# docker-deploy\n\n## When to Use\n\nWhen deploying.\n";
		const raw = serializeFrontmatter(data, body);
		const parsed = parseFrontmatter(raw);
		expect(parsed.error).toBeUndefined();
		expect(parsed.data).toEqual(data);
		expect(parsed.body.trim()).toBe(body.trim());
	});

	it("keeps `:` and `#` inside quoted descriptions", () => {
		const description = "Use when parsing: handle # comments.";
		const raw = serializeFrontmatter({ name: "x", description }, "\nbody\n");
		const parsed = parseFrontmatter(raw);
		expect(parsed.data?.description).toBe(description);
	});

	it("parses multi-line double-quoted scalars", () => {
		const raw = '---\nname: x\ndescription: "line one\nline two"\n---\nbody\n';
		const parsed = parseFrontmatter(raw);
		expect(parsed.data?.description).toBe("line one\nline two");
	});

	it("parses inline and block lists", () => {
		const raw = "---\nname: x\nplatforms: [linux, macos]\ntags:\n  - alpha\n  - beta\n---\nbody\n";
		const parsed = parseFrontmatter(raw);
		expect(parsed.data?.platforms).toEqual(["linux", "macos"]);
		expect(parsed.data?.tags).toEqual(["alpha", "beta"]);
	});

	it("strips a leading BOM before parsing", () => {
		const raw = `\uFEFF---\nname: x\n---\nbody\n`;
		expect(stripBom(raw).startsWith("---")).toBe(true);
		const parsed = parseFrontmatter(raw);
		expect(parsed.data?.name).toBe("x");
	});

	it("reports absent frontmatter as undefined data", () => {
		const parsed = parseFrontmatter("# just a body\n");
		expect(parsed.data).toBeUndefined();
		expect(parsed.error).toBeUndefined();
	});

	it("reports an unclosed frontmatter block", () => {
		const parsed = parseFrontmatter("---\nname: x\n\nbody without closing\n");
		expect(parsed.error).toContain("not closed");
	});
});
