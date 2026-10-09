/**
 * Configuration loading, validation, and merging for pi-mcp.
 *
 * Config file locations (Pi-native convention, highest priority first):
 *   1. <cwd>/.phi/mcp.json   — project-level config
 *   2. ~/.phi/agent/mcp.json — global config
 *
 * Project servers/settings override global servers/settings per-key (shallow merge).
 * No deep merge, no env var interpolation — WYSIWYG config.
 */

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "phi-code";
import { z } from "zod";
import { McpError } from "./errors.ts";

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const AuthConfigSchema = z.object({
	/** Auth type. Currently only "oauth" is supported. Default: "oauth". */
	type: z.enum(["oauth"]).default("oauth"),
	/**
	 * Callback URL for the OAuth redirect.
	 * Default: auto-detected local callback server.
	 */
	redirectUrl: z.string().optional(),
	/**
	 * Optional scope to request during authorization.
	 */
	scope: z.string().optional(),
	/**
	 * Pre-registered client_id (skip dynamic client registration).
	 */
	clientId: z.string().optional(),
	/**
	 * Pre-registered client_secret.
	 */
	clientSecret: z.string().optional(),
});

const ServerConfigSchema = z
	.object({
		/** Executable to spawn (e.g. "npx", "node", "uvx"). Required for stdio. */
		command: z.string().optional(),
		/** Arguments passed to command. */
		args: z.array(z.string()).default([]),
		/**
		 * Extra environment variables passed to the child process as literals.
		 * These merge with process.env; project env overrides parent env.
		 * No ${VAR} interpolation — set vars in your shell environment instead.
		 */
		env: z.record(z.string()).optional(),
		/** Transport protocol. Default: "stdio". */
		transport: z.enum(["stdio", "streamable-http", "sse"]).default("stdio"),
		/**
		 * URL for streamable-http or sse transports.
		 * Must be a valid URL (e.g. "https://my-mcp-server.example.com/mcp").
		 */
		url: z.string().url().optional(),
		/**
		 * Static HTTP headers to include with every request (streamable-http / sse only).
		 * Useful for API-key-based auth (e.g. { "Authorization": "Bearer <key>" }).
		 * For OAuth2, use the "auth" field instead.
		 */
		headers: z.record(z.string()).optional(),
		/**
		 * OAuth2 configuration for servers that require authorization.
		 * When set, the transport will use the SDK's OAuth flow (discovery,
		 * dynamic client registration, PKCE, token refresh).
		 * Only applies to streamable-http and sse transports.
		 */
		auth: AuthConfigSchema.optional(),
		/**
		 * "eager" — start at session_start.
		 * "lazy"  — start manually via /mcp:start command.
		 */
		lifecycle: z.enum(["eager", "lazy"]).default("lazy"),
		/** Per-request timeout in ms. Overrides global setting. Default: 30000. */
		requestTimeoutMs: z.number().positive().optional(),
		/**
		 * Opt-in heartbeat interval (ping) in ms.
		 * Only useful for long-lived connections where you want proactive liveness checks.
		 * Default: disabled.
		 */
		healthCheckIntervalMs: z.number().positive().optional(),
	})
	.refine(
		(cfg) => {
			if (cfg.transport === "stdio") return cfg.command !== undefined;
			return cfg.url !== undefined;
		},
		(cfg) => ({
			message:
				cfg.transport === "stdio"
					? `"command" is required for stdio transport`
					: `"url" is required for ${cfg.transport} transport`,
		}),
	);

const SettingsSchema = z.object({
	/**
	 * Prefix used in Pi tool names: <prefix>_<server>_<tool>.
	 * Must match [a-zA-Z0-9_]. Default: "mcp".
	 */
	toolPrefix: z
		.string()
		.regex(/^[a-zA-Z0-9_]+$/, "toolPrefix must match [a-zA-Z0-9_]")
		.default("mcp"),
	/** Default per-request timeout in ms for all servers. Default: 30000. */
	requestTimeoutMs: z.number().positive().default(30000),
	/** Maximum retry attempts when a server fails to connect. Default: 5. */
	maxRetries: z.number().int().min(0).max(10).default(5),
});

const McpConfigSchema = z.object({
	settings: SettingsSchema.default({}),
	mcpServers: z.record(ServerConfigSchema).default({}),
});

// ─── Public Types ─────────────────────────────────────────────────────────────

export type AuthConfig = z.output<typeof AuthConfigSchema>;
export type ServerConfig = z.output<typeof ServerConfigSchema>;
export type Settings = z.output<typeof SettingsSchema>;
export type McpConfig = z.output<typeof McpConfigSchema>;

/** A valid config with no servers and default settings. */
export function createEmptyConfig(): McpConfig {
	return McpConfigSchema.parse({});
}

