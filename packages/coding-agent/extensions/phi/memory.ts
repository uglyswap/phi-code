/**
 * Memory Extension - Persistent memory management for Phi Code
 *
 * Now powered by sigma-memory package which provides:
 * - NotesManager: Markdown files management
 * - OntologyManager: Knowledge graph with entities and relations
 * - VectorStore: Embedded vector search (sql.js + local embeddings)
 *
 * Features:
 * - memory_search: Unified search across notes, ontology, and vector store
 * - memory_write: Write content to memory files
 * - memory_read: Read specific memory files or list available ones
 * - memory_status: Get status of all memory subsystems
 * - Report AGENTS.md files on session start (notification only; the core
 *   context loader is what injects <cwd>/AGENTS.md into the system prompt)
 *
 * Usage:
 * 1. Ensure sigma-memory package is built: cd packages/sigma-memory && npm run build
 * 2. Memory files are stored in ~/.phi/memory/
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { type ExtensionAPI, getAgentDir } from "phi-code";
import { type OntologyEntity, SigmaMemory } from "sigma-memory";

/**
 * Build a unique, human-readable filename for a single memory fact.
 *
 * Combines a kebab-case slug of the first words of the content with a short
 * content hash. This prevents same-day clobber (each fact gets its own file)
 * while staying deterministic: re-writing the exact same fact yields the same
 * name instead of piling up duplicates.
 */
