/**
 * Browser Extension for Phi Code
 *
 * Registers 10 browser tools backed by the bundled Camoufox stack
 * (`@phi-code-admin/browser`):
 *
 *   browser_navigate     : open/follow a URL
 *   browser_extract      : main-text extraction heuristic (works on SPAs)
 *   browser_screenshot   : PNG capture, returned as an image block
 *   browser_search       : DDG/Google search macro
 *   browser_click        : click by accessibility ref or CSS selector
 *   browser_type         : type text into focused/targeted element
 *   browser_scroll       : mouse-wheel scroll
 *   browser_snapshot     : accessibility tree with refs for follow-up tools
 *   browser_close_tab    : release a single tab
 *   browser_list_tabs    : list open tabs for the current session
 *
 * Lifecycle:
 *   - Lazy boot: the Camoufox server starts on the first tool call.
 *   - `session_shutdown`: best-effort `closeAll()` to avoid zombie Firefox.
 *   - PHI_BROWSER_DISABLED=1 disables the whole extension at startup (the
 *     user keeps the legacy `web_search` / `fetch_url` only).
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "@sinclair/typebox";
import { type AgentToolResult, type ExtensionAPI, formatDimensionNote, resizeImage } from "phi-code";

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

type ToolContent = AgentToolResult<unknown>["content"];

function textResult(value: unknown): AgentToolResult<undefined> {
	return { content: [{ type: "text", text: jsonResult(value) }], details: undefined };
}

/**
 * Turn a PNG screenshot into an image content block the model can see,
 * downscaled to the inline image limits (a full-page capture easily exceeds
 * them). Base64 in a text block would be invisible to the model and cost tens
 * of thousands of tokens.
 */
export async function screenshotContent(shot: {
	tabId: string;
	mimeType: string;
	bytesBase64: string;
}): Promise<ToolContent> {
	const resized = await resizeImage(Buffer.from(shot.bytesBase64, "base64"), shot.mimeType);
	if (!resized) {
		return [
			{
				type: "text",
				text: `Screenshot of tab ${shot.tabId} omitted: it could not be resized below the inline image size limit. Retry without fullPage.`,
			},
		];
	}
	const note = formatDimensionNote(resized);
	return [
		{ type: "text", text: `Screenshot of tab ${shot.tabId}${note ? ` ${note}` : ""}` },
		{ type: "image", data: resized.data, mimeType: resized.mimeType },
	];
}

/** Render a snapshot as plain text (no JSON escaping of the tree) with a pagination hint. */
export function snapshotText(res: {
	url?: string;
	snapshot?: string;
	refsCount?: number;
	totalChars?: number;
	hasMore?: boolean;
	nextOffset?: number | null;
}): string {
	const header = [`url: ${res.url ?? "?"}`, `refs: ${res.refsCount ?? 0}`];
	if (res.hasMore && typeof res.nextOffset === "number") {
		header.push(
			`truncated: ${res.totalChars ?? "?"} chars in total, call browser_snapshot again with offset=${res.nextOffset} for the next chunk`,
		);
	}
	return `${header.join("\n")}\n\n${res.snapshot ?? ""}`;
}

