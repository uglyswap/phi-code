/**
 * @phi-code-admin/browser — programmatic browser API for phi-code.
 *
 * Boots the bundled `@phi-code-admin/camofox-browser` Express server on a
 * private localhost port the first time any tool is called, then exposes
 * the 10 OpenClaw tools as plain async functions. Shutdown is automatic
 * on `process.exit` and can be triggered explicitly with `closeAll()`.
 *
 * Design constraints (per phi-code vendoring spec):
 *   - The Camoufox binary is fetched once, at install time, by
 *     `@phi-code-admin/camoufox-js`'s postinstall, from the
 *     `uglyswap/phi-code` GitHub Release into a versioned cache. The only
 *     runtime download is the uBlock Origin add-on (addons.mozilla.org) on
 *     the first browser launch; offline, the launch proceeds without it and
 *     the download is retried at a later launch (after a 6 h backoff).
 *   - The Express server is an implementation detail; consumers only see
 *     ES module exports. The server can still be launched independently
 *     via `npx @phi-code-admin/camofox-browser` for users who want REST.
 *   - Each tool returns a JSON-serialisable object. No process objects,
 *     no file handles, no streams — the result is safe to pass into a
 *     TUI rendering layer or to serialise as a tool_result message.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as path from "node:path";
import { ensureRuntimeServerEntry, type ProgressListener } from "./server-runtime.ts";

export type { ProgressListener } from "./server-runtime.ts";

const require = createRequire(import.meta.url);

// ─── Server lifecycle ────────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null;
let serverPort: number | null = null;
let bootPromise: Promise<{ baseUrl: string }> | null = null;

/**
 * Per-process secret for the local camofox-browser API. Without it the server
 * accepts any loopback request in non-production mode, so any local process (or
 * a web page via DNS rebinding) could drive the browser, run JavaScript in
 * logged-in pages and import cookies.
 */
const ACCESS_KEY = randomBytes(32).toString("hex");

/** Credentials and secrets the browser server has no reason to see. */
const SECRET_ENV_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE)/i;

function serverEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) {
		// CAMOFOX_* settings (proxy credentials...) are meant for this server.
		if (!name.startsWith("CAMOFOX_") && SECRET_ENV_PATTERN.test(name)) continue;
		env[name] = value;
	}
	return env;
}

const DEFAULT_USER_ID = "phi-default";
const DEFAULT_SESSION_KEY = "phi-default-session";
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_INTERVAL_MS = 250;

async function findAvailablePort(): Promise<number> {
	return await new Promise<number>((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address && typeof address !== "string") {
				server.close(() => resolve(address.port));
			} else {
				server.close();
				reject(new Error("Could not allocate port"));
			}
		});
	});
}

async function waitForHealth(baseUrl: string, stop?: AbortSignal): Promise<void> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (stop?.aborted) return;
		try {
			const res = await fetch(`${baseUrl}/health`);
			if (res.ok) return;
		} catch {
			// not yet
		}
		await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
	}
	throw new Error(
		`camofox-browser server failed to become healthy at ${baseUrl} within ${HEALTH_TIMEOUT_MS}ms`,
	);
}

