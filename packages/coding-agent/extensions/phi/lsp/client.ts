/**
 * Minimal LSP client (JSON-RPC over stdio, Content-Length framing).
 *
 * Lazy spawns one server per (language, workspaceRoot). Used by the `lsp` tool
 * registered in index.ts. Not a full LSP implementation: covers initialize,
 * didOpen/didClose, diagnostics (server-pushed `textDocument/publishDiagnostics`
 * only, no pull diagnostics), definition, references, hover.
 */

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath, pathToFileURL } from "node:url";
import crossSpawn from "cross-spawn";

export interface LspServerSpec {
	command: string;
	args: string[];
	/** File extensions this server handles */
	extensions: string[];
}

/**
 * Default server registry. A missing binary is reported by the `lsp` tool as an
 * error result (the spawn failure is caught, it never crashes the host).
 */
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

/**
 * Spawn a language server. On Windows, npm-installed servers
 * (typescript-language-server, pyright-langserver) are `.cmd` shims that
 * `child_process.spawn` cannot run without a shell: cross-spawn resolves them
 * safely (no shell string interpolation).
 */
function spawnServer(command: string, args: string[], options: SpawnOptions): ChildProcess {
	return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);
}

/** `file:` URI for a local path (correct on Windows: `file:///C:/...`, percent-encoded). */
export function pathToUri(filePath: string): string {
	return pathToFileURL(filePath).href;
}

/**
 * Canonical form used to compare document URIs. Servers may echo a URI in a
 * different but equivalent spelling (e.g. `file:///c%3A/...` vs `file:///C:/...`).
 */
export function normalizeUri(uri: string): string {
	try {
		const path = fileURLToPath(uri);
		return process.platform === "win32" ? path.toLowerCase() : path;
	} catch {
		return uri;
	}
}

/** Display form of a location URI: a decoded local path when possible. */
export function uriToDisplayPath(uri: string): string {
	try {
		return fileURLToPath(uri);
	} catch {
		return uri;
	}
}

/** Result of waiting for pushed diagnostics. */
export interface DiagnosticsWaitResult {
	/** false when the server published nothing for the document before the timeout. */
	received: boolean;
	diagnostics: unknown[];
}

export class LspClient extends EventEmitter {
	private proc: ChildProcess;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private diagnostics = new Map<string, unknown[]>();
	private initialized = false;
	/** Set once the process failed to start or exited; requests then fail fast. */
	private failure: Error | undefined;

	private rootUri: string;

	constructor(spec: LspServerSpec, rootUri: string) {
		super();
		this.rootUri = rootUri;
		this.proc = spawnServer(spec.command, spec.args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		// Without an "error" listener, a missing binary (ENOENT) is an uncaught
		// exception that terminates the whole agent.
		this.proc.on("error", (error: NodeJS.ErrnoException) => {
			const reason =
				error.code === "ENOENT"
					? `language server "${spec.command}" not found on PATH (install it to use this language)`
					: `language server "${spec.command}" failed: ${error.message}`;
			this.fail(new Error(reason));
		});
		// Writing to a dead process emits EPIPE on stdin; the failure itself is reported via "error"/"exit".
		this.proc.stdin?.on("error", () => {});
		this.proc.stdout?.on("data", (chunk: Buffer) => this.onData(chunk));
		// Drain stderr so a chatty server cannot stall on a full pipe.
		this.proc.stderr?.on("data", () => {});
		this.proc.on("exit", (code, signal) => {
			this.fail(
				new Error(`language server "${spec.command}" exited (code ${code ?? "null"}, signal ${signal ?? "none"})`),
			);
		});
	}

	/** Whether the server process is still usable. */
	get alive(): boolean {
		return this.failure === undefined;
	}

	private fail(error: Error): void {
		if (!this.failure) this.failure = error;
		for (const p of this.pending.values()) p.reject(this.failure);
		this.pending.clear();
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
				const key = normalizeUri(params.uri);
				this.diagnostics.set(key, params.diagnostics);
				this.emit("diagnostics", key);
			}
		}
	}

	private send(method: string, params: unknown, id?: number): void {
		const stdin = this.proc.stdin;
		if (this.failure || !stdin?.writable) return;
		const message = id !== undefined ? { jsonrpc: "2.0", id, method, params } : { jsonrpc: "2.0", method, params };
		const body = JSON.stringify(message);
		stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	}

	request<T = unknown>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			if (this.failure) {
				reject(this.failure);
				return;
			}
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
		const uri = pathToUri(filePath);
		this.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: 1, text: content },
		});
		return uri;
	}

	closeDocument(uri: string): void {
		this.notify("textDocument/didClose", { textDocument: { uri } });
		this.diagnostics.delete(normalizeUri(uri));
	}

	/**
	 * Wait for the server to publish diagnostics for `uri`. `received: false`
	 * means nothing arrived before the timeout, which is NOT the same as a clean file.
	 */
	async waitForDiagnostics(uri: string, timeoutMs = 8_000): Promise<DiagnosticsWaitResult> {
		const key = normalizeUri(uri);
		const existing = this.diagnostics.get(key);
		if (existing) return { received: true, diagnostics: existing };
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.removeListener("diagnostics", handler);
				const late = this.diagnostics.get(key);
				resolve(late ? { received: true, diagnostics: late } : { received: false, diagnostics: [] });
			}, timeoutMs);
			const handler = (publishedKey: string) => {
				if (publishedKey === key) {
					clearTimeout(timer);
					this.removeListener("diagnostics", handler);
					resolve({ received: true, diagnostics: this.diagnostics.get(key) ?? [] });
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
