/**
 * PHI_DISABLE_PROJECT_EXTENSIONS / PHI_DISABLE_BUNDLED_EXTENSIONS must act on the
 * real CLI load path (package-manager resolve), not only on discoverAndLoadExtensions.
 */

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filterExtensionsByOptOut, type ResolvedResource } from "../src/core/package-manager.ts";

const agentDir = join("/tmp", "phi-agent");
const res = (path: string, scope: "user" | "project"): ResolvedResource => ({
	path,
	enabled: true,
	metadata: { source: "local", scope, origin: "top-level" },
});

const all = [
	res(join(agentDir, "extensions", "memory.ts"), "user"), // bundled copy
	res(join(agentDir, "extensions", "my-own.ts"), "user"), // user's own
	res(join("/repo", ".phi", "extensions", "repo-ext.ts"), "project"),
];

describe("extension opt-out env vars", () => {
	afterEach(() => {
		delete process.env.PHI_DISABLE_PROJECT_EXTENSIONS;
		delete process.env.PHI_DISABLE_BUNDLED_EXTENSIONS;
	});

	it("keeps everything by default", () => {
		expect(filterExtensionsByOptOut(all, agentDir)).toHaveLength(3);
	});

	it("drops project extensions with PHI_DISABLE_PROJECT_EXTENSIONS=1", () => {
		process.env.PHI_DISABLE_PROJECT_EXTENSIONS = "1";
		const kept = filterExtensionsByOptOut(all, agentDir).map((r) => r.metadata.scope);
		expect(kept).toEqual(["user", "user"]);
	});

	it("drops only the bundled phi copies with PHI_DISABLE_BUNDLED_EXTENSIONS=1", () => {
		process.env.PHI_DISABLE_BUNDLED_EXTENSIONS = "1";
		const kept = filterExtensionsByOptOut(all, agentDir).map((r) => r.path);
		expect(kept).toEqual([
			join(agentDir, "extensions", "my-own.ts"),
			join("/repo", ".phi", "extensions", "repo-ext.ts"),
		]);
	});
});
