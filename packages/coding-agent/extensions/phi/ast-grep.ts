/**
 * AST Grep Extension - Structural code search for Phi Code
 *
 * Registers the `ast_grep` tool: search code by syntax-tree pattern instead of
 * text regex, powered by @ast-grep/napi (prebuilt native module, no build
 * scripts required at install).
 *
 * Supported languages: TypeScript, JavaScript (incl. TSX/JSX), Python, Go, Rust.
 * Read-only tool: it never modifies files.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Lang, parse } from "@ast-grep/napi";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "phi-code";

const LANG_BY_EXT: Record<string, Lang> = {
	".ts": "TypeScript" as Lang,
	".tsx": "Tsx" as Lang,
	".js": "JavaScript" as Lang,
	".jsx": "JavaScript" as Lang,
	".mjs": "JavaScript" as Lang,
	".cjs": "JavaScript" as Lang,
	".py": "Python" as Lang,
	".go": "Go" as Lang,
	".rs": "Rust" as Lang,
};

const LANG_ENUM: Record<string, Lang> = {
	typescript: "TypeScript" as Lang,
	ts: "TypeScript" as Lang,
	tsx: "Tsx" as Lang,
	javascript: "JavaScript" as Lang,
	js: "JavaScript" as Lang,
	jsx: "JavaScript" as Lang,
	python: "Python" as Lang,
	py: "Python" as Lang,
	go: "Go" as Lang,
	rust: "Rust" as Lang,
	rs: "Rust" as Lang,
};

function langForFile(file: string, explicit?: string): Lang | undefined {
	if (explicit) return LANG_ENUM[explicit.toLowerCase()];
	const dot = file.lastIndexOf(".");
	if (dot === -1) return undefined;
	return LANG_BY_EXT[file.slice(dot)];
}

async function collectFiles(target: string, cwd: string, explicitLang?: string): Promise<string[]> {
	const { statSync, readdirSync } = await import("node:fs");
	const abs = resolve(cwd, target);
	const stat = statSync(abs, { throwIfNoEntry: false });
	if (!stat) return [];
	if (stat.isFile()) return [abs];
	const out: string[] = [];
	const walk = (dir: string, depth: number) => {
		if (depth > 6) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (langForFile(entry.name, explicitLang)) out.push(full);
		}
	};
	walk(abs, 0);
	return out.slice(0, 2000);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ast_grep",
		label: "AST Grep",
		description:
			"Structural code search using syntax-tree patterns (ast-grep). Find code by shape, not text: e.g. pattern 'console.log($MSG)' finds all calls regardless of formatting. Supports TypeScript, JavaScript, Python, Go, Rust.",
		promptGuidelines: [
			"Use ast_grep instead of grep when searching for code constructs (function calls, class methods, imports) where formatting varies.",
			"Use $VAR for single-node wildcards and $$$ for multi-node wildcards in patterns.",
		],
		parameters: Type.Object({
			pattern: Type.String({ description: "Structural pattern, e.g. 'fetch($URL)' or 'function $NAME($$$) { $$$ }'" }),
			path: Type.Optional(Type.String({ description: "File or directory to search (default: current directory)" })),
			lang: Type.Optional(
				Type.String({ description: "Language override: ts, tsx, js, py, go, rs (default: inferred per file)" }),
			),
			maxResults: Type.Optional(Type.Number({ description: "Max matches to return (default 50)" })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as { pattern: string; path?: string; lang?: string; maxResults?: number };
			const maxResults = p.maxResults ?? 50;
			try {
				const files = await collectFiles(p.path ?? ".", ctx.cwd, p.lang);
				const matches: string[] = [];
				for (const file of files) {
					const lang = langForFile(file, p.lang);
					if (!lang) continue;
					let root;
					try {
						root = parse(lang, readFileSync(file, "utf8"));
					} catch {
						continue; // unparseable file: skip
					}
					let nodes;
					try {
						nodes = root.root().findAll(p.pattern);
					} catch {
						return {
							content: [{ type: "text", text: `Invalid ast-grep pattern: ${p.pattern}` }],
							details: { matchCount: 0, filesScanned: files.length },
							isError: true,
						};
					}
					for (const node of nodes) {
						const range = node.range();
						matches.push(`${file}:${range.start.line + 1}: ${node.text().split("\n")[0].slice(0, 160)}`);
						if (matches.length >= maxResults) break;
					}
					if (matches.length >= maxResults) break;
				}
				if (matches.length === 0) {
					return {
					content: [{ type: "text", text: `No structural matches for pattern: ${p.pattern}` }],
					details: { matchCount: 0, filesScanned: files.length },
				};
				}
				return {
					content: [{ type: "text", text: matches.join("\n") }],
					details: { matchCount: matches.length, filesScanned: files.length },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: `ast_grep error: ${error}` }],
					details: { matchCount: 0, filesScanned: 0 },
					isError: true,
				};
			}
		},
	});
}