function isFile(candidate: string): boolean {
	try {
		return statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/**
 * First `node` executable found on PATH, if any. `.cmd` shims (nvm-windows,
 * volta) are skipped: they cannot be spawned without a shell.
 */
export function findNodeOnPath(
	pathValue: string | undefined = process.env.PATH,
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const name = platform === "win32" ? "node.exe" : "node";
	const delimiter = platform === "win32" ? ";" : ":";
	for (const rawDir of (pathValue ?? "").split(delimiter)) {
		const dir = rawDir.replace(/^"(.*)"$/, "$1");
		if (!dir) continue;
		const candidate = path.join(dir, name);
		if (isFile(candidate)) return candidate;
	}
	return undefined;
}

/**
 * The runtime used to start camofox-browser (an Express + Playwright Node app,
 * engines node >= 22). Under Node this is simply `process.execPath`. Under Bun
 * (`bun run`, or phi compiled to a standalone executable where `process.execPath`
 * is the phi binary itself) relaunching `process.execPath` would start phi again
 * instead of the server, so a real `node` from PATH is required.
 */
export function resolveNodeExecutable(
	runtime: { bun?: string; execPath: string } = { bun: process.versions.bun, execPath: process.execPath },
	lookup: () => string | undefined = () => findNodeOnPath(),
): string {
	if (!runtime.bun) return runtime.execPath;
	const node = lookup();
	if (node) return node;
	throw new Error(
		"The browser tools need Node.js >= 22 to run the bundled camofox-browser server, but phi is running " +
			"on Bun (standalone executable or `bun run`) and no `node` executable was found on PATH. " +
			"Install Node.js (https://nodejs.org) and restart phi, or set PHI_BROWSER_DISABLED=1 to hide these tools.",
	);
}

let runtimeInstallDir: string | undefined;
const progressListeners = new Set<ProgressListener>();

function emitProgress(message: string): void {
	for (const listener of progressListeners) {
		try {
			listener(message);
		} catch {
			// a broken listener must not break the boot
		}
	}
}

/**
 * Where to install the camofox-browser server on first use when it is not
 * installed next to this package (phi's standalone Bun executable ships this
 * package without it: the server needs the system Node and native modules
 * built for it). Without it, a missing server is an error, as before.
 */
export function configureServerRuntime(options: { installDir?: string }): void {
	runtimeInstallDir = options.installDir;
}

async function resolveServerEntry(nodeExecutable: string): Promise<string> {
	// The vendored camofox-browser ships its Express entry as `server.js`
	// (declared as the `main` field). createRequire resolves the package
	// to that file even when consumers install us via npm/pnpm/yarn.
	try {
		return require.resolve("@phi-code-admin/camofox-browser");
	} catch (error) {
		if (!runtimeInstallDir) throw error;
	}
	return await ensureRuntimeServerEntry({ installDir: runtimeInstallDir, nodeExecutable, onProgress: emitProgress });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export interface EnsureServerOptions {
	/** Stops waiting (the shared boot, e.g. a first-use install, goes on). */
	signal?: AbortSignal;
	/** Progress of a first-use runtime install, while this call waits. */
	onProgress?: ProgressListener;
}

/**
 * Boot (or reuse) the camofox-browser server. Idempotent across calls.
 */
export async function ensureServer(options: EnsureServerOptions = {}): Promise<{ baseUrl: string }> {
	const { signal, onProgress } = options;
	signal?.throwIfAborted();
	if (onProgress) progressListeners.add(onProgress);
	try {
		return await abortable(bootServer(), signal);
	} finally {
		if (onProgress) progressListeners.delete(onProgress);
	}
}

async function bootServer(): Promise<{ baseUrl: string }> {
	if (bootPromise) return bootPromise;

	bootPromise = (async () => {
		const nodeExecutable = resolveNodeExecutable();
		const entry = await resolveServerEntry(nodeExecutable);
		const port = await findAvailablePort();
		const cwd = path.dirname(entry);

		const env: NodeJS.ProcessEnv = {
			// Filtered: provider API keys must not reach the server nor Firefox.
			...serverEnvironment(),
			PORT: String(port),
			// Gate every route (and cookie import) behind the per-process key.
			CAMOFOX_ACCESS_KEY: ACCESS_KEY,
			CAMOFOX_API_KEY: ACCESS_KEY,
			// Never let an inherited NODE_ENV=production turn the local server into 503s.
			NODE_ENV: "development",
			// Disable telemetry by default (PHI-VENDOR contract).
			CAMOFOX_CRASH_REPORT_URL: process.env.CAMOFOX_CRASH_REPORT_URL || "",
			// Tighten resource caps; phi-code is interactive, so 2 sessions
			// with 4 tabs each is plenty. Override with the env var.
			MAX_SESSIONS: process.env.MAX_SESSIONS || "2",
			MAX_TABS_PER_SESSION: process.env.MAX_TABS_PER_SESSION || "4",
		};

		const child = spawn(nodeExecutable, [entry], {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: false,
		});

		// Surface child stderr so the user can see crash reasons. Once the
		// server has become healthy we go quiet again unless
		// PHI_BROWSER_VERBOSE=1 is set. Boot-time crashes ALWAYS print —
		// otherwise a silent E22-style "failed to become healthy" exception
		// is unsurmountable from the consumer side.
		const stderrTail: string[] = [];
		let healthy = false;
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			if (!healthy || process.env.PHI_BROWSER_VERBOSE) {
				process.stderr.write(`[camofox] ${text}`);
			}
			stderrTail.push(text);
			while (stderrTail.length > 200) stderrTail.shift();
		});
		// Settles as soon as the child dies (or cannot be spawned) before it is
		// healthy, so a boot crash fails fast instead of waiting HEALTH_TIMEOUT_MS.
		let failBoot: (err: Error) => void = () => {};
		const bootFailure = new Promise<never>((_, reject) => {
			failBoot = reject;
		});
		bootFailure.catch(() => {});
		child.on("error", (err) => {
			if (!healthy) failBoot(new Error(`camofox-browser server failed to start (${nodeExecutable}): ${err.message}`));
		});
		child.on("exit", (code, signal) => {
			serverProcess = null;
			serverPort = null;
			bootPromise = null;
			if (!healthy) {
				const reason = signal ? `signal ${signal}` : `code ${code}`;
				const fail = () => failBoot(new Error(`camofox-browser server exited during startup (${reason})`));
				// Give the stderr pipe a moment to drain so the error carries the crash reason.
				const stderr = child.stderr;
				if (!stderr || stderr.readableEnded) {
					fail();
				} else {
					const timer = setTimeout(fail, 250);
					stderr.once("end", () => {
						clearTimeout(timer);
						fail();
					});
				}
			}
			if (!healthy || process.env.PHI_BROWSER_VERBOSE) {
				process.stderr.write(`[camofox] server exited with code ${code}\n`);
			}
		});
		// Expose stderr tail through a wrapper that promotes the listener
		// flip — needed below when waitForHealth resolves.
		(child as { __markHealthy?: () => void }).__markHealthy = () => {
			healthy = true;
		};
		(child as { __stderrTail?: string[] }).__stderrTail = stderrTail;

		serverProcess = child;
		serverPort = port;

		const baseUrl = `http://127.0.0.1:${port}`;
		const stopPolling = new AbortController();
		try {
			await Promise.race([waitForHealth(baseUrl, stopPolling.signal), bootFailure]);
			(child as { __markHealthy?: () => void }).__markHealthy?.();
		} catch (err) {
			stopPolling.abort();
			// A server that never became healthy is useless: do not leave it running.
			if (child.exitCode === null && child.signalCode === null) {
				try {
					child.kill();
				} catch {
					/* already gone */
				}
			}
			// Augment the health-check error with whatever the child wrote to
			// stderr so the consumer has at least one breadcrumb to follow.
			const tail = ((child as { __stderrTail?: string[] }).__stderrTail ?? [])
				.join("")
				.split(/\r?\n/)
				.filter(Boolean)
				.slice(-20)
				.join("\n")
				// Never echo the per-process API key, should the server log it.
				.split(ACCESS_KEY)
				.join("<redacted>");
			const original = err instanceof Error ? err.message : String(err);
			const augmented = new Error(
				tail
					? `${original}\nLast stderr lines from camofox-browser child:\n${tail}`
					: `${original}\n(no stderr captured — set PHI_BROWSER_VERBOSE=1 for more)`,
			);
			throw augmented;
		}
		return { baseUrl };
	})();

	try {
		return await bootPromise;
	} catch (err) {
		bootPromise = null;
		serverProcess = null;
		serverPort = null;
		throw err;
	}
}

/**
 * Kill the embedded camofox-browser server (if running) and reset state.
 * Safe to call multiple times. Resolves once the child has exited.
 */
export async function closeAll(): Promise<void> {
	const proc = serverProcess;
	bootPromise = null;
	serverProcess = null;
	serverPort = null;
	if (!proc) return;
	return await new Promise<void>((resolve) => {
		const done = () => resolve();
		proc.once("exit", done);
		try {
			proc.kill("SIGTERM");
		} catch {
			done();
			return;
		}
		// Hard fallback after 2s — Firefox can take a moment.
		setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {
				/* already dead */
			}
		}, 2_000);
	});
}

