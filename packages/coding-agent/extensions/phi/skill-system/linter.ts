/**
 * Skill linter (plan §C7). 15 ported rules + 2 phi-specific security rules.
 *
 * Two levels, deliberately distinct:
 *  - BLOCKING rules (`prompt-injection`, `unicode-smuggling`) refuse the write
 *    (security decision, `lint.blockOnInjection: false` disables);
 *  - severity `error` / `warning` rules are ATTACHED to the result only —
 *    hard validations (§C1.3) already rejected those cases before any write.
 */

import { parseFrontmatter, stripBom } from "./frontmatter.ts";
import { FILE_PATH_ROOTS, MARKETING_WORDS, NAME_RE } from "./validate.ts";

export interface LintFinding {
	rule: string;
	severity: "error" | "warning";
	blocking: boolean;
	message: string;
}

export interface LintInput {
	name: string;
	dirName?: string;
	raw: string;
	/** Posix-relative file list of the skill directory (for reference rules). */
	files?: readonly string[];
}

const INJECTION_PATTERNS: ReadonlyArray<{ pattern: RegExp; message: string }> = [
	{
		pattern: /ignore\s+(all\s+)?(the\s+)?previous\s+instructions/i,
		message: "body asks the agent to ignore previous instructions",
	},
	{
		pattern: /disregard\s+(all\s+)?(your\s+|the\s+)?(previous|prior)\s+(instructions|rules|guidelines)/i,
		message: "body asks the agent to disregard its instructions",
	},
	{
		pattern: /^\s*system\s*:/im,
		message: "body contains a `system:` line impersonating a system message",
	},
	{
		pattern: /<\s*system\s*>/i,
		message: "body contains a <system> tag",
	},
	{
		pattern: /you\s+are\s+now\s+(a\s+)?(?:diff|different|new)\s+(?:assistant|agent|ai)/i,
		message: "body attempts to reassign the agent's role",
	},
];

