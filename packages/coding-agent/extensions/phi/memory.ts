/**
 * Memory Extension - Persistent memory management for Phi Code
 *
 * Provides persistent memory capabilities through markdown files stored in 
 * ~/.phi/memory/ and .phi/memory/ directories. Automatically loads AGENTS.md 
 * on session start if available.
 *
 * Features:
 * - memory_search: Semantic (full-text) search in memory files
 * - memory_write: Write content to memory files
 * - memory_read: Read specific memory files or list available ones
 * - Auto-load AGENTS.md on session start
 *
 * Usage:
 * 1. Copy to packages/coding-agent/extensions/phi/memory.ts
 * 2. Memory files are automatically created in ~/.phi/memory/
 */

import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "phi-code";
import { readdir, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export default function memoryExtension(pi: ExtensionAPI) {
	// Memory directory paths
	const globalMemoryDir = join(homedir(), ".phi", "memory");
	const localMemoryDir = join(process.cwd(), ".phi", "memory");

	/**
	 * Ensure memory directories exist
	 */
	async function ensureMemoryDirectories() {
		try {
			await mkdir(globalMemoryDir, { recursive: true });
			await mkdir(localMemoryDir, { recursive: true });
		} catch (error) {
			console.warn("Failed to create memory directories:", error);
		}
	}

	/**
	 * Get all memory directories that exist
	 */
	async function getMemoryDirectories(): Promise<string[]> {
		const dirs: string[] = [];
		
		try {
			await access(globalMemoryDir);
			dirs.push(globalMemoryDir);
		} catch {}

		try {
			await access(localMemoryDir);
			dirs.push(localMemoryDir);
		} catch {}

		return dirs;
	}

	/**
	 * Get all .md files from memory directories
	 */
	async function getMemoryFiles(): Promise<string[]> {
		const dirs = await getMemoryDirectories();
		const files: string[] = [];

		for (const dir of dirs) {
			try {
				const dirFiles = await readdir(dir);
				const mdFiles = dirFiles
					.filter(file => file.endsWith(".md"))
					.map(file => join(dir, file));
				files.push(...mdFiles);
			} catch (error) {
				console.warn(`Failed to read directory ${dir}:`, error);
			}
		}

		return files;
	}

	/**
	 * Generate today's filename
	 */
	function getTodayFilename(): string {
		const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
		return `${today}.md`;
	}

	/**
	 * Memory search tool - Full-text search in memory files
	 */
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description: "Search for content in memory files using full-text search",
		parameters: Type.Object({
			query: Type.String({ description: "Search query to find in memory files" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { query } = params as { query: string };
			
			try {
				const memoryFiles = await getMemoryFiles();
				
				if (memoryFiles.length === 0) {
					return {
						content: [{ type: "text", text: "No memory files found. Use memory_write to create some!" }],
						details: { found: false, filesSearched: 0 }
					};
				}

				const results: Array<{ file: string; matches: string[] }> = [];

				// Simple grep-like search in each file
				for (const filePath of memoryFiles) {
					try {
						const content = await readFile(filePath, 'utf-8');
						const lines = content.split('\n');
						const matches: string[] = [];

						lines.forEach((line, index) => {
							if (line.toLowerCase().includes(query.toLowerCase())) {
								// Include context (line before and after if available)
								const contextLines: string[] = [];
								if (index > 0) contextLines.push(`${index}: ${lines[index - 1]}`);
								contextLines.push(`${index + 1}: **${line}**`);
								if (index < lines.length - 1) contextLines.push(`${index + 2}: ${lines[index + 1]}`);
								
								matches.push(contextLines.join('\n'));
							}
						});

						if (matches.length > 0) {
							results.push({ file: filePath, matches });
						}
					} catch (error) {
						console.warn(`Failed to search in file ${filePath}:`, error);
					}
				}

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: `No matches found for "${query}" in ${memoryFiles.length} memory files.` }],
						details: { found: false, filesSearched: memoryFiles.length, query }
					};
				}

				// Format results
				let resultText = `Found ${results.length} files with matches for "${query}":\n\n`;
				
				for (const result of results) {
					const fileName = result.file.split('/').pop() || result.file;
					resultText += `**${fileName}:**\n`;
					result.matches.forEach((match, index) => {
						resultText += `\nMatch ${index + 1}:\n${match}\n`;
					});
					resultText += '\n---\n\n';
				}

				return {
					content: [{ type: "text", text: resultText }],
					details: { found: true, matchCount: results.length, filesSearched: memoryFiles.length, query }
				};

			} catch (error) {
				return {
					content: [{ type: "text", text: `Memory search failed: ${error}` }],
					details: { error: String(error), found: false }
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
				await ensureMemoryDirectories();

				// Use provided filename or default to today's date
				const filename = file || getTodayFilename();
				const filePath = join(globalMemoryDir, filename);

				// Add timestamp to content
				const timestamp = new Date().toISOString();
				const timestampedContent = `<!-- Written at ${timestamp} -->\n\n${content}\n`;

				// Check if file exists and append, otherwise create new
				let finalContent = timestampedContent;
				try {
					const existingContent = await readFile(filePath, 'utf-8');
					finalContent = existingContent + '\n\n' + timestampedContent;
				} catch {
					// File doesn't exist, use timestamped content as-is
				}

				await writeFile(filePath, finalContent, 'utf-8');

				return {
					content: [{ type: "text", text: `Content written to ${filename}` }],
					details: { filePath, filename, contentLength: content.length }
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
					const memoryFiles = await getMemoryFiles();
					
					if (memoryFiles.length === 0) {
						return {
							content: [{ type: "text", text: "No memory files found." }],
							details: { action: "list", fileCount: 0 }
						};
					}

					const fileList = memoryFiles
						.map(filePath => {
							const fileName = filePath.split('/').pop() || filePath;
							const dir = filePath.includes('.phi/memory') ? 'local' : 'global';
							return `- ${fileName} (${dir})`;
						})
						.join('\n');

					return {
						content: [{ type: "text", text: `Available memory files (${memoryFiles.length}):\n\n${fileList}` }],
						details: { action: "list", fileCount: memoryFiles.length }
					};
				}

				// Read specific file
				const dirs = await getMemoryDirectories();
				let filePath: string | null = null;

				// Try to find file in any memory directory
				for (const dir of dirs) {
					const candidatePath = join(dir, file);
					try {
						await access(candidatePath);
						filePath = candidatePath;
						break;
					} catch {}
				}

				if (!filePath) {
					return {
						content: [{ type: "text", text: `Memory file "${file}" not found in any memory directory.` }],
						details: { action: "read", found: false, filename: file }
					};
				}

				const content = await readFile(filePath, 'utf-8');

				return {
					content: [{ type: "text", text: `**${file}:**\n\n${content}` }],
					details: { action: "read", found: true, filename: file, contentLength: content.length }
				};

			} catch (error) {
				return {
					content: [{ type: "text", text: `Failed to read memory: ${error}` }],
					details: { error: String(error), action: "read" }
				};
			}
		},
	});

	/**
	 * Auto-load AGENTS.md on session start
	 */
	pi.on("session_start", async (_event, ctx) => {
		try {
			await ensureMemoryDirectories();

			// Try to find AGENTS.md in current directory
			const agentsPath = join(process.cwd(), "AGENTS.md");
			
			try {
				await access(agentsPath);
				const agentsContent = await readFile(agentsPath, 'utf-8');
				
				// Send the content as a system message to provide context
				ctx.ui.notify("Loaded AGENTS.md context for this session", "info");
				
				// Optionally inject into the session context
				await pi.sendHookMessage({
					role: "system",
					content: `Session context loaded from AGENTS.md:\n\n${agentsContent}`,
				}, { source: "extension" });

			} catch {
				// AGENTS.md doesn't exist, that's fine
			}

		} catch (error) {
			console.warn("Failed to initialize memory extension:", error);
		}
	});
}