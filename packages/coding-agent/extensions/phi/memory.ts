/**
 * Memory Extension - Persistent memory management for Phi Code
 *
 * Now powered by sigma-memory package which provides:
 * - NotesManager: Markdown files management
 * - OntologyManager: Knowledge graph with entities and relations  
 * - QMDManager: Vector search (if QMD is available)
 *
 * Features:
 * - memory_search: Unified search across notes, ontology, and QMD
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
	// Initialize sigma-memory
	const sigmaMemory = new SigmaMemory({
		// Configuration par défaut, peut être surchargée
		qmdEnabled: true,
		qmdCommand: 'qmd'
	});

	// Initialize memory directories
	sigmaMemory.init().catch(error => {
		console.warn("Failed to initialize sigma-memory:", error);
	});

	/**
	 * Memory search tool - Unified search across notes, ontology, and QMD
	 */
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: "Search for content in memory using unified search (notes + ontology + QMD vector search)",
		promptSnippet: "Search project memory (notes, ontology, vector search). ALWAYS call before answering questions about prior work, decisions, or project context.",
		promptGuidelines: [
			"Before answering questions about prior work, architecture, decisions, or project context: call memory_search first.",
			"When starting work on a topic, search memory for existing notes and learnings.",
			"After completing important work or learning something new, use memory_write to save it.",
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
					
					for (const result of sourceResults.slice(0, 5)) { // Limite à 5 résultats par source
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
						} else if (result.source === 'qmd') {
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
				// Use notes manager to write
				sigmaMemory.notes.write(content, file);

				const filename = file || new Date().toISOString().split('T')[0] + '.md';
				
				return {
					content: [{ type: "text", text: `Content written to ${filename}` }],
					details: { filename, contentLength: content.length }
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
	 * Memory status tool - Get status of all memory subsystems
	 */
	pi.registerTool({
		name: "memory_status",
		label: "Memory Status",
		description: "Get status of all memory subsystems (notes, ontology, QMD)",
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
				
				// QMD status
				statusText += `## QMD Vector Search\n`;
				statusText += `- Available: ${status.qmd.available ? 'Yes' : 'No'}\n`;
				if (status.qmd.available && status.qmd.status) {
					statusText += `- Files indexed: ${status.qmd.status.files}\n`;
					statusText += `- Chunks: ${status.qmd.status.chunks}\n`;
					statusText += `- Last update: ${status.qmd.status.lastUpdate || 'Never'}\n`;
				}

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
			if (status.qmd.available) parts.push("QMD active");
			if (parts.length > 0) {
				ctx.ui.notify(`🧠 Memory: ${parts.join(", ")}`, "info");
			}
		} catch (error) {
			// Non-critical, don't spam errors
		}
	});
}