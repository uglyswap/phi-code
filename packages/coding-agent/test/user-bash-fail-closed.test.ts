/**
 * user_bash interception must fail closed: when an extension that routes `!cmd`
 * (sandbox, SSH...) throws or returns garbage, the command must NOT fall back to
 * local execution.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

describe("user_bash fail-closed", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phi-user-bash-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function runnerFor(handlerBody: string): Promise<ExtensionRunner> {
		const extPath = path.join(tempDir, "ext.ts");
		fs.writeFileSync(extPath, `export default function (pi) { pi.on("user_bash", async () => { ${handlerBody} }); }`);
		const result = await loadExtensions([extPath], tempDir);
		expect(result.errors).toEqual([]);
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		return new ExtensionRunner(result.extensions, result.runtime, tempDir, SessionManager.inMemory(), modelRegistry);
	}

	const event = { type: "user_bash" as const, command: "echo hi", excludeFromContext: false, cwd: "." };

	it("blocks the command when the handler throws", async () => {
		const runner = await runnerFor(`throw new Error("sandbox down");`);
		const result = await runner.emitUserBash(event);
		expect(result?.result?.cancelled).toBe(true);
		expect(result?.result?.output).toContain("sandbox down");
		expect(result?.operations).toBeUndefined();
	});

	it("blocks the command when the handler returns an invalid object", async () => {
		const runner = await runnerFor(`return { foo: 1 };`);
		const result = await runner.emitUserBash(event);
		expect(result?.result?.cancelled).toBe(true);
		expect(result?.result?.output).toContain("invalid user_bash result");
	});

	it("still lets handlers decline with undefined", async () => {
		const runner = await runnerFor(`return undefined;`);
		expect(await runner.emitUserBash(event)).toBeUndefined();
	});
});
