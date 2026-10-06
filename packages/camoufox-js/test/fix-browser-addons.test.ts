/**
 * PHI-VENDOR regression: an offline first launch must not leave an empty
 * addons/UBO dir that makes every later launch fail with InvalidAddonPath.
 */
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", online: false }));

vi.mock("../src/pkgman.ts", () => ({
	getPath: (p: string) => join(state.root, p),
	webdl: vi.fn(async () => {
		if (!state.online) throw new Error("Failed to download (offline)");
		return Buffer.from("zip");
	}),
	unzip: vi.fn(async (_buf: Buffer, extractPath: string) => {
		fs.writeFileSync(join(extractPath, "manifest.json"), "{}");
	}),
}));

vi.mock("../src/utils.ts", () => ({ getAsBooleanFromENV: () => false }));

const { confirmPaths, maybeDownloadAddons } = await import("../src/addons.ts");

describe("maybeDownloadAddons offline recovery", () => {
	beforeEach(() => {
		state.root = fs.mkdtempSync(join(tmpdir(), "fix-browser-addons-"));
		state.online = false;
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(state.root, { recursive: true, force: true });
	});

	test("a failed download leaves no addon dir and the next online launch succeeds", async () => {
		const offline: string[] = [];
		await maybeDownloadAddons({ UBO: "https://example.invalid/ubo.xpi" }, offline);
		expect(offline).toEqual([]);
		expect(fs.existsSync(join(state.root, "addons", "UBO"))).toBe(false);

		state.online = true;
		const online: string[] = [];
		await maybeDownloadAddons({ UBO: "https://example.invalid/ubo.xpi" }, online);
		expect(online).toEqual([join(state.root, "addons", "UBO")]);
		expect(() => confirmPaths(online)).not.toThrow();
	});

	test("an empty leftover dir from an older version is discarded and re-downloaded", async () => {
		const leftover = join(state.root, "addons", "UBO");
		fs.mkdirSync(leftover, { recursive: true });

		const offline: string[] = [];
		await maybeDownloadAddons({ UBO: "https://example.invalid/ubo.xpi" }, offline);
		expect(offline).toEqual([]);
		expect(fs.existsSync(leftover)).toBe(false);

		state.online = true;
		const online: string[] = [];
		await maybeDownloadAddons({ UBO: "https://example.invalid/ubo.xpi" }, online);
		expect(online).toEqual([leftover]);
	});
});
