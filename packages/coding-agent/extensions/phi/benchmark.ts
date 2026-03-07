/**
 * Benchmark Extension - Production-grade model performance testing
 *
 * Tests AI models across 6 categories:
 * 1. Code Generation — Write a function from a spec
 * 2. Debugging — Find and fix a bug
 * 3. Planning — Create an implementation plan
 * 4. Tool Calling — Generate structured JSON output
 * 5. Speed — Response latency measurement
 * 6. Orchestration — Multi-step reasoning task
 *
 * Usage:
 * - /benchmark            — Run benchmark on current model
 * - /benchmark all        — Run on all available models
 * - /benchmark results    — Show saved results
 * - /benchmark compare    — Side-by-side model comparison
 * - /benchmark clear      — Clear all results
 */

import type { ExtensionAPI, ExtensionContext } from "phi-code";
import { writeFile, mkdir, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────────

interface TestCase {
	category: "code-gen" | "debug" | "planning" | "tool-calling" | "speed" | "orchestration";
	name: string;
	prompt: string;
	validate: (response: string) => TestResult;
	weight: number; // Score weight (1-3)
}

interface TestResult {
	passed: boolean;
	score: number; // 0-100
	details: string;
}

interface ModelBenchmark {
	modelId: string;
	modelName: string;
	provider: string;
	timestamp: string;
	categories: {
		[key: string]: {
			score: number;
			timeMs: number;
			details: string;
		};
	};
	totalScore: number;
	totalTimeMs: number;
	avgTimeMs: number;
}

interface BenchmarkStore {
	version: 2;
	results: ModelBenchmark[];
	lastUpdated: string;
}

// ─── Test Suite ──────────────────────────────────────────────────────────

function createTestSuite(): TestCase[] {
	return [
		// 1. CODE GENERATION
		{
			category: "code-gen",
			name: "Fibonacci Function",
			weight: 2,
			prompt: `Write a TypeScript function called 'fibonacci' that:
- Takes a number n as parameter
- Returns the nth Fibonacci number
- Handles edge cases (n <= 0 returns 0, n = 1 returns 1)
- Uses iterative approach (not recursive)
- Is properly typed

Respond with ONLY the function code, no explanations.`,
			validate: (response: string) => {
				const code = extractCode(response);
				const checks = [
					{ test: /function\s+fibonacci/.test(code), detail: "Function named 'fibonacci'" },
					{ test: /:\s*number/.test(code), detail: "TypeScript type annotation" },
					{ test: /return/.test(code), detail: "Has return statement" },
					{ test: /for|while/.test(code), detail: "Uses iteration (not recursion)" },
					{ test: /(<=\s*0|===?\s*0|<\s*1)/.test(code), detail: "Handles edge case n=0" },
					{ test: /(===?\s*1|<=\s*1)/.test(code), detail: "Handles edge case n=1" },
				];
				const passed = checks.filter(c => c.test).length;
				const total = checks.length;
				return {
					passed: passed >= 5,
					score: Math.round((passed / total) * 100),
					details: checks.map(c => `${c.test ? "✅" : "❌"} ${c.detail}`).join("\n"),
				};
			},
		},

		// 2. DEBUGGING
		{
			category: "debug",
			name: "Find the Bug",
			weight: 2,
			prompt: `Find and fix the bug in this TypeScript code:

\`\`\`typescript
function mergeArrays<T>(arr1: T[], arr2: T[]): T[] {
  const result = arr1;
  for (let i = 0; i < arr2.length; i++) {
    result.push(arr2[i]);
  }
  return result;
}

// Bug: calling mergeArrays modifies the original arr1
const a = [1, 2, 3];
const b = [4, 5, 6];
const merged = mergeArrays(a, b);
console.log(a); // Expected [1,2,3] but got [1,2,3,4,5,6]
\`\`\`

Explain the bug and provide the fixed code.`,
			validate: (response: string) => {
				const lower = response.toLowerCase();
				const checks = [
					{ test: /reference|shallow|copy|spread|\[\.\.\./.test(lower), detail: "Identifies reference/copy issue" },
					{ test: /\[\.\.\.arr1\]|\[\.\.\.arr1,|Array\.from|\.slice\(\)|structuredClone|concat/.test(response), detail: "Uses spread/copy/concat fix" },
					{ test: /mutate|modify|original|side.?effect/.test(lower), detail: "Explains the mutation problem" },
					{ test: /const result\s*=\s*\[/.test(response) || /\.slice\(/.test(response) || /\.concat\(/.test(response) || /Array\.from/.test(response), detail: "Creates new array in fix" },
				];
				const passed = checks.filter(c => c.test).length;
				return {
					passed: passed >= 3,
					score: Math.round((passed / checks.length) * 100),
					details: checks.map(c => `${c.test ? "✅" : "❌"} ${c.detail}`).join("\n"),
				};
			},
		},

		// 3. PLANNING
		{
			category: "planning",
			name: "Implementation Plan",
			weight: 2,
			prompt: `Create a detailed implementation plan for adding JWT authentication to an existing Express.js REST API.

The API currently has:
- User model with email/password
- CRUD endpoints for /users and /posts
- PostgreSQL database with Prisma ORM

Requirements:
- Login endpoint returns access + refresh tokens
- Protected routes require valid access token
- Refresh token rotation
- Token blacklisting on logout

Provide a structured plan with specific files to create/modify, dependencies to add, and implementation steps.`,
			validate: (response: string) => {
				const lower = response.toLowerCase();
				const checks = [
					{ test: /jsonwebtoken|jwt|jose/.test(lower), detail: "Mentions JWT library" },
					{ test: /access.?token|refresh.?token/.test(lower), detail: "Covers both token types" },
					{ test: /middleware/.test(lower), detail: "Mentions auth middleware" },
					{ test: /bcrypt|argon|hash/.test(lower), detail: "Addresses password hashing" },
					{ test: /blacklist|revoke|invalidat/.test(lower), detail: "Addresses token revocation" },
					{ test: /prisma|schema|model|migration/.test(lower), detail: "Covers database changes" },
					{ test: /env|secret|config/.test(lower), detail: "Addresses secret management" },
					{ test: /step|phase|\d\.|create|modify|add/.test(lower), detail: "Provides structured steps" },
				];
				const passed = checks.filter(c => c.test).length;
				return {
					passed: passed >= 6,
					score: Math.round((passed / checks.length) * 100),
					details: checks.map(c => `${c.test ? "✅" : "❌"} ${c.detail}`).join("\n"),
				};
			},
		},

		// 4. TOOL CALLING (structured output)
		{
			category: "tool-calling",
			name: "Structured JSON Output",
			weight: 1,
			prompt: `Parse this natural language description and output ONLY a valid JSON object (no markdown, no explanation):

"Create a new user named Alice Smith, email alice@example.com, she's a software engineer at TechCorp, based in San Francisco, age 28, prefers dark mode and email notifications"

Required JSON schema:
{
  "name": { "first": string, "last": string },
  "email": string,
  "profile": {
    "occupation": string,
    "company": string,
    "location": string,
    "age": number
  },
  "preferences": {
    "theme": "light" | "dark",
    "notifications": { "email": boolean, "push": boolean }
  }
}

Output ONLY the JSON.`,
			validate: (response: string) => {
				const checks: Array<{ test: boolean; detail: string }> = [];

				// Try to extract JSON from response
				let jsonStr = response.trim();
				const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) || response.match(/(\{[\s\S]*\})/);
				if (jsonMatch) jsonStr = jsonMatch[1].trim();

				try {
					const obj = JSON.parse(jsonStr);
					checks.push({ test: true, detail: "Valid JSON" });
					checks.push({ test: obj?.name?.first === "Alice", detail: 'name.first = "Alice"' });
					checks.push({ test: obj?.name?.last === "Smith", detail: 'name.last = "Smith"' });
					checks.push({ test: obj?.email === "alice@example.com", detail: "Correct email" });
					checks.push({ test: typeof obj?.profile?.age === "number" && obj.profile.age === 28, detail: "Age is number 28" });
					checks.push({ test: obj?.preferences?.theme === "dark", detail: 'theme = "dark"' });
					checks.push({ test: obj?.preferences?.notifications?.email === true, detail: "email notifications = true" });
				} catch {
					checks.push({ test: false, detail: "Valid JSON (parse failed)" });
					checks.push({ test: false, detail: "name.first" });
					checks.push({ test: false, detail: "name.last" });
					checks.push({ test: false, detail: "email" });
					checks.push({ test: false, detail: "age" });
					checks.push({ test: false, detail: "theme" });
					checks.push({ test: false, detail: "notifications" });
				}

				const passed = checks.filter(c => c.test).length;
				return {
					passed: passed >= 5,
					score: Math.round((passed / checks.length) * 100),
					details: checks.map(c => `${c.test ? "✅" : "❌"} ${c.detail}`).join("\n"),
				};
			},
		},

		// 5. SPEED (simple task, measures latency)
		{
			category: "speed",
			name: "Quick Response",
			weight: 1,
			prompt: `Reply with exactly this text and nothing else: "Hello, World!"`,
			validate: (response: string) => {
				const trimmed = response.trim().replace(/^["']|["']$/g, "").replace(/```\w*\n?/g, "").trim();
				const exact = trimmed === "Hello, World!";
				const close = trimmed.toLowerCase().includes("hello, world");
				return {
					passed: close,
					score: exact ? 100 : close ? 75 : 0,
					details: exact ? "✅ Exact match" : close ? "⚠️ Close match" : `❌ Got: "${trimmed.substring(0, 50)}"`,
				};
			},
		},

		// 6. ORCHESTRATION (multi-step reasoning)
		{
			category: "orchestration",
			name: "Multi-Step Analysis",
			weight: 2,
			prompt: `Analyze this scenario step by step:

A Node.js microservice has these symptoms:
1. Response times gradually increase from 50ms to 3000ms over 24 hours
2. Memory usage grows steadily from 200MB to 1.5GB
3. The service handles file uploads (multipart/form-data)
4. After restart, everything returns to normal
5. No errors in logs
6. Database queries remain fast (<10ms)

Tasks:
A) Identify the most likely root cause
B) List 3 specific things to check in the code
C) Propose a fix with code example
D) Suggest monitoring to prevent recurrence

Be specific and technical.`,
			validate: (response: string) => {
				const lower = response.toLowerCase();
				const checks = [
					{ test: /memory.?leak|leak/.test(lower), detail: "Identifies memory leak" },
					{ test: /stream|buffer|file|upload|temp|cleanup/.test(lower), detail: "Links to file upload handling" },
					{ test: /close|destroy|cleanup|dispose|gc|garbage/.test(lower), detail: "Suggests resource cleanup" },
					{ test: /event.?listener|handler|remove|off/.test(lower) || /stream|pipe/.test(lower), detail: "Checks for handler/stream leaks" },
					{ test: /heapdump|heap.?snapshot|inspect|profile|--max-old-space/.test(lower) || /process\.memoryUsage/.test(lower), detail: "Suggests debugging tools" },
					{ test: /monitor|alert|metric|prometheus|grafana|threshold/.test(lower), detail: "Suggests monitoring" },
				];
				const passed = checks.filter(c => c.test).length;
				return {
					passed: passed >= 4,
					score: Math.round((passed / checks.length) * 100),
					details: checks.map(c => `${c.test ? "✅" : "❌"} ${c.detail}`).join("\n"),
				};
			},
		},
	];
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function extractCode(response: string): string {
	const match = response.match(/```(?:typescript|ts|javascript|js)?\s*([\s\S]*?)```/);
	return match ? match[1].trim() : response.trim();
}

interface ProviderConfig {
	name: string;
	envVar: string;
	baseUrl: string;
	models: string[];
}

function getProviderConfigs(): ProviderConfig[] {
	return [
		{
			name: "alibaba-codingplan",
			envVar: "ALIBABA_CODING_PLAN_KEY",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			models: ["qwen3.5-plus", "qwen3-max-2026-01-23", "qwen3-coder-plus", "qwen3-coder-next", "kimi-k2.5", "glm-5", "glm-4.7", "MiniMax-M2.5"],
		},
		{
			name: "openai",
			envVar: "OPENAI_API_KEY",
			baseUrl: "https://api.openai.com/v1",
			models: ["gpt-4o", "gpt-4o-mini"],
		},
		{
			name: "anthropic-openai",
			envVar: "ANTHROPIC_API_KEY",
			baseUrl: "https://api.anthropic.com/v1",
			models: [],
		},
		{
			name: "openrouter",
			envVar: "OPENROUTER_API_KEY",
			baseUrl: "https://openrouter.ai/api/v1",
			models: [],
		},
		{
			name: "groq",
			envVar: "GROQ_API_KEY",
			baseUrl: "https://api.groq.com/openai/v1",
			models: [],
		},
	];
}

function getAvailableModels(): Array<{ id: string; provider: string; baseUrl: string; apiKey: string }> {
	const models: Array<{ id: string; provider: string; baseUrl: string; apiKey: string }> = [];

	for (const provider of getProviderConfigs()) {
		const apiKey = process.env[provider.envVar];
		if (!apiKey) continue;

		for (const modelId of provider.models) {
			models.push({
				id: modelId,
				provider: provider.name,
				baseUrl: provider.baseUrl,
				apiKey,
			});
		}
	}

	return models;
}

async function callModel(
	baseUrl: string,
	apiKey: string,
	model: string,
	prompt: string,
	timeoutMs: number = 60000,
): Promise<{ response: string; timeMs: number }> {
	const startTime = Date.now();

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: prompt }],
				max_tokens: 4096,
				temperature: 0.1,
			}),
			signal: controller.signal,
		});

		if (!res.ok) {
			const errorBody = await res.text().catch(() => "");
			throw new Error(`API error ${res.status}: ${errorBody.substring(0, 200)}`);
		}

		const data = (await res.json()) as any;
		const response = data?.choices?.[0]?.message?.content || "";
		const timeMs = Date.now() - startTime;

		return { response, timeMs };
	} finally {
		clearTimeout(timeout);
	}
}

// ─── Extension ───────────────────────────────────────────────────────────

export default function benchmarkExtension(pi: ExtensionAPI) {
	const benchmarkDir = join(homedir(), ".phi", "benchmark");
	const resultsPath = join(benchmarkDir, "results.json");

	async function ensureDir() {
		await mkdir(benchmarkDir, { recursive: true });
	}

	async function loadStore(): Promise<BenchmarkStore> {
		try {
			await access(resultsPath);
			const content = await readFile(resultsPath, "utf-8");
			const store = JSON.parse(content);
			if (store.version === 2) return store;
			return { version: 2, results: [], lastUpdated: new Date().toISOString() };
		} catch {
			return { version: 2, results: [], lastUpdated: new Date().toISOString() };
		}
	}

	async function saveStore(store: BenchmarkStore) {
		await ensureDir();
		store.lastUpdated = new Date().toISOString();
		await writeFile(resultsPath, JSON.stringify(store, null, 2), "utf-8");
	}

	/**
	 * Run full benchmark on a single model
	 */
	async function benchmarkModel(
		modelId: string,
		provider: string,
		baseUrl: string,
		apiKey: string,
		ctx: ExtensionContext,
	): Promise<ModelBenchmark> {
		const tests = createTestSuite();
		const categories: ModelBenchmark["categories"] = {};
		let totalTime = 0;

		for (const test of tests) {
			ctx.ui.notify(`  ⏳ ${test.category}: ${test.name}...`, "info");

			try {
				const { response, timeMs } = await callModel(baseUrl, apiKey, modelId, test.prompt, 90000);
				totalTime += timeMs;

				const result = test.validate(response);

				categories[test.category] = {
					score: result.score,
					timeMs,
					details: result.details,
				};

				const emoji = result.score >= 80 ? "✅" : result.score >= 50 ? "⚠️" : "❌";
				ctx.ui.notify(`  ${emoji} ${test.category}: ${result.score}/100 (${timeMs}ms)`, "info");
			} catch (error) {
				totalTime += 60000;
				categories[test.category] = {
					score: 0,
					timeMs: 60000,
					details: `Error: ${error}`,
				};
				ctx.ui.notify(`  ❌ ${test.category}: Error — ${String(error).substring(0, 100)}`, "error");
			}
		}

		// Calculate weighted total
		const weights: Record<string, number> = {};
		for (const test of tests) {
			weights[test.category] = test.weight;
		}

		let weightedSum = 0;
		let totalWeight = 0;
		for (const [cat, data] of Object.entries(categories)) {
			const w = weights[cat] || 1;
			weightedSum += data.score * w;
			totalWeight += w;
		}

		const totalScore = Math.round(weightedSum / totalWeight);

		return {
			modelId,
			modelName: modelId,
			provider,
			timestamp: new Date().toISOString(),
			categories,
			totalScore,
			totalTimeMs: totalTime,
			avgTimeMs: Math.round(totalTime / tests.length),
		};
	}

	/**
	 * Generate formatted comparison report
	 */
	function generateReport(results: ModelBenchmark[]): string {
		if (results.length === 0) return "No benchmark results yet. Run `/benchmark` to start.";

		// Sort by totalScore desc
		const sorted = [...results].sort((a, b) => b.totalScore - a.totalScore);
		const categories = ["code-gen", "debug", "planning", "tool-calling", "speed", "orchestration"];

		let report = "🏆 **Phi Code Benchmark Results**\n\n";

		// Leaderboard
		report += "**Leaderboard:**\n";
		sorted.forEach((r, i) => {
			const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
			const tier = r.totalScore >= 80 ? "S" : r.totalScore >= 65 ? "A" : r.totalScore >= 50 ? "B" : r.totalScore >= 35 ? "C" : "D";
			report += `${medal} **${r.modelId}** — ${r.totalScore}/100 [${tier}] (avg ${r.avgTimeMs}ms)\n`;
		});

		// Category breakdown
		report += "\n**Category Breakdown:**\n```\n";
		const header = "Model".padEnd(25) + categories.map(c => c.substring(0, 8).padEnd(10)).join("") + "TOTAL\n";
		report += header;
		report += "-".repeat(header.length) + "\n";

		for (const r of sorted) {
			let line = r.modelId.substring(0, 24).padEnd(25);
			for (const cat of categories) {
				const score = r.categories[cat]?.score ?? "-";
				line += String(score).padEnd(10);
			}
			line += String(r.totalScore);
			report += line + "\n";
		}
		report += "```\n";

		// Best model per category
		report += "\n**Best per Category:**\n";
		for (const cat of categories) {
			let best = { model: "none", score: -1 };
			for (const r of sorted) {
				const s = r.categories[cat]?.score ?? 0;
				if (s > best.score) {
					best = { model: r.modelId, score: s };
				}
			}
			report += `- ${cat}: **${best.model}** (${best.score}/100)\n`;
		}

		report += `\n_Last updated: ${sorted[0]?.timestamp ?? "N/A"}_`;
		return report;
	}

	// ─── Command ─────────────────────────────────────────────────────────

	pi.registerCommand("benchmark", {
		description: "Run AI model benchmarks (6 categories: code-gen, debug, planning, tool-calling, speed, orchestration)",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			// Show results
			if (arg === "results" || arg === "report") {
				const store = await loadStore();
				ctx.ui.notify(generateReport(store.results), "info");
				return;
			}

			// Compare (same as results but emphasized)
			if (arg === "compare") {
				const store = await loadStore();
				if (store.results.length < 2) {
					ctx.ui.notify("Need at least 2 model results to compare. Run `/benchmark all` first.", "info");
					return;
				}
				ctx.ui.notify(generateReport(store.results), "info");
				return;
			}

			// Clear
			if (arg === "clear") {
				await saveStore({ version: 2, results: [], lastUpdated: new Date().toISOString() });
				ctx.ui.notify("🗑️ All benchmark results cleared.", "info");
				return;
			}

			// Help
			if (arg === "help" || arg === "?") {
				ctx.ui.notify(`**Phi Code Benchmark** — 6 categories, real API calls

Commands:
  /benchmark              Run on current model
  /benchmark all          Run on ALL available models
  /benchmark <model-id>   Run on a specific model
  /benchmark results      Show saved results
  /benchmark compare      Side-by-side comparison
  /benchmark clear        Clear all results

Categories tested (weighted):
  ⚡ code-gen (×2)       — Generate a TypeScript function
  🐛 debug (×2)          — Find and fix a bug
  📋 planning (×2)       — Create implementation plan
  🔧 tool-calling (×1)   — Structured JSON output
  ⏱️ speed (×1)          — Response latency
  🧩 orchestration (×2)  — Multi-step analysis

Scoring: S (80+), A (65+), B (50+), C (35+), D (<35)`, "info");
				return;
			}

			// Get available models
			const available = getAvailableModels();
			if (available.length === 0) {
				ctx.ui.notify("❌ No API keys detected. Set ALIBABA_CODING_PLAN_KEY, OPENAI_API_KEY, or another provider key.", "warning");
				return;
			}

			const store = await loadStore();

			if (arg === "all") {
				// Benchmark ALL available models
				ctx.ui.notify(`🚀 Starting benchmark on ${available.length} models (6 tests each)...\n`, "info");

				for (const model of available) {
					ctx.ui.notify(`\n🧪 **${model.id}** (${model.provider})`, "info");
					const result = await benchmarkModel(model.id, model.provider, model.baseUrl, model.apiKey, ctx);

					// Replace existing result for this model
					store.results = store.results.filter(r => r.modelId !== model.id);
					store.results.push(result);
					await saveStore(store);
				}

				ctx.ui.notify(`\n✅ Benchmark complete! ${available.length} models tested.\n`, "info");
				ctx.ui.notify(generateReport(store.results), "info");
				return;
			}

			if (arg) {
				// Benchmark specific model
				const model = available.find(m => m.id.toLowerCase() === arg || m.id.toLowerCase().includes(arg));
				if (!model) {
					ctx.ui.notify(`Model "${arg}" not found or no API key. Available:\n${available.map(m => `  - ${m.id} (${m.provider})`).join("\n")}`, "warning");
					return;
				}

				ctx.ui.notify(`🧪 Benchmarking **${model.id}** (6 categories)...\n`, "info");
				const result = await benchmarkModel(model.id, model.provider, model.baseUrl, model.apiKey, ctx);
				store.results = store.results.filter(r => r.modelId !== model.id);
				store.results.push(result);
				await saveStore(store);

				ctx.ui.notify(`\n✅ **${model.id}** — Total: ${result.totalScore}/100 (avg ${result.avgTimeMs}ms)`, "info");
				return;
			}

			// Default: benchmark current model
			// Try to find current model in available list
			const currentModel = ctx.model;
			if (currentModel) {
				const modelConfig = available.find(m => m.id === currentModel.id);
				if (modelConfig) {
					ctx.ui.notify(`🧪 Benchmarking current model **${currentModel.id}** (6 categories)...\n`, "info");
					const result = await benchmarkModel(modelConfig.id, modelConfig.provider, modelConfig.baseUrl, modelConfig.apiKey, ctx);
					store.results = store.results.filter(r => r.modelId !== modelConfig.id);
					store.results.push(result);
					await saveStore(store);
					ctx.ui.notify(`\n✅ **${currentModel.id}** — Total: ${result.totalScore}/100`, "info");
					return;
				}
			}

			// Fallback: show available models
			ctx.ui.notify(`Available models for benchmark:\n${available.map(m => `  - ${m.id} (${m.provider})`).join("\n")}\n\nUsage: /benchmark <model-id> or /benchmark all`, "info");
		},
	});

	// Session start notification
	pi.on("session_start", async (_event, ctx) => {
		try {
			const store = await loadStore();
			if (store.results.length > 0) {
				ctx.ui.notify(`🧪 ${store.results.length} benchmark results available. /benchmark results to view.`, "info");
			}
		} catch {
			// ignore
		}
	});
}
