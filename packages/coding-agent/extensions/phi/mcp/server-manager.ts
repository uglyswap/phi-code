/**
 * Server lifecycle manager for pi-mcp.
 *
 * Manages MCP server connections using the official SDK.
 * Deliberately thin: the SDK handles protocol state, transport, and process lifecycle.
 * This module handles:
 *   - 3-state lifecycle per server (stopped / starting / ready)
 *   - Retry with a fixed delay schedule (cancellable by stop/shutdown)
 *   - roots/list capability for the MCP handshake
 *   - notifications/tools/list_changed → tool refresh callback
 *   - Stderr capture (circular buffer)
 *   - PID tracking for safety-net SIGKILL on shutdown failure
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	ListRootsRequestSchema,
	LoggingMessageNotificationSchema,
	ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getAgentDir } from "phi-code";
import type { McpConfig, ServerConfig, Settings } from "./config.ts";
import { McpError } from "./errors.ts";
import { getAuthStatus, McpOAuthProvider, resetAuth } from "./oauth-provider.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ServerState = "stopped" | "starting" | "ready";

/** Fixed retry delay schedule — predictable, no jitter math needed. */
const RETRY_DELAYS_MS = [1000, 3000, 5000, 10000, 30000] as const;

/** Maximum stderr lines stored per server (circular). */
const STDERR_BUFFER_SIZE = 100;

export interface ManagedServer {
	name: string;
	config: ServerConfig;
	state: ServerState;
	client: Client | null;
	/** PID of the child process (stdio transport only). Used for safety-net cleanup. */
	childPid: number | null;
	retryCount: number;
	lastError: Error | null;
	/** Recent stderr lines from the server subprocess. */
	stderrLog: string[];
	healthCheckTimer: ReturnType<typeof setInterval> | null;
	/** Pending retry timeout — cleared on shutdown to prevent ghost reconnects. */
	retryTimer: ReturnType<typeof setTimeout> | null;
	/** Wakes up a pending retry wait as cancelled (set while waiting). */
	cancelRetry: (() => void) | null;
	/**
	 * Bumped by every stop/shutdown. A connect/retry chain captures it when it
	 * starts and gives up as soon as it changes, so a stopped server never
	 * reconnects on its own.
	 */
	generation: number;
}

/**
 * Result of a connect chain (first attempt + retries).
 * "auth-required": the server needs OAuth; never retried, user must run /mcp:auth.
 * "cancelled": stopped/shut down while connecting or waiting for a retry.
 */
export type ConnectOutcome = "ready" | "failed" | "auth-required" | "cancelled";

/** Called after tool list is refreshed for a server (e.g. on list_changed notification). */
export type ToolRefreshCallback = (serverName: string, client: Client) => Promise<void>;

/**
 * Called when a ready server loses its connection (failed health check) and again if
 * reconnecting gives up. `message` is meant for the model: the server's tools should
 * return it until the server is back (the tool refresh callback runs on reconnect).
 */
export type ServerUnavailableCallback = (serverName: string, message: string) => void;

export interface TransportAuthCallbacks {
	/**
	 * Called when an automatic connection finds that OAuth authorization is required.
	 * Notification only: automatic connections never open a browser (no callback
	 * server listens for them); the user authorizes with /mcp:auth <name>.
	 */
	onAuthRequired: (serverName: string) => void;
}

// ─── Transport Factory ────────────────────────────────────────────────────────

