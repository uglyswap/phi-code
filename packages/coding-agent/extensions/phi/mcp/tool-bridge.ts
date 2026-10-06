/**
 * Tool bridge for pi-mcp.
 *
 * Converts MCP tools to Pi tools and manages their lifecycle:
 *   - Paginated tools/list (cursor loop per spec)
 *   - JSON Schema → TypeBox conversion (common types + Type.Any() fallback)
 *   - Tool name sanitization (Pi-compatible identifiers)
 *   - Tool annotations → description hints
 *   - AbortSignal → SDK's built-in cancellation (notifications/cancelled)
 *   - Protocol error vs tool execution error distinction
 *   - Activate/deactivate pattern (register once, toggle on server state change)
 *   - Image content → image blocks (supported formats); audio/other → text placeholder
 *   - Long text output truncated (20 KB) with the full text in an owner-only temp file
 */

import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionAPI } from "phi-code";
import type { TSchema } from "typebox";
import * as Type from "typebox";
import type { Settings } from "./config.ts";
import { McpError } from "./errors.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Subset of Pi's ExtensionAPI used by the bridge. */
export type PiExtensionAPI = Pick<ExtensionAPI, "registerTool" | "getActiveTools" | "setActiveTools">;

// ─── Schema Conversion ────────────────────────────────────────────────────────

/**
 * Convert a JSON Schema object to a TypeBox schema.
 * Handles the common subset used by real-world MCP servers:
 *   - Primitives (string, number, integer, boolean, null)
 *   - Arrays, objects (with required/optional/additionalProperties)
 *   - Enums (string enums → Union of Literals)
 *   - Nullable types ("type": ["string", "null"])
 *   - $ref (local #/$defs/ and #/definitions/ references)
 *   - oneOf / anyOf → TypeBox Union
 *   - allOf → TypeBox Intersect
 * Falls back to Type.Any() for unresolvable $ref or missing type.
 */
