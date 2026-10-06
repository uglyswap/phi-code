import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BashOperations, createBashTool, createLocalBashOperations } from "../src/core/tools/bash.ts";

describe("fix-core #9577 signal-terminated shell commands", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "phi-fix-core-bash-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")("maps signal-killed commands to 128 plus the signal number", async () => {
		const operations = createLocalBashOperations();
		for (const { signal, exitCode } of [
			{ signal: "KILL", exitCode: 137 },
			{ signal: "TERM", exitCode: 143 },
		]) {
			const result = await operations.exec(`kill -${signal} $$`, testDir, { onData: () => {} });
			expect(result.exitCode).toBe(exitCode);
		}
	});

	it.skipIf(process.platform === "win32")(
		"reports signal-killed commands as errors while preserving partial output",
		async () => {
			const bash = createBashTool(testDir);
			await expect(
				bash.execute("signal-kill", { command: "printf 'before-kill\\n'; kill -KILL $$" }),
			).rejects.toThrow(/before-kill\s+Command exited with code 137$/);
		},
	);

	it("rejects a null exit code from custom operations", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("partial\n", "utf-8"));
				return { exitCode: null };
			},
		};
		const bash = createBashTool(testDir, { operations });
		await expect(bash.execute("null-exit", { command: "remote" })).rejects.toThrow(
			/partial\s+Command terminated without an exit code$/,
		);
	});
});