// Best-effort cleanup on process exit. Async cleanup is allowed in the
// `beforeExit` phase; `exit` is sync-only so we can only request a kill.
process.on("beforeExit", () => {
	void closeAll();
});
process.on("exit", () => {
	const proc = serverProcess;
	if (proc) {
		try {
			proc.kill("SIGKILL");
		} catch {
			/* no-op */
		}
	}
});

// ─── HTTP helpers ────────────────────────────────────────────────────────

interface RequestOptions {
	method?: "GET" | "POST" | "DELETE";
	body?: unknown;
	headers?: Record<string, string>;
	timeoutMs?: number;
	/** Caller cancellation (e.g. the agent aborting the tool call). */
	signal?: AbortSignal;
	/**
	 * When `"binary"`, return the raw response body as a Uint8Array instead
	 * of JSON-parsing it. Used for endpoints that stream `image/png` etc.
	 */
	responseType?: "json" | "binary";
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function errorMessageFrom(parsed: unknown, status: number): string {
	return typeof parsed === "object" && parsed && "error" in parsed
		? String((parsed as { error: unknown }).error)
		: `HTTP ${status}`;
}

function parseBody(text: string): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

async function request<T = unknown>(pathname: string, options: RequestOptions = {}): Promise<T> {
	options.signal?.throwIfAborted();
	const { baseUrl } = await ensureServer();
	options.signal?.throwIfAborted();
	const url = `${baseUrl}${pathname}`;
	const method = options.method ?? "GET";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...(options.headers ?? {}),
		Authorization: `Bearer ${ACCESS_KEY}`,
	};
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
	const onAbort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const res = await fetch(url, {
			method,
			headers,
			body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
			signal: controller.signal,
		});

