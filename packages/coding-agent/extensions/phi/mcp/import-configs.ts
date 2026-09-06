/**
 * Import MCP server configs from other agent tools into ~/.phi/agent/mcp.json.
 *
 * Sources (omp-style discovery):
 *   - <cwd>/.mcp.json            (Claude Code project)
 *   - ~/.claude.json             (Claude Code user)
 *   - ~/.codex/config.toml       (Codex, [mcp_servers.NAME] tables)
 *   - ~/.gemini/settings.json    (Gemini CLI)
 *   - <cwd>/.cursor/mcp.json     (Cursor)
 *   - <cwd>/.vscode/mcp.json     (VS Code, "servers" key)
 *
 * Existing entries in the phi config are NEVER overwritten: same-name imports
 * are skipped and reported.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ImportResult {
	imported: string[];
	skipped: string[];
	sources: string[];
	errors: string[];
}

type ServerEntry = Record<string, unknown>;

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** Minimal TOML reader for Codex [mcp_servers.NAME] tables (flat key=value). */
function parseCodexToml(path: string): Record<string, ServerEntry> {
	const out: Record<string, ServerEntry> = {};
	let text: string;
	try {
		if (!existsSync(path)) return out;
		text = readFileSync(path, "utf8");
	} catch {
		return out;
	}
	let current: ServerEntry | undefined;
	let currentName: string | undefined;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		const table = /^\[mcp_servers\.([^\]]+)\]$/.exec(line);
		if (table) {
			currentName = table[1];
			current = {};
			out[currentName] = current;
			continue;
		}
		if (line.startsWith("[") || !current) {
			if (line.startsWith("[")) current = undefined;
			continue;
		}
		const kv = /^([A-Za-z_]+)\s*=\s*(.+)$/.exec(line);
		if (!kv) continue;
		const [, key, value] = kv;
		try {
			current[key] = JSON.parse(value.replace(/'/g, '"'));
		} catch {
			current[key] = value.replace(/^"|"$/g, "");
		}
	}
	return out;
}

export function importExternalMcpConfigs(cwd: string, targetPath = join(homedir(), ".phi", "agent", "mcp.json")): ImportResult {
	const result: ImportResult = { imported: [], skipped: [], sources: [], errors: [] };

	const candidates: Array<{ label: string; servers: Record<string, ServerEntry> }> = [];

	const claudeProject = readJson(join(cwd, ".mcp.json"));
	if (claudeProject?.mcpServers) candidates.push({ label: ".mcp.json", servers: claudeProject.mcpServers as Record<string, ServerEntry> });

	const claudeUser = readJson(join(homedir(), ".claude.json"));
	if (claudeUser?.mcpServers) candidates.push({ label: "~/.claude.json", servers: claudeUser.mcpServers as Record<string, ServerEntry> });

	const codex = parseCodexToml(join(homedir(), ".codex", "config.toml"));
	if (Object.keys(codex).length > 0) candidates.push({ label: "~/.codex/config.toml", servers: codex });

	const gemini = readJson(join(homedir(), ".gemini", "settings.json"));
	if (gemini?.mcpServers) candidates.push({ label: "~/.gemini/settings.json", servers: gemini.mcpServers as Record<string, ServerEntry> });

	const cursor = readJson(join(cwd, ".cursor", "mcp.json"));
	if (cursor?.mcpServers) candidates.push({ label: ".cursor/mcp.json", servers: cursor.mcpServers as Record<string, ServerEntry> });

	const vscode = readJson(join(cwd, ".vscode", "mcp.json"));
	const vscodeServers = (vscode?.mcpServers ?? vscode?.servers) as Record<string, ServerEntry> | undefined;
	if (vscodeServers) candidates.push({ label: ".vscode/mcp.json", servers: vscodeServers });

	const existing = readJson(targetPath) ?? { mcpServers: {} };
	const servers = (existing.mcpServers ?? {}) as Record<string, ServerEntry>;

	for (const { label, servers: incoming } of candidates) {
		let used = false;
		for (const [name, entry] of Object.entries(incoming)) {
			if (servers[name]) {
				result.skipped.push(`${name} (${label}: already in phi config)`);
				continue;
			}
			servers[name] = entry;
			result.imported.push(`${name} (${label})`);
			used = true;
		}
		if (used) result.sources.push(label);
	}

	if (result.imported.length > 0) {
		existing.mcpServers = servers;
		mkdirSync(dirname(targetPath), { recursive: true });
		writeFileSync(targetPath, JSON.stringify(existing, null, 2));
	}
	return result;
}
