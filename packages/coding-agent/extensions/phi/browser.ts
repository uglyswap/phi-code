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
			"Open a URL in a real anti-detect Firefox browser (Camoufox). " +
			"Use this as the FIRST STEP whenever you need to interact with a page " +
			"(click, fill a form, take a screenshot) or when a previous `fetch_url` " +
			"returned empty/minimal content (sign that the page is JavaScript-rendered " +
			"or behind bot protection like Cloudflare). " +
			"Returns `tabId` to chain with `browser_extract` / `browser_snapshot` / " +
			"`browser_click` / `browser_type` / `browser_screenshot` / `browser_scroll`. " +
			"Slower than `fetch_url` (~3-5s boot on first call) — do not use for plain " +
			"static HTML pages where `fetch_url` already works.",
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
			"Extract readable text from a fully rendered page using Mozilla Readability. " +
			"**PREFER THIS OVER `fetch_url`** when the target URL is: " +
			"(1) a JavaScript SPA (React, Vue, Svelte, Next.js client-side, etc.), " +
			"(2) behind Cloudflare / Akamai / PerimeterX bot protection, " +
			"(3) a site where `fetch_url` returned the shell HTML only (title + empty body, " +
			"or a noscript fallback). Also use this when you've already called " +
			"`browser_navigate` and want the page content. " +
			"Either pass `tabId` (continues in an existing tab) or `url` (opens a fresh " +
			"tab and extracts in one call). Slower than `fetch_url` — keep `fetch_url` as " +
			"the default for plain static pages, docs, blog posts, etc.",
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
			"Capture a PNG screenshot of an open tab. Use this whenever the user asks " +
			"to *see* a page, when a visual proof is requested (e.g. \"show me what " +
			"this looks like\", \"is the layout broken\", \"did the bot detection page " +
			"trigger?\"), or to confirm a UI state after `browser_click` / " +
			"`browser_type`. Requires a `tabId` from a prior `browser_navigate`. " +
			"Returns the image as base64 under `bytesBase64` with `mimeType: image/png`.",
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
			"Search the web *through* a real anti-detect Firefox browser, then return " +
			"the readability extraction of the results page. " +
			"**Fallback for `web_search`** — use this only when `web_search` " +
			"rate-limited, returned a CAPTCHA / 429 / 403, or you specifically need " +
			"the rendered search engine UI (e.g. featured snippets, knowledge cards, " +
			"AI Overview boxes). Slower than `web_search` and requires the Camoufox " +
			"browser to boot. Defaults to DuckDuckGo (least restrictive); pass " +
			"`engine: \"google\"` only when you need Google-specific results.",
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
			"Click an element on an open tab — buttons, links, checkboxes, modal " +
			"close icons, etc. Use this for any interactive workflow: accepting " +
			"cookies, dismissing popups, opening menus, submitting forms (alongside " +
			"`browser_type`), pagination, etc. Resolve the target with either " +
			"`ref` (from `browser_snapshot`, semantically stable across renders — " +
			"PREFERRED) or `selector` (CSS, fragile if the site changes). Requires " +
			"a `tabId` from `browser_navigate`. No interactive equivalent exists in " +
			"`fetch_url` / `web_search` — this tool is only available via the bundled " +
			"browser.",
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
			"Type text into an input or contenteditable on an open tab — search boxes, " +
			"login forms, chat composers, etc. Target with `ref` (PREFERRED, from " +
			"`browser_snapshot`) or `selector` (CSS). Without either, types into the " +
			"currently focused element. Set `pressEnter: true` to submit a form / " +
			"trigger a search. Combine with `browser_click` for full form workflows " +
			"(click field → type → click submit). No equivalent in `fetch_url` or " +
			"`web_search`.",
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
			"Scroll an open tab to reveal more content. Essential for infinite-scroll " +
			"feeds (Twitter/X, Reddit, news sites, e-commerce listings), lazy-loaded " +
			"images, and dropdowns inside scrollable containers. Defaults to scrolling " +
			"the page; pass `ref` to scroll inside a specific element. After scrolling, " +
			"re-run `browser_snapshot` or `browser_extract` to see the newly loaded " +
			"content.",
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
			"Return the accessibility tree of the current tab — a structured outline of " +
			"every interactive element (links, buttons, inputs, headings) with a stable " +
			"`ref` you can pass back to `browser_click` / `browser_type` / " +
			"`browser_scroll`. **Use this BEFORE clicking or typing** to discover the " +
			"`ref` of the target element — much more reliable than guessing CSS " +
			"selectors. Lighter and more semantic than raw HTML. " +
			"Requires a `tabId` from `browser_navigate`.",
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
		description:
			"Close a single browser tab once you no longer need it. " +
			"**Always call this at the end of a browsing workflow** to free memory — " +
			"a Camoufox tab can hold 50-200 MB. The underlying Firefox process stays " +
			"warm for the next `browser_navigate`, so this is cheap (no re-boot cost).",
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
		description:
			"List all open tabs in the current browser session with their URL, title, " +
			"and `tabId`. Use this to recover a `tabId` if you lost track of which tab " +
			"holds which page (e.g. across multi-step workflows that opened several " +
			"tabs). Cheap — no Firefox interaction required.",
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