export default function browserExtension(pi: ExtensionAPI) {
	if (isDisabled()) {
		// Keep startup quiet — the user opted out.
		return;
	}

	// ─── browser_navigate ─────────────────────────────────────────────
	pi.registerTool({
		name: "browser_navigate",
		label: "Browser Navigate",
		description:
			"Open a URL in a real anti-detect Firefox browser (Camoufox). " +
			"Use this as the FIRST STEP whenever you need to interact with a page " +
			"(click, fill a form, take a screenshot) or when a previous `fetch_url` " +
			"returned empty/minimal content (sign that the page is JavaScript-rendered " +
			"or behind bot protection like Cloudflare). " +
			"Returns `tabId` (to chain with `browser_extract` / `browser_snapshot` / " +
			"`browser_click` / `browser_type` / `browser_screenshot` / `browser_scroll`) and the final `url`. " +
			"Without `tabId`, opens a new tab. Always waits for DOMContentLoaded (30 s max); " +
			'`waitUntil: "load"` also waits for the document to complete, `"networkidle"` additionally ' +
			"for the network to go quiet (5 s max); `timeoutMs` bounds that extra wait. " +
			"Slower than `fetch_url` (~3-5s boot on first call) — do not use for plain " +
			"static HTML pages where `fetch_url` already works.",
		parameters: Type.Object({
			url: Type.String({ description: "Full URL (https://...)" }),
			tabId: Type.Optional(Type.String({ description: "Existing tab to navigate; omit to open a new tab" })),
			waitUntil: Type.Optional(
				Type.Union([Type.Literal("load"), Type.Literal("domcontentloaded"), Type.Literal("networkidle")]),
			),
			timeoutMs: Type.Optional(Type.Number({ description: "Budget for the extra waitUntil wait (default 10000)" })),
		}),
		execute: async (_toolCallId, params, signal) => {
			const api = await getBrowserApi();
			return textResult(await api.navigate({ ...params, signal }));
		},
	});

	// ─── browser_extract ──────────────────────────────────────────────
	pi.registerTool({
		name: "browser_extract",
		label: "Browser Extract",
		description:
			"Extract the readable text of a fully rendered page (simple in-page heuristic: drops " +
			"scripts, nav, header, footer, aside and forms, keeps <main>, else <article>, else <body>; " +
			"text truncated to 50 000 characters, `length` gives the full size). " +
			"**PREFER THIS OVER `fetch_url`** when the target URL is: " +
			"(1) a JavaScript SPA (React, Vue, Svelte, Next.js client-side, etc.), " +
			"(2) behind Cloudflare / Akamai / PerimeterX bot protection, " +
			"(3) a site where `fetch_url` returned the shell HTML only (title + empty body, " +
			"or a noscript fallback). Also use this when you've already called " +
			"`browser_navigate` and want the page content. " +
			"Either pass `tabId` (continues in an existing tab) or `url` (opens a fresh " +
			'tab and extracts in one call). `mode: "text"` returns the whole body text, `"html"` the raw HTML. ' +
			"Slower than `fetch_url`: keep `fetch_url` as " +
			"the default for plain static pages, docs, blog posts, etc.",
		parameters: Type.Object({
			tabId: Type.Optional(Type.String()),
			url: Type.Optional(Type.String()),
			mode: Type.Optional(Type.Union([Type.Literal("readability"), Type.Literal("html"), Type.Literal("text")])),
		}),
		execute: async (_toolCallId, params, signal) => {
			const api = await getBrowserApi();
			return textResult(await api.extract({ ...params, signal }));
		},
	});

	// ─── browser_screenshot ───────────────────────────────────────────
	pi.registerTool({
		name: "browser_screenshot",
		label: "Browser Screenshot",
		description:
			"Capture a PNG screenshot of an open tab and return it as an image you can see. Use this whenever the user asks " +
			'to *see* a page, when a visual proof is requested (e.g. "show me what ' +
			'this looks like", "is the layout broken", "did the bot detection page ' +
			'trigger?"), or to confirm a UI state after `browser_click` / ' +
			"`browser_type`. Requires a `tabId` from a prior `browser_navigate`. " +
			"Large captures (especially `fullPage`) are downscaled.",
		parameters: Type.Object({
			tabId: Type.String(),
			fullPage: Type.Optional(Type.Boolean()),
		}),
		execute: async (_toolCallId, params, signal) => {
			const api = await getBrowserApi();
			const shot = await api.screenshot({ ...params, signal });
			return { content: await screenshotContent(shot), details: undefined };
		},
	});

	// ─── browser_search ───────────────────────────────────────────────
	pi.registerTool({
		name: "browser_search",
		label: "Browser Search",
		description:
			"Search the web *through* a real anti-detect Firefox browser, then return " +
			"the `browser_extract` text of the results page. " +
			"**Fallback for `web_search`** — use this only when `web_search` " +
			"rate-limited, returned a CAPTCHA / 429 / 403, or you specifically need " +
			"the rendered search engine UI (e.g. featured snippets, knowledge cards, " +
			"AI Overview boxes). Slower than `web_search` and requires the Camoufox " +
			"browser to boot. Defaults to DuckDuckGo (least restrictive); pass " +
			'`engine: "google"` only when you need Google-specific results.',
		parameters: Type.Object({
			query: Type.String(),
			engine: Type.Optional(Type.Union([Type.Literal("google"), Type.Literal("duckduckgo"), Type.Literal("bing")])),
		}),
		execute: async (_toolCallId, params, signal) => {
			const api = await getBrowserApi();
			return textResult(await api.search({ ...params, signal }));
		},
	});

	// ─── browser_click ────────────────────────────────────────────────
	pi.registerTool({
		name: "browser_click",
		label: "Browser Click",
		description:
			"Left-click an element on an open tab: buttons, links, checkboxes, modal " +
			"close icons, etc. Use this for any interactive workflow: accepting " +
			"cookies, dismissing popups, opening menus, submitting forms (alongside " +
			"`browser_type`), pagination, etc. Resolve the target with either " +
			"`ref` (from `browser_snapshot`, semantically stable across renders — " +
			"PREFERRED) or `selector` (CSS, fragile if the site changes). Requires " +
			"a `tabId` from `browser_navigate`. Returns the `url` after the click. " +
			"Right/middle clicks are not supported.",
		parameters: Type.Object({
			tabId: Type.String(),
			ref: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
		}),
		execute: async (_toolCallId, params, signal) => {
			const api = await getBrowserApi();
			return textResult(await api.click({ ...params, signal }));
		},
	});

	// ─── browser_type ─────────────────────────────────────────────────
	pi.registerTool({
		name: "browser_type",
		label: "Browser Type",
		description:
			"Type text into an input or contenteditable on an open tab — search boxes, " +
			"login forms, chat composers, etc. Target with `ref` (PREFERRED, from " +
			"`browser_snapshot`) or `selector` (CSS): the field value is replaced. Without either, " +
			"the text is typed key by key into the currently focused element (focus it first with " +
			"`browser_click`). `delayMs` types key by key with that delay (for inputs that ignore a " +
			"direct fill), appending to the current value. Set `pressEnter: true` to submit a form / " +
			"trigger a search. Combine with `browser_click` for full form workflows " +
			"(click field → type → click submit).",
		parameters: Type.Object({
			tabId: Type.String(),
			text: Type.String(),
			ref: Type.Optional(Type.String()),
			selector: Type.Optional(Type.String()),
			pressEnter: Type.Optional(Type.Boolean()),
			delayMs: Type.Optional(Type.Number({ description: "Delay between key presses (key-by-key mode)" })),
		}),
		execute: async (_toolCallId, params, signal) => {
			const api = await getBrowserApi();
			return textResult(await api.type({ ...params, signal }));
		},
	});

	// ─── browser_scroll ───────────────────────────────────────────────
	pi.registerTool({
		name: "browser_scroll",
		label: "Browser Scroll",
		description:
			"Scroll an open tab with the mouse wheel to reveal more content. Essential for infinite-scroll " +
			"feeds (Twitter/X, Reddit, news sites, e-commerce listings) and lazy-loaded " +
			"images. Scrolls by `amount` pixels (default 500) at the current pointer position, " +
			"so it scrolls the page or the scrollable area under the last clicked element. " +
			"After scrolling, re-run `browser_snapshot` or `browser_extract` to see the newly loaded " +
			"content.",
		parameters: Type.Object({
			tabId: Type.String(),
			direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]),
			amount: Type.Optional(Type.Number({ description: "Pixels to scroll (default 500)" })),
		}),
		execute: async (_toolCallId, params, signal) => {
			const api = await getBrowserApi();
			return textResult(await api.scroll({ ...params, signal }));
		},
	});

	// ─── browser_snapshot ─────────────────────────────────────────────
	pi.registerTool({
		name: "browser_snapshot",
		label: "Browser Snapshot",
		description:
			"Return the accessibility tree of the current tab — a structured outline of " +
			"every interactive element (links, buttons, inputs, headings) with a stable " +
			"`[eN]` ref you can pass back to `browser_click` / `browser_type`. " +
			"**Use this BEFORE clicking or typing** to discover the " +
			"`ref` of the target element — much more reliable than guessing CSS " +
			"selectors. Lighter and more semantic than raw HTML. Long pages are split into " +
			"~80 000-character chunks: when the header says so, call again with the given `offset`. " +
			"Requires a `tabId` from `browser_navigate`.",
		parameters: Type.Object({
			tabId: Type.String(),
			offset: Type.Optional(
				Type.Number({ description: "Character offset of the next chunk (from a previous call)" }),
			),
		}),
		execute: async (_toolCallId, params, signal) => {
			const api = await getBrowserApi();
			const res = await api.snapshot({ ...params, signal });
			return { content: [{ type: "text", text: snapshotText(res) }], details: undefined };
		},
	});

	// ─── browser_close_tab ────────────────────────────────────────────
	pi.registerTool({
		name: "browser_close_tab",
		label: "Browser Close Tab",
		description:
			"Close a single browser tab once you no longer need it. " +
			"**Always call this at the end of a browsing workflow** to free memory — " +
			"a Camoufox tab can hold 50-200 MB. The underlying Firefox process stays " +
			"warm for the next `browser_navigate`, so this is cheap (no re-boot cost).",
		parameters: Type.Object({
			tabId: Type.String(),
		}),
		execute: async (_toolCallId, params, signal) => {
			const api = await getBrowserApi();
			return textResult(await api.closeTab({ ...params, signal }));
		},
	});

	// ─── browser_list_tabs ────────────────────────────────────────────
	pi.registerTool({
		name: "browser_list_tabs",
		label: "Browser List Tabs",
		description:
			"List all open tabs in the current browser session with their URL, title, " +
			"and `tabId`. Use this to recover a `tabId` if you lost track of which tab " +
			"holds which page (e.g. across multi-step workflows that opened several " +
			"tabs). Cheap: no navigation involved.",
		parameters: Type.Object({
			userId: Type.Optional(Type.String()),
		}),
		execute: async (_toolCallId, params, signal) => {
			const api = await getBrowserApi();
			return textResult(await api.listTabs({ ...params, signal }));
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
