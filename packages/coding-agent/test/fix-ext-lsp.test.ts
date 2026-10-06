import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LspClient, normalizeUri, pathToUri, uriToDisplayPath } from "../extensions/phi/lsp/client.ts";

/**
 * Minimal fake language server: answers `initialize`, and on `didOpen` publishes
 * diagnostics for the document using an equivalent but differently spelled URI
 * (lowercase drive + percent-encoded colon on Windows), like real servers do.
 * With PUBLISH=0 it never publishes anything.
 */
const FAKE_SERVER = `
let buffer = Buffer.alloc(0);
const publish = process.env.PUBLISH !== "0";
function send(msg) {
	const body = JSON.stringify(msg);
	process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}
function respell(uri) {
	return uri.replace(/^file:\\/\\/\\/([A-Za-z]):/, (_m, d) => "file:///" + d.toLowerCase() + "%3A");
}
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const end = buffer.indexOf("\\r\\n\\r\\n");
		if (end === -1) return;
		const len = Number(/Content-Length: (\\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
		if (buffer.length < end + 4 + len) return;
		const msg = JSON.parse(buffer.subarray(end + 4, end + 4 + len).toString());
		buffer = buffer.subarray(end + 4 + len);
		if (msg.method === "initialize") send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
		if (msg.method === "textDocument/didOpen" && publish) {
			send({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: {
					uri: respell(msg.params.textDocument.uri),
					diagnostics: [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: "boom" }],
				},
			});
		}
	}
});
`;

describe("fix-ext: lsp client", () => {
	let dir: string;
	const clients: LspClient[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fix-ext-lsp-"));
		writeFileSync(join(dir, "server.cjs"), FAKE_SERVER);
		writeFileSync(join(dir, "a.ts"), "const x: number = 'a';\n");
	});

	afterEach(() => {
		for (const client of clients.splice(0)) client.dispose();
		delete process.env.PUBLISH;
		rmSync(dir, { recursive: true, force: true });
	});

	it("a missing server binary is reported as a rejected promise, not an uncaught exception", async () => {
		const client = new LspClient(
			{ command: "phi-fix-ext-definitely-missing-language-server", args: ["--stdio"], extensions: [".ts"] },
			pathToUri(dir),
		);
		clients.push(client);
		await expect(client.initialize()).rejects.toThrow(/not found|failed|exited/);
		expect(client.alive).toBe(false);
		// Later requests fail fast instead of hanging until the timeout.
		await expect(client.request("textDocument/hover", {}, 60_000)).rejects.toThrow();
	});

	it("matches published diagnostics whose URI is spelled differently (Windows drive/encoding)", async () => {
		const client = new LspClient(
			{ command: process.execPath, args: [join(dir, "server.cjs")], extensions: [".ts"] },
			pathToUri(dir),
		);
		clients.push(client);
		await client.initialize();
		const uri = await client.openDocument(join(dir, "a.ts"), "const x = 1;\n", "typescript");
		const result = await client.waitForDiagnostics(uri, 5_000);
		expect(result.received).toBe(true);
		expect(result.diagnostics).toHaveLength(1);
	});

	it("distinguishes 'no diagnostics received' from a clean file", async () => {
		process.env.PUBLISH = "0";
		const client = new LspClient(
			{ command: process.execPath, args: [join(dir, "server.cjs")], extensions: [".ts"] },
			pathToUri(dir),
		);
		clients.push(client);
		await client.initialize();
		const uri = await client.openDocument(join(dir, "a.ts"), "const x = 1;\n", "typescript");
		const result = await client.waitForDiagnostics(uri, 200);
		expect(result).toEqual({ received: false, diagnostics: [] });
	});

	it("builds standard file URIs and decodes them back to local paths", () => {
		const file = join(dir, "dir with space", "a.ts");
		const uri = pathToUri(file);
		expect(uri.startsWith("file:///")).toBe(true);
		expect(uri).toContain("dir%20with%20space");
		expect(uriToDisplayPath(uri)).toBe(file);
		if (process.platform === "win32") {
			const respelled = uri.replace(/^file:\/\/\/([A-Za-z]):/, (_m, d: string) => `file:///${d.toLowerCase()}%3A`);
			expect(normalizeUri(respelled)).toBe(normalizeUri(uri));
		}
	});
});
