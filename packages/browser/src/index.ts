/**
 * @phi-code-admin/browser — programmatic browser API for phi-code.
 *
 * Boots the bundled `@phi-code-admin/camofox-browser` Express server on a
 * private localhost port the first time any tool is called, then exposes
 * the 10 OpenClaw tools as plain async functions. Shutdown is automatic
 * on `process.exit` and can be triggered explicitly with `closeAll()`.
 *
 * Design constraints (per phi-code vendoring spec):
 *   - Zero external network calls. The Camoufox binary is provided by
 *     `@phi-code-admin/camoufox-bin-*` via npm optionalDependencies.
 *   - The Express server is an implementation detail; consumers only see
 *     ES module exports. The server can still be launched independently
 *     via `npx @phi-code-admin/camofox-browser` for users who want REST.
 *   - Each tool returns a JSON-serialisable object. No process objects,
 *     no file handles, no streams — the result is safe to pass into a
 *     TUI rendering layer or to serialise as a tool_result message.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as path from "node:path";

const require = createRequire(import.meta.url);

// ─── Server lifecycle ────────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null;
let serverPort: number | null = null;
let bootPromise: Promise<{ baseUrl: string }> | null = null;

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

async function waitForHealth(baseUrl: string): Promise<void> {
	const deadline = Date.now() + HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
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

function resolveServerEntry(): string {
	// The vendored camofox-browser ships its Express entry as `server.js`
	// (declared as the `main` field). createRequire resolves the package
	// to that file even when consumers install us via npm/pnpm/yarn.
	return require.resolve("@phi-code-admin/camofox-browser");
}

/**
 * Boot (or reuse) the camofox-browser server. Idempotent across calls.
 */