/**
 * Validate one server entry against the phi schema.
 * Returns the parsed entry, or the list of issues when it is invalid.
 */
export function validateServerConfig(
	raw: unknown,
): { ok: true; config: ServerConfig } | { ok: false; issues: string[] } {
	const result = ServerConfigSchema.safeParse(raw);
	if (result.success) return { ok: true, config: result.data };
	return {
		ok: false,
		issues: result.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)),
	};
}

// ─── Loader ───────────────────────────────────────────────────────────────────

async function readJsonFile(path: string): Promise<unknown | null> {
	try {
		const text = await readFile(path, "utf8");
		return JSON.parse(text) as unknown;
	} catch (err) {
		// ENOENT → file doesn't exist, silently skip
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

function parseConfig(raw: unknown, sourcePath: string): McpConfig {
	const result = McpConfigSchema.safeParse(raw);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
		throw new McpError(`Invalid mcp.json at ${sourcePath}:\n${issues}`, "<config>", "config");
	}
	return result.data;
}

function mergeConfigs(globalCfg: McpConfig, projectCfg: McpConfig): McpConfig {
	// A project entry may only ADD servers. It must never replace a global entry
	// of the same name: OAuth credentials and user-chosen commands are attached to
	// global servers, and a cloned repo redefining them could redirect tokens or
	// swap the spawned command.
	const projectServers = Object.fromEntries(
		Object.entries(projectCfg.mcpServers).filter(([name]) => !(name in globalCfg.mcpServers)),
	);
	return {
		// Shallow spread: project settings override global settings per key
		settings: { ...globalCfg.settings, ...projectCfg.settings },
		mcpServers: { ...globalCfg.mcpServers, ...projectServers },
	};
}

export interface LoadConfigOptions {
	/**
	 * Read <cwd>/.phi/mcp.json. Must only be true once the project is trusted:
	 * project servers spawn local commands.
	 */
	includeProject: boolean;
}

/**
 * Names an MCP config file supplied by the program that launched phi (e.g. an
 * orchestrator handing each run its own connector tokens). Same format as mcp.json.
 */
export const CALLER_CONFIG_ENV = "PHI_MCP_CONFIG";

/** Caller config problems already printed: loadConfig runs at load time and again at session_start. */
const reportedCallerConfigErrors = new Set<string>();

function reportCallerConfigError(message: string): void {
	if (reportedCallerConfigErrors.has(message)) return;
	reportedCallerConfigErrors.add(message);
	console.error(`[pi-mcp] ${message}`);
}

/**
 * The config named by PHI_MCP_CONFIG, or null when the variable is unset. A missing,
 * unreadable or invalid file is reported on stderr and ignored: phi still starts with
 * the global (and project) servers.
 */
async function loadCallerConfig(): Promise<McpConfig | null> {
	const value = process.env[CALLER_CONFIG_ENV]?.trim();
	if (!value) return null;
	const path = resolve(value);
	try {
		const raw = await readJsonFile(path);
		if (raw === null) {
			reportCallerConfigError(`${CALLER_CONFIG_ENV}: ${path} does not exist; its MCP servers are ignored.`);
			return null;
		}
		return parseConfig(raw, path);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		reportCallerConfigError(`${CALLER_CONFIG_ENV}: cannot use ${path} (${reason}); its MCP servers are ignored.`);
		return null;
	}
}

/**
 * Load and merge global (~/.phi/agent/mcp.json), caller ($PHI_MCP_CONFIG) and project
 * (<cwd>/.phi/mcp.json) configs, in that order. The project config is read only when
 * `options.includeProject` is true (trusted project). The caller and project configs
 * can add servers but never replace one defined before them.
 * Returns a fully validated, merged config.
 */
export async function loadConfig(cwd: string, options: LoadConfigOptions): Promise<McpConfig> {
	const globalPath = join(getAgentDir(), "mcp.json");
	const projectPath = join(cwd, ".phi", "mcp.json");

	const [globalRaw, projectRaw, callerCfg] = await Promise.all([
		readJsonFile(globalPath),
		options.includeProject ? readJsonFile(projectPath) : Promise.resolve(null),
		loadCallerConfig(),
	]);

	// If no file exists, return an empty valid config
	if (globalRaw === null && projectRaw === null && callerCfg === null) {
		return McpConfigSchema.parse({});
	}

	const globalCfg = globalRaw !== null ? parseConfig(globalRaw, globalPath) : McpConfigSchema.parse({});
	const baseCfg = callerCfg !== null ? mergeConfigs(globalCfg, callerCfg) : globalCfg;

	if (projectRaw === null) return baseCfg;

	const projectCfg = parseConfig(projectRaw, projectPath);
	return mergeConfigs(baseCfg, projectCfg);
}