export function convertJsonSchemaToTypebox(schema: unknown, depth = 0, defs?: Record<string, unknown>): TSchema {
	// Guard against infinite recursion and malformed schemas
	if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 10) {
		return Type.Any();
	}

	const s = schema as Record<string, unknown>;
	const description = typeof s.description === "string" ? s.description : undefined;
	const opts = description ? { description } : {};

	// Extract $defs / definitions for $ref resolution (carried through recursive calls)
	const resolvedDefs: Record<string, unknown> = {
		...((s.$defs ?? s.definitions) as Record<string, unknown> | undefined),
		...defs,
	};

	// ── Handle $ref ──────────────────────────────────────────────────────────
	if (typeof s.$ref === "string") {
		const ref = s.$ref as string;
		let resolved: unknown;

		// Local references: #/$defs/Foo, #/definitions/Foo
		if (ref.startsWith("#/")) {
			const parts = ref.slice(2).split("/");
			if (parts[0] === "$defs" || parts[0] === "definitions") {
				const key = parts.slice(1).join("/");
				resolved = resolvedDefs[key];
			} else {
				// Fallback: try walking the defs map by the last part
				const key = parts[parts.length - 1]!;
				resolved = resolvedDefs[key];
			}
		} else {
			// External $ref — cannot resolve, fall back
			console.warn(`[pi-mcp] Cannot resolve external $ref "${ref}", using Type.Any()`);
			return Type.Any(opts);
		}

		if (!resolved) {
			console.warn(`[pi-mcp] Could not resolve $ref "${ref}", using Type.Any()`);
			return Type.Any(opts);
		}

		// Merge description from referencing schema into resolved schema
		const merged = { ...(resolved as Record<string, unknown>) };
		if (description && !merged.description) {
			merged.description = description;
		}
		return convertJsonSchemaToTypebox(merged, depth + 1, resolvedDefs);
	}

	// ── Handle oneOf / anyOf → TypeBox Union ─────────────────────────────────
	if (Array.isArray(s.oneOf)) {
		const members = (s.oneOf as unknown[]).map((sub) => convertJsonSchemaToTypebox(sub, depth + 1, resolvedDefs));
		return members.length === 1 ? members[0]! : Type.Union(members, opts);
	}

	if (Array.isArray(s.anyOf)) {
		const members = (s.anyOf as unknown[]).map((sub) => convertJsonSchemaToTypebox(sub, depth + 1, resolvedDefs));
		return members.length === 1 ? members[0]! : Type.Union(members, opts);
	}

	// ── Handle allOf → TypeBox Intersect ─────────────────────────────────────
	if (Array.isArray(s.allOf)) {
		const members = (s.allOf as unknown[]).map((sub) => convertJsonSchemaToTypebox(sub, depth + 1, resolvedDefs));
		return members.length === 1 ? members[0]! : Type.Intersect(members, opts);
	}

	// Handle nullable types: { "type": ["string", "null"] }
	const rawType = s.type;
	const type = Array.isArray(rawType)
		? (rawType.find((t) => t !== "null") as string | undefined)
		: typeof rawType === "string"
			? rawType
			: undefined;

	const isNullable = Array.isArray(rawType) && rawType.includes("null");

	let base: TSchema;

	switch (type) {
		case "string": {
			const enumVals = s.enum;
			if (Array.isArray(enumVals) && enumVals.every((v) => typeof v === "string")) {
				// TypeBox doesn't have a built-in StringEnum — use Union of Literals
				base = Type.Union(
					(enumVals as string[]).map((v) => Type.Literal(v)),
					opts,
				);
			} else {
				base = Type.String(opts);
			}
			break;
		}
		case "number":
		case "integer":
			base = Type.Number(opts);
			break;
		case "boolean":
			base = Type.Boolean(opts);
			break;
		case "null":
			base = Type.Null(opts);
			break;
		case "array": {
			const items = s.items;
			base = Type.Array(items ? convertJsonSchemaToTypebox(items, depth + 1, resolvedDefs) : Type.Unknown(), opts);
			break;
		}
		case "object": {
			const properties = s.properties as Record<string, unknown> | undefined;
			const required = new Set<string>(Array.isArray(s.required) ? (s.required as string[]) : []);
			const additionalProperties = s.additionalProperties;

			if (!properties) {
				// Open object — passthrough as Any to avoid over-constraining
				base = Type.Record(Type.String(), Type.Unknown(), opts);
				break;
			}

			const props: Record<string, TSchema> = {};
			for (const [key, value] of Object.entries(properties)) {
				const converted = convertJsonSchemaToTypebox(value, depth + 1, resolvedDefs);
				props[key] = required.has(key) ? converted : Type.Optional(converted);
			}

			const objOpts: Record<string, unknown> = { ...opts };
			if (additionalProperties === false) {
				objOpts.additionalProperties = false;
			}

			base = Type.Object(props, objOpts as any);
			break;
		}
		default: {
			// Truly unsupported or missing type field
			base = Type.Any(opts);
			break;
		}
	}

	return isNullable ? Type.Union([base, Type.Null()]) : base;
}

// ─── Tool Name Sanitization ───────────────────────────────────────────────────

const MAX_TOOL_NAME_LEN = 64;

/**
 * Build a Pi-compatible tool name.
 * Format: <prefix>_<server>_<tool>
 * Rules: [a-zA-Z0-9_], max 64 chars.
 * Sanitizing can map different tools to one name (`read-file`/`read_file`, or servers
 * `my-srv`/`my_srv`). When the name is too long, or `isTaken` reports it is used by
 * another MCP tool, a hash of (server, tool) replaces the end so names stay unique.
 */
export function buildToolName(
	prefix: string,
	serverName: string,
	toolName: string,
	isTaken: (name: string) => boolean = () => false,
): string {
	const raw = `${prefix}_${serverName}_${toolName}`;
	const safe = raw.replace(/[^a-zA-Z0-9_]/g, "_");
	if (safe.length <= MAX_TOOL_NAME_LEN && !isTaken(safe)) return safe;
	const hash = createHash("sha256").update(`${serverName}\0${toolName}`).digest("hex").slice(0, 8);
	return `${safe.slice(0, MAX_TOOL_NAME_LEN - hash.length - 1)}_${hash}`;
}

// ─── Content Conversion ───────────────────────────────────────────────────────

