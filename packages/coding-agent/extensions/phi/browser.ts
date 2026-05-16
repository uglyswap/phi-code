/**
 * Browser Extension for Phi Code
 *
 * Registers 10 browser tools backed by the bundled Camoufox stack
 * (`@phi-code-admin/browser`):
 *
 *   browser_navigate     — open/follow a URL
 *   browser_extract      — readability extraction (works on SPAs)
 *   browser_screenshot   — PNG capture, base64 in the tool result
 *   browser_search       — DDG/Google search macro
 *   browser_click        — click by accessibility ref or CSS selector
 *   browser_type         — type text into focused/targeted element
 *   browser_scroll       — page/element scroll
 *   browser_snapshot     — accessibility tree with refs for follow-up tools
 *   browser_close_tab    — release a single tab
 *   browser_list_tabs    — list open tabs for the current session
 *
 * Lifecycle:
 *   - Lazy boot: the Camoufox server starts on the first tool call.
 *   - `session_shutdown`: best-effort `closeAll()` to avoid zombie Firefox.
 *   - PHI_BROWSER_DISABLED=1 disables the whole extension at startup (the
 *     user keeps the legacy `web_search` / `fetch_url` only).
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "phi-code";

// PHI-VENDOR: dynamic import so phi-code keeps starting even when the
// vendored browser stack isn't installed (e.g. binaries unavailable for
// the host's `process.platform`-`process.arch` combo). We surface a
// concrete error on first tool call instead of refusing to boot.
type BrowserApi = typeof import("@phi-code-admin/browser");

let cachedApi: BrowserApi | undefined;

/**
 * Resolve `@phi-code-admin/browser` from the host phi-code installation
 * (the binary that loaded us, via `process.argv[1]`), not from this file's
 * location. The extension is typically copied by phi-code's postinstall
 * into `~/.phi/agent/extensions/browser.ts`, which has no `node_modules`
 * of its own — a plain `import("@phi-code-admin/browser")` would resolve
 * relative to that copy and fail. Walking the resolution from
 * `process.argv[1]` (the `phi` CLI entry, which DOES sit next to its
 * bundled `node_modules`) finds the package every time.
 */
