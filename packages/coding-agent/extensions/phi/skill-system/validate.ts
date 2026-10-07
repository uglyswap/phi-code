/**
 * Hard validations for skill writes (plan §C1.3).
 *
 * These run BEFORE any side effect. Lint findings (§C7) are advisory; these
 * rules reject. Messages are pedagogic: a shape error names the offending key
 * and where the text should go.
 */

import { posix } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

export const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
export const NAME_MAX = 64;
export const DESCRIPTION_CREATE_MAX = 60;
export const DESCRIPTION_MAX = 1024;
export const CONTENT_MAX = 100_000;
export const FILE_CONTENT_MAX_BYTES = 1_048_576;
export const FILE_PATH_ROOTS = ["references", "templates", "scripts", "assets"] as const;

export const MARKETING_WORDS = [
	"powerful",
	"comprehensive",
	"seamless",
	"advanced",
	"cutting-edge",
	"state-of-the-art",
	"revolutionary",
	"robust",
] as const;

/** Which op owns which key — used to make shape errors actionable. */
export const KEY_OWNERS: Record<string, string> = {
	content: "create (or a full-rewrite patch)",
	new_string: "a targeted patch",
	file_content: "write_file",
};

export interface ValidationOk {
	ok: true;
}

export interface ValidationError {
	ok: false;
	error: string;
}

export type ValidationResult = ValidationOk | ValidationError;

const ok: ValidationOk = { ok: true };
const err = (error: string): ValidationError => ({ ok: false, error });

export function validateSkillName(name: unknown): ValidationResult {
	if (typeof name !== "string" || name.trim() === "") return err("`name` is required");
	const value = name.trim();
	if (value.length > NAME_MAX) return err(`\`name\` exceeds ${NAME_MAX} characters`);
	if (!NAME_RE.test(value))
		return err("`name` must match ^[a-z0-9][a-z0-9._-]*$ (lowercase letters, digits, dot, underscore, dash)");
	return ok;
}

export function validateCategory(category: unknown): ValidationResult {
	if (category === undefined || category === null) return ok;
	if (typeof category !== "string") return err("`category` must be a string");
	if (!NAME_RE.test(category)) return err("`category` must be a single path segment matching ^[a-z0-9][a-z0-9._-]*$");
	if (category.length > NAME_MAX) return err(`\`category\` exceeds ${NAME_MAX} characters`);
	return ok;
}

/** Relative support-file path rules: SKILL.md alone, or under an allowed root. */
export function validateFilePath(filePath: unknown): ValidationResult {
	if (typeof filePath !== "string" || filePath.trim() === "") return err("`file_path` is required");
	const normalized = posix.normalize(filePath.trim().replace(/\\/g, "/"));
	if (normalized.startsWith("/") || normalized.startsWith("..") || normalized.includes("../"))
		return err("`file_path` must not escape the skill directory (`..` is forbidden)");
	if (normalized === ".") return err("`file_path` must name a file");
	if (normalized === "SKILL.md") return ok;
	const first = normalized.split("/")[0];
	if (!(FILE_PATH_ROOTS as readonly string[]).includes(first))
		return err(`\`file_path\` must be \`SKILL.md\` or start with one of: ${FILE_PATH_ROOTS.join(", ")}`);
	return ok;
}

export interface ParsedSkillContent {
	data: Record<string, unknown>;
	body: string;
}

export function parseSkillContent(content: string): ParsedSkillContent | ValidationError {
	const parsed = parseFrontmatter(content);
	if (parsed.error) return err(`frontmatter error: ${parsed.error}`);
	if (!parsed.data) return err("`content` must start with a `---` YAML frontmatter block");
	const data = parsed.data;
	if (typeof data.name !== "string" || data.name.trim() === "") return err("frontmatter must declare `name`");
	if (typeof data.description !== "string" || data.description.trim() === "")
		return err("frontmatter must declare `description`");
	if (parsed.body.trim() === "") return err("skill body (after the frontmatter) must not be empty");
	return { data, body: parsed.body };
}

