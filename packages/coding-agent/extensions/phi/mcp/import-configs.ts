/**
 * Import MCP server configs from other agent tools into <agentDir>/mcp.json.
 *
 * Sources (omp-style discovery):
 *   - <cwd>/.mcp.json            (Claude Code project)
 *   - ~/.claude.json             (Claude Code user, then projects[<cwd>].mcpServers)
 *   - ~/.codex/config.toml       (Codex, [mcp_servers.NAME] tables)
 *   - ~/.gemini/settings.json    (Gemini CLI)
 *   - <cwd>/.cursor/mcp.json     (Cursor)
 *   - <cwd>/.vscode/mcp.json     (VS Code, "servers" key)
 *
 * Each entry is converted to the phi schema (`transport`, `url`, `headers`...)
 * and validated on its own: an entry that cannot be converted is skipped with a
 * reason instead of making the whole phi config invalid.
 *
 * Existing entries in the phi config are NEVER overwritten: same-name imports
 * are skipped and reported. Within one import the first source wins, and a later
 * source defining the same name is reported as a conflict.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir } from "phi-code";
import { validateServerConfig } from "./config.ts";
import { parseToml } from "./toml.ts";

export interface ImportResult {
	imported: string[];
	skipped: string[];
	sources: string[];
	/** Entries or files that could not be imported, with the reason. */
	errors: string[];
	/** Imported entries whose settings were partly dropped or need attention. */
	warnings: string[];
}

type ServerEntry = Record<string, unknown>;

/** Source format: decides how a bare `url` is interpreted and which extra fields exist. */
export type SourceKind = "claude" | "cursor" | "vscode" | "gemini" | "codex";

export interface ConvertedEntry {
	entry?: ServerEntry;
	error?: string;
	warnings: string[];
}

/** Names that would reach Object.prototype when used as object keys. */
const FORBIDDEN_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonRead = { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string };

