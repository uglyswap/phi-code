/**
 * pi-mcp — MCP client extension for the Pi coding agent.
 *
 * Entry point registered in package.json under "pi.extensions".
 * Pi loads this file via jiti (TypeScript executed directly, no build step).
 *
 * Wires together: config → server manager → tool bridge → Pi API.
 *
 * Vendored into phi-code from the MIT-licensed `pi-mcp-extension` by irahardianto
 * (https://github.com/irahardianto/pi-mcp-extension). See ./LICENSE. Adapted for
 * phi: type imports resolve via "phi-code"; config lives in ~/.phi/agent/mcp.json
 * and <cwd>/.phi/mcp.json (phi configDir), and it ships bundled (no install).
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir } from "phi-code";
// OAuth imports
import { cancelCallback, ensureCallbackServer, stopCallbackServer, waitForCallback } from "./callback-server.ts";
import { splitCommandLine } from "./command-line.ts";
import { createEmptyConfig, loadConfig, validateServerConfig } from "./config.ts";
import { McpError } from "./errors.ts";
import { importExternalMcpConfigs } from "./import-configs.ts";
import { McpOAuthProvider, setCallbackPort } from "./oauth-provider.ts";
import type { TransportAuthCallbacks } from "./server-manager.ts";
import { ServerManager } from "./server-manager.ts";
import { ToolBridge } from "./tool-bridge.ts";

/**
 * Open a URL in the user's default browser.
 * Works on macOS, Linux, and Windows.
 *
 * Never goes through a shell: the authorization URL comes from server metadata,
 * and WHATWG URL serialization keeps `$(...)` and `%VAR%` intact, which a shell
 * (sh or cmd.exe) would expand. Only http(s) URLs are opened.
 */
function openBrowser(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		console.error(`[phi-mcp] Refusing to open invalid authorization URL`);
		return;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		console.error(`[phi-mcp] Refusing to open non-http(s) authorization URL (${parsed.protocol})`);
		return;
	}
	const target = parsed.toString();
	const [cmd, args]: [string, string[]] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", target]]
				: ["xdg-open", [target]];

	spawn(cmd, args, { stdio: "ignore", detached: true })
		.on("error", (err) => {
			console.error(`[phi-mcp] Failed to open browser: ${err.message}`);
		})
		.unref();
}

/** Global MCP config path (honors PHI_CODING_AGENT_DIR). */
function globalConfigPath(): string {
	return join(getAgentDir(), "mcp.json");
}

function errorMessage(err: unknown): string {
	return err instanceof McpError ? err.userMessage : err instanceof Error ? err.message : String(err);
}

/** Default bound of the headless wait for eager servers; PHI_MCP_STARTUP_WAIT_MS overrides it. */
const DEFAULT_MCP_STARTUP_WAIT_MS = 15_000;

/** PHI_MCP_STARTUP_WAIT_MS in ms (0 disables the wait); the default when unset or invalid. */
export function mcpStartupWaitMs(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PHI_MCP_STARTUP_WAIT_MS?.trim();
	if (!raw) return DEFAULT_MCP_STARTUP_WAIT_MS;
	const value = Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MCP_STARTUP_WAIT_MS;
}

