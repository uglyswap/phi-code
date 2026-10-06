/**
 * PHI-VENDOR regression (FIX2-BROWSER): offline, the optional uBlock Origin
 * download must not delay every launch (it used 5 attempts spaced 5 s apart).
 * A failure is remembered for ADDON_DOWNLOAD_BACKOFF_MS; launches skip it.
 */
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", online: false }));

const webdl = vi.hoisted(() =>
	vi.fn(async () => {
		if (!state.online) throw new Error("Failed to download (offline)");
		return Buffer.from("zip");
	}),
);

vi.mock("../src/pkgman.ts", () => ({
	getPath: (p: string) => join(state.root, p),
	webdl,
	unzip: vi.fn(async (_buf: Buffer, extractPath: string) => {
		fs.writeFileSync(join(extractPath, "manifest.json"), "{}");
	}),
}));

vi.mock("../src/utils.ts", () => ({ getAsBooleanFromENV: () => false }));

const { ADDON_DOWNLOAD_BACKOFF_MS, addDefaultAddons, maybeDownloadAddons } = await import("../src/addons.ts");

describe("default addon download backoff", () => {
	beforeEach(() => {
		state.root = fs.mkdtempSync(join(tmpdir(), "fix2-browser-addons-"));
		state.online = false;
		webdl.mockClear();
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(state.root, { recursive: true, force: true });
	});

	test("downloads with a single attempt", async () => {
		await addDefaultAddons([]);
		expect(webdl).toHaveBeenCalledTimes(1);
		expect(webdl.mock.calls[0]).toContainEqual({ retries: 1 });
	});

	test("an offline failure is not retried at the next launches until the backoff expires", async () => {
		const first: string[] = [];
		await addDefaultAddons(first);
		expect(first).toEqual([]);
		expect(webdl).toHaveBeenCalledTimes(1);

		// Next launch, even online: skipped without any network attempt.
		state.online = true;
		const second: string[] = [];
		await addDefaultAddons(second);
		expect(second).toEqual([]);
		expect(webdl).toHaveBeenCalledTimes(1);

		// Backoff expired: downloaded again, and the marker is gone.
		const marker = join(state.root, "addons", ".UBO.download-failed");
		const past = new Date(Date.now() - ADDON_DOWNLOAD_BACKOFF_MS - 1000);
		fs.utimesSync(marker, past, past);
		const third: string[] = [];
		await addDefaultAddons(third);
		expect(third).toEqual([join(state.root, "addons", "UBO")]);
		expect(webdl).toHaveBeenCalledTimes(2);
		expect(fs.existsSync(marker)).toBe(false);
	});

	test("an explicit maybeDownloadAddons (camoufox fetch) ignores the backoff", async () => {
		await addDefaultAddons([]);
		state.online = true;
		const list: string[] = [];
		await maybeDownloadAddons({ UBO: "https://example.invalid/ubo.xpi" }, list);
		expect(list).toEqual([join(state.root, "addons", "UBO")]);
	});

	test("excluded addons are neither downloaded nor marked", async () => {
		await addDefaultAddons([], ["UBO"]);
		expect(webdl).not.toHaveBeenCalled();
		expect(fs.existsSync(join(state.root, "addons", ".UBO.download-failed"))).toBe(false);
	});
});

describe("webdl", () => {
	test("does not sleep after the final failed attempt", async () => {
		const actual = await vi.importActual<typeof import("../src/pkgman.ts")>("../src/pkgman.ts");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("fetch failed");
			}),
		);
		vi.spyOn(console, "error").mockImplementation(() => {});
		const started = Date.now();
		await expect(actual.webdl("https://example.invalid/x", "", false, null, { retries: 1 })).rejects.toThrow(
			/after 1 attempts/,
		);
		expect(Date.now() - started).toBeLessThan(2_000);
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});
});