type PiTextContent = { type: "text"; text: string };
type PiImageContent = { type: "image"; data: string; mimeType: string };
export type PiToolContent = PiTextContent | PiImageContent;

/** Image formats every supported provider accepts inline; others stay a text placeholder. */
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function toImageBlock(data: unknown, mimeType: unknown): PiImageContent | undefined {
	if (typeof data !== "string" || !data || typeof mimeType !== "string") return undefined;
	const mime = mimeType.toLowerCase();
	return SUPPORTED_IMAGE_TYPES.has(mime) ? { type: "image", data, mimeType: mime } : undefined;
}

function convertMcpItem(item: unknown): PiToolContent {
	if (!item || typeof item !== "object") {
		return { type: "text", text: String(item) };
	}
	const block = item as Record<string, unknown>;
	switch (block.type) {
		case "text":
			return { type: "text", text: String(block.text ?? "") };
		case "image":
			return (
				toImageBlock(block.data, block.mimeType) ?? {
					type: "text",
					text: `[Image: ${String(block.mimeType ?? "unknown")}, unsupported format omitted]`,
				}
			);
		case "audio":
			return { type: "text", text: `[Audio: ${String(block.mimeType ?? "unknown")}, omitted]` };
		case "resource_link":
			return { type: "text", text: `${String(block.name ?? "resource")}: ${String(block.uri ?? "")}` };
		case "resource": {
			const r = block.resource as Record<string, unknown> | undefined;
			if (typeof r?.text === "string") return { type: "text", text: r.text };
			const image = toImageBlock(r?.blob, r?.mimeType);
			if (image) return image;
			if (r?.blob) return { type: "text", text: `[Resource blob: ${String(r.uri)}]` };
			return { type: "text", text: `[Resource: ${String(r?.uri ?? "unknown")}]` };
		}
		default:
			return { type: "text", text: JSON.stringify(item) };
	}
}

/** Convert MCP content blocks: text stays text, supported images become image blocks. */
export function convertMcpContent(items: unknown[]): PiToolContent[] {
	return items.map(convertMcpItem);
}

// ─── Output Limit ─────────────────────────────────────────────────────────────

/** Model-facing text of one MCP result beyond this is cut in the middle (same limit as pi). */
export const MCP_OUTPUT_MAX_BYTES = 20 * 1024;

/** Write the full output to an owner-only temp file and return its path. */
async function saveFullOutput(text: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "phi-mcp-")); // created 0700
	const path = join(dir, "output.txt");
	await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
	return path;
}

/** Keep the first and last `half` bytes of `text` (UTF-8), dropping the middle. */
function cutMiddle(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text, "utf8");
	const half = Math.floor(maxBytes / 2);
	// Decoding may split a multi-byte character at the cut: it shows as U+FFFD, harmless.
	const head = bytes.subarray(0, half).toString("utf8");
	const tail = bytes.subarray(bytes.length - half).toString("utf8");
	const omitted = bytes.length - 2 * half;
	return `${head}\n\n[... ${omitted} bytes omitted ...]\n\n${tail}`;
}

/**
 * Keep the text of a result within MCP_OUTPUT_MAX_BYTES: long text becomes one
 * block with its start and end, followed by the path of a temp file holding the
 * full text. Images are kept after it.
 */
export async function limitMcpContent(
	content: PiToolContent[],
	saveOutput: (text: string) => Promise<string> = saveFullOutput,
): Promise<{ content: PiToolContent[]; fullOutputPath?: string }> {
	const combined = content
		.filter((c): c is PiTextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	if (Buffer.byteLength(combined, "utf8") <= MCP_OUTPUT_MAX_BYTES) return { content };

	let fullOutputPath: string | undefined;
	let where: string;
	try {
		fullOutputPath = await saveOutput(combined);
		where = `[Output truncated. Full output: ${fullOutputPath} (read it with offset/limit)]`;
	} catch (err) {
		where = `[Output truncated. Could not save the full output: ${err instanceof Error ? err.message : String(err)}]`;
	}
	const text = `${cutMiddle(combined, MCP_OUTPUT_MAX_BYTES)}\n\n${where}`;
	const images = content.filter((c): c is PiImageContent => c.type === "image");
	return { content: [{ type: "text", text }, ...images], ...(fullOutputPath && { fullOutputPath }) };
}

// ─── Tool Listing ─────────────────────────────────────────────────────────────

export interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
		title?: string;
	};
}