function createTransport(serverName: string, config: ServerConfig, onStderr: (line: string) => void): Transport {
	// Build requestInit for static headers (API keys, etc.)
	const requestInit: RequestInit | undefined = config.headers ? { headers: config.headers } : undefined;

	// Build OAuth authProvider if auth config is present
	let authProvider: OAuthClientProvider | undefined;
	if (config.auth && config.transport !== "stdio") {
		// Stored tokens are used and refreshed silently. If the SDK needs a new
		// authorization, the redirect is ignored here: the transport then fails with
		// UnauthorizedError and the server is marked "auth required" (see _attempt).
		authProvider = new McpOAuthProvider(serverName, config.url, config.auth, () => {});
	}

	switch (config.transport) {
		case "stdio": {
			// Build clean env: process.env may contain undefined values,
			// child_process.spawn silently drops them, but let's be explicit
			const env: Record<string, string> = {};
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined) env[key] = value;
			}
			Object.assign(env, config.env ?? {});
			const transport = new StdioClientTransport({
				command: config.command!,
				args: config.args,
				env,
				stderr: "pipe",
			});
			// Capture stderr lines into the circular buffer
			transport.stderr?.on("data", (chunk: Buffer) => {
				const lines = chunk.toString().split("\n").filter(Boolean);
				for (const line of lines) onStderr(line);
			});
			return transport;
		}
		case "streamable-http":
			return new StreamableHTTPClientTransport(new URL(config.url!), {
				...(requestInit && { requestInit }),
				...(authProvider && { authProvider }),
			}) as unknown as Transport;
		case "sse":
			return new SSEClientTransport(new URL(config.url!), {
				...(requestInit && { requestInit }),
				...(authProvider && { authProvider }),
			});
	}
}

// ─── ServerManager ────────────────────────────────────────────────────────────

export class ServerManager {
	private readonly servers = new Map<string, ManagedServer>();
	private settings: Settings;
	private onToolRefresh: ToolRefreshCallback | null = null;
	private onServerUnavailable: ServerUnavailableCallback | null = null;

	private authCallbacks: TransportAuthCallbacks | undefined;

