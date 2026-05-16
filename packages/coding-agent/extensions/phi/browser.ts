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

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "phi-code";

// PHI-VENDOR: dynamic import so phi-code keeps starting even when the
// vendored browser stack isn't installed (e.g. binaries unavailable for
// the host's `process.platform`-`process.arch` combo). We surface a
// concrete error on first tool call instead of refusing to boot.
type BrowserApi = typeof import("@phi-code-admin/browser");

let cachedApi: BrowserApi | undefined;
let importError: Error | undefined;

async function getBrowserApi(): Promise<BrowserApi> {
	if (cachedApi) return cachedApi;
	if (importError) throw importError;
	try {
		cachedApi = (await import("@phi-code-admin/browser")) as BrowserApi;
		return cachedApi;
	} catch (err) {
		importError = err instanceof Error ? err : new Error(String(err));
		throw importError;
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