function buildFactFilename(content: string): string {
	const slug = content
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.trim()
		.split(/\s+/)
		.slice(0, 6)
		.join("-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
	const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
	const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
	const stem = slug ? `${date}-${slug}-${hash}` : `${date}-${hash}`;
	return `${stem}.md`;
}

/**
 * Prepend a minimal YAML frontmatter ({name, description}) if absent, so each
 * fact file carries lightweight metadata for later listing and search.
 */
function withFrontmatter(content: string, name: string): string {
	if (content.startsWith("---\n") || content.startsWith("---\r\n")) {
		return content;
	}
	const firstLine = content.split("\n", 1)[0]?.trim() ?? "";
	const description = (firstLine || name).replace(/"/g, "'").slice(0, 120);
	return `---\nname: "${name}"\ndescription: "${description}"\n---\n\n${content}`;
}

/** Hard caps for the deterministic recall manifest (no LLM involved). */
const MANIFEST_MAX_ENTRIES = 40;
const MANIFEST_MAX_CHARS = 2000;
const MANIFEST_DESC_MAX = 100;
// Chars reserved for the trailing "… (N notes total …)" overflow line so the
// final manifest still respects MANIFEST_MAX_CHARS once it is appended.
const MANIFEST_OVERFLOW_RESERVE = 96;

/**
 * Extract a one-line summary for a single note file, deterministically.
 *
 * Prefers the YAML frontmatter `description:` field (written by
 * withFrontmatter). Falls back to the first non-empty, non-frontmatter line.
 * Returns a trimmed, single-line string truncated to MANIFEST_DESC_MAX chars.
 */
function summarizeNote(content: string): string {
	const text = content.replace(/\r\n/g, "\n");
	let body = text;

	// If a frontmatter block is present, scan it for a description first.
	if (text.startsWith("---\n")) {
		const end = text.indexOf("\n---", 4);
		if (end !== -1) {
			const fm = text.slice(4, end);
			for (const rawLine of fm.split("\n")) {
				const m = rawLine.match(/^\s*description\s*:\s*(.+?)\s*$/);
				if (m) {
					// Strip surrounding quotes if present.
					const value = m[1].replace(/^["']|["']$/g, "").trim();
					if (value) return collapseLine(value);
				}
			}
			// No description in frontmatter: summarize the body that follows it.
			body = text.slice(end + 4);
		}
	}

	for (const rawLine of body.split("\n")) {
		const line = rawLine.replace(/^#+\s*/, "").trim();
		if (line && line !== "---") {
			return collapseLine(line);
		}
	}
	return "";
}

/** Collapse internal whitespace to single spaces and truncate cleanly. */
function collapseLine(value: string): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > MANIFEST_DESC_MAX ? `${flat.slice(0, MANIFEST_DESC_MAX - 1).trimEnd()}…` : flat;
}

/**
 * Build a deterministic one-line-per-file manifest of all memory notes.
 *
 * Purely local: lists note files and reads their frontmatter / first line.
 * No LLM call, no vector search. Bounded to MANIFEST_MAX_ENTRIES entries and
 * MANIFEST_MAX_CHARS characters so it stays cheap to inject every turn.
 *
 * Returns an empty string when there are no notes, so callers can skip
 * injection entirely.
 */
function buildMemoryManifest(sigmaMemory: SigmaMemory): string {
	let files: Array<{ name: string; size: number; date: string }>;
	try {
		files = sigmaMemory.notes.list();
	} catch {
		return "";
	}
	if (files.length === 0) {
		return "";
	}

	const lines: string[] = [];
	let total = 0;
	let truncated = false;

	for (const file of files) {
		if (lines.length >= MANIFEST_MAX_ENTRIES) {
			truncated = true;
			break;
		}
		let summary = "";
		try {
			summary = summarizeNote(sigmaMemory.notes.read(file.name));
		} catch {
			// Unreadable note: still list its name so the model knows it exists.
			summary = "";
		}
		const entry = summary ? `- ${file.name}: ${summary}` : `- ${file.name}`;
		if (total + entry.length + 1 > MANIFEST_MAX_CHARS - MANIFEST_OVERFLOW_RESERVE) {
			truncated = true;
			break;
		}
		lines.push(entry);
		total += entry.length + 1;
	}

	if (lines.length === 0) {
		return "";
	}
	if (truncated || lines.length < files.length) {
		lines.push(`- … (${files.length} notes total; use memory_read/memory_search for full content)`);
	}
	return lines.join("\n");
}

/**
 * Minimum length for a query token to take part in keyword matching. Shorter
 * fragments ("a", "to", "de") appear on almost every line and only add noise.
 */
const MIN_TOKEN_LENGTH = 3;

/**
 * Significant tokens of a query, lowercased, deduplicated, punctuation-split.
 *
 * Needed because `NotesManager.search()` tests `line.includes(wholeQuery)`: any
 * multi-word query matches no note at all, so the extension unions per-token hits
 * itself (see memory_search) instead of relying on that single substring test.
 */
function queryTokens(query: string): string[] {
	const seen = new Set<string>();
	for (const token of query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
		if (token.length >= MIN_TOKEN_LENGTH) {
			seen.add(token);
		}
	}
	return [...seen];
}

/** Narrow a library search result's `data` to a note line hit. */
function isNoteLine(data: unknown): data is { file: string; line: number; content: string } {
	if (!data || typeof data !== "object") {
		return false;
	}
	const candidate = data as Record<string, unknown>;
	return (
		typeof candidate.file === "string" && typeof candidate.line === "number" && typeof candidate.content === "string"
	);
}

/** Ontology types are free-form (sigma-memory accepts any non-empty type); callers reject empty ones first. */
function toEntityType(value: string): OntologyEntity["type"] {
	return value;
}

/** Resolve an entity reference by exact ID first, then by case-insensitive name. */
function findEntityByIdOrName(sigmaMemory: SigmaMemory, ref: string): OntologyEntity | undefined {
	const byId = sigmaMemory.ontology.findEntity({ id: ref })[0];
	if (byId) return byId;
	const key = ref.toLowerCase();
	return sigmaMemory.ontology.findEntity({}).find((e) => e.name.toLowerCase() === key);
}

export default function memoryExtension(pi: ExtensionAPI) {
	// Initialize sigma-memory with embedded vector store
	// Cache the embedding model under the agent dir (honors PHI_CODING_AGENT_DIR)
	// instead of node_modules/@huggingface/transformers/.cache, which is wiped on
	// every update and unwritable for a global sudo install.
	const sigmaMemory = new SigmaMemory({ modelCacheDir: join(getAgentDir(), "cache", "models") });

	// Initialize memory + vector store (lazy model download on first search).
	// Tools that touch the vector store must await this: calling vectors.* before
	// init() finishes throws "VectorStore not initialized", which used to be
	// swallowed (search returned notes only, writes claimed to be indexed).
	const memoryReady = sigmaMemory.init().catch(() => {
		// Non-critical — memory works without vectors
	});

	/**
	 * Memory search tool - Unified search across notes, ontology, and QMD
	 */
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: "Search for content in memory using unified search (notes + ontology + vector search)",
		promptSnippet:
			"Search project memory (notes, ontology, vector search). ALWAYS call before answering questions about prior work, decisions, or project context.",
		promptGuidelines: [
			"MANDATORY: Before starting ANY task, call memory_search with relevant keywords. This is not optional.",
			"When starting work on a topic, search memory for existing notes and learnings.",
			"After completing important work or learning something new, use memory_write to save it.",
			"MANDATORY: After completing any significant work, call memory_write to save what you did and what you learned.",
			"When a command fails or produces an unexpected error, document the error and fix in memory_write (self-improvement).",
			"When the user corrects you, save the correction in memory_write so you never repeat the mistake.",
			"After a significant debugging session, write a summary of root cause and solution to memory.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query to find in memory" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { query } = params as { query: string };

			try {
				await memoryReady;
				const results = await sigmaMemory.search(query);
				type MemoryHit = (typeof results)[number];

				// The library matches the whole query as one substring, so multi-word
				// queries miss every note. Union the per-token hits instead (dedup by
				// file:line) and order them by measured token coverage — the same number
				// the output displays. Keyword recall only: semantic matching is the
				// vector store's job.
				const tokens = queryTokens(query);
				const coverageByLine = new Map<string, { matched: number; total: number }>();
				let notes: MemoryHit[] = [];
				if (tokens.length > 0) {
					const placement = results.find((r) => r.source === "notes")?.score ?? 0.8;
					const byLine = new Map<string, { file: string; line: number; content: string }>();
					for (const token of tokens) {
						for (const hit of sigmaMemory.notes.search(token)) {
							const key = `${hit.file}:${hit.line}`;
							if (!byLine.has(key)) byLine.set(key, hit);
						}
					}
					notes = [...byLine.values()]
						.map((hit) => {
							const lower = hit.content.toLowerCase();
							const matched = tokens.filter((token) => lower.includes(token)).length;
							coverageByLine.set(`${hit.file}:${hit.line}`, { matched, total: tokens.length });
							return { hit, matched };
						})
						.sort(
							(a, b) => b.matched - a.matched || a.hit.file.localeCompare(b.hit.file) || a.hit.line - b.hit.line,
						)
						.map(
							({ hit }): MemoryHit => ({
								source: "notes",
								type: "note",
								// placement, not relevance: the library pins notes at 0.8
								// between ontology entities (0.9) and relations (0.7), so we
								// reuse the score it reports rather than inventing one
								score: placement,
								data: hit,
							}),
						);
				}

				// score-descending as the library orders it; equal scores keep insertion
				// order (sort is stable), so notes stay sorted by coverage
				const ordered: MemoryHit[] =
					tokens.length === 0
						? results
						: [...notes, ...results.filter((r) => r.source !== "notes")].sort((a, b) => b.score - a.score);

				if (ordered.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `No results found for "${query}". Use memory_write to create some memory files!`,
							},
						],
						details: { found: false, query, resultCount: 0 },
					};
				}

				// Format results by source
				let resultText = `Found ${ordered.length} results for "${query}":\n\n`;

				const groupedResults = ordered.reduce(
					(groups, result) => {
						if (!groups[result.source]) groups[result.source] = [];
						groups[result.source].push(result);
						return groups;
					},
					{} as Record<string, typeof results>,
				);

				for (const [source, sourceResults] of Object.entries(groupedResults)) {
					resultText += `## ${source.toUpperCase()} (${sourceResults.length} results)\n\n`;

					for (const result of sourceResults.slice(0, 5)) {
						// Limit to 5 results per source
						if (result.source === "notes") {
							// no fake relevance: report how many query tokens this line matched
							const coverage = isNoteLine(result.data)
								? coverageByLine.get(`${result.data.file}:${result.data.line}`)
								: undefined;
							resultText += coverage
								? `**matches: ${coverage.matched}/${coverage.total} tokens** | Type: note\n`
								: `**Type: note** | no significant query token (≥ ${MIN_TOKEN_LENGTH} chars)\n`;
							if (isNoteLine(result.data)) {
								resultText += `File: ${result.data.file} (line ${result.data.line})\n`;
								resultText += `> ${result.data.content}\n\n`;
							}
						} else if (result.source === "ontology") {
							resultText += `**Score: ${result.score.toFixed(2)}** | Type: ${result.type}\n`;
							const data = result.data;
							if (result.type === "entity") {
								resultText += `Entity: ${data.name} (${data.type})\n`;
								resultText += `Properties: ${JSON.stringify(data.properties)}\n\n`;
							} else if (result.type === "relation") {
								resultText += `Relation: ${data.type} (${data.from} → ${data.to})\n`;
								resultText += `Properties: ${JSON.stringify(data.properties)}\n\n`;
							}
						} else if (result.source === "vectors") {
							// vectors carry a real cosine similarity, so its score is shown
							resultText += `**Score: ${result.score.toFixed(2)}** | Type: ${result.type}\n`;
							const data = result.data;
							// VectorStore.search() returns { file, chunkIndex, content, score }
							resultText += `File: ${data.file} (chunk ${data.chunkIndex})\n`;
							resultText += `> ${data.content}\n\n`;
						}
					}

					resultText += "---\n\n";
				}

				return {
					content: [{ type: "text", text: resultText }],
					details: { found: true, query, resultCount: ordered.length, sources: Object.keys(groupedResults) },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Memory search failed: ${error}` }],
					details: { error: String(error), found: false, query },
					isError: true,
				};
			}
		},
	});

	/**
	 * Memory write tool - Write content to memory files
	 */
	pi.registerTool({
		name: "memory_write",
		label: "Memory Write",
		description: "Write content to a memory file. If no filename provided, uses today's date.",
		parameters: Type.Object({
			content: Type.String({ description: "Content to write to the memory file" }),
			file: Type.Optional(Type.String({ description: "Optional filename (defaults to YYYY-MM-DD.md)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { content, file } = params as { content: string; file?: string };

			try {
				// Generate a unique per-fact filename when the caller did not pass
				// one, so each memory_write becomes its own file instead of
				// clobbering today's note. An explicit file name is still honored.
				const targetName = file || buildFactFilename(content);
				const finalContent = withFrontmatter(content, targetName);

				// write() returns the name actually written (with a "-N" suffix if
				// a same-name file already existed), so we never overwrite data.
				const filename = sigmaMemory.notes.write(finalContent, targetName);

				// Index in the vector store and report the actual outcome: this used to
				// fire-and-forget with .catch(() => {}), so the tool claimed "(indexed for
				// vector search)" even when the embedding step failed.
				let vectorIndexed = true;
				let vectorError: string | undefined;
				try {
					await memoryReady;
					await sigmaMemory.vectors.addDocument(filename, finalContent);
				} catch (error) {
					vectorIndexed = false;
					vectorError = error instanceof Error ? error.message : String(error);
					if (process.env.PHI_MEMORY_VERBOSE) console.warn(`[memory] vector indexing failed: ${vectorError}`);
				}

				return {
					content: [
						{
							type: "text",
							text: vectorIndexed
								? `Content written to ${filename} (indexed for vector search)`
								: `Content written to ${filename} (NOT indexed for vector search: ${vectorError})`,
						},
					],
					details: { filename, contentLength: content.length, vectorIndexed, vectorError },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Failed to write to memory: ${error}` }],
					details: { error: String(error) },
					isError: true,
				};
			}
		},
	});

	/**
	 * Memory read tool - Read memory files or list available ones
	 */
	pi.registerTool({
		name: "memory_read",
		label: "Memory Read",
		description: "Read a specific memory file or list all available memory files",
		parameters: Type.Object({
			file: Type.Optional(Type.String({ description: "Optional filename to read (omit to list all files)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { file } = params as { file?: string };

			try {
				if (!file) {
					// List all available memory files
					const files = sigmaMemory.notes.list();

					if (files.length === 0) {
						return {
							content: [{ type: "text", text: "No memory files found." }],
							details: { action: "list", fileCount: 0 },
						};
					}

					const fileList = files
						.map(
							(f) => `- ${f.name} (${(f.size / 1024).toFixed(1)} KB, ${new Date(f.date).toLocaleDateString()})`,
						)
						.join("\n");

					// Lead with the deterministic recall manifest (file + summary)
					// so a no-arg memory_read surfaces what each note contains, not
					// just file names. Falls back gracefully when empty.
					const manifest = buildMemoryManifest(sigmaMemory);
					const manifestSection = manifest ? `## Memory index (summaries)\n\n${manifest}\n\n` : "";

					return {
						content: [
							{
								type: "text",
								text: `${manifestSection}## Available memory files (${files.length})\n\n${fileList}`,
							},
						],
						details: { action: "list", fileCount: files.length },
					};
				}

				// Read specific file
				const content = sigmaMemory.notes.read(file);

				return {
					content: [{ type: "text", text: `**${file}:**\n\n${content}` }],
					details: { action: "read", found: true, filename: file, contentLength: content.length },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Failed to read memory: ${error}` }],
					details: { error: String(error), action: "read", filename: file },
					isError: true,
				};
			}
		},
	});

	/**
	 * Ontology tool - Add entities and relations to the knowledge graph
	 */
	pi.registerTool({
		name: "ontology_add",
		label: "Ontology Add",
		description:
			"Add an entity or relation to the project knowledge graph. Entities represent things (projects, files, services, people). Relations connect them.",
		promptGuidelines: [
			"When discovering project architecture (services, databases, APIs), add entities and relations to the ontology.",
			"When learning about how components connect, add relations (e.g. 'api-server' → 'uses' → 'postgres-db').",
		],
		parameters: Type.Object({
			type: Type.Union([Type.Literal("entity"), Type.Literal("relation")], {
				description: "What to add: 'entity' or 'relation'",
			}),
			// Entity fields
			entityType: Type.Optional(
				Type.String({ description: "Entity type (e.g. Project, Service, Database, File, Person, Tool)" }),
			),
			name: Type.Optional(Type.String({ description: "Entity name (e.g. 'my-api', 'postgres-db')" })),
			properties: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: "Key-value properties (e.g. {language: 'TypeScript', port: '3000'})",
				}),
			),
			// Relation fields
			from: Type.Optional(Type.String({ description: "Source entity ID" })),
			to: Type.Optional(Type.String({ description: "Target entity ID" })),
			relationType: Type.Optional(
				Type.String({ description: "Relation type (e.g. 'uses', 'depends-on', 'deployed-on', 'created-by')" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const p = params;
			try {
				if (p.type === "entity") {
					if (!p.entityType || !p.name) {
						return {
							content: [{ type: "text", text: "Entity requires 'entityType' and 'name'" }],
							details: { error: "missing-fields", type: p.type },
							isError: true,
						};
					}
					const id = sigmaMemory.ontology.addEntity({
						type: toEntityType(p.entityType),
						name: p.name,
						properties: p.properties || {},
					});
					return {
						content: [{ type: "text", text: `Entity added: **${p.name}** (${p.entityType}) — ID: \`${id}\`` }],
						details: { id, type: p.entityType, name: p.name },
					};
				} else if (p.type === "relation") {
					if (!p.from || !p.to || !p.relationType) {
						return {
							content: [{ type: "text", text: "Relation requires 'from', 'to', and 'relationType'" }],
							details: { error: "missing-fields", type: p.type },
							isError: true,
						};
					}

					// Endpoints are given by ID or by (case-insensitive) name. An unknown
					// reference (typo, entity never added) is a normal runtime case:
					// report it as a tool error instead of dereferencing undefined.
					const sourceEntity = findEntityByIdOrName(sigmaMemory, p.from);
					if (!sourceEntity) {
						return {
							content: [{ type: "text", text: `Source entity not found: ${p.from}` }],
							details: { error: "source-not-found", from: p.from },
							isError: true,
						};
					}
					const targetEntity = findEntityByIdOrName(sigmaMemory, p.to);
					if (!targetEntity) {
						return {
							content: [{ type: "text", text: `Target entity not found: ${p.to}` }],
							details: { error: "target-not-found", to: p.to },
							isError: true,
						};
					}

					const id = sigmaMemory.ontology.addRelation({
						from: sourceEntity.id,
						to: targetEntity.id,
						type: p.relationType,
						properties: p.properties || {},
					});
					return {
						content: [
							{
								type: "text",
								text: `Relation added: \`${sourceEntity.name}\` → **${p.relationType}** → \`${targetEntity.name}\` — ID: \`${id}\``,
							},
						],
						details: { id, from: sourceEntity.id, to: targetEntity.id, type: p.relationType },
					};
				}
				return {
					content: [{ type: "text", text: "Type must be 'entity' or 'relation'" }],
					details: { error: "invalid-type" },
					isError: true,
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Ontology error: ${error}` }],
					details: { error: String(error) },
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "ontology_batch_add",
		label: "Ontology Batch Add",
		description:
			"Add multiple entities and relations to the project knowledge graph in a single call. Relations can reference entities by name (existing or from this batch). Prefer this over repeated ontology_add calls.",
		promptGuidelines: [
			"When mapping a project architecture, add ALL entities and relations in one ontology_batch_add call instead of many ontology_add calls.",
		],
		parameters: Type.Object({
			entities: Type.Array(
				Type.Object({
					entityType: Type.String({ description: "Entity type (e.g. Project, Service, Library, Module)" }),
					name: Type.String({ description: "Entity name" }),
					properties: Type.Optional(Type.Record(Type.String(), Type.String())),
				}),
			),
			relations: Type.Optional(
				Type.Array(
					Type.Object({
						fromName: Type.String({ description: "Source entity name (existing or from this batch)" }),
						toName: Type.String({ description: "Target entity name (existing or from this batch)" }),
						relationType: Type.String({ description: "Relation type (e.g. 'uses', 'depends_on')" }),
					}),
				),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// params are validated against this tool's TypeBox schema before execute(),
			// but an empty string still passes Type.String(): empty names/types are
			// skipped and reported below instead of being persisted.
			const p = params;
			try {
				// Deliberately NOT ontology.addBatch(): addBatch always creates new
				// entities (duplicates on re-run) and throws on the first unresolved
				// relation endpoint, whereas this tool reuses existing entities,
				// skips duplicate relations and reports unresolved ones. Trade-off:
				// the batch is written entry by entry (not one atomic append).
				// Names are resolved against one index (built once, updated as
				// entities are added) so a relation can reference an entity created
				// earlier in the same batch.
				const byName = new Map<string, string>();
				for (const e of sigmaMemory.ontology.findEntity({})) byName.set(e.name.toLowerCase(), e.id);

				const entityIds: string[] = [];
				const relationIds: string[] = [];
				const reusedEntities: string[] = [];
				const reusedRelations: string[] = [];
				const unresolved: string[] = [];
				const errors: string[] = [];

				const resolveName = (name: string): string | undefined => {
					const key = name.toLowerCase();
					const direct = byName.get(key);
					if (direct) return direct;
					// fall back to the library's substring search for near-exact names
					const partial = sigmaMemory.ontology.findEntity({ name }).find((e) => e.name.toLowerCase() === key);
					if (partial) byName.set(key, partial.id);
					return partial?.id;
				};

				for (const e of p.entities || []) {
					if (!e?.name) continue;
					const existing = resolveName(e.name);
					if (existing) {
						reusedEntities.push(e.name);
						continue;
					}
					if (!e.entityType) {
						errors.push(`entity "${e.name}": 'entityType' is required`);
						continue;
					}
					const id = sigmaMemory.ontology.addEntity({
						type: toEntityType(e.entityType),
						name: e.name,
						properties: e.properties || {},
					});
					byName.set(e.name.toLowerCase(), id);
					entityIds.push(id);
				}

				for (const r of p.relations || []) {
					if (!r.relationType) {
						errors.push(`${r.fromName} -[?]-> ${r.toName}: 'relationType' is required`);
						continue;
					}
					const from = resolveName(r.fromName);
					const to = resolveName(r.toName);
					if (!from || !to) {
						unresolved.push(`${r.fromName} -[${r.relationType}]-> ${r.toName}`);
						continue;
					}
					try {
						// the triple (from, to, type) is the natural key: re-running a
						// batch must not duplicate the graph
						const duplicate = sigmaMemory.ontology
							.findRelations(from)
							.some((rel) => rel.from === from && rel.to === to && rel.type === r.relationType);
						if (duplicate) {
							reusedRelations.push(`${r.fromName} -[${r.relationType}]-> ${r.toName}`);
							continue;
						}
						relationIds.push(
							sigmaMemory.ontology.addRelation({
								from,
								to,
								type: r.relationType,
								properties: {},
							}),
						);
					} catch (error) {
						errors.push(`${r.fromName} -[${r.relationType}]-> ${r.toName}: ${error}`);
					}
				}

				let text = `Batch added: ${entityIds.length} entities, ${relationIds.length} relations.`;
				if (reusedEntities.length > 0) text += ` Reused ${reusedEntities.length} existing entities.`;
				if (reusedRelations.length > 0) text += ` Reused ${reusedRelations.length} existing relations.`;
				if (unresolved.length > 0) text += `\nUnresolved endpoints (relation skipped): ${unresolved.join("; ")}`;
				if (errors.length > 0) text += `\nRelation errors: ${errors.join("; ")}`;

				return {
					content: [{ type: "text", text }],
					details: { entityIds, relationIds, reusedEntities, reusedRelations, unresolved, errors },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Ontology batch error: ${error}` }],
					details: { error: String(error) },
					isError: true,
				};
			}
		},
	});

	/**
	 * Ontology query tool - Query the knowledge graph
	 */
	pi.registerTool({
		name: "ontology_query",
		label: "Ontology Query",
		description:
			"Query the project knowledge graph. Find entities by type/name, get relations, find paths between entities, or get stats.",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("find"),
					Type.Literal("relations"),
					Type.Literal("path"),
					Type.Literal("stats"),
					Type.Literal("graph"),
				],
				{
					description:
						"Query action: find (entities), relations (of entity), path (between entities), stats, graph (full export)",
				},
			),
			entityType: Type.Optional(Type.String({ description: "Filter by entity type (for 'find' action)" })),
			name: Type.Optional(Type.String({ description: "Filter by name (partial match, for 'find' action)" })),
			entityId: Type.Optional(Type.String({ description: "Entity ID (for 'relations' action)" })),
			fromId: Type.Optional(Type.String({ description: "Source entity ID (for 'path' action)" })),
			toId: Type.Optional(Type.String({ description: "Target entity ID (for 'path' action)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const p = params;
			const details = { action: p.action };
			try {
				switch (p.action) {
					case "find": {
						const results = sigmaMemory.ontology.findEntity({ type: p.entityType, name: p.name });
						if (results.length === 0) return { content: [{ type: "text", text: "No entities found." }], details };
						const text = results
							.map((e) => `- **${e.name}** (${e.type}) ID:\`${e.id}\` ${JSON.stringify(e.properties)}`)
							.join("\n");
						return { content: [{ type: "text", text: `Found ${results.length} entities:\n${text}` }], details };
					}
					case "relations": {
						if (!p.entityId)
							return { content: [{ type: "text", text: "'entityId' required" }], details, isError: true };
						const rels = sigmaMemory.ontology.findRelations(p.entityId);
						if (rels.length === 0) return { content: [{ type: "text", text: "No relations found." }], details };
						const text = rels.map((r) => `- \`${r.from}\` → **${r.type}** → \`${r.to}\``).join("\n");
						return { content: [{ type: "text", text: `Found ${rels.length} relations:\n${text}` }], details };
					}
					case "path": {
						if (!p.fromId || !p.toId)
							return {
								content: [{ type: "text", text: "'fromId' and 'toId' required" }],
								details,
								isError: true,
							};
						const path = sigmaMemory.ontology.queryPath(p.fromId, p.toId);
						if (!path)
							return { content: [{ type: "text", text: "No path found between these entities." }], details };
						// each step carries the relation that *leads to* its entity, so the
						// label belongs between the previous entity and this one
						const text = path
							.map((s, i) =>
								i === 0 || !s.relation ? s.entity.name : `[${s.relation.type}] → ${s.entity.name}`,
							)
							.join(" → ");
						return { content: [{ type: "text", text: `Path: ${text}` }], details };
					}
					case "stats": {
						const stats = sigmaMemory.ontology.stats();
						const graph = sigmaMemory.ontology.getGraph();
						let text = `**Ontology Stats:**\n- Entities: ${graph.entities.length}\n- Relations: ${graph.relations.length}\n`;
						text += `\nBy type:\n`;
						for (const [type, count] of Object.entries(stats.entitiesByType)) text += `  - ${type}: ${count}\n`;
						return { content: [{ type: "text", text }], details };
					}
					case "graph": {
						const graph = sigmaMemory.ontology.export();
						return { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }], details };
					}
					default:
						return {
							content: [{ type: "text", text: "Action must be: find, relations, path, stats, graph" }],
							details,
							isError: true,
						};
				}
			} catch (error) {
				return { content: [{ type: "text", text: `Ontology query error: ${error}` }], details, isError: true };
			}
		},
	});

	/**
	 * Memory status tool - Get status of all memory subsystems
	 */
	pi.registerTool({
		name: "memory_status",
		label: "Memory Status",
		description: "Get status of all memory subsystems (notes, ontology, vector search)",
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			try {
				await memoryReady;
				const status = await sigmaMemory.status();

				let statusText = "# Memory Status\n\n";

				// Notes status
				statusText += `## Notes\n`;
				statusText += `- Files: ${status.notes.count}\n`;
				statusText += `- Total size: ${(status.notes.totalSize / 1024).toFixed(1)} KB\n`;
				statusText += `- Last modified: ${status.notes.lastModified ? new Date(status.notes.lastModified).toLocaleString() : "Never"}\n\n`;

				// Ontology status
				statusText += `## Ontology\n`;
				statusText += `- Entities: ${status.ontology.entities}\n`;
				statusText += `- Relations: ${status.ontology.relations}\n`;
				statusText += `- Entities by type: ${JSON.stringify(status.ontology.entitiesByType)}\n`;
				statusText += `- Relations by type: ${JSON.stringify(status.ontology.relationsByType)}\n\n`;

				// Vector store status
				statusText += `## Vector Search (embedded)\n`;
				statusText += `- Documents: ${status.vectors.documentCount}\n`;
				statusText += `- Chunks: ${status.vectors.chunkCount}\n`;
				statusText += `- Last update: ${status.vectors.lastUpdate || "Never"}\n`;

				return {
					content: [{ type: "text", text: statusText }],
					details: { status },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `Failed to get memory status: ${error}` }],
					details: { error: String(error) },
					isError: true,
				};
			}
		},
	});

	/**
	 * Per-turn reminder injection (Combo strategy D).
	 *
	 * Pi LLMs (Claude, Kimi, GLM, MiniMax) consistently ignore "MANDATORY"
	 * guidelines buried in long system prompts. To enforce the
	 * memory_search/memory_write rules, we prepend a fresh <system-reminder>
	 * block to the system prompt at EVERY turn. This pattern is what Claude
	 * Code and Cursor use successfully in production for high-priority rules.
	 *
	 * The reminder is short and concrete (includes the user's current prompt
	 * truncated) so it grabs the LLM's attention even mid-conversation when
	 * the original critical_rule has receded due to context pressure.
	 */
	pi.on("before_agent_start", async (event, _ctx) => {
		// Skip during /plan orchestration: the orchestrator manages its own
		// systemPrompt per phase via the same hook. Conflicting overrides would
		// override the orchestrator's agent personas.
		if ((globalThis as { __phiOrchestrationActive?: unknown }).__phiOrchestrationActive) {
			return {};
		}
		const userPrompt = (event.prompt ?? "").trim();
		if (userPrompt.length === 0) {
			return {};
		}
		// The reminder must stay byte-identical across turns: it is prepended to the
		// system prompt, so any per-turn text (such as echoing the user's message, which
		// the model already sees) would invalidate the provider's prompt cache on every
		// message. Only the manifest changes, and only when notes are written.

		// Deterministic recall index: a one-line-per-file manifest of memory
		// notes so the model ALWAYS sees which facts exist without having to
		// guess and call memory_search blindly. Built locally (no LLM).
		const manifest = buildMemoryManifest(sigmaMemory);
		const manifestBlock = manifest
			? `\nMEMORY INDEX (existing saved notes, read with \`memory_read <file>\`):\n${manifest}\n`
			: "";

		const reminder = `<system-reminder>
Before responding to each user message, apply the memory rules below.
${manifestBlock}
REMINDER (project rule, applies every turn):
1. Call \`memory_search\` FIRST with keywords from the user's intent. Recent
   project context, prior decisions, and saved learnings are accessible
   ONLY via this tool.
2. AFTER completing significant work, call \`memory_write\` to save what
   you did and learned. Save only NON-OBVIOUS, cross-session facts and user
   preferences; do NOT save what the repo or git history already records.
3. Saved notes describe a PAST state. Before you act on a recalled fact,
   verify it against the CURRENT code (read/grep that the path or symbol still
   exists). If it conflicts, the live observation wins. Do not delete a stale
   note; note the divergence.

The memory_search and memory_write calls are not optional. Skipping them
violates project rules.
</system-reminder>

`;
		return { systemPrompt: reminder + event.systemPrompt };
	});

	/**
	 * Report AGENTS.md files on session start (nothing is loaded here)
	 * Checks both project directory and ~/.phi/memory/
	 */
	pi.on("session_start", async (_event, ctx) => {
		try {
			// This handler only REPORTS the file: <cwd>/AGENTS.md is injected into
			// the system prompt by the core context loader (unless context files are
			// disabled); the two other locations are not injected by anyone, the
			// model has to open them with the read tool.
			const locations = [
				{ path: join(ctx.cwd, "AGENTS.md"), injectedByCore: true },
				{ path: join(ctx.cwd, ".phi", "AGENTS.md"), injectedByCore: false },
				{ path: join(sigmaMemory.getConfig().memoryDir, "AGENTS.md"), injectedByCore: false },
			];

			for (const { path: agentsPath, injectedByCore } of locations) {
				try {
					await access(agentsPath);
					const content = readFileSync(agentsPath, "utf-8");
					if (content.trim()) {
						const lineCount = content.split("\n").length;
						const note = injectedByCore ? "" : " (not loaded into the prompt automatically; use the read tool)";
						ctx.ui.notify(`📝 Found AGENTS.md (${lineCount} lines) at ${agentsPath}${note}`, "info");
						break;
					}
				} catch {
					// File doesn't exist at this location, try next
				}
			}

			// Show memory status
			const status = await sigmaMemory.status();
			const parts: string[] = [];
			if (status.notes.count > 0) parts.push(`${status.notes.count} notes`);
			if (status.ontology.entities > 0) parts.push(`${status.ontology.entities} entities`);
			if (status.vectors.chunkCount > 0) parts.push(`${status.vectors.chunkCount} vectors`);
			if (parts.length > 0) {
				ctx.ui.notify(`🧠 Memory: ${parts.join(", ")}`, "info");
			}
		} catch (_error) {
			// Non-critical, don't spam errors
		}
	});
}
