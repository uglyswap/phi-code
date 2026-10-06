/**
 * FIX4-BINBROWSER: the npm install path is unchanged. When the camofox-browser
 * server resolves next to @phi-code-admin/browser (npm install, monorepo), it
 * is started from there with the current Node, and the configured runtime
 * install dir is never touched. spawn is mocked: no browser is launched.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const spawned = vi.hoisted(() => [] as Array<{ command: string; args: string[] }>);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: vi.fn((command: string, args: string[]) => {
			spawned.push({ command, args });
			const child = new EventEmitter() as EventEmitter & {
				stderr: EventEmitter;
				kill: () => boolean;
				exitCode: number | null;
				signalCode: string | null;
			};
			child.stderr = new EventEmitter();
			child.exitCode = null;
			child.signalCode = null;
			child.kill = () => {
				setImmediate(() => child.emit("exit", 0));
				return true;
			};
			return child;
		}),
	};
});

const browser = await import("../../browser/src/index.ts");
const root = mkdtempSync(join(tmpdir(), "fix4-binbrowser-npm-"));

afterAll(async () => {
	await browser.closeAll();
	vi.unstubAllGlobals();
	rmSync(root, { recursive: true, force: true });
});

describe("@phi-code-admin/browser with the server installed next to it", () => {
	it("starts the bundled server with the current Node and never installs", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}", { status: 200 })),
		);
		const installDir = join(root, "agent", "runtime", "browser");
		browser.configureServerRuntime({ installDir });
		const progress: string[] = [];
		await browser.ensureServer({ onProgress: (message) => progress.push(message) });

		const expectedEntry = createRequire(join(import.meta.dirname, "..", "..", "browser", "src", "index.ts")).resolve(
			"@phi-code-admin/camofox-browser",
		);
		expect(spawned).toHaveLength(1);
		expect(spawned[0].command).toBe(process.execPath);
		expect(spawned[0].args).toEqual([expectedEntry]);
		expect(existsSync(installDir)).toBe(false);
		expect(progress).toEqual([]);
	});

	it("ensureServer stops waiting on abort", async () => {
		const controller = new AbortController();
		controller.abort(new Error("stop"));
		await expect(browser.ensureServer({ signal: controller.signal })).rejects.toThrow("stop");
	});
});
