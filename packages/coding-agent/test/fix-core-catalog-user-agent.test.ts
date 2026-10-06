import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	getModelCatalogUserAgent,
	getPiUserAgent,
	PI_MODEL_CATALOG_COMPAT_VERSION,
} from "../src/utils/pi-user-agent.ts";

// Copied from pi scripts/model-catalog-protocol.ts (PI_USER_AGENT_RE): pi.dev only selects a
// version-compatible catalog revision for User-Agents matching this pattern.
const PI_USER_AGENT_RE = /^pi\/([^\s()]+)(?: \([^;()]+(?:;\s*[^;()]+(?:;\s*[^()]+)?)?\))?$/i;

describe("fix-core pi.dev model catalog User-Agent", () => {
	it("announces the upstream base version so pi.dev serves a compatible revision", () => {
		const userAgent = getModelCatalogUserAgent("0.99.1");
		expect(PI_USER_AGENT_RE.exec(userAgent)?.[1]).toBe(PI_MODEL_CATALOG_COMPAT_VERSION);
		expect(userAgent).toContain("phi/0.99.1");
	});

	it("keeps the phi User-Agent (not matched by the catalog protocol) for other endpoints", () => {
		expect(PI_USER_AGENT_RE.test(getPiUserAgent("0.99.1"))).toBe(false);
	});

	it("tracks the phi-code-ai package version (the upstream model schema phi implements)", () => {
		const aiPackage = JSON.parse(readFileSync(new URL("../../ai/package.json", import.meta.url), "utf-8")) as {
			version: string;
		};
		expect(PI_MODEL_CATALOG_COMPAT_VERSION).toBe(aiPackage.version);
	});
});