function browserPackageFromPhi(): string | undefined {
	const cliPath = process.argv[1];
	if (!cliPath) return undefined;
	try {
		const req = createRequire(pathToFileURL(cliPath));
		return req.resolve("@phi-code-admin/browser");
	} catch {
		// Fall through — we'll try walking up from cliPath manually.
	}
	let dir = dirname(cliPath);
	for (let depth = 0; depth < 8; depth++) {
		const candidate = join(dir, "node_modules", "@phi-code-admin", "browser", "dist", "index.js");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

async function getBrowserApi(): Promise<BrowserApi> {
	if (cachedApi) return cachedApi;

	// 1. Try the standard dynamic import first. This works when the extension
	//    lives next to a `node_modules/@phi-code-admin/browser` (dev / monorepo
	//    layouts and any setup where the user has run a fresh `npm install` in
	//    the extension's directory).
	try {
		cachedApi = (await import("@phi-code-admin/browser")) as BrowserApi;
		return cachedApi;
	} catch (firstErr) {
		// 2. Fall back to resolving through the phi CLI binary, which always
		//    sits next to its bundled deps even when the extension was copied
		//    elsewhere by the postinstall script.
		const resolved = browserPackageFromPhi();
		if (resolved) {
			try {
				cachedApi = (await import(pathToFileURL(resolved).href)) as BrowserApi;
				return cachedApi;
			} catch (secondErr) {
				// Re-throw the second error: it's the more informative one.
				throw secondErr instanceof Error ? secondErr : new Error(String(secondErr));
			}
		}
		// 3. No path worked. Throw the original error WITHOUT caching it, so
		//    the user can fix their install and the next tool call retries.
		throw firstErr instanceof Error ? firstErr : new Error(String(firstErr));
	}
}

function isDisabled(): boolean {
	const v = process.env.PHI_BROWSER_DISABLED;
	return v === "1" || v === "true" || v === "yes";
}

function jsonResult(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export default function browserExtension(pi: ExtensionAPI) {
	if (isDisabled()) {
		// Keep startup quiet — the user opted out.
		return;
	}

	// ─── browser_navigate ─────────────────────────────────────────────
	pi.registerTool({
		name: "browser_navigate",
		description:
			"Open a URL in a Camoufox tab. If `tabId` is omitted, a new tab is created. Returns the tab id, the final URL and the HTTP status when available.",
		parameters: Type.Object({
			url: Type.String({ description: "Full URL (https://...)" }),
			tabId: Type.Optional(Type.String()),
			waitUntil: Type.Optional(
				Type.Union([
					Type.Literal("load"),
					Type.Literal("domcontentloaded"),
					Type.Literal("networkidle"),
				]),
			),
			timeoutMs: Type.Optional(Type.Number()),
		}),
		execute: async (params) => {
			const api = await getBrowserApi();
			const res = await api.navigate(params);
			return { content: [{ type: "text", text: jsonResult(res) }] };
		},
	});

	// ─── browser_extract ──────────────────────────────────────────────
	pi.registerTool({
		name: "browser_extract",
		description:
			"Return the readable content of a page (Mozilla Readability under the hood). Works on SPA / JS-heavy sites. Pass either `tabId` (existing tab) or `url` (opens a fresh tab).",
		parameters: Type.Object({
			tabId: Type.Optional(Type.String()),
			url: Type.Optional(Type.String()),
			mode: Type.Optional(
				Type.Union([
					Type.Literal("readability"),
					Type.Literal("html"),
					Type.Literal("text"),
				]),
			),
		}),
		execute: async (params) => {
			const api = await getBrowserApi();
			const res = await api.extract(params);
			return { content: [{ type: "text", text: jsonResult(res) }] };
		},
	});

	// ─── browser_screenshot ───────────────────────────────────────────
	pi.registerTool({
		name: "browser_screenshot",
		description:
			"Capture a screenshot of the current tab as a PNG. The image bytes are returned base64-encoded under `bytesBase64`.",
		parameters: Type.Object({
			tabId: Type.String(),
			fullPage: Type.Optional(Type.Boolean()),
		}),
		execute: async (params) => {
			const api = await getBrowserApi();
			const res = await api.screenshot(params);
			return { content: [{ type: "text", text: jsonResult(res) }] };
		},
	});

	// ─── browser_search ───────────────────────────────────────────────
	pi.registerTool({
		name: "browser_search",
		description:
			"Run a web search through the Camoufox browser (anti-detect Firefox) and return the readability extraction of the results page. Useful when scraping Google directly is rate-limited.",
		parameters: Type.Object({
			query: Type.String(),
			engine: Type.Optional(
				Type.Union([
					Type.Literal("google"),
					Type.Literal("duckduckgo"),
					Type.Literal("bing"),
				]),
			),
		}),
		execute: async (params) => {
			const api = await getBrowserApi();
			const res = await api.search(params);
			return { content: [{ type: "text", text: jsonResult(res) }] };
		},
	});

	// ─── browser_click ────────────────────────────────────────────────
	pi.registerTool({
		name: "browser_click",
		description:
			"Click an element. Pass either `ref` (returned by browser_snapshot) or `selector` (CSS).",
		parameters: Type.Object({
			tabId: Type.String(),
			ref: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			button: Type.Optional(
				Type.Union([
					Type.Literal("left"),
					Type.Literal("right"),
					Type.Literal("middle"),
				]),
			),
		}),
		execute: async (params) => {
			const api = await getBrowserApi();
			const res = await api.click(params);
			return { content: [{ type: "text", text: jsonResult(res) }] };
		},
	});

	// ─── browser_type ─────────────────────────────────────────────────
	pi.registerTool({
		name: "browser_type",
		description:
			"Type text into an element. Pass `ref` or `selector` to target a specific input; otherwise types into the currently focused element. Set `pressEnter: true` to submit a form.",
		parameters: Type.Object({
			tabId: Type.String(),
			text: Type.String(),
			ref: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			pressEnter: Type.Optional(Type.Boolean()),
			delayMs: Type.Optional(Type.Number()),
		}),
		execute: async (params) => {
			const api = await getBrowserApi();
			const res = await api.type(params);
			return { content: [{ type: "text", text: jsonResult(res) }] };
		},
	});

	// ─── browser_scroll ───────────────────────────────────────────────
	pi.registerTool({
		name: "browser_scroll",
		description:
			"Scroll the page (or a specific element by `ref`) by `pixels` in the given direction.",
		parameters: Type.Object({
			tabId: Type.String(),
			direction: Type.Union([
				Type.Literal("up"),
				Type.Literal("down"),
				Type.Literal("left"),
				Type.Literal("right"),
			]),
			ref: Type.Optional(Type.String()),
			pixels: Type.Optional(Type.Number()),
		}),
		execute: async (params) => {
			const api = await getBrowserApi();
			const res = await api.scroll(params);
			return { content: [{ type: "text", text: jsonResult(res) }] };
		},
	});

	// ─── browser_snapshot ─────────────────────────────────────────────
	pi.registerTool({
		name: "browser_snapshot",
		description:
			"Return the accessibility tree for the current tab. Each node carries a `ref` that can be passed back to browser_click / browser_type / browser_scroll. Cheaper than parsing HTML.",
		parameters: Type.Object({
			tabId: Type.String(),
		}),
		execute: async (params) => {
			const api = await getBrowserApi();
			const res = await api.snapshot(params);
			return { content: [{ type: "text", text: jsonResult(res) }] };
		},
	});

	// ─── browser_close_tab ────────────────────────────────────────────
	pi.registerTool({
		name: "browser_close_tab",
		description: "Close a single tab. The browser process stays warm.",
		parameters: Type.Object({
			tabId: Type.String(),
		}),
		execute: async (params) => {
			const api = await getBrowserApi();
			const res = await api.closeTab(params);
			return { content: [{ type: "text", text: jsonResult(res) }] };
		},
	});

	// ─── browser_list_tabs ────────────────────────────────────────────
	pi.registerTool({
		name: "browser_list_tabs",
		description: "List open tabs for the current user.",
		parameters: Type.Object({
			userId: Type.Optional(Type.String()),
		}),
		execute: async (params) => {
			const api = await getBrowserApi();
			const res = await api.listTabs(params);
			return { content: [{ type: "text", text: jsonResult(res) }] };
		},
	});

	// ─── Lifecycle: shut the Firefox process down on session shutdown ──
	pi.on("session_shutdown", async () => {
		if (!cachedApi) return;
		try {
			await cachedApi.closeAll();
		} catch {
			// best-effort
		}
	});
}
