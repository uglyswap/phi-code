import { describe, expect, it } from "vitest";
import { assertSupportedPlaywright } from "../src/sync_api.ts";

/**
 * Camoufox is driven over juggler, whose shape is fixed by the playwright
 * version. From 1.61.0 playwright sends a `Browser.setDefaultViewport` field
 * this Firefox 135 build rejects, and the user sees
 * `Found property "<root>.viewport.isMobile"` on their first newPage() — a
 * message with no hint that a version is at fault. These cases lock the
 * boundary that was measured against the real binary.
 */
describe("playwright-core compatibility guard", () => {
	it.each(["1.58.0", "1.58.1", "1.59.1", "1.60.0", "1.60.99"])("accepts %s", (version) => {
		expect(() => assertSupportedPlaywright(version)).not.toThrow();
	});

	it.each(["1.61.0", "1.61.1", "1.62.0", "1.62.1", "2.0.0"])("refuses %s with an actionable message", (version) => {
		expect(() => assertSupportedPlaywright(version)).toThrow(/>=1\.58\.0 <1\.61\.0/);
	});

	it("refuses a version below the floor", () => {
		expect(() => assertSupportedPlaywright("1.57.0")).toThrow(/cannot drive this Camoufox build/);
	});

	it("stays out of the way when the version cannot be read", () => {
		// A missing or unparseable version is not a reason to refuse to launch:
		// the launch either works or fails on its own terms.
		expect(() => assertSupportedPlaywright(undefined)).not.toThrow();
		expect(() => assertSupportedPlaywright("next")).not.toThrow();
	});
});