export interface ContentValidationOptions {
	creating: boolean;
	/** Expected skill name (usually the directory basename) — enforces name===dir. */
	expectedName?: string;
}

/** Validate a full SKILL.md content string. */
export function validateSkillContent(content: unknown, options: ContentValidationOptions): ValidationResult {
	if (typeof content !== "string") return err("`content` is required and must be a string");
	if (content.length > CONTENT_MAX) return err(`\`content\` exceeds ${CONTENT_MAX} characters`);
	const parsed = parseSkillContent(content);
	if ("ok" in parsed && parsed.ok === false) return parsed;
	const { data } = parsed as ParsedSkillContent;
	const name = String(data.name);
	const nameCheck = validateSkillName(name);
	if (!nameCheck.ok) return nameCheck;
	if (options.expectedName !== undefined && name !== options.expectedName)
		return err(
			`frontmatter \`name\` (${name}) must equal the skill directory name (${options.expectedName}) — sigma-skills indexes by directory`,
		);
	const description = String(data.description);
	if (description.length > DESCRIPTION_MAX) return err(`\`description\` exceeds ${DESCRIPTION_MAX} characters`);
	if (options.creating && description.length > DESCRIPTION_CREATE_MAX)
		return err(
			`\`description\` is ${description.length} chars; the creation budget is ${DESCRIPTION_CREATE_MAX}. ` +
				"Keep it one self-contained sentence: 'Use when <trigger>. <one-line behavior>.'",
		);
	return ok;
}

export function validateFileContent(fileContent: unknown): ValidationResult {
	if (typeof fileContent !== "string") return err("`file_content` is required and must be a string");
	if (Buffer.byteLength(fileContent, "utf8") > FILE_CONTENT_MAX_BYTES)
		return err(`\`file_content\` exceeds ${FILE_CONTENT_MAX_BYTES} bytes`);
	if (fileContent.length > CONTENT_MAX) return err(`\`file_content\` exceeds ${CONTENT_MAX} characters`);
	return ok;
}

/**
 * Detect misplaced-key shape errors and return an actionable message.
 * Returns undefined when no shape error is detected. The hint only applies to
 * SHAPE errors — an unfindable `old_string` must never be routed to a rewrite.
 */
export function opShapeError(op: Record<string, unknown>): string | undefined {
	const has = (key: string) => op[key] !== undefined && op[key] !== null;
	switch (op.action) {
		case "create": {
			if (!has("content")) {
				if (has("file_content"))
					return "this op carries `file_content` (that key belongs to `write_file`) — move this text to `content`";
				if (has("new_string"))
					return "this op carries `new_string` (that key belongs to a targeted `patch`) — move this text to `content`";
				return "`content` is required for `create` (full SKILL.md text)";
			}
			return undefined;
		}
		case "patch": {
			if (!has("content") && !has("old_string")) {
				if (has("file_content"))
					return "this op carries `file_content` (that key belongs to `write_file`) — for a targeted patch use `old_string`/`new_string`, or `content` for a full rewrite";
				return "`patch` requires either `old_string`+`new_string` (targeted, preferred) or `content` (full rewrite). An unfindable `old_string` must NOT be replaced by a full rewrite — read the file first";
			}
			if (has("old_string")) {
				if (typeof op.old_string !== "string" || op.old_string === "")
					return "`old_string` must be a non-empty string";
				if (op.new_string === null || op.new_string === undefined)
					return '`new_string` is required (use "" to delete the matched text)';
			}
			return undefined;
		}
		case "write_file": {
			if (!has("file_content")) {
				if (has("content"))
					return "this op carries `content` (that key belongs to `create` or a rewrite `patch`) — move this text to `file_content`";
				return "`file_content` is required for `write_file`";
			}
			return undefined;
		}
		default:
			return undefined;
	}
}

export function validateStatusCode(value: unknown): ValidationResult {
	if (value === undefined || value === null) return ok;
	if (typeof value !== "string") return err("`status` must be a string");
	return ok;
}
