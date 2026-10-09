/**
 * The camofox-browser server logs one JSON line per request on stdout. phi must
 * drain that pipe: unread, it fills up and the server stops answering (on Windows
 * pipe writes are synchronous and freeze it after ~350 requests). The drained
 * output must never reach phi's own stdout, which is pure JSONL in --mode json.
 */
import type * as ChildProcessModule from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as browser from "../../browser/src/index.ts";

const state = vi.hoisted(() => ({ fakeEntry: "" }));

// Real child process, but the server entry is replaced by a fake that writes
// 1 MiB on stdout and only starts answering /health once that write is flushed,
// which happens only if the parent reads the pipe.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcessModule>();
	return {
		...actual,
		spawn: (command: string, _args: readonly string[], options: ChildProcessModule.SpawnOptions) =>
			actual.spawn(command, [state.fakeEntry], options),
	};
});

const FAKE_SERVER = `
const http = require("node:http");
const marker = "camofox-stdout-marker\\n";
process.stdout.write(marker + "x".repeat(1024 * 1024) + "\\n", () => {
	http
		.createServer((_req, res) => {
			process.stdout.write(marker);
			res.writeHead(200, { "content-type": "application/json" });
			res.end("{}");
		})
		.listen(Number(process.env.PORT), "127.0.0.1");
});
`;

describe("@phi-code-admin/browser server stdout", () => {
	const root = mkdtempSync(join(tmpdir(), "browser-stdout-drain-"));
	state.fakeEntry = join(root, "fake-server.cjs");
	writeFileSync(state.fakeEntry, FAKE_SERVER);

	afterAll(async () => {
		await browser.closeAll();
		rmSync(root, { recursive: true, force: true });
	});

	it("drains the server stdout so the server keeps answering, without forwarding it to process.stdout", async () => {
		const forwarded: string[] = [];
		const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			forwarded.push(String(chunk));
			return true;
		});
		let timer: NodeJS.Timeout | undefined;
		try {
			const boot = browser.ensureServer();
			boot.catch(() => {});
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("server did not become healthy within 10 s: its stdout is not drained")),
					10_000,
				);
			});
			const { baseUrl } = await Promise.race([boot, timeout]);
			for (let i = 0; i < 50; i++) {
				const response = await fetch(`${baseUrl}/tabs`);
				expect(response.status).toBe(200);
			}
		} finally {
			clearTimeout(timer);
			stdoutWrite.mockRestore();
		}
		expect(forwarded.join("")).not.toContain("camofox-stdout-marker");
	}, 20_000);
});
