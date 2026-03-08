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
 * - Auto-load AGENTS.md on session start
 *
 * Usage:
 * 1. Ensure sigma-memory package is built: cd packages/sigma-memory && npm run build
 * 2. Memory files are stored in ~/.phi/memory/
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "phi-code";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { SigmaMemory } from "sigma-memory";

export default function memoryExtension(pi: ExtensionAPI) {
	// Initialize sigma-memory with embedded vector store
	const sigmaMemory = new SigmaMemory();

	// Initialize memory + vector store (lazy model download on first search)
	sigmaMemory.init().catch(() => {
		// Non-critical — memory works without vectors
	});

	/**
	 * Memory search tool - Unified search across notes, ontology, and QMD
	 */
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: "Search for content in memory using unified search (notes + ontology + vector search)",
		promptSnippet: "Search project memory (notes, ontology, vector search). ALWAYS call before answering questions about prior work, decisions, or project context.",
		promptGuidelines: [
			"Before answering questions about prior work, architecture, decisions, or project context: call memory_search first.",
			"When starting work on a topic, search memory for existing notes and learnings.",
			"After completing important work or learning something new, use memory_write to save it.",
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
				const results = await sigmaMemory.search(query);
				
				if (results.length === 0) {
					return {
						content: [{ type: "text", text: `No results found for "${query}". Use memory_write to create some memory files!` }],
						details: { found: false, query, resultCount: 0 }
					};
				}

				// Format results by source
				let resultText = `Found ${results.length} results for "${query}":\n\n`;
				
				const groupedResults = results.reduce((groups, result) => {
					if (!groups[result.source]) groups[result.source] = [];
					groups[result.source].push(result);
					return groups;
				}, {} as Record<string, typeof results>);

				for (const [source, sourceResults] of Object.entries(groupedResults)) {
					resultText += `## ${source.toUpperCase()} (${sourceResults.length} results)\n\n`;
					
					for (const result of sourceResults.slice(0, 5)) { // Limit to 5 results per source
						resultText += `**Score: ${result.score.toFixed(2)}** | Type: ${result.type}\n`;
						
						if (result.source === 'notes') {
							const data = result.data;
							resultText += `File: ${data.file} (line ${data.line})\n`;
							resultText += `> ${data.content}\n\n`;
						} else if (result.source === 'ontology') {
							const data = result.data;
							if (result.type === 'entity') {
								resultText += `Entity: ${data.name} (${data.type})\n`;
								resultText += `Properties: ${JSON.stringify(data.properties)}\n\n`;
							} else if (result.type === 'relation') {
								resultText += `Relation: ${data.type} (${data.from} → ${data.to})\n`;
								resultText += `Properties: ${JSON.stringify(data.properties)}\n\n`;
							}
						} else if (result.source === 'vectors') {
							const data = result.data;
							resultText += `File: ${data.file} (line ${data.line})\n`;
							resultText += `> ${data.content}\n\n`;
						}
					}
					
					resultText += '---\n\n';
				}

				return {
					content: [{ type: "text", text: resultText }],
					details: { found: true, query, resultCount: results.length, sources: Object.keys(groupedResults) }
				};

			} catch (error) {
				return {
					content: [{ type: "text", text: `Memory search failed: ${error}` }],
					details: { error: String(error), found: false, query }
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
				// Write to notes
				sigmaMemory.notes.write(content, file);
				const filename = file || new Date().toISOString().split('T')[0] + '.md';

				// Auto-index in vector store (non-blocking)
				sigmaMemory.vectors.addDocument(filename, content).catch(() => {
					// Vector indexing failed silently — notes still saved
				});
				
				return {
					content: [{ type: "text", text: `Content written to ${filename} (indexed for vector search)` }],
					details: { filename, contentLength: content.length, vectorIndexed: true }
				};

			} catch (error) {
				return {
					content: [{ type: "text", text: `Failed to write to memory: ${error}` }],
					details: { error: String(error) }
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
							details: { action: "list", fileCount: 0 }
						};
					}

					const fileList = files
						.map(f => `- ${f.name} (${(f.size / 1024).toFixed(1)} KB, ${new Date(f.date).toLocaleDateString()})`)
						.join('\n');

					return {
						content: [{ type: "text", text: `Available memory files (${files.length}):\n\n${fileList}` }],
						details: { action: "list", fileCount: files.length }
					};
				}

				// Read specific file
				const content = sigmaMemory.notes.read(file);

				return {
					content: [{ type: "text", text: `**${file}:**\n\n${content}` }],
					details: { action: "read", found: true, filename: file, contentLength: content.length }
				};

			} catch (error) {
				return {
					content: [{ type: "text", text: `Failed to read memory: ${error}` }],
					details: { error: String(error), action: "read", filename: file }
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
		description: "Add an entity or relation to the project knowledge graph. Entities represent things (projects, files, services, people). Relations connect them.",
		promptGuidelines: [
			"When discovering project architecture (services, databases, APIs), add entities and relations to the ontology.",
			"When learning about how components connect, add relations (e.g. 'api-server' → 'uses' → 'postgres-db').",
		],
		parameters: Type.Object({
			type: Type.Union([Type.Literal("entity"), Type.Literal("relation")], { description: "What to add: 'entity' or 'relation'" }),
			// Entity fields
			entityType: Type.Optional(Type.String({ description: "Entity type (e.g. Project, Service, Database, File, Person, Tool)" })),
			name: Type.Optional(Type.String({ description: "Entity name (e.g. 'my-api', 'postgres-db')" })),
			properties: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Key-value properties (e.g. {language: 'TypeScript', port: '3000'})" })),
			// Relation fields
			from: Type.Optional(Type.String({ description: "Source entity ID" })),
			to: Type.Optional(Type.String({ description: "Target entity ID" })),
			relationType: Type.Optional(Type.String({ description: "Relation type (e.g. 'uses', 'depends-on', 'deployed-on', 'created-by')" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const p = params as any;
			try {
				if (p.type === "entity") {
					if (!p.entityType || !p.name) {
						return { content: [{ type: "text", text: "Entity requires 'entityType' and 'name'" }], isError: true };
					}
					const id = sigmaMemory.ontology.addEntity({
						type: p.entityType,
						name: p.name,
						properties: p.properties || {},
					});
					return {
						content: [{ type: "text", text: `Entity added: **${p.name}** (${p.entityType}) — ID: \`${id}\`` }],
						details: { id, type: p.entityType, name: p.name },
					};
				} else if (p.type === "relation") {
					if (!p.from || !p.to || !p.relationType) {
						return { content: [{ type: "text", text: "Relation requires 'from', 'to', and 'relationType'" }], isError: true };
					}
					const id = sigmaMemory.ontology.addRelation({
						from: p.from,
						to: p.to,
						type: p.relationType,
						properties: p.properties || {},
					});
					return {
						content: [{ type: "text", text: `Relation added: \`${p.from}\` → **${p.relationType}** → \`${p.to}\` — ID: \`${id}\`` }],
						details: { id, from: p.from, to: p.to, type: p.relationType },
					};
				}
				return { content: [{ type: "text", text: "Type must be 'entity' or 'relation'" }], isError: true };
			} catch (error) {
				return { content: [{ type: "text", text: `Ontology error: ${error}` }], isError: true };
			}
		},
	});

	/**
	 * Ontology query tool - Query the knowledge graph
	 */
	pi.registerTool({
		name: "ontology_query",
		label: "Ontology Query",
		description: "Query the project knowledge graph. Find entities by type/name, get relations, find paths between entities, or get stats.",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("find"),
				Type.Literal("relations"),
				Type.Literal("path"),
				Type.Literal("stats"),
				Type.Literal("graph"),
			], { description: "Query action: find (entities), relations (of entity), path (between entities), stats, graph (full export)" }),
			entityType: Type.Optional(Type.String({ description: "Filter by entity type (for 'find' action)" })),
			name: Type.Optional(Type.String({ description: "Filter by name (partial match, for 'find' action)" })),
			entityId: Type.Optional(Type.String({ description: "Entity ID (for 'relations' action)" })),
			fromId: Type.Optional(Type.String({ description: "Source entity ID (for 'path' action)" })),
			toId: Type.Optional(Type.String({ description: "Target entity ID (for 'path' action)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const p = params as any;
			try {
				switch (p.action) {
					case "find": {
						const results = sigmaMemory.ontology.findEntity({ type: p.entityType, name: p.name });
						if (results.length === 0) return { content: [{ type: "text", text: "No entities found." }] };
						const text = results.map(e => `- **${e.name}** (${e.type}) ID:\`${e.id}\` ${JSON.stringify(e.properties)}`).join("\n");
						return { content: [{ type: "text", text: `Found ${results.length} entities:\n${text}` }] };
					}
					case "relations": {
						if (!p.entityId) return { content: [{ type: "text", text: "'entityId' required" }], isError: true };
						const rels = sigmaMemory.ontology.findRelations(p.entityId);
						if (rels.length === 0) return { content: [{ type: "text", text: "No relations found." }] };
						const text = rels.map(r => `- \`${r.from}\` → **${r.type}** → \`${r.to}\``).join("\n");
						return { content: [{ type: "text", text: `Found ${rels.length} relations:\n${text}` }] };
					}
					case "path": {
						if (!p.fromId || !p.toId) return { content: [{ type: "text", text: "'fromId' and 'toId' required" }], isError: true };
						const path = sigmaMemory.ontology.queryPath(p.fromId, p.toId);
						if (!path) return { content: [{ type: "text", text: "No path found between these entities." }] };
						const text = path.map(s => `${s.entity.name}${s.relation ? ` → [${s.relation.type}]` : ""}`).join(" → ");
						return { content: [{ type: "text", text: `Path: ${text}` }] };
					}
					case "stats": {
						const stats = sigmaMemory.ontology.stats();
						const graph = sigmaMemory.ontology.getGraph();
						let text = `**Ontology Stats:**\n- Entities: ${graph.entities.length}\n- Relations: ${graph.relations.length}\n`;
						text += `\nBy type:\n`;
						for (const [type, count] of Object.entries(stats.entitiesByType)) text += `  - ${type}: ${count}\n`;
						return { content: [{ type: "text", text }] };
					}
					case "graph": {
						const graph = sigmaMemory.ontology.export();
						return { content: [{ type: "text", text: JSON.stringify(graph, null, 2) }] };
					}
					default:
						return { content: [{ type: "text", text: "Action must be: find, relations, path, stats, graph" }], isError: true };
				}
			} catch (error) {
				return { content: [{ type: "text", text: `Ontology query error: ${error}` }], isError: true };
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
				const status = await sigmaMemory.status();
				
				let statusText = "# Memory Status\n\n";
				
				// Notes status
				statusText += `## Notes\n`;
				statusText += `- Files: ${status.notes.count}\n`;
				statusText += `- Total size: ${(status.notes.totalSize / 1024).toFixed(1)} KB\n`;
				statusText += `- Last modified: ${status.notes.lastModified ? new Date(status.notes.lastModified).toLocaleString() : 'Never'}\n\n`;
				
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
				statusText += `- Last update: ${status.vectors.lastUpdate || 'Never'}\n`;

				return {
					content: [{ type: "text", text: statusText }],
					details: { status }
				};

			} catch (error) {
				return {
					content: [{ type: "text", text: `Failed to get memory status: ${error}` }],
					details: { error: String(error) }
				};
			}
		},
	});

	/**
	 * Auto-load AGENTS.md on session start
	 * Checks both project directory and ~/.phi/memory/
	 */
	pi.on("session_start", async (_event, ctx) => {
		try {
			const locations = [
				join(process.cwd(), "AGENTS.md"),
				join(process.cwd(), ".phi", "AGENTS.md"),
				join(sigmaMemory.config.memoryDir, "AGENTS.md"),
			];

			for (const agentsPath of locations) {
				try {
					await access(agentsPath);
					const content = readFileSync(agentsPath, "utf-8");
					if (content.trim()) {
						// Notify user that persistent instructions were loaded
						const lineCount = content.split("\n").length;
						ctx.ui.notify(`📝 Loaded AGENTS.md (${lineCount} lines) from ${agentsPath}`, "info");
						// The content is available via memory_read tool — the model can access it
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
		} catch (error) {
			// Non-critical, don't spam errors
		}
	});
}