/** Resolves when `promise` settles or after `ms`, whichever comes first. */
async function waitAtMost(promise: Promise<unknown>, ms: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, ms);
	});
	try {
		await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Ask for a stdio or remote server entry; undefined when the user cancels. */
async function promptServerEntry(ctx: ExtensionCommandContext): Promise<Record<string, unknown> | undefined> {
	const transport = await ctx.ui.select("Transport", ["stdio (local command)", "http (remote URL)"]);
	if (!transport) return undefined;
	if (transport.startsWith("stdio")) {
		const command = await ctx.ui.input("Command", "npx -y @modelcontextprotocol/server-filesystem .");
		if (!command) return undefined;
		// Quote-aware split: `"C:\Program Files\x\server.exe" --root "my dir"` keeps its spaces.
		const [cmd, ...rest] = splitCommandLine(command);
		if (!cmd) throw new Error("Empty command");
		return { command: cmd, args: rest, lifecycle: "lazy" };
	}
	const url = await ctx.ui.input("Server URL", "https://example.com/mcp");
	if (!url) return undefined;
	// Without an explicit transport the schema defaults to stdio and rejects the entry.
	return { transport: "streamable-http", url: url.trim(), lifecycle: "lazy" };
}

/** Read the global mcp.json for editing; throws instead of silently starting from scratch. */
function readGlobalConfigForEdit(
	configPath: string,
): Record<string, unknown> & { mcpServers: Record<string, unknown> } {
	if (!existsSync(configPath)) return { mcpServers: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (err) {
		throw new Error(
			`${configPath} is not valid JSON (${err instanceof Error ? err.message : String(err)}): fix it first`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${configPath} must contain a JSON object`);
	}
	const config = parsed as Record<string, unknown>;
	const servers = config.mcpServers;
	const mcpServers =
		typeof servers === "object" && servers !== null && !Array.isArray(servers)
			? (servers as Record<string, unknown>)
			: {};
	return { ...config, mcpServers };
}

/** /mcp add: interactive wizard writing a lazy server to the global config. */
async function runAddWizard(nameArg: string, ctx: ExtensionCommandContext): Promise<void> {
	const configPath = globalConfigPath();
	if (!ctx.hasUI) {
		ctx.ui.notify(`pi-mcp: /mcp add requires interactive UI. Edit ${configPath} directly.`, "error");
		return;
	}
	const name = nameArg || (await ctx.ui.input("Server name", "my-server"));
	if (!name) return;
	const entry = await promptServerEntry(ctx);
	if (!entry) return;
	const validation = validateServerConfig(entry);
	if (!validation.ok) {
		ctx.ui.notify(`pi-mcp: Invalid server entry: ${validation.issues.join("; ")}`, "error");
		return;
	}
	const config = readGlobalConfigForEdit(configPath);
	if (Object.hasOwn(config.mcpServers, name)) {
		ctx.ui.notify(`pi-mcp: "${name}" already exists in ${configPath}`, "error");
		return;
	}
	config.mcpServers[name] = entry;
	mkdirSync(dirname(configPath), { recursive: true });
	// env/headers may hold secrets: owner-only file (chmod covers pre-existing files; no-op on Windows).
	writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(configPath, 0o600);
	} catch (err) {
		console.error(`[pi-mcp] Could not restrict permissions of ${configPath}: ${(err as Error).message}`);
	}
	ctx.ui.notify(`pi-mcp: Added "${name}" to ${configPath}. /reload to connect.`, "info");
}

export default async function (pi: ExtensionAPI): Promise<void> {
	// ── 1. Load and validate config ──────────────────────────────────────────
	// cwd is available on the ExtensionContext passed to event handlers.
	// We load config lazily on session_start to get the correct per-session cwd.
	// For the initial load we use process.cwd() as a bootstrap path to detect
	// whether any config exists at all.
	let config: Awaited<ReturnType<typeof loadConfig>>;
	/** Last config error, shown by /mcp. The commands stay registered so the user can see and fix it. */
	let configError: string | undefined;
	try {
		// Global config only: project trust is unknown until session_start.
		config = await loadConfig(process.cwd(), { includeProject: false });
	} catch (err) {
		// Can't notify yet (no ctx), so log to stderr. The session_start handler
		// will re-try with the real cwd and surface errors properly.
		configError = err instanceof McpError ? err.message : String(err);
		console.error(`[pi-mcp] Config error: ${configError}`);
		config = createEmptyConfig();
	}

	// Even with zero configured servers we proceed so the bundled `/mcp` command
	// is always available (discoverability); it then guides the user to create an
	// mcp.json. Servers are still only connected when one is actually configured.

	// ── 2. Initialize bridge components ──────────────────────────────────────
	// Automatic connections never open a browser (no callback server listens for
	// them): the server is marked "auth required" and the user runs /mcp:auth.
	const authCallbacks: TransportAuthCallbacks = {
		onAuthRequired: (serverName: string): void => {
			console.error(`[pi-mcp] OAuth required for "${serverName}". Run /mcp:auth ${serverName} to authorize.`);
		},
	};

	const manager = new ServerManager(config, authCallbacks);
	const bridge = new ToolBridge(config.settings, pi);

	// Connect tool refresh callback: called on connect and on list_changed
	manager.setToolRefreshCallback(async (serverName, client) => {
		await bridge.refreshTools(serverName, client);
	});
	// Lost connection (failed health check): tools answer with an explicit message
	// until the reconnect refreshes them.
	manager.setServerUnavailableCallback((serverName, message) => {
		bridge.markServerUnavailable(serverName, message);
	});

	/**
	 * Bumped on every session start/shutdown: background connections started for an
	 * older session must not notify through its (now stale) ctx.
	 */
	let sessionGeneration = 0;

	// ── 3. Session lifecycle ──────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		const generation = ++sessionGeneration;
		// Reload config with the real session cwd (project config may differ)
		let sessionConfig = config;
		try {
			// <cwd>/.phi/mcp.json spawns local commands: read it only for trusted projects.
			sessionConfig = await loadConfig(ctx.cwd, { includeProject: ctx.isProjectTrusted() });
			configError = undefined;
		} catch (err) {
			const msg = err instanceof McpError ? err.userMessage : String(err);
			configError = msg;
			ctx.ui.notify(`pi-mcp: Config error: ${msg}\nRun /mcp for details.`, "error");
			return;
		}

		// If config changed (different cwd with project-level overrides),
		// shut down old servers and rebuild the manager's server list
		if (JSON.stringify(sessionConfig) !== JSON.stringify(config)) {
			// Deactivate and remove all tools from old config
			for (const server of manager.getAllServers()) {
				bridge.removeServer(server.name);
			}
			// Shut down all running servers
			await manager.shutdownAll();
			// Rebuild server entries from new config
			manager.rebuildServers(sessionConfig);
			// Tool names embed settings.toolPrefix: the bridge must use the new settings.
			bridge.updateSettings(sessionConfig.settings);
			// Compare the next session against what is actually running now.
			config = sessionConfig;
		}

		const eagerServers = Object.entries(sessionConfig.mcpServers).filter(([, cfg]) => cfg.lifecycle === "eager");

		// Connect eager servers in the background: retries can take ~50 s per server
		// and must not block an interactive session. Failures are reported when they settle.
		const notify = (message: string): void => {
			if (generation !== sessionGeneration) return;
			// Without a UI (print / json mode) ctx.ui.notify is a no-op: stderr is the only channel.
			if (!ctx.hasUI) console.error(message.replace(/^pi-mcp: /, "[pi-mcp] "));
			try {
				ctx.ui.notify(message, "error");
			} catch (err) {
				console.error(`[pi-mcp] ${message} (${err instanceof Error ? err.message : String(err)})`);
			}
		};
		const connecting = Promise.allSettled(
			eagerServers.map(async ([name]) => {
				try {
					await manager.startServer(name, ctx.cwd);
				} catch (err) {
					notify(`pi-mcp: Failed to start ${name}: ${errorMessage(err)}`);
				}
			}),
		);
		// Without a UI the first prompt is sent as soon as session_start returns: wait
		// (bounded) so the eager servers' tools are part of the very first request.
		if (!ctx.hasUI && eagerServers.length > 0) {
			await waitAtMost(connecting, mcpStartupWaitMs());
		}
	});

	pi.on("session_shutdown", async (_event, _ctx: ExtensionContext) => {
		sessionGeneration++;
		// Stop the callback server
		await stopCallbackServer().catch(() => {});

		// Deactivate all tools before shutting down servers
		for (const server of manager.getAllServers()) {
			bridge.deactivateServer(server.name);
		}
		await manager.shutdownAll();
	});

	// ── 4. /mcp — show server status ─────────────────────────────────────────
	pi.registerCommand("mcp", {
		description: "Show MCP server status. Usage: /mcp [server-name] for detail.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const serverName = args.trim();
			if (serverName === "add" || serverName.startsWith("add ")) {
				// Interactive wizard: /mcp add (omp-style mcp-add-wizard)
				try {
					await runAddWizard(serverName.slice(4).trim(), ctx);
				} catch (err) {
					ctx.ui.notify(`pi-mcp: /mcp add failed: ${errorMessage(err)}`, "error");
				}
				return;
			}
			if (configError && !serverName) {
				// The config could not be loaded: no server was started. Say why.
				ctx.ui.notify(`pi-mcp: MCP config error, no server started:\n${configError}`, "error");
				return;
			}
			if (serverName) {
				// Detailed view: status + recent stderr
				const server = manager.getServer(serverName);
				if (!server) {
					ctx.ui.notify(`pi-mcp: No server named "${serverName}"`, "error");
					return;
				}
				const logs = manager.getServerLogs(serverName);
				const detail = [
					`Server: ${serverName}`,
					`State:  ${server.state}`,
					`Retries: ${server.retryCount}`,
					server.lastError ? `Last error: ${server.lastError.message}` : null,
					"",
					"Recent output:",
					logs,
				]
					.filter(Boolean)
					.join("\n");
				ctx.ui.notify(detail, "info");
			} else if (manager.getAllServers().length === 0) {
				// No servers configured yet: guide the user instead of showing nothing.
				ctx.ui.notify(
					`No MCP servers configured. Create ${globalConfigPath()} (global) or .phi/mcp.json (project) with an "mcpServers" block, e.g.:\n` +
						'{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."], "lifecycle": "eager" } } }',
					"info",
				);
			} else {
				// Summary view: all servers
				ctx.ui.notify(manager.getStatusSummary(), "info");
			}
		},
	});

	// ── 4b. /mcp:import — import server configs from other agent tools ─────
	pi.registerCommand("mcp:import", {
		description: "Import MCP servers from Claude/Codex/Gemini/Cursor/VS Code configs into the global phi mcp.json",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const result = importExternalMcpConfigs(ctx.cwd);
			const lines = [
				result.imported.length ? `Imported: ${result.imported.join(", ")}` : "Nothing new to import.",
				result.skipped.length ? `Skipped (already configured): ${result.skipped.join(", ")}` : null,
				result.errors.length ? `Not imported:\n  ${result.errors.join("\n  ")}` : null,
				result.warnings.length ? `Warnings:\n  ${result.warnings.join("\n  ")}` : null,
				result.imported.length ? "Restart or /reload to start the new servers." : null,
			].filter(Boolean);
			const level = result.imported.length && !result.errors.length ? "info" : "warning";
			ctx.ui.notify(lines.join("\n"), level);
		},
	});

	// ── 4c. /mcp:prompt — list or invoke MCP server prompts ──────────────
	pi.registerCommand("mcp:prompt", {
		description: "List MCP prompts or invoke one. Usage: /mcp:prompt [<server>:<prompt>]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const spec = args.trim();
			const getClient = (name: string) => {
				const server = manager.getServer(name);
				if (!server?.client)
					throw new Error(
						`Server "${name}" is not connected (state: ${server?.state ?? "unknown"}). Try /mcp:start ${name}.`,
					);
				return server.client;
			};
			try {
				if (!spec) {
					const lines: string[] = [];
					for (const server of manager.getAllServers()) {
						if (!server.client) continue;
						try {
							const list = await server.client.listPrompts();
							for (const prompt of list.prompts ?? []) {
								lines.push(
									`${server.name}:${prompt.name}${prompt.description ? ` — ${prompt.description}` : ""}`,
								);
							}
						} catch {
							// server without prompts support: skip
						}
					}
					ctx.ui.notify(
						lines.length ? lines.join("\n") : "No MCP prompts available (servers may not support prompts).",
						"info",
					);
					return;
				}
				const sep = spec.indexOf(":");
				if (sep === -1) {
					ctx.ui.notify("Usage: /mcp:prompt <server>:<prompt>", "error");
					return;
				}
				const client = getClient(spec.slice(0, sep));
				const result = await client.getPrompt({ name: spec.slice(sep + 1), arguments: {} });
				const text = (result.messages ?? [])
					.map((m) => (m.content?.type === "text" ? m.content.text : ""))
					.filter(Boolean)
					.join("\n\n");
				if (!text) {
					ctx.ui.notify(`pi-mcp: prompt returned no text.`, "warning");
					return;
				}
				pi.sendUserMessage(text);
			} catch (error) {
				ctx.ui.notify(`pi-mcp prompt error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	// ── 5. /mcp:stop — stop a server ─────────────────────────────────────────
	pi.registerCommand("mcp:stop", {
		description: "Stop an MCP server. Usage: /mcp:stop <server-name>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const serverName = args.trim();
			if (!serverName) {
				ctx.ui.notify("Usage: /mcp:stop <server-name>", "error");
				return;
			}
			if (!manager.getServer(serverName)) {
				ctx.ui.notify(`pi-mcp: No server named "${serverName}"`, "error");
				return;
			}
			bridge.deactivateServer(serverName);
			await manager.stopServer(serverName);
			ctx.ui.notify(`pi-mcp: Stopped ${serverName}`, "info");
		},
	});

	// ── 6. /mcp:start — manually start a lazy server ─────────────────────────
	pi.registerCommand("mcp:start", {
		description: "Start an MCP server. Usage: /mcp:start <server-name>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const serverName = args.trim();
			if (!serverName) {
				ctx.ui.notify("Usage: /mcp:start <server-name>", "error");
				return;
			}
			if (!manager.getServer(serverName)) {
				ctx.ui.notify(`pi-mcp: No server named "${serverName}"`, "error");
				return;
			}
			const before = manager.getServer(serverName)?.state;
			if (before === "ready" || before === "starting") {
				ctx.ui.notify(`pi-mcp: ${serverName} is already ${before === "ready" ? "running" : "starting"}`, "info");
				return;
			}
			try {
				ctx.ui.notify(`pi-mcp: Starting ${serverName}...`, "info");
				// startServer throws when every attempt failed or OAuth is required;
				// it returns without a ready server only when stopped meanwhile.
				await manager.startServer(serverName, ctx.cwd);
				const state = manager.getServer(serverName)?.state;
				if (state === "ready") ctx.ui.notify(`pi-mcp: Started ${serverName}`, "info");
				else ctx.ui.notify(`pi-mcp: ${serverName} was stopped before it finished connecting`, "warning");
			} catch (err) {
				const msg = err instanceof McpError ? err.userMessage : String(err);
				ctx.ui.notify(`pi-mcp: Failed to start ${serverName} — ${msg}`, "error");
			}
		},
	});

	// ── 7. /mcp:auth — trigger OAuth authentication for a server ────────────────
	pi.registerCommand("mcp:auth", {
		description:
			"Trigger OAuth authentication for a server. Resets credentials and opens browser for re-authorization. Usage: /mcp:auth <server-name>",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const serverName = args.trim();
			if (!serverName) {
				// List servers with auth config
				const authServers = manager.getAllServers().filter((s) => s.config.auth);
				if (authServers.length === 0) {
					ctx.ui.notify(
						'pi-mcp: No servers with OAuth configured. Add `auth: { type: "oauth" }` to a server in mcp.json.',
						"error",
					);
					return;
				}
				const lines = authServers.map(async (s) => {
					const status = await manager.getServerAuthStatus(s.name);
					const authIcon = status?.hasTokens ? "\u2705 authenticated" : "\u274C not authenticated";
					const savedInfo = status?.savedAt ? ` (since ${status.savedAt})` : "";
					return `  ${s.name}: ${authIcon}${savedInfo}`;
				});
				const statusLines = await Promise.all(lines);
				ctx.ui.notify(
					["Usage: /mcp:auth <server-name>", "", "OAuth-enabled servers:", ...statusLines].join("\n"),
					"info",
				);
				return;
			}
			const server = manager.getServer(serverName);
			if (!server) {
				ctx.ui.notify(`pi-mcp: No server named "${serverName}"`, "error");
				return;
			}
			if (!server.config.auth) {
				ctx.ui.notify(
					`pi-mcp: Server "${serverName}" does not have OAuth configured. Add \`auth: { type: "oauth" }\` to its config in mcp.json.`,
					"error",
				);
				return;
			}

			const config = server.config;
			let oauthState: string | undefined;

			try {
				// Stop the server if running
				if (server.state !== "stopped") {
					bridge.deactivateServer(serverName);
					await manager.stopServer(serverName);
				}

				// Validate that we have a server URL (required for OAuth)
				if (!config.url) {
					throw new McpError(
						`Server "${serverName}" has OAuth configured but no URL. OAuth requires a URL-based server transport.`,
						serverName,
						"config",
					);
				}

				// Reset all OAuth credentials (tokens, client info, PKCE, discovery)
				await manager.resetServerAuth(serverName);

				ctx.ui.notify(`pi-mcp: Starting OAuth flow for ${serverName}...`, "info");

				// 1. Start the callback server
				const port = await ensureCallbackServer();
				setCallbackPort(port);

				// 2. Generate a cryptographically secure state parameter for CSRF protection
				oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
					.map((b: number) => b.toString(16).padStart(2, "0"))
					.join("");

				// 3. Register the callback promise BEFORE opening the browser
				const callbackPromise = waitForCallback(oauthState);

				// 4. Create auth provider and transport
				const authProvider = new McpOAuthProvider(
					serverName,
					config.url,
					config.auth || { type: "oauth" },
					(url: URL) => {
						console.error(`[pi-mcp] Opening browser for ${serverName}...`);
						openBrowser(url.toString());
					},
				);

				// CRITICAL FIX #1: Set the OAuth state on the provider before calling auth()
				// This ensures the state parameter is included in the authorization URL
				authProvider.setState(oauthState);

				const transport = new StreamableHTTPClientTransport(new URL(config.url), { authProvider });

				// 5. Start the auth flow - this will trigger redirectToAuthorization which opens the browser
				// CRITICAL FIX #2: Check the return value of auth() instead of catching UnauthorizedError
				// The SDK returns 'REDIRECT' when it needs browser interaction, not an error
				const authResult = await auth(authProvider, { serverUrl: config.url });

				if (authResult === "AUTHORIZED") {
					// Auth succeeded without needing browser interaction (e.g., had valid tokens)
					ctx.ui.notify(`pi-mcp: ${serverName} authenticated successfully!`, "info");
				} else if (authResult === "REDIRECT") {
					// Browser was opened, wait for the callback from the user
					ctx.ui.notify(`pi-mcp: Browser opened for ${serverName}. Complete authorization to continue...`, "info");

					// 6. Wait for the callback (this blocks until the user authorizes)
					const code = await callbackPromise;

					// 7. Complete the OAuth flow with the authorization code
					await transport.finishAuth(code);

					ctx.ui.notify(`pi-mcp: ${serverName} authenticated successfully!`, "info");
				} else {
					throw new McpError(`Unexpected auth result: ${authResult}`, serverName, "protocol");
				}

				// 8. Close the transport (we'll create a new one when starting the server)
				await transport.close().catch(() => {});

				// 9. Start the server with fresh auth credentials
				await manager.startServer(serverName, ctx.cwd);
			} catch (err) {
				const msg = err instanceof McpError ? err.userMessage : String(err);
				ctx.ui.notify(`pi-mcp: Authentication failed for ${serverName} — ${msg}`, "error");

				// Clean up on error
				if (oauthState) {
					cancelCallback(oauthState);
				}
			}
		},
	});
}