		if (options.responseType === "binary" && res.ok) {
			return new Uint8Array(await res.arrayBuffer()) as unknown as T;
		}
		// Error bodies are JSON, even on binary endpoints.
		const parsed = parseBody(await res.text());
		if (!res.ok) {
			throw new Error(`${method} ${pathname} → ${errorMessageFrom(parsed, res.status)}`);
		}
		return parsed as T;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

function tabPath(tabId: string, suffix = ""): string {
	return `/tabs/${encodeURIComponent(tabId)}${suffix}`;
}

// ─── Public API: 10 OpenClaw tools ──────────────────────────────────────

/** Options shared by every call: cancellation of the underlying HTTP request. */
export interface CallOptions {
	signal?: AbortSignal;
}

export interface CreateTabResult {
	tabId: string;
	userId: string;
	sessionKey: string;
	url?: string;
}

/**
 * Open a new browser tab. Returns the tab id used by the other tools.
 *
 * The camofox-browser REST contract requires every tab to be associated
 * with a `userId` (logical user) AND a `sessionKey` (logical session
 * inside that user — used to group tabs that should share cookies /
 * fingerprints / proxies). Phi-code's chat agents only need one of each,
 * so both default to a constant sentinel when omitted.
 *
 * When `url` is given the server navigates before answering (it waits for
 * `domcontentloaded`, 30 s max). `viewport` is applied after creation through
 * `POST /tabs/:tabId/viewport` (the create route ignores it).
 */
export async function createTab(
	options: {
		userId?: string;
		sessionKey?: string;
		url?: string;
		viewport?: { width: number; height: number };
	} & CallOptions = {},
): Promise<CreateTabResult> {
	const userId = options.userId ?? DEFAULT_USER_ID;
	const sessionKey = options.sessionKey ?? DEFAULT_SESSION_KEY;
	const body: Record<string, unknown> = { userId, sessionKey };
	if (options.url) body.url = options.url;
	const res = await request<{ tabId: string; url?: string }>("/tabs", {
		method: "POST",
		body,
		signal: options.signal,
	});
	if (options.viewport) {
		await request(tabPath(res.tabId, "/viewport"), {
			method: "POST",
			body: { userId, width: options.viewport.width, height: options.viewport.height },
			signal: options.signal,
		});
	}
	return { tabId: res.tabId, userId, sessionKey, url: res.url ?? options.url };
}

export type WaitUntil = "load" | "domcontentloaded" | "networkidle";

export interface NavigateResult {
	tabId: string;
	/** Final URL after redirects, as reported by the browser. */
	url: string;
	/** Whether element refs were built for the page (false on Google SERPs). */
	refsAvailable?: boolean;
	/** True when Google served its "unusual traffic" block page. */
	googleBlocked?: boolean;
	/** Outcome of the extra wait requested through `waitUntil` (if any). */
	ready?: boolean;
	/** @deprecated The server never reports the HTTP status; always undefined. */
	status?: number;
	/** @deprecated The server never reports a load event; always undefined. */
	loadEvent?: string;
}

interface ServerNavigateResponse {
	ok?: boolean;
	tabId?: string;
	url?: string;
	refsAvailable?: boolean;
	googleBlocked?: boolean;
}

/**
 * Navigate the given tab (or a freshly opened one) to a URL.
 * High-level convenience: passing `url` without `tabId` opens a new tab
 * first.
 *
 * The server always navigates with `waitUntil: "domcontentloaded"` and its own
 * 30 s budget. `waitUntil: "load"` / `"networkidle"` add a `POST /wait` after
 * that (document complete, plus network idle for `"networkidle"`), bounded by
 * `timeoutMs`; `timeoutMs` also bounds the whole HTTP call.
 */
export async function navigate(
	options: {
		url: string;
		tabId?: string;
		userId?: string;
		sessionKey?: string;
		waitUntil?: WaitUntil;
		timeoutMs?: number;
	} & CallOptions,
): Promise<NavigateResult> {
	const userId = options.userId ?? DEFAULT_USER_ID;
	const sessionKey = options.sessionKey ?? DEFAULT_SESSION_KEY;
	let result: NavigateResult;
	if (!options.tabId) {
		const tab = await createTab({ userId, sessionKey, url: options.url, signal: options.signal });
		result = { tabId: tab.tabId, url: tab.url ?? options.url };
	} else {
		const res = await request<ServerNavigateResponse>(tabPath(options.tabId, "/navigate"), {
			method: "POST",
			body: { userId, sessionKey, url: options.url },
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
		result = {
			tabId: options.tabId,
			url: res.url ?? options.url,
			refsAvailable: res.refsAvailable,
			googleBlocked: res.googleBlocked,
		};
	}
	if (options.waitUntil && options.waitUntil !== "domcontentloaded") {
		const waited = await waitForTab({
			tabId: result.tabId,
			userId,
			waitForNetwork: options.waitUntil === "networkidle",
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
		result.ready = waited.ready;
	}
	return result;
}

/**
 * Wait until the tab's document is complete (`POST /tabs/:tabId/wait`):
 * domcontentloaded, then optionally network idle (capped at 5 s by the
 * server), then a hydration heuristic. Resolves `ready: false` on timeout.
 */
async function waitForTab(
	options: { tabId: string; userId: string; waitForNetwork: boolean; timeoutMs?: number } & CallOptions,
): Promise<{ ready: boolean }> {
	const timeout = options.timeoutMs ?? 10_000;
	const res = await request<{ ready?: boolean }>(tabPath(options.tabId, "/wait"), {
		method: "POST",
		body: { userId: options.userId, timeout, waitForNetwork: options.waitForNetwork },
		// network idle (5 s) + hydration + settle can exceed `timeout` slightly
		timeoutMs: Math.max(timeout + 20_000, DEFAULT_REQUEST_TIMEOUT_MS),
		signal: options.signal,
	});
	return { ready: res.ready === true };
}

export interface SnapshotResult {
	url?: string;
	/** Accessibility tree (YAML-like), `[eN]` markers are the refs. */
	snapshot?: string;
	refsCount?: number;
	truncated?: boolean;
	totalChars?: number;
	hasMore?: boolean;
	/** Pass back as `offset` to read the next chunk when `hasMore` is true. */
	nextOffset?: number | null;
}

/**
 * Get an accessibility snapshot (DOM tree with ref ids) of the given tab.
 * Refs returned here can be used with `click`/`type`.
 *
 * The server returns at most ~80 000 characters per call; when `hasMore` is
 * true, call again with `offset: nextOffset` to read the next chunk (served
 * from the snapshot cached by the previous call).
 */
export async function snapshot(
	options: { tabId: string; userId?: string; offset?: number } & CallOptions,
): Promise<SnapshotResult> {
	const query = new URLSearchParams();
	query.set("userId", options.userId ?? DEFAULT_USER_ID);
	if (options.offset !== undefined && options.offset > 0) query.set("offset", String(Math.floor(options.offset)));
	return await request<SnapshotResult>(tabPath(options.tabId, `/snapshot?${query.toString()}`), {
		signal: options.signal,
	});
}

export interface ExtractResult {
	url?: string;
	title?: string;
	content?: string;
	textContent?: string;
	excerpt?: string;
	length?: number;
}

/**
 * Extract the readable content of the current page with a small in-page
 * heuristic (NOT Mozilla Readability): drops script/style/nav/header/footer/
 * aside/form/svg/iframe, keeps `<main>`, else `<article>`, else `<body>`, and
 * truncates `content`/`textContent` to 50 000 characters (`length` is the full
 * text length). For a fresh page, pass `url` to navigate first; otherwise the
 * tab's current document is extracted.
 */
export async function extract(
	options: {
		tabId?: string;
		userId?: string;
		sessionKey?: string;
		url?: string;
		mode?: "readability" | "html" | "text";
	} & CallOptions,
): Promise<ExtractResult> {
	const userId = options.userId ?? DEFAULT_USER_ID;
	let tabId = options.tabId;
	if (!tabId) {
		if (!options.url) {
			throw new Error("extract() requires either tabId or url");
		}
		const tab = await createTab({
			userId,
			sessionKey: options.sessionKey,
			url: options.url,
			signal: options.signal,
		});
		tabId = tab.tabId;
		// Let client-side rendering settle before extracting (best effort).
		await waitForTab({ tabId, userId, waitForNetwork: true, signal: options.signal }).catch((err: unknown) => {
			if (options.signal?.aborted) throw err;
		});
	} else if (options.url) {
		await navigate({
			tabId,
			url: options.url,
			userId,
			sessionKey: options.sessionKey,
			signal: options.signal,
		});
	}

	// The camofox-browser POST /tabs/:tabId/extract endpoint is a
	// *deterministic* extractor that requires a structured `schema` of
	// refs from a prior snapshot. Phi callers expect a plain
	// `{title, content, textContent}` blob, so we run a small heuristic
	// script inside the page via /evaluate. This keeps the public API stable
	// regardless of how the camofox-browser server evolves.
	const mode = options.mode ?? "readability";
	const expression = `(() => {
		const limit = 50000;
		const title = document.title || "";
		const url = window.location.href || "";
		if (${JSON.stringify(mode)} === "html") {
			return { title, url, content: document.documentElement.outerHTML.slice(0, limit) };
		}
		if (${JSON.stringify(mode)} === "text") {
			return { title, url, textContent: (document.body && document.body.innerText || "").slice(0, limit) };
		}
		// readability-light: strip nav/footer/header/aside, keep <main>/<article>/body.
		const clone = document.cloneNode(true);
		clone.querySelectorAll("script,style,noscript,iframe,nav,footer,header,aside,svg,form").forEach((el) => el.remove());
		const root = clone.querySelector("main") || clone.querySelector("article") || clone.body || clone;
		const text = (root.innerText || root.textContent || "").replace(/\\n{3,}/g, "\\n\\n").trim();
		const excerpt = text.slice(0, 240);
		return {
			title,
			url,
			content: root.innerHTML ? root.innerHTML.slice(0, limit) : undefined,
			textContent: text.slice(0, limit),
			excerpt,
			length: text.length,
		};
	})()`;

	const evalRes = await request<{ ok?: boolean; result?: ExtractResult }>(tabPath(tabId, "/evaluate"), {
		method: "POST",
		body: { userId, expression },
		signal: options.signal,
	});
	return evalRes.result ?? {};
}

export interface ScreenshotResult {
	tabId: string;
	mimeType: string;
	bytesBase64: string;
}

/**
 * Capture a screenshot of the given tab as a base64-encoded PNG. Tool layers
 * should forward `bytesBase64` as an image content block, not as text.
 */
export async function screenshot(
	options: {
		tabId: string;
		userId?: string;
		fullPage?: boolean;
	} & CallOptions,
): Promise<ScreenshotResult> {
	const query = new URLSearchParams();
	query.set("userId", options.userId ?? DEFAULT_USER_ID);
	// The server expects `fullPage=true` (string match), not `=1`.
	if (options.fullPage) query.set("fullPage", "true");
	// The camofox-browser screenshot endpoint streams a raw `image/png`
	// body, not a JSON envelope.
	const bytes = await request<Uint8Array>(tabPath(options.tabId, `/screenshot?${query.toString()}`), {
		responseType: "binary",
		signal: options.signal,
	});
	return {
		tabId: options.tabId,
		mimeType: "image/png",
		bytesBase64: Buffer.from(bytes).toString("base64"),
	};
}

/**
 * High-level search macro: opens a new tab on the engine's results page
 * (`?q=...` on DuckDuckGo, Google or Bing) and returns the `extract()` result
 * of that page.
 */
export async function search(
	options: {
		query: string;
		engine?: "google" | "duckduckgo" | "bing";
		userId?: string;
		sessionKey?: string;
	} & CallOptions,
): Promise<ExtractResult> {
	const engine = options.engine ?? "duckduckgo";
	const url =
		engine === "google"
			? `https://www.google.com/search?q=${encodeURIComponent(options.query)}`
			: engine === "bing"
				? `https://www.bing.com/search?q=${encodeURIComponent(options.query)}`
				: `https://duckduckgo.com/?q=${encodeURIComponent(options.query)}`;
	return await extract({ url, userId: options.userId, sessionKey: options.sessionKey, signal: options.signal });
}

export interface ClickResult {
	tabId: string;
	/** URL after the click (it may have navigated). */
	url?: string;
	refsAvailable?: boolean;
}

/**
 * Left-click an element by ref (from `snapshot`) or CSS selector. The server
 * only performs left clicks: any other `button` is rejected rather than
 * silently turned into a left click.
 */
export async function click(
	options: {
		tabId: string;
		userId?: string;
		ref?: string;
		selector?: string;
		/** Only `"left"` is supported by camofox-browser. */
		button?: "left" | "right" | "middle";
	} & CallOptions,
): Promise<ClickResult> {
	if (!options.ref && !options.selector) {
		throw new Error("click() requires `ref` or `selector`");
	}
	if (options.button && options.button !== "left") {
		throw new Error(`click(): button "${options.button}" is not supported, the browser server only performs left clicks`);
	}
	const body: Record<string, unknown> = { userId: options.userId ?? DEFAULT_USER_ID };
	if (options.ref) body.ref = options.ref;
	if (options.selector) body.selector = options.selector;
	const res = await request<{ url?: string; refsAvailable?: boolean }>(tabPath(options.tabId, "/click"), {
		method: "POST",
		body,
		signal: options.signal,
	});
	return { tabId: options.tabId, url: res?.url, refsAvailable: res?.refsAvailable };
}

/**
 * Type text into an element.
 *
 * - With `ref`/`selector` and no `delayMs`: replaces the field value in one go
 *   (server `mode: "fill"`).
 * - Without a target, or with `delayMs`: real key events, character by
 *   character (server `mode: "keyboard"`), into the targeted element (focused
 *   first) or else the currently focused one. Needed for contenteditable and
 *   framework-controlled inputs; appends to the existing value.
 */
export async function type(
	options: {
		tabId: string;
		userId?: string;
		text: string;
		ref?: string;
		selector?: string;
		pressEnter?: boolean;
		delayMs?: number;
	} & CallOptions,
): Promise<{ tabId: string }> {
	const hasTarget = Boolean(options.ref || options.selector);
	const body: Record<string, unknown> = {
		userId: options.userId ?? DEFAULT_USER_ID,
		text: options.text,
		mode: hasTarget && options.delayMs === undefined ? "fill" : "keyboard",
	};
	if (options.ref) body.ref = options.ref;
	if (options.selector) body.selector = options.selector;
	if (options.pressEnter) body.pressEnter = true;
	if (options.delayMs !== undefined) body.delay = options.delayMs;
	await request(tabPath(options.tabId, "/type"), {
		method: "POST",
		body,
		signal: options.signal,
	});
	return { tabId: options.tabId };
}

/**
 * Scroll the page with the mouse wheel (at the current pointer position) by
 * `amount` pixels (server default 500). Scrolling inside a specific element
 * is not supported by the server: `ref` is rejected.
 */
export async function scroll(
	options: {
		tabId: string;
		userId?: string;
		direction: "up" | "down" | "left" | "right";
		amount?: number;
		/** @deprecated Alias of `amount`. */
		pixels?: number;
		/** @deprecated Not supported by camofox-browser; rejected. */
		ref?: string;
	} & CallOptions,
): Promise<{ tabId: string }> {
	if (options.ref) {
		throw new Error("scroll(): scrolling a specific element (`ref`) is not supported, only the page scrolls");
	}
	const body: Record<string, unknown> = {
		userId: options.userId ?? DEFAULT_USER_ID,
		direction: options.direction,
	};
	const amount = options.amount ?? options.pixels;
	if (amount !== undefined) body.amount = amount;
	await request(tabPath(options.tabId, "/scroll"), {
		method: "POST",
		body,
		signal: options.signal,
	});
	return { tabId: options.tabId };
}

/** Close a single tab. The underlying browser context is kept warm. */
export async function closeTab(options: { tabId: string; userId?: string } & CallOptions): Promise<{ tabId: string }> {
	const userId = options.userId ?? DEFAULT_USER_ID;
	const qs = `?userId=${encodeURIComponent(userId)}`;
	await request(tabPath(options.tabId, qs), { method: "DELETE", signal: options.signal });
	return { tabId: options.tabId };
}

export interface ListedTab {
	tabId: string;
	url?: string;
	title?: string;
	/** camofox-browser group (the `sessionKey` the tab was opened with). */
	listItemId?: string;
	/** @deprecated Not reported by the server; always undefined. */
	createdAt?: number;
}

/** List all open tabs for a user (`GET /tabs?userId=`). */
export async function listTabs(options: { userId?: string } & CallOptions = {}): Promise<ListedTab[]> {
	const userId = options.userId ?? DEFAULT_USER_ID;
	const res = await request<{ tabs?: ListedTab[] }>(`/tabs?userId=${encodeURIComponent(userId)}`, {
		signal: options.signal,
	});
	return Array.isArray(res?.tabs) ? res.tabs : [];
}

// ─── Exported types ─────────────────────────────────────────────────────

export type BrowserApi = {
	createTab: typeof createTab;
	navigate: typeof navigate;
	snapshot: typeof snapshot;
	extract: typeof extract;
	screenshot: typeof screenshot;
	search: typeof search;
	click: typeof click;
	type: typeof type;
	scroll: typeof scroll;
	closeTab: typeof closeTab;
	listTabs: typeof listTabs;
	ensureServer: typeof ensureServer;
	closeAll: typeof closeAll;
	configureServerRuntime: typeof configureServerRuntime;
};
