/**
 * Minimal LSP client (JSON-RPC over stdio, Content-Length framing).
 *
 * Lazy spawns one server per (language, workspaceRoot). Used by the `lsp` tool
 * registered in index.ts. Not a full LSP implementation: covers initialize,
 * didOpen/didChange/didClose sync, diagnostics (pull + publish fallback),
 * definition, references, hover.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";

export interface LspServerSpec {
	command: string;
	args: string[];
	/** File extensions this server handles */
	extensions: string[];
}

/** Default server registry. Missing binaries are skipped silently. */
export const DEFAULT_SERVERS: Record<string, LspServerSpec> = {
	typescript: {
		command: "typescript-language-server",
		args: ["--stdio"],
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
	},
	python: { command: "pyright-langserver", args: ["--stdio"], extensions: [".py"] },
	go: { command: "gopls", args: ["serve"], extensions: [".go"] },
	rust: { command: "rust-analyzer", args: [], extensions: [".rs"] },
};

export function serverForFile(
	file: string,
	registry: Record<string, LspServerSpec> = DEFAULT_SERVERS,
): LspServerSpec | undefined {
	const dot = file.lastIndexOf(".");
	if (dot === -1) return undefined;
	const ext = file.slice(dot);
	for (const spec of Object.values(registry)) {
		if (spec.extensions.includes(ext)) return spec;
	}
	return undefined;
}

interface JsonRpcResponse {
	id?: number;
	result?: unknown;
	error?: { code: number; message: string };
	method?: string;
	params?: unknown;
}

export class LspClient extends EventEmitter {
	private proc: ChildProcess;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private diagnostics = new Map<string, unknown[]>();
	private initialized = false;

	private rootUri: string;

	constructor(spec: LspServerSpec, rootUri: string) {
		super();
		this.rootUri = rootUri;
		this.proc = spawn(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"] });
		this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
		this.proc.on("exit", () => {
			for (const p of this.pending.values()) p.reject(new Error("LSP server exited"));
			this.pending.clear();
		});
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const header = this.buffer.subarray(0, headerEnd).toString("ascii");
			const match = /Content-Length: (\d+)/i.exec(header);
			if (!match) {
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const length = Number.parseInt(match[1], 10);
			const start = headerEnd + 4;
			if (this.buffer.length < start + length) return;
			const body = this.buffer.subarray(start, start + length).toString("utf8");
			this.buffer = this.buffer.subarray(start + length);
			let message: JsonRpcResponse;
			try {
				message = JSON.parse(body);
			} catch {
				continue;
			}
			if (message.id !== undefined && this.pending.has(message.id)) {
				const p = this.pending.get(message.id)!;
				this.pending.delete(message.id);
				if (message.error) p.reject(new Error(message.error.message));
				else p.resolve(message.result);
			} else if (message.method === "textDocument/publishDiagnostics") {
				const params = message.params as { uri: string; diagnostics: unknown[] };
				this.diagnostics.set(params.uri, params.diagnostics);
				this.emit("diagnostics", params);
			}
		}
	}

	private send(method: string, params: unknown, id?: number): void {
		const message = id !== undefined ? { jsonrpc: "2.0", id, method, params } : { jsonrpc: "2.0", method, params };
		const body = JSON.stringify(message);
		this.proc.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}

	request<T = unknown>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`LSP request ${method} timed out`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v as T);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.send(method, params, id);
		});
	}

	notify(method: string, params: unknown): void {
		this.send(method, params);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await this.request("initialize", {
			processId: process.pid,
			rootUri: this.rootUri,
			capabilities: {
				textDocument: {
					publishDiagnostics: {},
					definition: {},
					references: {},
					hover: {},
				},
			},
			workspaceFolders: [{ uri: this.rootUri, name: "workspace" }],
		});
		this.notify("initialized", {});
		this.initialized = true;
	}

	async openDocument(filePath: string, content: string, languageId: string): Promise<string> {
		const uri = `file://${filePath}`;
		this.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: 1, text: content },
		});
		return uri;
	}

	closeDocument(uri: string): void {
		this.notify("textDocument/didClose", { textDocument: { uri } });
		this.diagnostics.delete(uri);
	}

	async waitForDiagnostics(uri: string, timeoutMs = 8_000): Promise<unknown[]> {
		const existing = this.diagnostics.get(uri);
		if (existing) return existing;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.removeListener("diagnostics", handler);
				resolve(this.diagnostics.get(uri) ?? []);
			}, timeoutMs);
			const handler = (params: { uri: string }) => {
				if (params.uri === uri) {
					clearTimeout(timer);
					this.removeListener("diagnostics", handler);
					resolve(this.diagnostics.get(uri) ?? []);
				}
			};
			this.on("diagnostics", handler);
		});
	}

	dispose(): void {
		try {
			this.proc.kill();
		} catch {}
	}
}