	constructor(config: McpConfig, authCallbacks?: TransportAuthCallbacks) {
		this.settings = config.settings;
		this.authCallbacks = authCallbacks;
		for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
			this.servers.set(name, {
				name,
				config: serverConfig,
				state: "stopped",
				client: null,
				childPid: null,
				retryCount: 0,
				lastError: null,
				stderrLog: [],
				healthCheckTimer: null,
				retryTimer: null,
				cancelRetry: null,
				generation: 0,
			});
		}
	}

	/** Register callback invoked after tool list changes for a server. */
	setToolRefreshCallback(cb: ToolRefreshCallback): void {
		this.onToolRefresh = cb;
	}

	/** Register callback invoked when a ready server's connection is lost. */
	setServerUnavailableCallback(cb: ServerUnavailableCallback): void {
		this.onServerUnavailable = cb;
	}

	getServer(name: string): ManagedServer | undefined {
		return this.servers.get(name);
	}

	getAllServers(): ManagedServer[] {
		return Array.from(this.servers.values());
	}

	getReadyServers(): ManagedServer[] {
		return this.getAllServers().filter((s) => s.state === "ready");
	}

	/** Status summary for /mcp command. */
	getStatusSummary(): string {
		const all = this.getAllServers();
		if (all.length === 0) return `pi-mcp: No servers configured (create ${join(getAgentDir(), "mcp.json")})`;
		const lines = all.map((s) => {
			const icon = s.state === "ready" ? "✓" : s.state === "starting" ? "⟳" : "✗";
			const err = s.lastError ? ` — ${s.lastError.message}` : "";
			return `  ${icon} ${s.name} (${s.state})${err}`;
		});
		const ready = all.filter((s) => s.state === "ready").length;
		return [`MCP: ${ready}/${all.length} servers ready`, ...lines].join("\n");
	}

	/** Reset OAuth credentials for a server, forcing re-authorization on next connect. */
	async resetServerAuth(name: string): Promise<void> {
		await resetAuth(name, this.getServerUrl(name));
	}

	/** Get auth status for a server. */
	async getServerAuthStatus(name: string): Promise<{
		hasTokens: boolean;
		hasClientInfo: boolean;
		savedAt: string | undefined;
		scope: string | undefined;
	} | null> {
		return getAuthStatus(name, this.getServerUrl(name));
	}

	/** URL of a configured server (OAuth credentials are bound to name + URL). */
	private getServerUrl(name: string): string | undefined {
		return this.servers.get(name)?.config.url;
	}

	/** Get recent stderr output for a server. */
	getServerLogs(name: string): string {
		const server = this.servers.get(name);
		if (!server) return `No server named "${name}"`;
		if (server.stderrLog.length === 0) return `(no stderr output from ${name})`;
		return server.stderrLog.join("\n");
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────────

	/**
	 * Start a server and connect to it (retrying per settings.maxRetries).
	 * cwd is passed to roots/list — the workspace root exposed to the MCP server.
	 * Resolves once the server is ready, or when it was stopped meanwhile.
	 * Throws an McpError when every attempt failed or OAuth authorization is required.
	 */
	async startServer(name: string, cwd: string): Promise<void> {
		const server = this.servers.get(name);
		if (!server) {
			throw new McpError(`Unknown server "${name}"`, name, "config");
		}
		if (server.state !== "stopped") return; // Already starting or ready
		// Reset retry count on explicit start — allows /mcp:start after exhaustion
		server.retryCount = 0;
		const outcome = await this._connect(server, cwd);
		if (outcome === "auth-required") {
			throw new McpError(
				`OAuth authorization required. Run /mcp:auth ${name} to sign in.`,
				name,
				"auth",
				server.lastError,
			);
		}
		if (outcome === "failed") {
			const reason = server.lastError?.message ?? "unknown error";
			throw new McpError(`Could not connect: ${reason}`, name, "connection", server.lastError);
		}
	}

	async stopServer(name: string): Promise<void> {
		const server = this.servers.get(name);
		if (!server) return;
		// Not gated on state: a server waiting for a retry must be cancelled too.
		await this._shutdown(server);
	}

	async shutdownAll(): Promise<void> {
		await Promise.allSettled(Array.from(this.servers.values()).map((s) => this._shutdown(s)));
	}

	/**
	 * Rebuild the server map from a new config.
	 * Must only be called after shutdownAll() — old servers are discarded.
	 * New servers that didn't exist before are added; servers removed from
	 * config are dropped (their tools should already be deactivated).
	 */
	rebuildServers(config: McpConfig): void {
		this.settings = config.settings;
		this.servers.clear();
		for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
			this.servers.set(name, {
				name,
				config: serverConfig,
				state: "stopped",
				client: null,
				childPid: null,
				retryCount: 0,
				lastError: null,
				stderrLog: [],
				healthCheckTimer: null,
				retryTimer: null,
				cancelRetry: null,
				generation: 0,
			});
		}
	}

	// ─── Internal ───────────────────────────────────────────────────────────────

	/** Connect, retrying failed attempts until ready, retries are exhausted, auth is needed, or cancelled. */
	private async _connect(server: ManagedServer, cwd: string): Promise<ConnectOutcome> {
		const generation = server.generation;
		server.state = "starting";
		server.lastError = null;
		// Note: retryCount is NOT reset here: it's only reset after successful connect
		// or by startServer() (explicit start, e.g. /mcp:start).
		for (;;) {
			const outcome = await this._attempt(server, cwd, generation);
			if (outcome !== "failed") return outcome;
			if (!(await this._waitForRetry(server, generation))) {
				return server.generation === generation ? "failed" : "cancelled";
			}
		}
	}

	/** One connection attempt. On failure the state stays "starting" for the caller to retry. */
	private async _attempt(server: ManagedServer, cwd: string, generation: number): Promise<ConnectOutcome> {
		const appendStderr = (line: string): void => {
			server.stderrLog.push(line);
			if (server.stderrLog.length > STDERR_BUFFER_SIZE) {
				server.stderrLog.shift();
			}
		};

		// OAuth server without stored tokens: connecting can only end in an authorization
		// redirect that nothing listens for. Ask the user to run /mcp:auth instead.
		if (server.config.auth && server.config.transport !== "stdio") {
			const status = await getAuthStatus(server.name, server.config.url);
			if (server.generation !== generation) return "cancelled";
			if (!status?.hasTokens) return this._markAuthRequired(server);
		}

		let transport: Transport;
		try {
			transport = createTransport(server.name, server.config, appendStderr);
		} catch (err) {
			server.lastError = new Error(
				`Failed to create transport: ${err instanceof Error ? err.message : String(err)}`,
			);
			return "failed";
		}

		const client = this._createClient(server, cwd, appendStderr);

		try {
			await client.connect(transport);
		} catch (err) {
			// Clean up the transport we created (client.close() also closes transport)
			await client.close().catch(() => {});
			if (server.generation !== generation) return "cancelled";
			if (err instanceof UnauthorizedError) return this._markAuthRequired(server);
			server.lastError = err instanceof Error ? err : new Error(String(err));
			return "failed";
		}

		// Guard against shutdown being called while we were connecting.
		// _shutdown bumps the generation but can't close the local client variable.
		if (server.generation !== generation || server.state !== "starting") {
			await client.close().catch(() => {});
			return "cancelled";
		}

		// Extract PID from stdio transport for safety-net cleanup
		if (server.config.transport === "stdio") {
			// StdioClientTransport exposes the underlying process
			server.childPid = (transport as unknown as { process?: { pid?: number } }).process?.pid ?? null;
		}

		server.client = client;
		server.state = "ready";
		server.retryCount = 0;
		server.lastError = null;

		this._startHealthCheck(server, client, cwd);

		// Trigger initial tool registration
		if (this.onToolRefresh) {
			try {
				await this.onToolRefresh(server.name, client);
			} catch (err) {
				console.error(`[pi-mcp] Initial tool registration failed for ${server.name}:`, err);
			}
		}
		return "ready";
	}

	private _markAuthRequired(server: ManagedServer): ConnectOutcome {
		server.state = "stopped";
		server.lastError = new Error(`OAuth authorization required. Run /mcp:auth ${server.name}`);
		this.authCallbacks?.onAuthRequired(server.name);
		return "auth-required";
	}

	private _createClient(server: ManagedServer, cwd: string, appendStderr: (line: string) => void): Client {
		const client = new Client(
			{ name: "pi-mcp", version: "1.0.0" },
			{
				capabilities: {
					// Expose workspace root to MCP servers
					roots: { listChanged: true },
					// Sampling: explicitly NOT declared — not supported in v1
				},
			},
		);

		// Handle roots/list requests from the server. pathToFileURL gives a valid
		// file URI on every platform (file:///C:/... on Windows, percent-encoded).
		client.setRequestHandler(ListRootsRequestSchema, async () => ({
			roots: [{ uri: pathToFileURL(cwd).href, name: "workspace" }],
		}));

		// tools/list_changed: re-discover tools and update Pi registrations
		client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
			if (this.onToolRefresh && server.client) {
				try {
					await this.onToolRefresh(server.name, server.client);
				} catch (err) {
					console.error(`[pi-mcp] Failed to refresh tools for ${server.name}:`, err);
				}
			}
		});

		// notifications/message: structured logging from MCP servers
		client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
			const { level = "info", logger = server.name, data } = notification.params ?? {};
			const msg = typeof data === "string" ? data : JSON.stringify(data);
			console.error(`[pi-mcp:${server.name}] [${level}] ${logger}: ${msg}`);
			appendStderr(`[${level}] ${logger}: ${msg}`);
		});
		return client;
	}

	/** Opt-in health check: a failed ping drops the client and reconnects in the background. */
	private _startHealthCheck(server: ManagedServer, client: Client, cwd: string): void {
		if (!server.config.healthCheckIntervalMs) return;
		server.healthCheckTimer = setInterval(async () => {
			try {
				await client.ping();
			} catch {
				if (server.healthCheckTimer) clearInterval(server.healthCheckTimer);
				server.healthCheckTimer = null;
				if (server.client !== client) return; // already stopped or replaced
				console.error(`[pi-mcp] Health check failed for ${server.name}, reconnecting`);
				server.client = null;
				server.childPid = null;
				server.state = "starting";
				server.lastError = new Error("Health check failed");
				// Before any await: tools must stop using the dead client right away.
				this.onServerUnavailable?.(
					server.name,
					`MCP server "${server.name}" is disconnected (health check failed), reconnecting. Retry later or use another tool.`,
				);
				await client.close().catch(() => {});
				const generation = server.generation;
				const gaveUp = (): void => {
					if (server.generation !== generation) return; // stopped or restarted meanwhile
					this.onServerUnavailable?.(
						server.name,
						`MCP server "${server.name}" is disconnected and reconnecting failed. The user can run /mcp:start ${server.name}.`,
					);
				};
				if (await this._waitForRetry(server, generation)) {
					void this._connect(server, cwd).then(
						(outcome) => {
							if (outcome === "failed" || outcome === "auth-required") gaveUp();
						},
						(err: unknown) => {
							console.error(`[pi-mcp] Reconnecting ${server.name} failed:`, err);
							gaveUp();
						},
					);
				} else if (server.generation === generation) {
					server.state = "stopped";
					gaveUp();
				}
			}
		}, server.config.healthCheckIntervalMs);
	}

	/**
	 * Wait before the next attempt. Returns false when retries are exhausted
	 * (state becomes "stopped") or when the wait was cancelled by stop/shutdown.
	 */
	private async _waitForRetry(server: ManagedServer, generation: number): Promise<boolean> {
		const maxRetries = this.settings.maxRetries;
		if (server.retryCount >= maxRetries) {
			server.state = "stopped";
			console.error(
				`[pi-mcp] Server "${server.name}" failed after ${maxRetries} retries: ${server.lastError?.message}`,
			);
			return false;
		}

		const delayMs = RETRY_DELAYS_MS[Math.min(server.retryCount, RETRY_DELAYS_MS.length - 1)] ?? 30000;
		server.retryCount++;
		console.error(`[pi-mcp] Retrying "${server.name}" in ${delayMs}ms (attempt ${server.retryCount}/${maxRetries})`);

		const completed = await new Promise<boolean>((resolve) => {
			server.retryTimer = setTimeout(() => {
				server.retryTimer = null;
				server.cancelRetry = null;
				resolve(true);
			}, delayMs);
			server.cancelRetry = () => {
				if (server.retryTimer) clearTimeout(server.retryTimer);
				server.retryTimer = null;
				server.cancelRetry = null;
				resolve(false);
			};
		});
		return completed && server.generation === generation;
	}

	private async _shutdown(server: ManagedServer): Promise<void> {
		// Invalidate any in-flight connect/retry chain, then wake a pending retry wait.
		// Done before the state check: a server waiting for a retry has no client yet.
		server.generation++;
		server.cancelRetry?.();
		if (server.retryTimer) {
			clearTimeout(server.retryTimer);
			server.retryTimer = null;
		}

		// Stop health check
		if (server.healthCheckTimer) {
			clearInterval(server.healthCheckTimer);
			server.healthCheckTimer = null;
		}

		if (server.state === "stopped" && !server.client) return;

		server.state = "stopped";
		server.lastError = null;
		const client = server.client;
		const pid = server.childPid;
		server.client = null;
		server.childPid = null;

		try {
			// SDK handles transport-specific cleanup:
			// - stdio: closes stdin, waits for process exit, sends SIGTERM/SIGKILL
			// - streamable-http/sse: closes HTTP connections
			await client?.close();
		} catch {
			// If SDK cleanup fails, force kill the subprocess as a safety net
			if (pid !== null) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Process may already be dead
				}
			}
		}
	}
}
