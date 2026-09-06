/**
 * LSP Extension - structural code intelligence for Phi Code
 *
 * Registers the `lsp` tool: diagnostics, definition, references, hover via the
 * project's language server (typescript-language-server, pyright, gopls,
 * rust-analyzer). Servers are spawned lazily and reused for the session.
 * If no server binary is installed for a language, the tool says so instead of
 * failing.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "phi-code";
import { LspClient, serverForFile } from "./client.ts";

const clients = new Map<string, LspClient>();

const LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescriptreact",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".go": "go",
	".rs": "rust",
};

function languageIdFor(file: string): string {
	const dot = file.lastIndexOf(".");
	return LANGUAGE_IDS[file.slice(dot)] ?? "plaintext";
}

async function clientFor(file: string, cwd: string): Promise<LspClient | undefined> {
	const spec = serverForFile(file);
	if (!spec) return undefined;
	const key = `${spec.command}:${cwd}`;
	let client = clients.get(key);
	if (!client) {
		client = new LspClient(spec, `file://${cwd}`);
		clients.set(key, client);
		await client.initialize();
	}
	return client;
}

function formatLocation(loc: unknown): string {
	const l = loc as { uri?: string; range?: { start: { line: number; character: number } } };
	const path = (l.uri ?? "").replace(/^file:\/\//, "");
	const line = (l.range?.start.line ?? 0) + 1;
	return `${path}:${line}`;
}

export default function (pi: ExtensionAPI) {
	pi.on(
		"session_shutdown" as never,
		(() => {
			for (const client of clients.values()) client.dispose();
			clients.clear();
		}) as never,
	);

	pi.registerTool({
		name: "lsp",
		label: "LSP",
		permissionTier: "read",
		description:
			"Language server intelligence: diagnostics (errors/warnings without building), definition, references, hover. Requires the language server binary installed (typescript-language-server, pyright-langserver, gopls, rust-analyzer).",
		promptGuidelines: [
			"Use lsp diagnostics after editing a file to catch type errors immediately, before running builds.",
			"Use lsp definition/references to navigate unfamiliar code precisely instead of guessing with grep.",
		],
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("diagnostics"),
					Type.Literal("definition"),
					Type.Literal("references"),
					Type.Literal("hover"),
				],
				{ description: "LSP operation" },
			),
			path: Type.String({ description: "File path (relative or absolute)" }),
			line: Type.Optional(Type.Number({ description: "1-based line (for definition/references/hover)" })),
			character: Type.Optional(Type.Number({ description: "1-based character (for definition/references/hover)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as { action: string; path: string; line?: number; character?: number };
			const file = resolve(ctx.cwd, p.path);
			try {
				const client = await clientFor(file, ctx.cwd);
				if (!client) {
					return {
						content: [
							{
								type: "text",
								text: `No language server registered for ${p.path}. Install one of: typescript-language-server, pyright-langserver, gopls, rust-analyzer.`,
							},
						],
						details: { action: p.action },
						isError: true,
					};
				}

				const uri = await client.openDocument(file, readFileSync(file, "utf8"), languageIdFor(file));
				try {
					if (p.action === "diagnostics") {
						const diagnostics = (await client.waitForDiagnostics(uri)) as Array<{
							range: { start: { line: number; character: number } };
							severity?: number;
							message: string;
							source?: string;
						}>;
						if (diagnostics.length === 0) {
							return {
								content: [{ type: "text", text: `No diagnostics for ${p.path} (clean).` }],
								details: { action: p.action, count: 0 },
							};
						}
						const lines = diagnostics.slice(0, 50).map((d) => {
							const sev = d.severity === 1 ? "ERROR" : d.severity === 2 ? "WARN" : "INFO";
							return `${sev} ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`;
						});
						return {
							content: [{ type: "text", text: lines.join("\n") }],
							details: { action: p.action, count: diagnostics.length },
						};
					}

					const position = { line: (p.line ?? 1) - 1, character: (p.character ?? 1) - 1 };
					const base = { textDocument: { uri }, position };

					if (p.action === "definition") {
						const result = (await client.request("textDocument/definition", base)) as unknown;
						const locs = Array.isArray(result) ? result : result ? [result] : [];
						return {
							content: [
								{
									type: "text",
									text: locs.length ? locs.map(formatLocation).join("\n") : "No definition found.",
								},
							],
							details: { action: p.action, count: locs.length },
						};
					}
					if (p.action === "references") {
						const result = (await client.request("textDocument/references", {
							...base,
							context: { includeDeclaration: true },
						})) as unknown[];
						const locs = Array.isArray(result) ? result : [];
						const text = locs.slice(0, 50).map(formatLocation).join("\n");
						return {
							content: [{ type: "text", text: locs.length ? text : "No references found." }],
							details: { action: p.action, count: locs.length },
						};
					}
					// hover
					const result = (await client.request("textDocument/hover", base)) as {
						contents?: unknown;
					} | null;
					let text = "No hover info.";
					if (result?.contents) {
						const c = result.contents as { value?: string } | Array<{ value?: string } | string> | string;
						if (typeof c === "string") text = c;
						else if (Array.isArray(c))
							text = c.map((x) => (typeof x === "string" ? x : (x.value ?? ""))).join("\n");
						else text = c.value ?? text;
					}
					return { content: [{ type: "text", text }], details: { action: p.action } };
				} finally {
					client.closeDocument(uri);
				}
			} catch (error) {
				return {
					content: [{ type: "text", text: `lsp error: ${error}` }],
					details: { action: p.action },
					isError: true,
				};
			}
		},
	});
}
