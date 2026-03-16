/**
 * Web Search Extension - Internet search capabilities for Phi Code
 *
 * Provides web search functionality with multiple free providers (NO API keys needed):
 * 1. Google scraping (cheerio-based, works on local machines)
 * 2. SearXNG (if SEARXNG_URL is configured, for VPS/server usage)
 * 3. DuckDuckGo HTML scraping (last resort fallback)
 *
 * Also provides:
 * - fetch_url tool for reading web pages
 * - /search command for quick searches
 *
 * Zero configuration needed — works out of the box.
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

// Rotating user agents for anti-bot evasion
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

export default function webSearchExtension(pi: ExtensionAPI) {
	const SEARXNG_URL = process.env.SEARXNG_URL || "";
	const HTTP_TIMEOUT = parseInt(process.env.HTTP_TIMEOUT || "15000", 10);

	// Rate limiting
	let lastRequestTime = 0;
	const MIN_INTERVAL_MS = 1500;

	async function rateLimitWait(): Promise<void> {
		const now = Date.now();
		const elapsed = now - lastRequestTime;
		if (elapsed < MIN_INTERVAL_MS) {
			await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS - elapsed));
		}
		lastRequestTime = Date.now();
	}

	// ─── Simple HTML parser (no external dependency) ───

	function decodeHtmlEntities(text: string): string {
		return text
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&#x27;/g, "'")
			.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
			.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
	}

	function stripTags(html: string): string {
		return decodeHtmlEntities(html.replace(/<[^>]*>/g, "")).trim();
	}

	// ─── Provider 1: Google Scraping ───

	async function searchGoogle(query: string, count: number): Promise<SearchResult[]> {
		await rateLimitWait();

		const params = new URLSearchParams({
			q: query,
			num: Math.min(count + 2, 12).toString(), // request a few extra
			hl: "en",
			gl: "us",
		});

		const response = await fetch(`https://www.google.com/search?${params}`, {
			method: "GET",
			headers: {
				"User-Agent": randomUA(),
				Accept: "text/html,application/xhtml+xml",
				"Accept-Language": "en-US,en;q=0.9",
				"Accept-Encoding": "gzip, deflate",
				Cookie: "CONSENT=PENDING+987",
			},
			signal: AbortSignal.timeout(HTTP_TIMEOUT),
		});

		if (!response.ok) {
			throw new Error(`Google HTTP ${response.status}`);
		}

		const html = await response.text();

		// Check for CAPTCHA or JS-only page
		if (html.includes("detected unusual traffic") || html.includes("sorry/index") || html.includes("g-recaptcha")) {
			throw new Error("Google CAPTCHA detected");
		}

		const results: SearchResult[] = [];

		// Strategy 1: Parse <div class="g"> blocks with <h3> and <a href>
		const gBlockRegex = /<div class="g"[^>]*>(.*?)<\/div>\s*<\/div>\s*<\/div>/gs;
		let gMatch;
		while ((gMatch = gBlockRegex.exec(html)) !== null && results.length < count) {
			const block = gMatch[1];
			const linkMatch = block.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/);
			const titleMatch = block.match(/<h3[^>]*>(.*?)<\/h3>/s);
			const snippetMatch = block.match(/<div[^>]*class="[^"]*VwiC3b[^"]*"[^>]*>(.*?)<\/div>/s) ||
				block.match(/<span[^>]*class="[^"]*st[^"]*"[^>]*>(.*?)<\/span>/s);

			if (linkMatch && titleMatch) {
				const url = linkMatch[1];
				if (!url.includes("google.com") && !url.includes("youtube.com/sorry")) {
					results.push({
						title: stripTags(titleMatch[1]),
						url: url,
						description: snippetMatch ? stripTags(snippetMatch[1]) : "",
						source: "google",
					});
				}
			}
		}

		// Strategy 2: If strategy 1 failed, try finding any h3+link combos
		if (results.length === 0) {
			const h3Regex = /<h3[^>]*>(.*?)<\/h3>/gs;
			const allH3: string[] = [];
			let h3Match;
			while ((h3Match = h3Regex.exec(html)) !== null) {
				allH3.push(h3Match[0]);
			}

			for (const h3Block of allH3) {
				// Look backwards from h3 for the nearest <a href>
				const pos = html.indexOf(h3Block);
				const before = html.substring(Math.max(0, pos - 500), pos + h3Block.length + 200);
				const linkMatch = before.match(/<a[^>]*href="(https?:\/\/(?!www\.google)[^"]+)"[^>]*>/);
				const titleText = stripTags(h3Block.match(/<h3[^>]*>(.*?)<\/h3>/s)?.[1] || "");

				if (linkMatch && titleText && results.length < count) {
					// Find snippet after the h3
					const afterH3 = html.substring(pos + h3Block.length, pos + h3Block.length + 500);
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

		// Strategy 3: Extract from embedded JSON in script tags (Google sometimes embeds data)
		if (results.length === 0) {
			const urlsInPage = new Set<string>();
			const extLinkRegex = /href="(https?:\/\/(?!www\.google|accounts\.google|support\.google|maps\.google|policies\.google)[^"]+)"/g;
			let extMatch;
			while ((extMatch = extLinkRegex.exec(html)) !== null) {
				urlsInPage.add(extMatch[1]);
			}

			for (const url of Array.from(urlsInPage).slice(0, count)) {
				results.push({
					title: url.replace(/https?:\/\/(www\.)?/, "").split("/")[0],
					url: url,
					description: "",
					source: "google",
				});
			}
		}

		if (results.length === 0) {
			throw new Error("Google returned no parseable results (JS-heavy page or blocked)");
		}

		return results.slice(0, count);
	}

	// ─── Provider 2: SearXNG (self-hosted, if configured) ───

	async function searchSearXNG(query: string, count: number): Promise<SearchResult[]> {
		if (!SEARXNG_URL) {
			throw new Error("SEARXNG_URL not configured");
		}

		await rateLimitWait();

		const params = new URLSearchParams({
			q: query,
			format: "json",
			engines: "google,bing,duckduckgo",
		});

		const response = await fetch(`${SEARXNG_URL}/search?${params}`, {
			method: "GET",
			headers: {
				Accept: "application/json",
				"User-Agent": randomUA(),
			},
			signal: AbortSignal.timeout(HTTP_TIMEOUT),
		});

		if (!response.ok) {
			throw new Error(`SearXNG HTTP ${response.status}`);
		}

		const data = (await response.json()) as any;
		const rawResults = data.results || [];

		return rawResults.slice(0, count).map((r: any): SearchResult => ({
			title: r.title || "No title",
			url: r.url || "",
			description: r.content || r.snippet || "",
			source: "searxng",
		}));
	}

	// ─── Provider 3: DuckDuckGo HTML (last resort) ───

	async function searchDuckDuckGo(query: string, count: number): Promise<SearchResult[]> {
		await rateLimitWait();

		const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
			method: "GET",
			headers: {
				"User-Agent": randomUA(),
				Accept: "text/html",
				"Accept-Language": "en-US,en;q=0.5",
			},
			signal: AbortSignal.timeout(HTTP_TIMEOUT),
		});

		if (!response.ok) {
			throw new Error(`DuckDuckGo HTTP ${response.status}`);
		}

		const html = await response.text();

		// Check for CAPTCHA
		if (html.includes("Please complete the following challenge") || html.includes("bots use DuckDuckGo")) {
			throw new Error("DuckDuckGo CAPTCHA detected");
		}

		const results: SearchResult[] = [];

		// Parse DDG HTML results
		const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs;
		const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;

		const links: Array<{ url: string; title: string }> = [];
		let linkMatch;
		while ((linkMatch = resultRegex.exec(html)) !== null && links.length < count) {
			let url = linkMatch[1];
			const title = stripTags(linkMatch[2]);

			// DDG wraps URLs: //duckduckgo.com/l/?uddg=ENCODED_URL
			if (url.includes("uddg=")) {
				try {
					url = decodeURIComponent(url.split("uddg=")[1].split("&")[0]);
				} catch {
					continue;
				}
			}

			if (url.startsWith("http") && title) {
				links.push({ url, title });
			}
		}

		const snippets: string[] = [];
		let snippetMatch;
		while ((snippetMatch = snippetRegex.exec(html)) !== null) {
			snippets.push(stripTags(snippetMatch[1]));
		}

		for (let i = 0; i < links.length; i++) {
			results.push({
				title: links[i].title,
				url: links[i].url,
				description: snippets[i] || "",
				source: "duckduckgo",
			});
		}

		if (results.length === 0) {
			throw new Error("DuckDuckGo returned no results (CAPTCHA or empty)");
		}

		return results;
	}

	// ─── Provider 4: DuckDuckGo Lite (text-only version, extra fallback) ───

	async function searchDDGLite(query: string, count: number): Promise<SearchResult[]> {
		await rateLimitWait();

		// Use POST method which sometimes bypasses CAPTCHA
		const response = await fetch("https://lite.duckduckgo.com/lite/", {
			method: "POST",
			headers: {
				"User-Agent": randomUA(),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: `q=${encodeURIComponent(query)}`,
			signal: AbortSignal.timeout(HTTP_TIMEOUT),
		});

		if (!response.ok) {
			throw new Error(`DDG Lite HTTP ${response.status}`);
		}

		const html = await response.text();

		if (html.includes("complete the following challenge") || html.includes("bots use DuckDuckGo")) {
			throw new Error("DDG Lite CAPTCHA detected");
		}

		const results: SearchResult[] = [];

		// DDG Lite uses table-based layout
		// Links in: <a rel="nofollow" href="URL" class='result-link'>TITLE</a>
		// Snippets in: <td class="result-snippet">TEXT</td>
		const linkRegex = /<a[^>]*class='result-link'[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gs;
		const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>(.*?)<\/td>/gs;

		const links: Array<{ url: string; title: string }> = [];
		let m;
		while ((m = linkRegex.exec(html)) !== null && links.length < count) {
			const url = m[1];
			const title = stripTags(m[2]);
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
				source: "duckduckgo-lite",
			});
		}

		if (results.length === 0) {
			throw new Error("DDG Lite returned no results");
		}

		return results;
	}

	// ─── Main search function with cascading fallback ───

	async function performSearch(query: string, count: number = 5): Promise<SearchResponse> {
		const triedProviders: string[] = [];
		const errors: string[] = [];

		// Build provider chain based on what's available
		type Provider = { name: string; fn: (q: string, c: number) => Promise<SearchResult[]> };
		const providers: Provider[] = [
			{ name: "google", fn: searchGoogle },
		];

		// Insert SearXNG as second choice if configured
		if (SEARXNG_URL) {
			providers.push({ name: "searxng", fn: searchSearXNG });
		}

		providers.push(
			{ name: "duckduckgo", fn: searchDuckDuckGo },
			{ name: "duckduckgo-lite", fn: searchDDGLite },
		);

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
				const msg = error?.message || String(error);
				errors.push(`${provider.name}: ${msg}`);
				console.warn(`[web-search] ${provider.name} failed: ${msg}`);
			}
		}

		// All providers failed
		console.error(`[web-search] All providers failed:\n${errors.join("\n")}`);
		return {
			results: [],
			provider: "none",
			fallbackUsed: true,
			triedProviders,
		};
	}

	// ─── Fetch URL tool (read web pages) ───

	async function fetchUrl(url: string, maxLength: number = 8000): Promise<string> {
		const response = await fetch(url, {
			headers: {
				"User-Agent": randomUA(),
				Accept: "text/html,application/xhtml+xml,text/plain",
			},
			signal: AbortSignal.timeout(HTTP_TIMEOUT),
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}

		const contentType = response.headers.get("content-type") || "";
		const text = await response.text();

		if (contentType.includes("text/plain") || contentType.includes("application/json")) {
			return text.substring(0, maxLength);
		}

		// Strip HTML tags for a readable version
		let readable = text
			// Remove script/style blocks
			.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
			.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
			.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
			.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
			.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
			// Convert some tags to text equivalents
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/p>/gi, "\n\n")
			.replace(/<\/h[1-6]>/gi, "\n\n")
			.replace(/<\/li>/gi, "\n")
			.replace(/<\/tr>/gi, "\n")
			// Strip remaining tags
			.replace(/<[^>]+>/g, " ")
			// Clean up whitespace
			.replace(/[ \t]+/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.trim();

		readable = decodeHtmlEntities(readable);

		return readable.substring(0, maxLength);
	}

	// ─── Register web_search tool ───

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web for information. Uses Google with automatic fallback to other providers. No API keys needed.",
		parameters: Type.Object({
			query: Type.String({
				description: "Search query",
			}),
			count: Type.Optional(
				Type.Number({
					description: "Number of results (1-10, default: 5)",
					minimum: 1,
					maximum: 10,
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { query, count = 5 } = params as { query: string; count?: number };

			try {
				const response = await performSearch(query, count);

				if (response.results.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `No search results found for "${query}". Try rephrasing your search or checking your internet connection.\n\nProviders tried: ${response.triedProviders.join(", ")}`,
							},
						],
						details: { found: false, query, resultCount: 0, triedProviders: response.triedProviders },
					};
				}

				let resultText = `**Web Search Results for "${query}":**\n\n`;

				response.results.forEach((result, index) => {
					resultText += `**${index + 1}. ${result.title}**\n`;
					resultText += `🔗 ${result.url}\n`;
					if (result.description) {
						resultText += `📄 ${result.description}\n`;
					}
					resultText += "\n";
				});

				resultText += `\n*Results provided by ${response.provider}*`;
				if (response.fallbackUsed) {
					resultText += ` *(fallback from: ${response.triedProviders.slice(0, -1).join(", ")})*`;
				}

				return {
					content: [{ type: "text", text: resultText }],
					details: {
						found: true,
						query,
						resultCount: response.results.length,
						provider: response.provider,
						fallbackUsed: response.fallbackUsed,
						triedProviders: response.triedProviders,
						results: response.results.map((r) => ({ title: r.title, url: r.url })),
					},
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Web search failed: ${error}. Please check your internet connection and try again.`,
						},
					],
					details: { error: String(error), found: false, query },
				};
			}
		},
	});

	// ─── Register fetch_url tool ───

	pi.registerTool({
		name: "fetch_url",
		label: "Fetch URL",
		description: "Fetch and extract readable text content from a URL. Strips HTML, scripts, and navigation to return clean text.",
		parameters: Type.Object({
			url: Type.String({
				description: "URL to fetch",
			}),
			max_length: Type.Optional(
				Type.Number({
					description: "Maximum characters to return (default: 8000)",
					minimum: 500,
					maximum: 50000,
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { url, max_length = 8000 } = params as { url: string; max_length?: number };

			try {
				const content = await fetchUrl(url, max_length);

				if (!content || content.length < 10) {
					return {
						content: [
							{
								type: "text",
								text: `Could not extract meaningful content from ${url}. The page may require JavaScript rendering.`,
							},
						],
						details: { success: false, url },
					};
				}

				const truncated = content.length >= max_length;
				return {
					content: [
						{
							type: "text",
							text: `**Content from ${url}:**\n\n${content}${truncated ? "\n\n*(content truncated)*" : ""}`,
						},
					],
					details: { success: true, url, length: content.length, truncated },
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to fetch ${url}: ${error}`,
						},
					],
					details: { success: false, url, error: String(error) },
				};
			}
		},
	});

	// ─── /search command ───

	pi.registerCommand("search", {
		description: "Quick web search (usage: /search <query>)",
		handler: async (args, ctx) => {
			const query = args.trim();

			if (!query) {
				ctx.ui.notify("Usage: /search <search query>", "warning");
				return;
			}

			try {
				ctx.ui.notify(`🔍 Searching for: "${query}"...`, "info");

				const response = await performSearch(query, 3);

				if (response.results.length === 0) {
					ctx.ui.notify("No results found. Try different keywords.", "warning");
					return;
				}

				let message = `🔍 **Search Results for "${query}":**\n\n`;

				response.results.forEach((result, index) => {
					message += `**${index + 1}. ${result.title}**\n`;
					message += `${result.url}\n`;
					if (result.description) {
						message += `${result.description.slice(0, 100)}...\n`;
					}
					message += "\n";
				});

				message += `*via ${response.provider}*`;
				ctx.ui.notify(message, "info");
			} catch (error) {
				ctx.ui.notify(`Search failed: ${error}`, "error");
			}
		},
	});

	// ─── Session start notification ───

	pi.on("session_start", async (_event, ctx) => {
		const providers = ["Google"];
		if (SEARXNG_URL) providers.push("SearXNG");
		providers.push("DuckDuckGo");
		ctx.ui.notify(`🌐 Web search enabled (${providers.join(" → ")} fallback chain)`, "info");
	});
}