const UNICODE_SMUGGLING_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/;
const TAG_CHARS_RE = /[\u{e0000}-\u{e007f}]/u;
const SHELL_UTILITIES_RE = /`(?:cat|head|tail|sed|awk)\b/;
const FORBIDDEN_FILES = new Set(["README.md", "CHANGELOG.md", "install.sh", ".env", ".env.example", ".gitignore"]);

function finding(rule: string, severity: "error" | "warning", message: string, blocking = false): LintFinding {
	return { rule, severity, blocking, message };
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	return typeof value === "string" ? value : undefined;
}

function listField(data: Record<string, unknown>, key: string): string[] {
	const value = data[key];
	return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function nestedTags(data: Record<string, unknown>): string[] {
	const metadata = data.metadata;
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
	const record = metadata as Record<string, unknown>;
	for (const namespace of ["phi", "hermes"]) {
		const block = record[namespace];
		if (block && typeof block === "object" && !Array.isArray(block)) {
			const tags = (block as Record<string, unknown>).tags;
			if (Array.isArray(tags)) return tags.map((tag) => String(tag));
		}
		if (Array.isArray(record.tags)) return record.tags.map((tag) => String(tag));
	}
	return Array.isArray(record.tags) ? record.tags.map((tag) => String(tag)) : [];
}

/** Injection scan on arbitrary text (used by the write path and scan.ts). */
export function findInjection(text: string): LintFinding[] {
	const findings: LintFinding[] = [];
	// A leading BOM is a benign encoding artifact — strip it before scanning, but
	// any zero-width/bidi character INSIDE the text stays an attack.
	const cleaned = stripBom(text);
	for (const { pattern, message } of INJECTION_PATTERNS) {
		if (pattern.test(cleaned)) findings.push(finding("prompt-injection", "error", message, true));
	}
	if (UNICODE_SMUGGLING_RE.test(cleaned) || TAG_CHARS_RE.test(cleaned)) {
		findings.push(
			finding(
				"unicode-smuggling",
				"error",
				"body contains zero-width, bidi or tag characters — remove them (invisible instructions)",
				true,
			),
		);
	}
	return findings;
}

export function lintSkill(input: LintInput): LintFinding[] {
	const findings: LintFinding[] = [];
	const parsed = parseFrontmatter(input.raw);
	const data = parsed.data ?? {};
	const body = parsed.body;
	const description = stringField(data, "description") ?? "";
	const name = stringField(data, "name") ?? input.name;

	if (!NAME_RE.test(name))
		findings.push(finding("name-format", "error", `name "${name}" must match ^[a-z0-9][a-z0-9._-]*$`));
	if (input.dirName !== undefined && name !== input.dirName)
		findings.push(
			finding(
				"name-dir-mismatch",
				"error",
				`frontmatter name "${name}" differs from directory "${input.dirName}" — sigma-skills indexes by directory`,
			),
		);
	if (description.length > 60)
		findings.push(
			finding("description-length", "warning", `description is ${description.length} chars (budget: 60)`),
		);
	for (const word of MARKETING_WORDS) {
		if (new RegExp(`\\b${word}\\b`, "i").test(description))
			findings.push(finding("description-marketing", "warning", `description contains marketing word "${word}"`));
	}
	const hasVersion = stringField(data, "version") !== undefined;
	const hasAuthor = stringField(data, "author") !== undefined;
	const hasLicense = stringField(data, "license") !== undefined;
	if (!hasVersion || !hasAuthor || !hasLicense || nestedTags(data).length === 0)
		findings.push(
			finding("missing-metadata", "warning", "missing version/author/license or metadata tags (metadata.phi.tags)"),
		);
	const author = stringField(data, "author");
	if (author !== undefined) {
		const lowered = author.toLowerCase();
		const GENERIC = new Set(["hermes", "agent", "hermes agent", "phi", "pi", "phi agent", "pi agent"]);
		if (GENERIC.has(lowered) && author !== "Hermes Agent" && author !== "Phi Agent")
			findings.push(finding("author-caps", "warning", `author "${author}" should be a stable capitalized name`));
	}
	for (const platform of listField(data, "platforms")) {
		if (!["linux", "macos", "windows", "darwin"].includes(platform))
			findings.push(finding("platforms-value", "warning", `platform "${platform}" is not a known value`));
	}
	if (body.length > 24_000)
		findings.push(finding("oversized-body", "warning", `body is ${body.length} chars (budget: 24000)`));
	if (SHELL_UTILITIES_RE.test(body))
		findings.push(
			finding(
				"shell-utility-reference",
				"warning",
				"prose references shell utilities (cat/head/tail/sed/awk) — prefer the native read/edit tools",
			),
		);
	if (!/^##\s+When to Use\b/m.test(body))
		findings.push(finding("missing-section", "warning", "body lacks a `## When to Use` section (required)"));
	const incidentRefs = (body.match(/(?:#\d{3,}|PR\s*#?\d+|\/pull\/\d+|issue\s*#?\d+)/gi) ?? []).length;
	if (incidentRefs >= 4 && body.length >= 500)
		findings.push(
			finding(
				"incident-log-shape",
				"warning",
				"body reads like an incident log (>=4 issue/PR references) — extract the general rule instead",
			),
		);
	const files = input.files ?? [];
	if (files.length > 0) {
		const cited = body.match(/`?(?:\.\/)?(references\/[^\s`)"'\][]+)/g) ?? [];
		for (const raw of cited) {
			const rel = raw.replace(/^`?(?:\.\/)?/, "").replace(/[`)"'\][]+$/, "");
			if (!files.some((file) => file === rel)) {
				findings.push(finding("dangling-reference", "warning", `body cites ${rel} but the file does not exist`));
			}
		}
		if (files.some((file) => file.startsWith("scripts/")) && listField(data, "platforms").length === 0)
			findings.push(
				finding(
					"platforms-gating",
					"warning",
					"skill ships scripts/ but declares no `platforms:` — POSIX primitives may not run everywhere",
				),
			);
		for (const file of files) {
			if (FORBIDDEN_FILES.has(file.split("/")[0]) || FORBIDDEN_FILES.has(file))
				findings.push(finding("forbidden-file", "warning", `${file} should not live inside a skill directory`));
		}
		const referenceDocs = files.filter((file) => file.startsWith("references/") && file.endsWith(".md"));
		if (referenceDocs.length > 60)
			findings.push(
				finding(
					"references-sprawl",
					"warning",
					`${referenceDocs.length} files under references/ — consolidate into thematic documents`,
				),
			);
	}
	findings.push(...findInjection(input.raw));
	return findings;
}

/** Findings present in `after` but not in `before` (rule + message identity). */
export function introducedFindings(before: LintFinding[], after: LintFinding[]): LintFinding[] {
	const seen = new Set(before.map((f) => `${f.rule}\u0000${f.message}`));
	return after.filter((f) => !seen.has(`${f.rule}\u0000${f.message}`));
}

export { FILE_PATH_ROOTS };