/**
 * Fetch all tools from a server using cursor-based pagination.
 * The MCP spec mandates clients follow nextCursor until exhausted.
 * Includes a max-page guard to prevent infinite loops from broken servers.
 */
export async function listAllTools(client: Client, requestTimeoutMs: number): Promise<McpToolDefinition[]> {
	const tools: McpToolDefinition[] = [];
	let cursor: string | undefined;
	const MAX_PAGES = 100;
	let pageCount = 0;

	do {
		if (pageCount >= MAX_PAGES) {
			console.warn(
				`[pi-mcp] tools/list pagination exceeded ${MAX_PAGES} pages, stopping. The server may be malfunctioning.`,
			);
			break;
		}
		const result = await client.request(
			{ method: "tools/list", params: cursor ? { cursor } : {} },
			ListToolsResultSchema,
			{ timeout: requestTimeoutMs },
		);
		tools.push(...(result.tools as McpToolDefinition[]));
		cursor = result.nextCursor;
		pageCount++;
	} while (cursor);

	return tools;
}

// ─── Tool Bridge ──────────────────────────────────────────────────────────────

/**
 * Manages MCP tools as Pi tools for a set of servers.
 * Tools are registered once and activated/deactivated as servers connect/disconnect.
 */
export class ToolBridge {
	private readonly settings: Settings;
	private readonly pi: PiExtensionAPI;
	/** Tracks which Pi tool names belong to which MCP server. */
	private readonly serverToolNames = new Map<string, Set<string>>();
	/**
	 * Owner of each Pi tool name across ALL servers, as "<server>\0<tool>".
	 * Used to give colliding names a hash suffix instead of overwriting another tool.
	 */
	private readonly toolOwners = new Map<string, string>();

	constructor(settings: Settings, pi: PiExtensionAPI) {
		this.settings = settings;
		this.pi = pi;
	}

	/**
	 * Refresh tools for a server — called on initial connect and on list_changed.
	 * Always re-registers tools with the current client reference so that
	 * tool execute closures capture the latest client after reconnection.
	 * Deactivates tools that are no longer in the server's list.
	 * Note: Pi's registerTool() overwrites by name (Map.set), so re-registration is safe.
	 */
	async refreshTools(serverName: string, client: Client): Promise<void> {
		const timeoutMs = this.settings.requestTimeoutMs;

		let tools: McpToolDefinition[];
		try {
			tools = await listAllTools(client, timeoutMs);
		} catch (err) {
			throw new McpError(
				`Failed to list tools from ${serverName}: ${err instanceof Error ? err.message : String(err)}`,
				serverName,
				"protocol",
				err,
			);
		}

		const registeredForServer = this.serverToolNames.get(serverName) ?? new Set<string>();

		// Build the set of currently valid Pi tool names for this server
		const currentToolNames = new Set<string>();

		// This server's previous names are re-assigned below (same order => same names).
		for (const name of registeredForServer) this.toolOwners.delete(name);
		const seenTools = new Set<string>();

		for (const tool of tools) {
			if (seenTools.has(tool.name)) {
				// The server listed the same tool twice: keep the first definition.
				console.warn(`[pi-mcp] Server "${serverName}" lists tool "${tool.name}" twice, ignoring the duplicate.`);
				continue;
			}
			seenTools.add(tool.name);
			// Sanitizing can map different tools ("read-file"/"read_file", or servers
			// "my-srv"/"my_srv") to one Pi name: a taken name gets a hash suffix.
			const owner = `${serverName}\0${tool.name}`;
			const piName = buildToolName(this.settings.toolPrefix, serverName, tool.name, (name) => {
				const current = this.toolOwners.get(name);
				return current !== undefined && current !== owner;
			});
			this.toolOwners.set(piName, owner);
			currentToolNames.add(piName);
			// Always re-register — on reconnect the client reference changes and
			// Pi's registerTool overwrites by name, so this is idempotent.
			this._registerTool(piName, serverName, tool, client);
		}

		// Deactivate tools that were removed from the server (no longer in tools/list)
		for (const existingName of registeredForServer) {
			if (!currentToolNames.has(existingName)) {
				this._deactivateServerTool(existingName);
			}
		}

		this.serverToolNames.set(serverName, currentToolNames);

		// Activate all current tools for this server
		this._activateServerTools(serverName);
	}

