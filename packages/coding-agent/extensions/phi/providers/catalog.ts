/**
 * Single provider catalog shared by /setup, /phi-init and /benchmark.
 *
 * Before 0.97.0 each of those three surfaces hardcoded its own provider list
 * (init.ts, setup.ts, benchmark.ts) and they had already drifted (different
 * ids, env vars and model sets for the same provider). This module is the one
 * source of truth; consumers project the fields they need.
 */

import { ALIBABA_ENV_VAR, ALIBABA_MODELS, ALIBABA_PROVIDERS } from "./alibaba.js";
import { OPENCODE_GO_AUTH_URL, OPENCODE_GO_ENV_VAR } from "./opencode-go.js";

export interface ProviderCatalogEntry {
	id: string;
	displayName: string;
	envVar: string;
	baseUrl: string;
	api: string;
	/** Known model ids used as offline fallback by the wizards. */
	staticModels: string[];
	/** Models /benchmark exercises when this provider has a key. */
	benchModels?: string[];
	supportsOAuth?: boolean;
	local?: boolean;
	probeUrl?: string;
	docUrl?: string;
}

export function getProviderCatalog(): ProviderCatalogEntry[] {
	return [
		{
			id: "alibaba-codingplan",
			displayName: "Alibaba Coding Plan",
			envVar: ALIBABA_ENV_VAR,
			baseUrl: ALIBABA_PROVIDERS.openai.baseUrl,
			api: "openai-completions",
			staticModels: ALIBABA_MODELS.map((m) => m.id),
			benchModels: [
				"qwen3.5-plus",
				"qwen3-max-2026-01-23",
				"qwen3-coder-plus",
				"qwen3-coder-next",
				"kimi-k2.5",
				"glm-5",
				"glm-4.7",
				"MiniMax-M2.5",
			],
			docUrl: "https://www.alibabacloud.com/help/en/model-studio/coding-plan",
		},
		{
			id: "opencode-go",
			displayName: "OpenCode Go (zen)",
			envVar: OPENCODE_GO_ENV_VAR,
			baseUrl: "https://opencode.ai/zen/go/v1",
			api: "openai-completions",
			staticModels: [],
			docUrl: OPENCODE_GO_AUTH_URL,
		},
		{
			id: "opencode",
			displayName: "OpenCode Zen",
			envVar: "OPENCODE_API_KEY",
			baseUrl: "https://opencode.ai/zen/v1",
			api: "openai-completions",
			staticModels: [],
			docUrl: OPENCODE_GO_AUTH_URL,
		},
		{
			id: "openai",
			displayName: "OpenAI",
			envVar: "OPENAI_API_KEY",
			baseUrl: "https://api.openai.com/v1",
			api: "openai-completions",
			staticModels: ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini", "gpt-5"],
			benchModels: ["gpt-4o", "gpt-4o-mini"],
			supportsOAuth: true,
		},
		{
			id: "anthropic",
			displayName: "Anthropic",
			envVar: "ANTHROPIC_API_KEY",
			baseUrl: "https://api.anthropic.com/v1",
			api: "anthropic-messages",
			staticModels: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-3-5-haiku-20241022"],
			supportsOAuth: true,
		},
		{
			id: "google",
			displayName: "Google Gemini",
			envVar: "GOOGLE_API_KEY",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			api: "google",
			staticModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
			supportsOAuth: true,
		},
		{
			id: "openrouter",
			displayName: "OpenRouter",
			envVar: "OPENROUTER_API_KEY",
			baseUrl: "https://openrouter.ai/api/v1",
			api: "openai-completions",
			staticModels: [],
		},
		{
			id: "groq",
			displayName: "Groq",
			envVar: "GROQ_API_KEY",
			baseUrl: "https://api.groq.com/openai/v1",
			api: "openai-completions",
			staticModels: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"],
		},
		{
			id: "ollama",
			displayName: "Ollama (local)",
			envVar: "OLLAMA",
			baseUrl: "http://localhost:11434/v1",
			api: "openai-completions",
			staticModels: [],
			local: true,
			probeUrl: "http://localhost:11434/v1/models",
		},
		{
			id: "lm-studio",
			displayName: "LM Studio (local)",
			envVar: "LM_STUDIO",
			baseUrl: "http://localhost:1234/v1",
			api: "openai-completions",
			staticModels: [],
			local: true,
			probeUrl: "http://localhost:1234/v1/models",
		},
	];
}
