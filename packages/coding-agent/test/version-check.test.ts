import { afterEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_NAME } from "../src/config.js";
import {
	checkForNewVersion,
	comparePackageVersions,
	getLatestRelease,
	getLatestVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.js";

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalOffline = process.env.PI_OFFLINE;

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PI_SKIP_VERSION_CHECK;
	} else {
		process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
	if (originalOffline === undefined) {
		delete process.env.PI_OFFLINE;
	} else {
		process.env.PI_OFFLINE = originalOffline;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ name: PACKAGE_NAME, version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewVersion("1.2.2")).resolves.toBe("1.2.3");
	});

	it("queries the npm registry for the published package", async () => {
		const fetchMock = vi.fn(async () => Response.json({ name: PACKAGE_NAME, version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			`https://registry.npmjs.org/${PACKAGE_NAME}/latest`,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^pi\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("returns the published package name from the registry manifest", async () => {
		const fetchMock = vi.fn(async () => Response.json({ name: PACKAGE_NAME, version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestRelease("1.2.3")).resolves.toEqual({ packageName: PACKAGE_NAME, version: "1.2.4" });
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips api calls when offline", async () => {
		process.env.PI_OFFLINE = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