	/** Deactivate all Pi tools belonging to a server (called on disconnect). */
	deactivateServer(serverName: string): void {
		this._deactivateServerTools(serverName);
	}

	/** Remove all tracking data for a server (called when config changes remove a server). */
	removeServer(serverName: string): void {
		this._deactivateServerTools(serverName);
		for (const name of this.serverToolNames.get(serverName) ?? []) this.toolOwners.delete(name);
		this.serverToolNames.delete(serverName);
	}

	/** Re-activate all Pi tools belonging to a server (called on reconnect). */
	activateServer(serverName: string): void {
		this._activateServerTools(serverName);
	}

	// ─── Internal ───────────────────────────────────────────────────────────────

	private _registerTool(piName: string, serverName: string, tool: McpToolDefinition, client: Client): void {
		// Build description with annotation hints for LLM guidance
		let description = tool.description ?? `MCP tool: ${tool.name}`;
		const ann = tool.annotations;
		if (ann) {
			const hints: string[] = [];
			if (ann.readOnlyHint) hints.push("read-only");
			if (ann.destructiveHint) hints.push("⚠️ destructive");
			if (ann.idempotentHint) hints.push("idempotent");
			if (ann.openWorldHint) hints.push("may have side effects");
			if (hints.length > 0) description += ` [${hints.join(", ")}]`;
		}

		const schema = convertJsonSchemaToTypebox(tool.inputSchema);
		const timeoutMs = this.settings.requestTimeoutMs;

		this.pi.registerTool({
			name: piName,
			label: ann?.title ?? tool.name,
			description,
			promptSnippet: description.slice(0, 120),
			parameters: schema,

			async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Cancelled" }], details: {} };
				}

				try {
					const result = await client.request(
						{
							method: "tools/call",
							params: { name: tool.name, arguments: params },
						},
						CallToolResultSchema,
						// Pass AbortSignal to SDK — it will automatically send
						// notifications/cancelled when the signal fires
						{ timeout: timeoutMs, ...(signal ? { signal } : {}) },
					);

					const { content, fullOutputPath } = await limitMcpContent(
						convertMcpContent(result.content as unknown[]),
					);

					// Tool execution errors (isError: true) — distinct from protocol errors
					if (result.isError) {
						const errorText = content
							.map((c) => (c.type === "text" ? c.text : `[Image: ${c.mimeType}]`))
							.join("\n");
						throw new McpError(errorText || "Tool reported an error", serverName, "tool");
					}

					return { content, details: fullOutputPath ? { fullOutputPath } : {} };
				} catch (err) {
					if (err instanceof McpError) throw err;
					// Protocol-level errors (JSON-RPC error response, timeout, etc.)
					throw new McpError(err instanceof Error ? err.message : String(err), serverName, "protocol", err);
				}
			},
		});
	}

	private _activateServerTools(serverName: string): void {
		const serverTools = this.serverToolNames.get(serverName);
		if (!serverTools || serverTools.size === 0) return;

		const currentActive = new Set(this.pi.getActiveTools());
		for (const name of serverTools) currentActive.add(name);
		this.pi.setActiveTools(Array.from(currentActive));
	}

	private _deactivateServerTools(serverName: string): void {
		const serverTools = this.serverToolNames.get(serverName);
		if (!serverTools || serverTools.size === 0) return;

		const currentActive = this.pi.getActiveTools();
		const remaining = currentActive.filter((n) => !serverTools.has(n));
		this.pi.setActiveTools(remaining);
	}

	/** Deactivate a single tool by Pi name (used when a tool is removed on list_changed). */
	private _deactivateServerTool(piName: string): void {
		const currentActive = this.pi.getActiveTools();
		const remaining = currentActive.filter((n) => n !== piName);
		this.pi.setActiveTools(remaining);
	}
}
