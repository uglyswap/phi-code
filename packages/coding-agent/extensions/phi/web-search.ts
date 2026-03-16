/**
 * Web Search & Fetch Extension for Phi Code
 *
 * Tools:
 * - web_search: Google scraping (primary) → DuckDuckGo (fallback) → Brave (if API key set)
 * - fetch_url: Read any URL and extract clean text (node-fetch + @mozilla/readability + jsdom)
 * - /search command for quick searches
 *
 * Zero API keys required. Works out of the box.
 * Optional: set BRAVE_API_KEY for Brave Search as extra fallback.
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "phi-code";

interface SearchResult {
	title: string;
	url: string;
	description: string;
	source?: string;
}

interface SearchResponse {
	results: SearchResult[];
	provider: string;
	fallbackUsed: boolean;
	triedProviders: string[];
}

// ─── Rotating User-Agents ───

const USER_AGENTS = [
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3.1 Safari/605.1.15",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0",
];

function randomUA(): string {
	return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── HTML helpers (zero dependencies) ───

function decodeEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]*>/g, "")).trim();
}

export default function webSearchExtension(pi: ExtensionAPI) {
	const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
	const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
	const HTTP_TIMEOUT = parseInt(process.env.HTTP_TIMEOUT || "15000", 10);

	// Rate limiting
	let lastRequestTime = 0;
	const MIN_INTERVAL_MS = 1500;

	async function rateLimitWait(): Promise<void> {
		const now = Date.now();
		const elapsed = now - lastRequestTime;
		if (elapsed < MIN_INTERVAL_MS) {
			await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
		}
		lastRequestTime = Date.now();
	}

	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Provider 1: Google Scraping (primary — works on local machines)
	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function searchGoogle(query: string, count: number): Promise<SearchResult[]> {
		await rateLimitWait();

		const params = new URLSearchParams({
			q: query,
			num: Math.min(count + 2, 12).toString(),
			hl: "en",
			gl: "us",
		});

		const response = await fetch(`https://www.google.com/search?${params}`, {
			headers: {
				"User-Agent": randomUA(),
				"Accept": "text/html,application/xhtml+xml",
				"Accept-Language": "en-US,en;q=0.9",
				"Cookie": "CONSENT=PENDING+987",
			},
			signal: AbortSignal.timeout(HTTP_TIMEOUT),
		});

		if (!response.ok) throw new Error(`Google HTTP ${response.status}`);

		const html = await response.text();

		if (html.includes("detected unusual traffic") || html.includes("sorry/index") || html.includes("g-recaptcha")) {
			throw new Error("Google CAPTCHA detected");
		}

		const results: SearchResult[] = [];

		// Strategy 1: <div class="g"> blocks with <h3> and <a href>
		const gBlockRegex = /<div class="g"[^>]*>(.*?)<\/div>\s*<\/div>\s*<\/div>/gs;
		let gMatch;
		while ((gMatch = gBlockRegex.exec(html)) !== null && results.length < count) {
			const block = gMatch[1];
			const linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/);
			const titleMatch = block.match(/<h3[^>]*>(.*?)<\/h3>/s);
			const snippetMatch = block.match(/<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>(.*?)<\/div>/s)
				|| block.match(/<span[^>]*class="[^"]*st[^"]*"[^>]*>(.*?)<\/span>/s);

			if (linkMatch && titleMatch) {
				const url = linkMatch[1];
				if (!url.includes("google.com")) {
					results.push({
						title: stripTags(titleMatch[1]),
						url,
						description: snippetMatch ? stripTags(snippetMatch[1]) : "",
						source: "google",
					});
				}
			}
		}

		// Strategy 2: find <h3> + nearest <a href>
		if (results.length === 0) {
			const h3Regex = /<h3[^>]*>(.*?)<\/h3>/gs;
			let h3Match;
			while ((h3Match = h3Regex.exec(html)) !== null && results.length < count) {
				const pos = h3Match.index;
				const surrounding = html.substring(Math.max(0, pos - 500), pos + h3Match[0].length + 200);
				const linkMatch = surrounding.match(/<a[^>]*href="(https?:\/\/(?!www\.google)[^"]+)"[^>]*>/);
				const titleText = stripTags(h3Match[1]);
				if (linkMatch && titleText) {
					const afterH3 = html.substring(pos + h3Match[0].length, pos + h3Match[0].length + 500);
					const snippetMatch = afterH3.match(/<(?:div|span)[^>]*>(.*?)<\/(?:div|span)>/s);
					results.push({
						title: titleText,
						url: linkMatch[1],
						description: snippetMatch ? stripTags(snippetMatch[1]).substring(0, 200) : "",
						source: "google",
					});
				}
			}
		}

		// Strategy 3: extract any external links
		if (results.length === 0) {
			const extRegex = /href="(https?:\/\/(?!www\.google|accounts\.google|support\.google|maps\.google|policies\.google)[^"]+)"/g;
			const seen = new Set<string>();
			let extMatch;
			while ((extMatch = extRegex.exec(html)) !== null && seen.size < count) {
				if (!seen.has(extMatch[1])) {
					seen.add(extMatch[1]);
					results.push({
						title: extMatch[1].replace(/https?:\/\/(www\.)?/, "").split("/")[0],
						url: extMatch[1],
						description: "",
						source: "google",
					});
				}
			}
		}

		if (results.length === 0) {
			throw new Error("Google returned no parseable results (JS-heavy page or blocked)");
		}

		return results.slice(0, count);
	}

	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Provider 2: DuckDuckGo HTML scraping (fallback)
	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function searchDuckDuckGo(query: string, count: number): Promise<SearchResult[]> {
		await rateLimitWait();

		const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
			headers: {
				"User-Agent": randomUA(),
				"Accept": "text/html",
				"Accept-Language": "en-US,en;q=0.5",
			},
			signal: AbortSignal.timeout(HTTP_TIMEOUT),
		});

		if (!response.ok) throw new Error(`DuckDuckGo HTTP ${response.status}`);

		const html = await response.text();

		if (html.includes("complete the following challenge") || html.includes("bots use DuckDuckGo")) {
			throw new Error("DuckDuckGo CAPTCHA detected");
		}

		const results: SearchResult[] = [];

		// Parse result links
		const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs;
		const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;

		const links: Array<{ url: string; title: string }> = [];
		let m;
		while ((m = linkRegex.exec(html)) !== null && links.length < count) {
			let url = m[1];
			const title = stripTags(m[2]);

			// DDG wraps URLs through redirect
			if (url.includes("uddg=")) {
				try { url = decodeURIComponent(url.split("uddg=")[1].split("&")[0]); } catch { continue; }
			}

			if (url.startsWith("http") && title) {
				links.push({ url, title });
			}
		}

		const snippets: string[] = [];
		while ((m = snippetRegex.exec(html)) !== null) {
			snippets.push(stripTags(m[1]));
		}

		for (let i = 0; i < links.length; i++) {
			results.push({
				title: links[i].title,
				url: links[i].url,
				description: snippets[i] || "",
				source: "duckduckgo",
			});
		}

		if (results.length === 0) throw new Error("DuckDuckGo returned no results");

		return results;
	}

	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Provider 3: Brave Search API (fallback, needs BRAVE_API_KEY)
	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function searchBrave(query: string, count: number): Promise<SearchResult[]> {
		if (!BRAVE_API_KEY) throw new Error("BRAVE_API_KEY not set");

		await rateLimitWait();

		const params = new URLSearchParams({
			q: query,
			count: count.toString(),
			offset: "0",
			safesearch: "moderate",
			text_decorations: "false",
			spellcheck: "true",
		});

		const response = await fetch(`${BRAVE_API_URL}?${params}`, {
			headers: {
				"Accept": "application/json",
				"Accept-Encoding": "gzip",
				"X-Subscription-Token": BRAVE_API_KEY,
			},
			signal: AbortSignal.timeout(HTTP_TIMEOUT),
		});

		if (!response.ok) throw new Error(`Brave API HTTP ${response.status}`);

		const data = await response.json() as any;
		if (!data.web?.results) return [];

		return data.web.results.map((r: any): SearchResult => ({
			title: r.title || "No title",
			url: r.url || "",
			description: r.description || "",
			source: "brave",
		}));
	}

	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Search orchestrator with cascading fallback
	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	async function performSearch(query: string, count: number = 5): Promise<SearchResponse> {
		const triedProviders: string[] = [];

		type Provider = { name: string; fn: (q: string, c: number) => Promise<SearchResult[]> };
		const providers: Provider[] = [
			{ name: "google", fn: searchGoogle },
			{ name: "duckduckgo", fn: searchDuckDuckGo },
		];
		if (BRAVE_API_KEY) {
			providers.push({ name: "brave", fn: searchBrave });
		}

		for (const provider of providers) {
			triedProviders.push(provider.name);
			try {
				const results = await provider.fn(query, count);
				if (results.length > 0) {
					return {
						results,
						provider: provider.name,
						fallbackUsed: triedProviders.length > 1,
						triedProviders,
					};
				}
			} catch (error: any) {
				console.warn(`[web-search] ${provider.name} failed: ${error?.message || error}`);
			}
		}

		return { results: [], provider: "none", fallbackUsed: true, triedProviders };
	}

	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// fetch_url: Read web pages (readability + jsdom if available, raw fallback)
	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	// Lazy-loaded optional deps (installed by user if they want better extraction)
	let _Readability: any = null;
	let _JSDOM: any = null;
	let _readabilityChecked = false;

	async function tryLoadReadability(): Promise<boolean> {
		if (_readabilityChecked) return !!_Readability;
		_readabilityChecked = true;
		try {
			const readabilityMod = await import("@mozilla/readability");
			_Readability = readabilityMod.Readability;
			const jsdomMod = await import("jsdom");
			_JSDOM = jsdomMod.JSDOM;
			return true;
		} catch {
			return false;
		}
	}

	async function fetchUrl(url: string, maxLength: number = 8000): Promise<string> {
		const response = await fetch(url, {
			headers: {
				"User-Agent": randomUA(),
				"Accept": "text/html,application/xhtml+xml,text/plain,application/json",
			},
			signal: AbortSignal.timeout(HTTP_TIMEOUT),
		});

		if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

		const contentType = response.headers.get("content-type") || "";
		const text = await response.text();

		// Plain text / JSON — return as-is
		if (contentType.includes("text/plain") || contentType.includes("application/json")) {
			return text.substring(0, maxLength);
		}

		// Try Readability + JSDOM (best quality extraction)
		const hasReadability = await tryLoadReadability();
		if (hasReadability && _JSDOM && _Readability) {
			try {
				const dom = new _JSDOM(text, { url });
				const reader = new _Readability(dom.window.document);
				const article = reader.parse();
				if (article?.textContent) {
					return article.textContent.substring(0, maxLength);
				}
			} catch {
				// Fall through to basic extraction
			}
		}

		// Basic HTML → text extraction (no dependencies)
		let readable = text
			.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
			.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
			.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
			.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
			.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/p>/gi, "\n\n")
			.replace(/<\/h[1-6]>/gi, "\n\n")
			.replace(/<\/li>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
			.replace(/[ \t]+/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.trim();

		return decodeEntities(readable).substring(0, maxLength);
	}

	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Tool: web_search
	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web. Uses Google (primary), DuckDuckGo (fallback), Brave (if API key set). No API keys required.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			count: Type.Optional(Type.Number({
				description: "Number of results (1-10, default: 5)",
				minimum: 1,
				maximum: 10,
			})),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { query, count = 5 } = params as { query: string; count?: number };

			try {
				const response = await performSearch(query, count);

				if (response.results.length === 0) {
					return {
						content: [{
							type: "text",
							text: `No search results found for "${query}". Try rephrasing your search.\n\nProviders tried: ${response.triedProviders.join(", ")}`,
						}],
						details: { found: false, query, triedProviders: response.triedProviders },
					};
				}

				let resultText = `**Web Search Results for "${query}":**\n\n`;
				response.results.forEach((result, i) => {
					resultText += `**${i + 1}. ${result.title}**\n`;
					resultText += `🔗 ${result.url}\n`;
					if (result.description) resultText += `📄 ${result.description}\n`;
					resultText += "\n";
				});
				resultText += `\n*Results provided by ${response.provider}*`;
				if (response.fallbackUsed) {
					resultText += ` *(fallback from: ${response.triedProviders.filter(p => p !== response.provider).join(", ")})*`;
				}

				return {
					content: [{ type: "text", text: resultText }],
					details: {
						found: true, query,
						resultCount: response.results.length,
						provider: response.provider,
						fallbackUsed: response.fallbackUsed,
						triedProviders: response.triedProviders,
						results: response.results.map((r) => ({ title: r.title, url: r.url })),
					},
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Web search failed: ${error}` }],
					details: { error: String(error), found: false, query },
				};
			}
		},
	});

	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Tool: fetch_url
	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URL",
		description: "Fetch a URL and extract readable text content. Uses @mozilla/readability + jsdom if installed, otherwise basic HTML extraction.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			max_length: Type.Optional(Type.Number({
				description: "Max characters to return (default: 8000)",
				minimum: 500,
				maximum: 50000,
			})),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { url, max_length = 8000 } = params as { url: string; max_length?: number };

			try {
				const content = await fetchUrl(url, max_length);

				if (!content || content.length < 10) {
					return {
						content: [{ type: "text", text: `Could not extract content from ${url}. The page may require JavaScript.` }],
						details: { success: false, url },
					};
				}

				const truncated = content.length >= max_length;
				return {
					content: [{ type: "text", text: `**Content from ${url}:**\n\n${content}${truncated ? "\n\n*(truncated)*" : ""}` }],
					details: { success: true, url, length: content.length, truncated },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Failed to fetch ${url}: ${error}` }],
					details: { success: false, url, error: String(error) },
				};
			}
		},
	});

	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Command: /search
	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	pi.registerCommand("search", {
		description: "Quick web search (usage: /search <query>)",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) { ctx.ui.notify("Usage: /search <query>", "warning"); return; }

			try {
				ctx.ui.notify(`🔍 Searching: "${query}"...`, "info");
				const response = await performSearch(query, 3);

				if (response.results.length === 0) {
					ctx.ui.notify("No results found.", "warning");
					return;
				}

				let msg = `🔍 **"${query}":**\n\n`;
				response.results.forEach((r, i) => {
					msg += `**${i + 1}. ${r.title}**\n${r.url}\n`;
					if (r.description) msg += `${r.description.slice(0, 100)}...\n`;
					msg += "\n";
				});
				msg += `*via ${response.provider}*`;
				ctx.ui.notify(msg, "info");
			} catch (error) {
				ctx.ui.notify(`Search failed: ${error}`, "error");
			}
		},
	});

	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
	// Session start
	// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

	pi.on("session_start", async (_event, ctx) => {
		const chain = ["Google", "DuckDuckGo"];
		if (BRAVE_API_KEY) chain.push("Brave");
		const hasReadability = await tryLoadReadability();
		const fetchMode = hasReadability ? "readability+jsdom" : "basic HTML extraction";
		ctx.ui.notify(`🌐 Web search (${chain.join(" → ")}) · fetch_url (${fetchMode})`, "info");
	});
}
