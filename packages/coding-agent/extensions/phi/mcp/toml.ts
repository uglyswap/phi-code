/**
 * Minimal TOML reader for importing Codex `~/.codex/config.toml`.
 *
 * Supports the subset Codex configs use: `[table]` and `[a.b."c"]` headers
 * (sub-tables such as `[mcp_servers.NAME.env]` nest under their parent),
 * `[[array.of.tables]]`, bare/quoted/dotted keys, basic and literal strings
 * (single and multi-line), integers, floats, booleans, multi-line arrays and
 * inline tables. Dates are kept as strings. Comments are ignored.
 *
 * Throws a `TomlParseError` with a line number on malformed input.
 */

export class TomlParseError extends Error {
	constructor(message: string, line: number) {
		super(`line ${line}: ${message}`);
		this.name = "TomlParseError";
	}
}

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
	[key: string]: TomlValue;
}

/** Keys that would let a crafted file reach Object.prototype. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BARE_KEY = /[A-Za-z0-9_-]/;

function isTable(value: TomlValue | undefined): value is TomlTable {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

class TomlReader {
	private pos = 0;
	private readonly text: string;

	constructor(text: string) {
		this.text = text.replace(/\r\n/g, "\n");
	}

	fail(message: string): never {
		const line = this.text.slice(0, this.pos).split("\n").length;
		throw new TomlParseError(message, line);
	}

	peek(offset = 0): string {
		return this.text[this.pos + offset] ?? "";
	}

	startsWith(token: string): boolean {
		return this.text.startsWith(token, this.pos);
	}

	atEnd(): boolean {
		return this.pos >= this.text.length;
	}

	advance(count = 1): void {
		this.pos += count;
	}

	/** Skip spaces and tabs. */
	skipSpaces(): void {
		while (this.peek() === " " || this.peek() === "\t") this.advance();
	}

	/** Skip whitespace, newlines and comments. */
	skipBlank(): void {
		for (;;) {
			const c = this.peek();
			if (c === " " || c === "\t" || c === "\n") this.advance();
			else if (c === "#") this.skipComment();
			else return;
		}
	}

	skipComment(): void {
		while (!this.atEnd() && this.peek() !== "\n") this.advance();
	}

	/** After a key/value or header: only spaces and a comment may remain on the line. */
	expectLineEnd(): void {
		this.skipSpaces();
		if (this.peek() === "#") this.skipComment();
		if (!this.atEnd() && this.peek() !== "\n") this.fail(`unexpected character "${this.peek()}"`);
	}

	expect(char: string): void {
		if (this.peek() !== char) this.fail(`expected "${char}"`);
		this.advance();
	}

	parseKeyPart(): string {
		const c = this.peek();
		let key = "";
		if (c === '"' || c === "'") key = this.parseString();
		else {
			while (BARE_KEY.test(this.peek())) {
				key += this.peek();
				this.advance();
			}
			if (!key) this.fail("expected a key");
		}
		if (FORBIDDEN_KEYS.has(key)) this.fail(`forbidden key "${key}"`);
		return key;
	}

	/** Dotted key: a.b."c" */
	parseKey(): string[] {
		const parts: string[] = [];
		for (;;) {
			this.skipSpaces();
			parts.push(this.parseKeyPart());
			this.skipSpaces();
			if (this.peek() !== ".") return parts;
			this.advance();
		}
	}

	parseString(): string {
		if (this.startsWith('"""')) return this.parseMultiline('"""', true);
		if (this.startsWith("'''")) return this.parseMultiline("'''", false);
		const quote = this.peek();
		this.advance();
		let out = "";
		for (;;) {
			if (this.atEnd() || this.peek() === "\n") this.fail("unterminated string");
			const c = this.peek();
			if (c === quote) {
				this.advance();
				return out;
			}
			if (c === "\\" && quote === '"') out += this.parseEscape();
			else {
				out += c;
				this.advance();
			}
		}
	}

	parseMultiline(delimiter: string, escapes: boolean): string {
		this.advance(3);
		if (this.peek() === "\n") this.advance(); // a newline right after the delimiter is trimmed
		let out = "";
		while (!this.startsWith(delimiter)) {
			if (this.atEnd()) this.fail("unterminated multi-line string");
			if (escapes && this.peek() === "\\") out += this.parseEscape();
			else {
				out += this.peek();
				this.advance();
			}
		}
		this.advance(3);
		return out;
	}

	parseEscape(): string {
		this.advance(); // backslash
		const c = this.peek();
		this.advance();
		const simple: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
		if (c in simple) return simple[c] as string;
		if (c === "u" || c === "U") {
			const len = c === "u" ? 4 : 8;
			const hex = this.text.slice(this.pos, this.pos + len);
			if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) this.fail("invalid unicode escape");
			this.advance(len);
			return String.fromCodePoint(Number.parseInt(hex, 16));
		}
		if (c === "\n") {
			// Line-ending backslash (multi-line strings): trim following whitespace
			while (/[ \t\n]/.test(this.peek())) this.advance();
			return "";
		}
		return this.fail(`invalid escape "\\${c}"`);
	}

	parseValue(): TomlValue {
		const c = this.peek();
		if (c === '"' || c === "'") return this.parseString();
		if (c === "[") return this.parseArray();
		if (c === "{") return this.parseInlineTable();
		return this.parseScalar();
	}

	parseArray(): TomlValue[] {
		this.expect("[");
		const out: TomlValue[] = [];
		for (;;) {
			this.skipBlank();
			if (this.peek() === "]") break;
			out.push(this.parseValue());
			this.skipBlank();
			if (this.peek() === ",") this.advance();
			else if (this.peek() !== "]") this.fail('expected "," or "]" in array');
		}
		this.advance();
		return out;
	}

	parseInlineTable(): TomlTable {
		this.expect("{");
		const table: TomlTable = {};
		this.skipSpaces();
		if (this.peek() === "}") {
			this.advance();
			return table;
		}
		for (;;) {
			const key = this.parseKey();
			this.expect("=");
			this.skipSpaces();
			setPath(table, key, this.parseValue(), this);
			this.skipSpaces();
			if (this.peek() === "}") {
				this.advance();
				return table;
			}
			this.expect(",");
			this.skipSpaces();
		}
	}

	parseScalar(): TomlValue {
		const start = this.pos;
		while (!this.atEnd() && !/[,\]}\n#]/.test(this.peek())) this.advance();
		const raw = this.text.slice(start, this.pos).trim();
		if (raw === "true") return true;
		if (raw === "false") return false;
		const numeric = raw.replace(/_/g, "");
		if (/^[+-]?(\d+)(\.\d+)?([eE][+-]?\d+)?$/.test(numeric)) return Number(numeric);
		if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw; // dates/times kept as text
		return this.fail(`invalid value "${raw}"`);
	}
}

