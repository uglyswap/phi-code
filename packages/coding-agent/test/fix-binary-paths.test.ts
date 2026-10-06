import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getBundledExtensionsDir, getPackageDir } from "../src/config.ts";

describe("fix-binary: getBundledExtensionsDir", () => {
	const saved = process.env.PHI_PACKAGE_DIR;
	afterEach(() => {
		if (saved === undefined) delete process.env.PHI_PACKAGE_DIR;
		else process.env.PHI_PACKAGE_DIR = saved;
	});

	it("points at <package>/extensions/phi in a source checkout", () => {
		delete process.env.PHI_PACKAGE_DIR;
		const dir = getBundledExtensionsDir();
		expect(dir).toBe(join(getPackageDir(), "extensions", "phi"));
		expect(resolve(dir)).toBe(resolve(__dirname, "..", "extensions", "phi"));
		expect(existsSync(join(dir, "memory.ts"))).toBe(true);
	});

	it("follows getPackageDir() (the executable dir in a Bun binary) rather than import.meta.url", () => {
		const fakeExeDir = resolve("/opt/phi-linux-x64");
		process.env.PHI_PACKAGE_DIR = fakeExeDir;
		expect(getBundledExtensionsDir()).toBe(join(fakeExeDir, "extensions", "phi"));
	});
});