export async function ensureServer(): Promise<{ baseUrl: string }> {
	if (bootPromise) return bootPromise;

	bootPromise = (async () => {
		const port = await findAvailablePort();
		const entry = resolveServerEntry();
		const cwd = path.dirname(entry);

		const env: NodeJS.ProcessEnv = {
			...process.env,
			PORT: String(port),
			// Disable telemetry by default (PHI-VENDOR contract).
			CAMOFOX_CRASH_REPORT_URL: process.env.CAMOFOX_CRASH_REPORT_URL || "",
			// Tighten resource caps; phi-code is interactive, so 2 sessions
			// with 4 tabs each is plenty. Override with the env var.
			MAX_SESSIONS: process.env.MAX_SESSIONS || "2",
			MAX_TABS_PER_SESSION: process.env.MAX_TABS_PER_SESSION || "4",
		};

		const child = spawn(process.execPath, [entry], {
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
		child.on("exit", (code) => {
			serverProcess = null;
			serverPort = null;
			bootPromise = null;
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
		try {
			await waitForHealth(baseUrl);
			(child as { __markHealthy?: () => void }).__markHealthy?.();
		} catch (err) {
			// Augment the health-check error with whatever the child wrote to
			// stderr so the consumer has at least one breadcrumb to follow.
			const tail = ((child as { __stderrTail?: string[] }).__stderrTail ?? [])
				.join("")
				.split(/\r?\n/)
				.filter(Boolean)
				.slice(-20)
				.join("\n");
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
	/**
	 * When `"binary"`, return the raw response body as a Uint8Array instead
	 * of JSON-parsing it. Used for endpoints that stream `image/png` etc.
	 */
	responseType?: "json" | "binary";
}

async function request<T = unknown>(pathname: string, options: RequestOptions = {}): Promise<T> {
	const { baseUrl } = await ensureServer();
	const url = `${baseUrl}${pathname}`;
	const method = options.method ?? "GET";
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...(options.headers ?? {}),
	};
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
	try {
		const res = await fetch(url, {
			method,
			headers,
			body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
			signal: controller.signal,
		});

		if (options.responseType === "binary") {
			if (!res.ok) {
				// Even on error, the body is JSON — fall through to error parsing.
				const text = await res.text();
				let parsed: unknown = undefined;
				if (text) {
					try {
						parsed = JSON.parse(text);
					} catch {
						parsed = text;
					}
				}
				const message =
					typeof parsed === "object" && parsed && "error" in parsed
						? String((parsed as { error: unknown }).error)
						: `HTTP ${res.status}`;
				throw new Error(`${method} ${pathname} → ${message}`);
			}
			const buffer = new Uint8Array(await res.arrayBuffer());
			return buffer as unknown as T;
		}

		const text = await res.text();
		let parsed: unknown = undefined;
		if (text) {
			try {
				parsed = JSON.parse(text);
			} catch {
				parsed = text;
			}
		}
		if (!res.ok) {
			const message =
				typeof parsed === "object" && parsed && "error" in parsed
					? String((parsed as { error: unknown }).error)
					: `HTTP ${res.status}`;
			throw new Error(`${method} ${pathname} → ${message}`);
		}
		return parsed as T;
	} finally {
		clearTimeout(timeout);
	}
}

// ─── Public API: 10 OpenClaw tools ──────────────────────────────────────

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
 */
export async function createTab(options: {
	userId?: string;
	sessionKey?: string;
	url?: string;
	viewport?: { width: number; height: number };
} = {}): Promise<CreateTabResult> {
	const userId = options.userId ?? DEFAULT_USER_ID;
	const sessionKey = options.sessionKey ?? DEFAULT_SESSION_KEY;
	const body: Record<string, unknown> = { userId, sessionKey };
	if (options.url) body.url = options.url;
	if (options.viewport) body.viewport = options.viewport;
	const res = await request<{ tabId: string }>("/tabs", { method: "POST", body });
	return { tabId: res.tabId, userId, sessionKey, url: options.url };
}

export interface NavigateResult {
	tabId: string;
	url: string;
	status?: number;
	loadEvent?: string;
}

/**
 * Navigate the given tab (or a freshly opened one) to a URL.
 * High-level convenience: passing `url` without `tabId` opens a new tab
 * first.
 */
export async function navigate(options: {
	url: string;
	tabId?: string;
	userId?: string;
	sessionKey?: string;
	waitUntil?: "load" | "domcontentloaded" | "networkidle";
	timeoutMs?: number;
}): Promise<NavigateResult> {
	let tabId = options.tabId;
	if (!tabId) {
		const tab = await createTab({
			userId: options.userId,
			sessionKey: options.sessionKey,
			url: options.url,
		});
		tabId = tab.tabId;
		return { tabId, url: options.url };
	}
	const body: Record<string, unknown> = {
		userId: options.userId ?? DEFAULT_USER_ID,
		sessionKey: options.sessionKey ?? DEFAULT_SESSION_KEY,
		url: options.url,
	};
	if (options.waitUntil) body.waitUntil = options.waitUntil;
	if (options.timeoutMs) body.timeoutMs = options.timeoutMs;
	const res = await request<{ status?: number; loadEvent?: string }>(
		`/tabs/${encodeURIComponent(tabId)}/navigate`,
		{ method: "POST", body },
	);
	return { tabId, url: options.url, status: res.status, loadEvent: res.loadEvent };
}

/**
 * Get an accessibility snapshot (DOM tree with ref ids) of the given tab.
 * Refs returned here can be used with `click`/`type`/`scroll`.
 */
export async function snapshot(options: { tabId: string; userId?: string }): Promise<unknown> {
	const userId = options.userId ?? DEFAULT_USER_ID;
	const qs = `?userId=${encodeURIComponent(userId)}`;
	return await request(`/tabs/${encodeURIComponent(options.tabId)}/snapshot${qs}`);
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
 * Extract the readable content of the current page (Readability-style).
 * For a fresh page, pass `url` to navigate first; otherwise the tab's
 * current document is extracted.
 */
export async function extract(options: {
	tabId?: string;
	userId?: string;
	sessionKey?: string;
	url?: string;
	mode?: "readability" | "html" | "text";
}): Promise<ExtractResult> {
	let tabId = options.tabId;
	if (!tabId) {
		if (!options.url) {
			throw new Error("extract() requires either tabId or url");
		}
		const tab = await createTab({
			userId: options.userId,
			sessionKey: options.sessionKey,
			url: options.url,
		});
		tabId = tab.tabId;
		// Wait for the navigation to settle before extracting.
		await request(`/tabs/${encodeURIComponent(tabId)}/wait`, {
			method: "POST",
			body: { userId: options.userId ?? DEFAULT_USER_ID, event: "load" },
		}).catch(() => {});
	} else if (options.url) {
		await navigate({
			tabId,
			url: options.url,
			userId: options.userId,
			sessionKey: options.sessionKey,
		});
	}

	// The camofox-browser POST /tabs/:tabId/extract endpoint is a
	// *deterministic* extractor that requires a structured `schema` of
	// refs from a prior snapshot — it's not a Readability extractor. Phi
	// callers expect a plain `{title, content, textContent}` blob, so we
	// achieve that via /evaluate, running a small Readability-style script
	// inside the page. This keeps the public API stable regardless of how
	// the camofox-browser server evolves.
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

	const evalRes = await request<{ ok?: boolean; result?: ExtractResult }>(
		`/tabs/${encodeURIComponent(tabId)}/evaluate`,
		{
			method: "POST",
			body: { userId: options.userId ?? DEFAULT_USER_ID, expression },
		},
	);
	return evalRes.result ?? {};
}

export interface ScreenshotResult {
	tabId: string;
	mimeType: string;
	bytesBase64: string;
}

/** Capture a screenshot of the given tab as a base64-encoded PNG. */
export async function screenshot(options: {
	tabId: string;
	userId?: string;
	fullPage?: boolean;
}): Promise<ScreenshotResult> {
	const query = new URLSearchParams();
	query.set("userId", options.userId ?? DEFAULT_USER_ID);
	// The server expects `fullPage=true` (string match), not `=1`.
	if (options.fullPage) query.set("fullPage", "true");
	// The camofox-browser screenshot endpoint streams a raw `image/png`
	// body, not a JSON envelope. Pull it as a Uint8Array and base64-encode
	// here so the result is JSON-safe for the tool result channel.
	const bytes = await request<Uint8Array>(
		`/tabs/${encodeURIComponent(options.tabId)}/screenshot?${query.toString()}`,
		{ responseType: "binary" },
	);
	return {
		tabId: options.tabId,
		mimeType: "image/png",
		bytesBase64: Buffer.from(bytes).toString("base64"),
	};
}

/**
 * High-level search macro: opens a new tab, navigates to a search engine
 * macro (`?q=...` on Google / DDG depending on host config), and returns
 * the readability extraction of the result page.
 */
export async function search(options: {
	query: string;
	engine?: "google" | "duckduckgo" | "bing";
	userId?: string;
	sessionKey?: string;
}): Promise<ExtractResult> {
	const engine = options.engine ?? "duckduckgo";
	const url =
		engine === "google"
			? `https://www.google.com/search?q=${encodeURIComponent(options.query)}`
			: engine === "bing"
				? `https://www.bing.com/search?q=${encodeURIComponent(options.query)}`
				: `https://duckduckgo.com/?q=${encodeURIComponent(options.query)}`;
	return await extract({ url, userId: options.userId, sessionKey: options.sessionKey });
}

/** Click an element by ref (from `snapshot`) or CSS selector. */
export async function click(options: {
	tabId: string;
	userId?: string;
	ref?: string;
	selector?: string;
	button?: "left" | "right" | "middle";
}): Promise<{ tabId: string }> {
	if (!options.ref && !options.selector) {
		throw new Error("click() requires `ref` or `selector`");
	}
	const body: Record<string, unknown> = { userId: options.userId ?? DEFAULT_USER_ID };
	if (options.ref) body.ref = options.ref;
	if (options.selector) body.selector = options.selector;
	if (options.button) body.button = options.button;
	await request(`/tabs/${encodeURIComponent(options.tabId)}/click`, {
		method: "POST",
		body,
	});
	return { tabId: options.tabId };
}

/** Type text into a focused element (or one targeted via ref/selector). */
export async function type(options: {
	tabId: string;
	userId?: string;
	text: string;
	ref?: string;
	selector?: string;
	pressEnter?: boolean;
	delayMs?: number;
}): Promise<{ tabId: string }> {
	const body: Record<string, unknown> = {
		userId: options.userId ?? DEFAULT_USER_ID,
		text: options.text,
	};
	if (options.ref) body.ref = options.ref;
	if (options.selector) body.selector = options.selector;
	if (options.pressEnter) body.pressEnter = options.pressEnter;
	if (options.delayMs !== undefined) body.delayMs = options.delayMs;
	await request(`/tabs/${encodeURIComponent(options.tabId)}/type`, {
		method: "POST",
		body,
	});
	return { tabId: options.tabId };
}

/** Scroll the page or a specific element by ref. */
export async function scroll(options: {
	tabId: string;
	userId?: string;
	direction: "up" | "down" | "left" | "right";
	ref?: string;
	pixels?: number;
}): Promise<{ tabId: string }> {
	const body: Record<string, unknown> = {
		userId: options.userId ?? DEFAULT_USER_ID,
		direction: options.direction,
	};
	if (options.ref) body.ref = options.ref;
	if (options.pixels) body.pixels = options.pixels;
	await request(`/tabs/${encodeURIComponent(options.tabId)}/scroll`, {
		method: "POST",
		body,
	});
	return { tabId: options.tabId };
}

/** Close a single tab. The underlying browser context is kept warm. */
export async function closeTab(options: { tabId: string; userId?: string }): Promise<{ tabId: string }> {
	const userId = options.userId ?? DEFAULT_USER_ID;
	const qs = `?userId=${encodeURIComponent(userId)}`;
	await request(`/tabs/${encodeURIComponent(options.tabId)}${qs}`, { method: "DELETE" });
	return { tabId: options.tabId };
}

export interface ListedTab {
	tabId: string;
	url?: string;
	title?: string;
	createdAt?: number;
}

/** List all open tabs for a user. */
export async function listTabs(options: { userId?: string } = {}): Promise<ListedTab[]> {
	const userId = options.userId ?? DEFAULT_USER_ID;
	// camofox-browser exposes tabs in /metrics; for a focused listing we
	// fall back to the underlying session endpoint when available, else
	// derive from /metrics.
	type TabsResp = { tabs?: ListedTab[] };
	const metrics = await request<TabsResp>(
		`/sessions/${encodeURIComponent(userId)}/tabs`,
	).catch(async (): Promise<TabsResp> => {
		const all = await request<TabsResp>("/metrics").catch((): TabsResp => ({}));
		return { tabs: Array.isArray(all.tabs) ? all.tabs : [] };
	});
	return metrics.tabs ?? [];
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
};
