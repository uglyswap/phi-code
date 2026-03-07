/**
 * Web Search Extension - Internet search capabilities for Phi Code
 *
 * Provides web search functionality with fallback options:
 * 1. Brave Search API (if BRAVE_API_KEY environment variable is set)
 * 2. DuckDuckGo HTML scraping fallback
 *
 * Features:
 * - web_search tool for LLM use
 * - Configurable result count
 * - Clean result formatting with titles, URLs, and descriptions
 * - Automatic fallback when API is unavailable
 *
 * Usage:
 * 1. Copy to packages/coding-agent/extensions/phi/web-search.ts
 * 2. Optionally set BRAVE_API_KEY environment variable
 * 3. Use web_search tool in conversations
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "phi-code";

interface SearchResult {
	title: string;
	url: string;
	description: string;
}

export default function webSearchExtension(pi: ExtensionAPI) {
	const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
	const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";

	// Rate limiting: max 1 request per second (Brave free tier limit)
	let lastRequestTime = 0;
	const MIN_INTERVAL_MS = 1100;

	async function rateLimitWait(): Promise<void> {
		const now = Date.now();
		const elapsed = now - lastRequestTime;
		if (elapsed < MIN_INTERVAL_MS) {
			await new Promise(resolve => setTimeout(resolve, MIN_INTERVAL_MS - elapsed));
		}
		lastRequestTime = Date.now();
	}

	/**
	 * Search using Brave Search API
	 */
	async function searchBrave(query: string, count: number = 5): Promise<SearchResult[]> {
		if (!BRAVE_API_KEY) {
			throw new Error("BRAVE_API_KEY environment variable not set");
		}

		const params = new URLSearchParams({
			q: query,
			count: count.toString(),
			offset: "0",
			mkt: "en-US",
			safesearch: "moderate",
			freshness: "pw", // Past week preference
			text_decorations: "false",
			spellcheck: "true"
		});

		await rateLimitWait();
		const response = await fetch(`${BRAVE_API_URL}?${params}`, {
			method: "GET",
			headers: {
				"Accept": "application/json",
				"Accept-Encoding": "gzip",
				"X-Subscription-Token": BRAVE_API_KEY
			}
		});

		if (!response.ok) {
			throw new Error(`Brave API error: ${response.status} ${response.statusText}`);
		}

		const data = await response.json();
		
		if (!data.web?.results) {
			return [];
		}

		return data.web.results.map((result: any): SearchResult => ({
			title: result.title || "No title",
			url: result.url || "",
			description: result.description || "No description available"
		}));
	}

	/**
	 * Search using DuckDuckGo HTML fallback
	 */
	async function searchDuckDuckGo(query: string, count: number = 5): Promise<SearchResult[]> {
		try {
			const encodedQuery = encodeURIComponent(query);
			const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

			const response = await fetch(url, {
				method: "GET",
				headers: {
					"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
				}
			});

			if (!response.ok) {
				throw new Error(`DuckDuckGo error: ${response.status} ${response.statusText}`);
			}

			const html = await response.text();
			
			// Parse HTML to extract search results
			const results: SearchResult[] = [];
			
			// Basic regex parsing for DuckDuckGo results
			// This is fragile but works for basic cases
			const resultPattern = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g;
			const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([^<]*)<\/a>/g;

			let match;
			const urls: string[] = [];
			const titles: string[] = [];

			// Extract titles and URLs
			while ((match = resultPattern.exec(html)) !== null && titles.length < count) {
				const url = match[1];
				const title = match[2];
				
				if (url && title && !url.startsWith('/')) {
					urls.push(url);
					titles.push(title.trim());
				}
			}

			// Extract snippets (descriptions)
			const descriptions: string[] = [];
			while ((match = snippetPattern.exec(html)) !== null && descriptions.length < titles.length) {
				descriptions.push(match[1].trim());
			}

			// Combine results
			for (let i = 0; i < Math.min(titles.length, count); i++) {
				results.push({
					title: titles[i] || "No title",
					url: urls[i] || "",
					description: descriptions[i] || "No description available"
				});
			}

			return results;

		} catch (error) {
			console.warn("DuckDuckGo fallback failed:", error);
			return [];
		}
	}

	/**
	 * Perform web search with automatic fallback
	 */
	async function performSearch(query: string, count: number = 5): Promise<SearchResult[]> {
		// Try Brave first if API key is available
		if (BRAVE_API_KEY) {
			try {
				const results = await searchBrave(query, count);
				if (results.length > 0) {
					return results;
				}
			} catch (error) {
				console.warn("Brave Search failed, falling back to DuckDuckGo:", error);
			}
		}

		// Fallback to DuckDuckGo
		return await searchDuckDuckGo(query, count);
	}

	/**
	 * Web search tool
	 */
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web for information using Brave Search API or DuckDuckGo fallback",
		parameters: Type.Object({
			query: Type.String({ 
				description: "Search query to find information about" 
			}),
			count: Type.Optional(Type.Number({ 
				description: "Number of results to return (1-10, default: 5)",
				minimum: 1,
				maximum: 10 
			})),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { query, count = 5 } = params as { query: string; count?: number };

			try {
				const results = await performSearch(query, count);

				if (results.length === 0) {
					return {
						content: [{ 
							type: "text", 
							text: `No search results found for "${query}". Try rephrasing your search or checking your internet connection.` 
						}],
						details: { found: false, query, resultCount: 0 }
					};
				}

				// Format results
				let resultText = `**Web Search Results for "${query}":**\n\n`;

				results.forEach((result, index) => {
					resultText += `**${index + 1}. ${result.title}**\n`;
					resultText += `🔗 ${result.url}\n`;
					resultText += `📄 ${result.description}\n\n`;
				});

				// Add search method info
				const method = BRAVE_API_KEY ? "Brave Search API" : "DuckDuckGo";
				resultText += `\n*Results provided by ${method}*`;

				return {
					content: [{ type: "text", text: resultText }],
					details: { 
						found: true, 
						query, 
						resultCount: results.length,
						method,
						results: results.map(r => ({ title: r.title, url: r.url }))
					}
				};

			} catch (error) {
				return {
					content: [{ 
						type: "text", 
						text: `Web search failed: ${error}. Please check your internet connection and try again.` 
					}],
					details: { error: String(error), found: false, query }
				};
			}
		},
	});

	/**
	 * /search command - Quick web search from chat
	 */
	pi.registerCommand("search", {
		description: "Perform a web search (usage: /search <query>)",
		handler: async (args, ctx) => {
			const query = args.trim();

			if (!query) {
				ctx.ui.notify("Usage: /search <search query>", "warning");
				return;
			}

			try {
				ctx.ui.notify(`🔍 Searching for: "${query}"...`, "info");
				
				const results = await performSearch(query, 3); // Fewer results for command

				if (results.length === 0) {
					ctx.ui.notify("No results found. Try different keywords.", "warning");
					return;
				}

				let message = `🔍 **Search Results for "${query}":**\n\n`;

				results.forEach((result, index) => {
					message += `**${index + 1}. ${result.title}**\n`;
					message += `${result.url}\n`;
					message += `${result.description.slice(0, 100)}...\n\n`;
				});

				const method = BRAVE_API_KEY ? "Brave Search" : "DuckDuckGo";
				message += `*Powered by ${method}*`;

				ctx.ui.notify(message, "info");

			} catch (error) {
				ctx.ui.notify(`Search failed: ${error}`, "error");
			}
		},
	});

	/**
	 * Show search configuration on session start
	 */
	pi.on("session_start", async (_event, ctx) => {
		if (BRAVE_API_KEY) {
			if (BRAVE_API_KEY.length < 10) {
				ctx.ui.notify("⚠️ BRAVE_API_KEY looks invalid (too short). Using DuckDuckGo fallback.", "warning");
			} else {
				ctx.ui.notify("🌐 Web search enabled (Brave Search API)", "info");
			}
		} else {
			ctx.ui.notify("🌐 Web search enabled (DuckDuckGo fallback — set BRAVE_API_KEY for better results)", "info");
		}
	});
}