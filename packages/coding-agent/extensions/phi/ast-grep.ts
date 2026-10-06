/**
 * AST Grep Extension - Structural code search for Phi Code
 *
 * Registers the `ast_grep` tool: search code by syntax-tree pattern instead of
 * text regex, powered by @ast-grep/napi (prebuilt native module, no build
 * scripts required at install).
 *
 * Supported languages: TypeScript, JavaScript (incl. TSX/JSX), Python, Go, Rust.
 * Read-only tool: it never modifies files.
 *
 * Directory walks respect .gitignore/.ignore files, skip files larger than
 * MAX_FILE_BYTES, parse off the main thread (parseAsync) and stop as soon as
 * the tool call is aborted.
 */

import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Lang, parseAsync, type SgNode } from "@ast-grep/napi";
import { Type } from "@sinclair/typebox";
import ignore from "ignore";
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

/** Files above this size are skipped (minified bundles, generated code, fixtures). */
export const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 2000;
const MAX_DEPTH = 6;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

/** Rewrite one ignore-file line so it is relative to the walk root (same rules as core/skills.ts). */
function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;
	let pattern = trimmed;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const patterns = readFileSync(ignorePath, "utf-8")
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) ig.add(patterns);
		} catch {
			// unreadable ignore file: walk as if it were absent
		}
	}
}

export interface CollectedFiles {
	files: string[];
	/** True when MAX_FILES was reached (the search is partial). */
	truncated: boolean;
}

/**
 * List candidate source files under `target`. A file target is returned as is
 * (explicit request: no ignore rules). Directory walks skip dot-dirs,
 * node_modules, dist and anything matched by .gitignore/.ignore files found
 * between the workspace root and each directory.
 */
export async function collectFiles(
	target: string,
	cwd: string,
	explicitLang?: string,
	signal?: AbortSignal,
): Promise<CollectedFiles> {
	const abs = resolve(cwd, target);
	const info = await stat(abs).catch(() => undefined);
	if (!info) return { files: [], truncated: false };
	if (info.isFile()) return { files: [abs], truncated: false };

	// Ignore rules are rooted at the workspace when the target is inside it, so
	// the repository's top-level .gitignore applies to a sub-directory search too.
	const rel = relative(cwd, abs);
	const rootDir = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? cwd : abs;
	const ig = ignore();
	let ancestor = rootDir;
	addIgnoreRules(ig, ancestor, rootDir);
	for (const part of relative(rootDir, abs).split(sep).filter(Boolean)) {
		ancestor = join(ancestor, part);
		addIgnoreRules(ig, ancestor, rootDir);
	}

	const out: string[] = [];
	let truncated = false;
	const walk = async (dir: string, depth: number): Promise<void> => {
		if (depth > MAX_DEPTH || truncated) return;
		signal?.throwIfAborted();
		if (depth > 0) addIgnoreRules(ig, dir, rootDir);
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;
			const full = join(dir, entry.name);
			const relPath = toPosixPath(relative(rootDir, full));
			if (entry.isDirectory()) {
				if (ig.ignores(`${relPath}/`)) continue;
				await walk(full, depth + 1);
			} else if (langForFile(entry.name, explicitLang) && !ig.ignores(relPath)) {
				if (out.length >= MAX_FILES) {
					truncated = true;
					return;
				}
				out.push(full);
			}
			if (truncated) return;
		}
	};
	await walk(abs, 0);
	return { files: out, truncated };
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
			pattern: Type.String({
				description: "Structural pattern, e.g. 'fetch($URL)' or 'function $NAME($$$) { $$$ }'",
			}),
			path: Type.Optional(Type.String({ description: "File or directory to search (default: current directory)" })),
			lang: Type.Optional(
				Type.String({ description: "Language override: ts, tsx, js, py, go, rs (default: inferred per file)" }),
			),
			maxResults: Type.Optional(Type.Number({ description: "Max matches to return (default 50)" })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const p = params as { pattern: string; path?: string; lang?: string; maxResults?: number };
			const maxResults = p.maxResults ?? 50;
			try {
				const { files, truncated } = await collectFiles(p.path ?? ".", ctx.cwd, p.lang, signal);
				const matches: string[] = [];
				let skippedLarge = 0;
				for (const file of files) {
					signal?.throwIfAborted();
					const lang = langForFile(file, p.lang);
					if (!lang) continue;
					const size = (await stat(file).catch(() => undefined))?.size ?? 0;
					if (size > MAX_FILE_BYTES) {
						skippedLarge++;
						continue;
					}
					let root: Awaited<ReturnType<typeof parseAsync>>;
					try {
						root = await parseAsync(lang, await readFile(file, "utf8"));
					} catch {
						continue; // unreadable or unparseable file: skip
					}
					let nodes: SgNode[];
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
				const notes: string[] = [];
				if (skippedLarge > 0) notes.push(`${skippedLarge} file(s) over ${MAX_FILE_BYTES} bytes skipped`);
				if (truncated) notes.push(`file limit (${MAX_FILES}) reached: narrow 'path' for a complete search`);
				const footer = notes.length > 0 ? `\n\n(${notes.join("; ")})` : "";
				const details = { matchCount: matches.length, filesScanned: files.length, skippedLarge, truncated };
				if (matches.length === 0) {
					return {
						content: [{ type: "text", text: `No structural matches for pattern: ${p.pattern}${footer}` }],
						details,
					};
				}
				return {
					content: [{ type: "text", text: `${matches.join("\n")}${footer}` }],
					details,
				};
			} catch (error) {
				if (signal?.aborted) throw error;
				return {
					content: [{ type: "text", text: `ast_grep error: ${error}` }],
					details: { matchCount: 0, filesScanned: 0 },
					isError: true,
				};
			}
		},
	});
}