/** Read a JSON object; a missing file is `undefined`, a malformed one an error. */
function readJson(path: string): JsonRead {
	if (!existsSync(path)) return { ok: true, value: undefined };
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) return { ok: false, error: `${path}: top-level value is not an object` };
		return { ok: true, value: parsed };
	} catch (err) {
		return { ok: false, error: `${path}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

/** Read Codex [mcp_servers.NAME] tables (sub-tables like `.env` stay nested in their server). */
export function parseCodexServers(text: string): Record<string, ServerEntry> {
	const root = parseToml(text);
	const servers = root.mcp_servers;
	if (!isRecord(servers)) return {};
	const out: Record<string, ServerEntry> = {};
	for (const [name, entry] of Object.entries(servers)) {
		if (isRecord(entry)) out[name] = entry;
	}
	return out;
}

/** String map (env, headers). Scalars are stringified; anything else is invalid. */
function toStringMap(value: unknown, field: string): Record<string, string> | string {
	if (!isRecord(value)) return `"${field}" must be an object`;
	const out: Record<string, string> = {};
	for (const [key, v] of Object.entries(value)) {
		if (typeof v === "string") out[key] = v;
		else if (typeof v === "number" || typeof v === "boolean") out[key] = String(v);
		else return `"${field}.${key}" must be a string`;
	}
	return out;
}

type TransportChoice = { transport: "stdio" | "streamable-http" | "sse"; url?: string } | { error: string };

function detectTransport(raw: Record<string, unknown>, kind: SourceKind): TransportChoice {
	const type = typeof raw.type === "string" ? raw.type.toLowerCase() : undefined;
	const url = typeof raw.url === "string" ? raw.url : undefined;
	// Gemini: `httpUrl` is streamable HTTP, `url` is SSE.
	if (kind === "gemini" && typeof raw.httpUrl === "string") return { transport: "streamable-http", url: raw.httpUrl };
	if (type === "sse") return { transport: "sse", url };
	if (type === "http" || type === "streamable-http" || type === "streamablehttp") {
		return { transport: "streamable-http", url };
	}
	if (type !== undefined && type !== "stdio") return { error: `unsupported transport type "${raw.type}"` };
	if (type === undefined && raw.command === undefined && url !== undefined) {
		return { transport: kind === "gemini" ? "sse" : "streamable-http", url };
	}
	return { transport: "stdio" };
}

function collectWarnings(raw: Record<string, unknown>, kind: SourceKind): string[] {
	const warnings: string[] = [];
	if (raw.cwd !== undefined) warnings.push(`"cwd" is not supported by phi and was dropped`);
	for (const field of ["env_vars", "env_http_headers", "bearer_token_env_var"]) {
		if (raw[field] !== undefined) warnings.push(`"${field}" is not supported by phi and was dropped`);
	}
	if (raw.oauth !== undefined || raw.auth !== undefined) {
		warnings.push(`OAuth settings were not imported: add auth: { "type": "oauth" } manually if needed`);
	}
	// Claude/VS Code/Codex expand ${VAR}; phi uses values literally.
	if (/\$\{(?!input:)[^}]+\}/.test(JSON.stringify(raw))) {
		warnings.push(`contains \${...} placeholders, which phi does not expand: edit the values in mcp.json`);
	}
	if (kind === "codex" && raw.enabled === false) warnings.push(`was disabled in Codex (imported as lazy)`);
	return warnings;
}

function requestTimeout(raw: Record<string, unknown>, kind: SourceKind): number | undefined {
	if (kind === "gemini" && typeof raw.timeout === "number" && raw.timeout > 0) return raw.timeout;
	if (kind === "codex" && typeof raw.tool_timeout_sec === "number" && raw.tool_timeout_sec > 0) {
		return raw.tool_timeout_sec * 1000;
	}
	return undefined;
}

function buildStdioEntry(raw: Record<string, unknown>): ServerEntry | string {
	if (typeof raw.command !== "string" || !raw.command) return `"command" is missing`;
	const entry: ServerEntry = { command: raw.command };
	if (raw.args !== undefined) {
		if (!Array.isArray(raw.args)) return `"args" must be an array`;
		entry.args = raw.args.map((a) => (typeof a === "string" ? a : String(a)));
	}
	if (raw.env !== undefined) {
		const env = toStringMap(raw.env, "env");
		if (typeof env === "string") return env;
		entry.env = env;
	}
	return entry;
}

function buildRemoteEntry(
	raw: Record<string, unknown>,
	transport: string,
	url: string | undefined,
): ServerEntry | string {
	if (!url) return `"url" is missing for ${transport} transport`;
	const entry: ServerEntry = { transport, url };
	const rawHeaders = raw.headers ?? raw.http_headers;
	if (rawHeaders !== undefined) {
		const headers = toStringMap(rawHeaders, "headers");
		if (typeof headers === "string") return headers;
		entry.headers = headers;
	}
	return entry;
}

/**
 * Convert one server entry from another client's format to the phi schema and validate it.
 * Returns either the phi entry (with warnings) or the reason it cannot be imported.
 */
export function convertExternalEntry(raw: unknown, kind: SourceKind): ConvertedEntry {
	if (!isRecord(raw)) return { error: "entry is not an object", warnings: [] };
	if (JSON.stringify(raw).includes("${input:")) {
		return { error: `uses VS Code \${input:...} prompts, which phi cannot resolve: add it manually`, warnings: [] };
	}
	const choice = detectTransport(raw, kind);
	if ("error" in choice) return { error: choice.error, warnings: [] };
	const built =
		choice.transport === "stdio" ? buildStdioEntry(raw) : buildRemoteEntry(raw, choice.transport, choice.url);
	if (typeof built === "string") return { error: built, warnings: [] };
	const timeout = requestTimeout(raw, kind);
	if (timeout !== undefined) built.requestTimeoutMs = timeout;

	const validation = validateServerConfig(built);
	if (!validation.ok) return { error: validation.issues.join("; "), warnings: [] };
	return { entry: built, warnings: collectWarnings(raw, kind) };
}

interface Candidate {
	label: string;
	kind: SourceKind;
	servers: Record<string, unknown>;
}

function addJsonCandidate(
	candidates: Candidate[],
	errors: string[],
	path: string,
	label: string,
	kind: SourceKind,
	keys: string[],
): void {
	const read = readJson(path);
	if (!read.ok) {
		errors.push(`Could not read ${label}: ${read.error}`);
		return;
	}
	for (const key of keys) {
		const servers = read.value?.[key];
		if (isRecord(servers)) {
			candidates.push({ label, kind, servers });
			return;
		}
	}
}

/**
 * Comparable form of a project path as Claude Code stores it in ~/.claude.json
 * `projects` keys. On Windows the comparison ignores case and `\` vs `/`.
 */
export function normalizeProjectPath(path: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") {
		// "C:\Users\x\" and "c:/users/x" are the same project; a drive root keeps its "/".
		const normalized = path.replace(/\\/g, "/").toLowerCase();
		return /^[a-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/+$/, "");
	}
	return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Claude Code per-project servers (local scope): projects[<cwd>].mcpServers of ~/.claude.json. */
function addClaudeProjectCandidate(candidates: Candidate[], claudeJson: Record<string, unknown>, cwd: string): void {
	const projects = claudeJson.projects;
	if (!isRecord(projects)) return;
	const target = normalizeProjectPath(resolve(cwd));
	for (const [projectPath, project] of Object.entries(projects)) {
		if (normalizeProjectPath(projectPath) !== target || !isRecord(project)) continue;
		if (isRecord(project.mcpServers)) {
			candidates.push({
				label: `~/.claude.json (project ${projectPath})`,
				kind: "claude",
				servers: project.mcpServers,
			});
		}
	}
}

function collectCandidates(cwd: string, errors: string[]): Candidate[] {
	const candidates: Candidate[] = [];
	addJsonCandidate(candidates, errors, join(cwd, ".mcp.json"), ".mcp.json", "claude", ["mcpServers"]);
	const claudeJsonPath = join(homedir(), ".claude.json");
	addJsonCandidate(candidates, errors, claudeJsonPath, "~/.claude.json", "claude", ["mcpServers"]);
	// Global servers first: a project server with the same name is reported, not imported.
	const claudeJson = readJson(claudeJsonPath);
	if (claudeJson.ok && claudeJson.value) addClaudeProjectCandidate(candidates, claudeJson.value, cwd);

	const codexPath = join(homedir(), ".codex", "config.toml");
	if (existsSync(codexPath)) {
		try {
			const servers = parseCodexServers(readFileSync(codexPath, "utf8"));
			if (Object.keys(servers).length > 0) {
				candidates.push({ label: "~/.codex/config.toml", kind: "codex", servers });
			}
		} catch (err) {
			errors.push(`Could not read ~/.codex/config.toml: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const geminiPath = join(homedir(), ".gemini", "settings.json");
	addJsonCandidate(candidates, errors, geminiPath, "~/.gemini/settings.json", "gemini", ["mcpServers"]);
	addJsonCandidate(candidates, errors, join(cwd, ".cursor", "mcp.json"), ".cursor/mcp.json", "cursor", ["mcpServers"]);
	addJsonCandidate(candidates, errors, join(cwd, ".vscode", "mcp.json"), ".vscode/mcp.json", "vscode", [
		"mcpServers",
		"servers",
	]);
	return candidates;
}

export function importExternalMcpConfigs(cwd: string, targetPath = join(getAgentDir(), "mcp.json")): ImportResult {
	const result: ImportResult = { imported: [], skipped: [], sources: [], errors: [], warnings: [] };

	// Never rewrite a phi config we could not parse: that would drop the user's servers.
	const target = readJson(targetPath);
	if (!target.ok) {
		result.errors.push(`Refusing to import: the phi config is not valid JSON (${target.error})`);
		return result;
	}
	const existing = target.value ?? { mcpServers: {} };
	const servers: Record<string, unknown> = isRecord(existing.mcpServers) ? existing.mcpServers : {};
	/** Source of each entry imported by this run, to report same-name conflicts between sources. */
	const importedFrom = new Map<string, string>();

	for (const { label, kind, servers: incoming } of collectCandidates(cwd, result.errors)) {
		let used = false;
		for (const [name, raw] of Object.entries(incoming)) {
			if (FORBIDDEN_NAMES.has(name)) {
				result.errors.push(`${name} (${label}): invalid server name`);
				continue;
			}
			const earlier = importedFrom.get(name);
			if (earlier !== undefined) {
				result.skipped.push(`${name} (${label}: conflicts with ${name} from ${earlier}, which was kept)`);
				result.warnings.push(
					`${name}: defined in both ${earlier} and ${label}; imported the one from ${earlier}. Rename one to import both.`,
				);
				continue;
			}
			if (Object.hasOwn(servers, name)) {
				result.skipped.push(`${name} (${label}: already in phi config)`);
				continue;
			}
			const converted = convertExternalEntry(raw, kind);
			if (!converted.entry) {
				result.errors.push(`${name} (${label}): ${converted.error}`);
				continue;
			}
			servers[name] = converted.entry;
			importedFrom.set(name, label);
			result.imported.push(`${name} (${label})`);
			for (const warning of converted.warnings) result.warnings.push(`${name} (${label}): ${warning}`);
			used = true;
		}
		if (used) result.sources.push(label);
	}

	if (result.imported.length > 0) {
		existing.mcpServers = servers;
		mkdirSync(dirname(targetPath), { recursive: true });
		// Imported env/headers may hold secrets: owner-only file.
		writeFileSync(targetPath, JSON.stringify(existing, null, 2), { encoding: "utf8", mode: 0o600 });
		try {
			chmodSync(targetPath, 0o600); // mode only applies on creation (no-op on Windows)
		} catch (err) {
			result.warnings.push(`Could not restrict permissions of ${targetPath}: ${(err as Error).message}`);
		}
	}
	return result;
}