function setPath(root: TomlTable, path: string[], value: TomlValue, reader: TomlReader): void {
	let table = root;
	for (const part of path.slice(0, -1)) {
		const next = table[part];
		if (next === undefined) table[part] = {};
		else if (!isTable(next)) reader.fail(`key "${part}" is not a table`);
		table = table[part] as TomlTable;
	}
	const last = path[path.length - 1] as string;
	if (Object.hasOwn(table, last)) reader.fail(`duplicate key "${last}"`);
	table[last] = value;
}

/** Resolve (creating as needed) the table named by a header path. */
function resolveTable(root: TomlTable, path: string[], reader: TomlReader): TomlTable {
	let table = root;
	for (const part of path) {
		let next = table[part];
		if (next === undefined) {
			next = {};
			table[part] = next;
		}
		// `[a.b]` after `[[a]]` refers to the last element of the array of tables
		if (Array.isArray(next)) next = next[next.length - 1];
		if (!isTable(next)) reader.fail(`key "${part}" is not a table`);
		table = next;
	}
	return table;
}

function parseHeader(reader: TomlReader, root: TomlTable): TomlTable {
	const isArray = reader.startsWith("[[");
	reader.advance(isArray ? 2 : 1);
	const path = reader.parseKey();
	reader.expect("]");
	if (isArray) reader.expect("]");
	reader.expectLineEnd();
	if (!isArray) return resolveTable(root, path, reader);
	const parent = resolveTable(root, path.slice(0, -1), reader);
	const last = path[path.length - 1] as string;
	const list = parent[last] ?? [];
	if (!Array.isArray(list)) reader.fail(`key "${last}" is not an array of tables`);
	const table: TomlTable = {};
	list.push(table);
	parent[last] = list;
	return table;
}

/** Parse a TOML document into plain objects. */
export function parseToml(text: string): TomlTable {
	const reader = new TomlReader(text);
	const root: TomlTable = {};
	let current = root;
	for (;;) {
		reader.skipBlank();
		if (reader.atEnd()) return root;
		if (reader.peek() === "[") {
			current = parseHeader(reader, root);
			continue;
		}
		const key = reader.parseKey();
		reader.expect("=");
		reader.skipSpaces();
		setPath(current, key, reader.parseValue(), reader);
		reader.expectLineEnd();
	}
}
