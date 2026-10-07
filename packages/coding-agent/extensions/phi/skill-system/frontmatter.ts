/**
 * Minimal YAML frontmatter parser/serializer (plan §5.1).
 *
 * Deliberately hand-written: extensions may not depend on external packages.
 * Supports the subset used by skills: top-level scalars, inline lists,
 * block lists, one level of nested maps (metadata.phi), single/double quoted
 * scalars (including multi-line), `#` comments and a leading UTF-8 BOM.
 */

export interface ParsedFrontmatter {
	data: Record<string, unknown> | undefined;
	body: string;
	error?: string;
}

export function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

interface YamlLine {
	indent: number;
	text: string;
}

/** Find the index of the value-separating colon, ignoring quoted segments. */
function findColon(text: string): number {
	let quote: string | undefined;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === ":") return i;
	}
	return -1;
}

/** True while `text` ends inside an open quote (for multi-line scalars). */
function hasOpenQuote(text: string): boolean {
	const colon = findColon(text);
	const value = colon >= 0 ? text.slice(colon + 1).trim() : text.trim();
	if (value.startsWith('"')) return !/^"(?:[^"\\]|\\.)*"$/.test(value);
	if (value.startsWith("'")) return !/^'(?:[^']|'')*'$/.test(value);
	return false;
}

function tokenize(yaml: string): YamlLine[] {
	const raw = yaml.split(/\r?\n/);
	const lines: YamlLine[] = [];
	for (let i = 0; i < raw.length; i++) {
		const lineText = raw[i];
		const indent = (lineText.match(/^ */) ?? [""])[0].length;
		let text = lineText.slice(indent);
		let guard = 0;
		while (hasOpenQuote(text) && i + 1 < raw.length && guard < 1000) {
			i++;
			guard++;
			text += `\n${raw[i].trim()}`;
		}
		lines.push({ indent, text });
	}
	return lines;
}

function stripInlineComment(text: string): string {
	let quote: string | undefined;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "#" && (i === 0 || text[i - 1] === " " || text[i - 1] === "\t")) {
			return text.slice(0, i).trimEnd();
		}
	}
	return text;
}

function parseInlineList(text: string): unknown[] {
	const inner = text.slice(1, -1).trim();
	if (inner === "") return [];
	const items: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i];
		if (quote) {
			current += ch;
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === ",") {
			items.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim() !== "") items.push(current.trim());
	return items.map((item) => parseScalarValue(item));
}

function parseScalarValue(text: string): unknown {
	const value = text.trim();
	if (value === "" || value === "~" || value === "null") return null;
	if (value === "true") return true;
	if (value === "false") return false;
	if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
		try {
			return JSON.parse(value) as unknown;
		} catch {
			return value.slice(1, -1);
		}
	}
	if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	if (value.startsWith("[") && value.endsWith("]")) return parseInlineList(value);
	return value;
}

function parseBlock(lines: YamlLine[], start: number, indent: number, asList: boolean): [unknown, number] {
	const map: Record<string, unknown> = {};
	const list: unknown[] = [];
	let i = start;
	while (i < lines.length) {
		const line = lines[i];
		if (line.text.trim() === "" || line.text.trim().startsWith("#")) {
			i++;
			continue;
		}
		if (line.indent < indent) break;
		if (line.indent > indent) {
			i++;
			continue;
		}
		if (line.text.startsWith("- ")) {
			list.push(parseScalarValue(stripInlineComment(line.text.slice(2))));
			i++;
			continue;
		}
		if (line.text.startsWith("-")) {
			list.push(null);
			i++;
			continue;
		}
		const colon = findColon(line.text);
		if (colon < 0) {
			i++;
			continue;
		}
		const key = line.text.slice(0, colon).trim();
		const rest = stripInlineComment(line.text.slice(colon + 1)).trim();
		if (rest === "") {
			const next = lines[i + 1];
			if (next && next.text.trim() !== "" && next.indent > indent) {
				const childList = next.text.startsWith("-");
				const [child, nextIndex] = parseBlock(lines, i + 1, next.indent, childList);
				map[key] = child;
				i = nextIndex;
				continue;
			}
			map[key] = null;
			i++;
			continue;
		}
		map[key] = parseScalarValue(rest);
		i++;
	}
	return [asList ? list : map, i];
}

/** Parse a skill file (or raw string). `data` is undefined when absent. */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
	const text = stripBom(raw);
	if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
		return { data: undefined, body: text };
	}
	const lines = text.split(/\r?\n/);
	let closing = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			closing = i;
			break;
		}
	}
	if (closing < 0) {
		return { data: undefined, body: text, error: "frontmatter not closed (missing closing ---)" };
	}
	const yaml = lines.slice(1, closing).join("\n");
	const body = lines.slice(closing + 1).join("\n");
	const [data] = parseBlock(tokenize(yaml), 0, 0, false);
	if (data === null || Array.isArray(data) || typeof data !== "object") {
		return { data: undefined, body, error: "frontmatter is not a mapping" };
	}
	return { data: data as Record<string, unknown>, body };
}

function needsQuotes(value: string): boolean {
	if (value === "") return true;
	if (/^[\s]|[\s]$/.test(value)) return true;
	if (/[:#[\]{}"'&*!|>%@`,]/.test(value)) return true;
	if (/^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(value)) return true;
	if (value.includes("\n")) return true;
	return false;
}

function serializeScalar(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return String(value);
	if (Array.isArray(value)) return `[${value.map((item) => serializeScalar(item)).join(", ")}]`;
	const text = String(value);
	return needsQuotes(text) ? JSON.stringify(text) : text;
}

const KEY_ORDER = ["name", "description", "version", "author", "license", "platforms", "metadata"];

/** Rebuild a skill file from data + body (stable key order). */
export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
	const keys = [...Object.keys(data)].sort((a, b) => {
		const ia = KEY_ORDER.indexOf(a);
		const ib = KEY_ORDER.indexOf(b);
		if (ia >= 0 && ib >= 0) return ia - ib;
		if (ia >= 0) return -1;
		if (ib >= 0) return 1;
		return a.localeCompare(b);
	});
	const lines: string[] = ["---"];
	for (const key of keys) {
		const value = data[key];
		if (value && typeof value === "object" && !Array.isArray(value)) {
			lines.push(`${key}:`);
			for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
				if (childValue && typeof childValue === "object" && !Array.isArray(childValue)) {
					lines.push(`  ${childKey}:`);
					for (const [leafKey, leafValue] of Object.entries(childValue as Record<string, unknown>)) {
						lines.push(`    ${leafKey}: ${serializeScalar(leafValue)}`);
					}
				} else {
					lines.push(`  ${childKey}: ${serializeScalar(childValue)}`);
				}
			}
		} else {
			lines.push(`${key}: ${serializeScalar(value)}`);
		}
	}
	lines.push("---");
	const normalizedBody = body.startsWith("\n") ? body : `\n${body}`;
	return `${lines.join("\n")}\n${normalizedBody}`;
}
