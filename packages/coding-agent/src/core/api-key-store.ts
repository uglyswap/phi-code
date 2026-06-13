/**
 * API Key Store - Centralized storage and hot-reload for provider API keys.
 *
 * Per Q5 strategy C: explicit /keys command + file watcher both supported.
 * Per Q6 strategy A: keys stored in plain text in ~/.phi/agent/models.json
 * with chmod 0600 on Unix and clear warnings to users.
 *
 * Storage format: models.json providers.<id>.apiKey contains the key value
 * directly (not an env var reference). Resolution priority:
 *   1. Value in models.json (if non-empty)
 *   2. process.env[envVar] (legacy fallback)
 *
 * Events emitted via the EventEmitter:
 *   - "key_changed" { provider }       : when setKey() or external edit detected
 *   - "key_removed" { provider }       : when removeKey() called
 *   - "store_reloaded"                 : when reloadFromDisk() succeeds
 */

import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getModelsPath } from "../config.js";

export interface ProviderConfigPersisted {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	models?: unknown[];
	modelOverrides?: Record<string, unknown>;
}

export interface ModelsConfigPersisted {
	$comment?: string;
	providers: Record<string, ProviderConfigPersisted>;
}

export interface ApiKeyStoreOptions {
	configPath?: string;
}

export class ApiKeyStore extends EventEmitter {
	readonly configPath: string;
	private config: ModelsConfigPersisted = { providers: {} };
	private loaded = false;

	constructor(options: ApiKeyStoreOptions = {}) {
		super();
		this.configPath = options.configPath ?? getModelsPath();
	}

	/**
	 * Load config from disk. Creates an empty file if missing.
	 */
	load(): ModelsConfigPersisted {
		try {
			if (!existsSync(this.configPath)) {
				return this.config;
			}
			const raw = readFileSync(this.configPath, "utf-8");
			const parsed = JSON.parse(raw) as ModelsConfigPersisted;
			if (!parsed.providers || typeof parsed.providers !== "object") {
				parsed.providers = {};
			}
			this.config = parsed;
			this.loaded = true;
			return this.config;
		} catch (err) {
			throw new Error(`Failed to load ${this.configPath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Reload from disk and emit "store_reloaded".
	 */
	reloadFromDisk(): void {
		this.load();
		this.emit("store_reloaded");
	}

	/**
	 * Get the API key for a provider, with env-var fallback.
	 * Returns undefined if neither source has a value.
	 */
	getKey(providerId: string, envVar?: string): string | undefined {
		if (!this.loaded) this.load();
		const stored = this.config.providers[providerId]?.apiKey?.trim();
		if (stored && stored.length > 0 && !stored.startsWith("$")) return stored;
		if (envVar) return process.env[envVar]?.trim() || undefined;
		return undefined;
	}

	/**
	 * Get the full provider config block for a provider.
	 */
	getProvider(providerId: string): ProviderConfigPersisted | undefined {
		if (!this.loaded) this.load();
		return this.config.providers[providerId];
	}

	/**
	 * List all configured provider IDs.
	 */
	listProviders(): string[] {
		if (!this.loaded) this.load();
		return Object.keys(this.config.providers);
	}

	/**
	 * Set the API key for a provider. Creates the provider entry if missing.
	 * Performs atomic write (tmp + rename) and chmod 0600 on Unix.
	 * Emits "key_changed" event.
	 */
	setKey(providerId: string, key: string, providerConfig?: Partial<ProviderConfigPersisted>): void {
		if (!this.loaded) this.load();
		const existing = this.config.providers[providerId] ?? {};
		this.config.providers[providerId] = {
			...existing,
			...providerConfig,
			apiKey: key,
		};
		this.persist();
		// Do not include the raw key in the event payload to avoid leaking the
		// secret to listeners/logs. Listeners that need the value read it back
		// via getKey(providerId).
		this.emit("key_changed", { provider: providerId });
	}

	/**
	 * Remove the API key for a provider (but keep the rest of the provider config).
	 * Emits "key_removed" event.
	 */
	removeKey(providerId: string): void {
		if (!this.loaded) this.load();
		const existing = this.config.providers[providerId];
		if (!existing) return;
		const { apiKey: _removed, ...rest } = existing;
		this.config.providers[providerId] = rest;
		this.persist();
		this.emit("key_removed", { provider: providerId });
	}

	/**
	 * Mask an API key for display (preserves length info without exposing the secret).
	 */
	static maskKey(key: string | undefined): string {
		if (!key) return "(not set)";
		const trimmed = key.trim();
		if (trimmed.length === 0) return "(empty)";
		if (trimmed.length <= 8) return "********";
		return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
	}

	/**
	 * Atomic write of the config to disk:
	 *   1. Ensure parent dir exists
	 *   2. Write to <path>.tmp
	 *   3. Rename to <path> (atomic on POSIX)
	 *   4. Apply chmod 0600 on Unix (silently skip on Windows)
	 */
	private persist(): void {
		const isPosix = process.platform !== "win32";
		const parent = dirname(this.configPath);
		mkdirSync(parent, isPosix ? { recursive: true, mode: 0o700 } : { recursive: true });
		const tmpPath = `${this.configPath}.tmp`;
		const payload = `${JSON.stringify(this.config, null, 2)}\n`;
		// Write the tmp file with restrictive perms from the start so the plaintext
		// key is never world-readable on disk (mode is still subject to umask, hence
		// the belt-and-suspenders chmod below after the rename).
		writeFileSync(tmpPath, payload, isPosix ? { encoding: "utf-8", mode: 0o600 } : "utf-8");
		renameSync(tmpPath, this.configPath);
		if (isPosix) {
			try {
				chmodSync(this.configPath, 0o600);
			} catch {
				// chmod may fail on some filesystems (eg WSL); non-critical
			}
		}
	}
}

/** Module-level singleton for convenience. */
let _singleton: ApiKeyStore | null = null;
export function getApiKeyStore(options?: ApiKeyStoreOptions): ApiKeyStore {
	if (!_singleton || (options?.configPath && _singleton.configPath !== options.configPath)) {
		_singleton = new ApiKeyStore(options);
	}
	return _singleton;
}

export function _resetApiKeyStore(): void {
	_singleton = null;
}
