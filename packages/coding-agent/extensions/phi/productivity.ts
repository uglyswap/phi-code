/**
 * Productivity Extension - three deterministic, LLM-free helper commands.
 *
 * Like commit.ts, this file never calls a model: every command derives its
 * output purely from local state (the session transcript, the memory store on
 * disk, package.json / lockfiles). That makes the results fully reproducible
 * and immune to a flaky structured-output proxy or a single rate-limited key.
 *
 * Commands:
 *   /title          : derive a session title + kebab-case branch name from the
 *                     first user message. Sets the session name when the host
 *                     supports it (pi.setSessionName), otherwise just proposes.
 *   /dream          : deterministic memory consolidation. Lists memory notes,
 *                     finds EXACT (content-hash) duplicates, and REPORTS what
 *                     could be merged. It never deletes anything: the user is
 *                     asked to confirm, respecting the non-deletion rule.
 *   /agents-init    : write a minimal AGENTS.md at the repo root when none
 *                     exists, populated with detected build/test/lint commands
 *                     and the detected package manager. Never overwrites an
 *                     existing AGENTS.md; it reports its content instead.
 *
 * Robustness: there is no network or LLM call anywhere. Each handler is wrapped
 * in try/catch and reports via ctx.ui.notify, so a failure is surfaced as a
 * message and never throws out to the user.
 *
 * Security: /title treats the first user message as untrusted text. It is used
 * only to derive a title/slug (no instruction following, no execution), and the
 * derivation strips everything but a small whitelist of characters.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "phi-code";
import { SigmaMemory } from "sigma-memory";

/** Bounds for the derived session title (in words). */
const TITLE_MIN_WORDS = 4;
const TITLE_MAX_WORDS = 8;

/** Maximum length of the derived kebab-case branch slug. */
const BRANCH_SLUG_MAX = 40;

/** Cap on how many duplicate groups /dream reports, to keep output bounded. */
const DREAM_MAX_GROUPS = 25;

// ============================================================================
// Shared text helpers (pure, deterministic)
// ============================================================================

/**
 * Flatten an AgentMessage content (string or content-part array) into plain
 * text, keeping only text parts. Mirrors the defensive extraction used in
 * commit.ts so it stays valid across both string and array message shapes.
 */
function messageText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: "text"; text: string } => {
				const part = c as { type?: unknown; text?: unknown };
				return part?.type === "text" && typeof part.text === "string";
			})
			.map((c) => c.text)
			.join("\n");
	}
	return "";
}

/**
 * Extract the text of the FIRST user message in the session transcript.
 * Returns an empty string when there is no user message yet.
 */
function firstUserMessageText(ctx: ExtensionCommandContext): string {
	const entries = ctx.sessionManager.getEntries();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") {
			continue;
		}
		const text = messageText(entry.message.content).trim();
		if (text.length > 0) {
			return text;
		}
	}
	return "";
}

/**
 * Tokenize free text into clean lowercase-able words.
 *
 * Strips markdown/code fences first, then keeps only [A-Za-z0-9] word cores so
 * untrusted user content cannot smuggle anything beyond plain words. Every
 * other byte (including control characters) acts as a separator.
 */
function cleanWords(text: string): string[] {
	const stripped = text
		// Drop fenced code blocks and inline code so titles stay readable.
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ");
	// Only [A-Za-z0-9] word cores survive; every other byte (including control
	// characters and escape sequences) acts as a separator, so untrusted user
	// content cannot smuggle anything beyond plain words.
	const matches = stripped.match(/[A-Za-z0-9]+/g);
	return matches ? matches : [];
}

/**
 * Build a human-readable title from the first words of the source text.
 * Capitalizes the first word; clamps to [TITLE_MIN_WORDS, TITLE_MAX_WORDS].
 */
function deriveTitle(words: string[]): string {
	const chosen = words.slice(0, TITLE_MAX_WORDS);
	if (chosen.length === 0) {
		return "";
	}
	const title = chosen.join(" ");
	return title.charAt(0).toUpperCase() + title.slice(1);
}

/**
 * Build a kebab-case branch slug (a-z0-9-, max BRANCH_SLUG_MAX chars).
 * Trailing partial words are dropped so the slug never ends on a hyphen.
 */
function deriveBranchSlug(words: string[]): string {
	const lower = words.map((w) => w.toLowerCase()).filter(Boolean);
	if (lower.length === 0) {
		return "";
	}
	let slug = "";
	for (const word of lower) {
		const next = slug.length === 0 ? word : `${slug}-${word}`;
		if (next.length > BRANCH_SLUG_MAX) {
			break;
		}
		slug = next;
	}
	// If the very first word already exceeds the cap, hard-truncate it.
	if (slug.length === 0) {
		slug = lower[0].slice(0, BRANCH_SLUG_MAX);
	}
	return slug.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

// ============================================================================
// /dream helpers (deterministic memory consolidation)
// ============================================================================

/**
 * Normalize a note's content for duplicate detection.
 *
 * Drops a leading YAML frontmatter block (filename-specific metadata differs
 * between otherwise-identical facts), collapses whitespace, and lowercases, so
 * two notes that say the same thing hash to the same value.
 */
function normalizeNoteBody(content: string): string {
	let text = content.replace(/\r\n/g, "\n");
	if (text.startsWith("---\n")) {
		const end = text.indexOf("\n---", 4);
		if (end !== -1) {
			text = text.slice(end + 4);
		}
	}
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Stable content hash used to bucket exact-duplicate notes. */
function contentHash(normalized: string): string {
	return createHash("sha256").update(normalized).digest("hex");
}

interface DuplicateGroup {
	hash: string;
	names: string[];
}

/**
 * Group memory note names by normalized-content hash and keep only the buckets
 * with more than one member (the exact-duplicate groups). Pure: reads notes,
 * computes hashes, returns groups. No deletion, no network.
 */
function findExactDuplicateGroups(memory: SigmaMemory): DuplicateGroup[] {
	const byHash = new Map<string, string[]>();
	const files = memory.notes.list();
	for (const file of files) {
		let body: string;
		try {
			body = normalizeNoteBody(memory.notes.read(file.name));
		} catch {
			// Unreadable note: skip it rather than aborting the whole scan.
			continue;
		}
		if (body.length === 0) {
			continue;
		}
		const hash = contentHash(body);
		const bucket = byHash.get(hash);
		if (bucket) {
			bucket.push(file.name);
		} else {
			byHash.set(hash, [file.name]);
		}
	}

	const groups: DuplicateGroup[] = [];
	for (const [hash, names] of byHash) {
		if (names.length > 1) {
			groups.push({ hash, names: names.slice().sort() });
		}
	}
	// Largest groups first for a useful, stable report.
	groups.sort((a, b) => b.names.length - a.names.length || a.hash.localeCompare(b.hash));
	return groups;
}

// ============================================================================
// /agents-init helpers (deterministic project introspection)
// ============================================================================

interface PackageManagerInfo {
	name: string;
	lockfile: string;
	install: string;
	run: string;
}

/**
 * Detect the package manager from lockfiles at the repo root.
 * Order matters: the most specific lockfiles are checked first. Falls back to
 * npm when no lockfile is present.
 */
function detectPackageManager(root: string): PackageManagerInfo {
	const candidates: Array<{ lockfile: string; info: PackageManagerInfo }> = [
		{ lockfile: "bun.lockb", info: { name: "bun", lockfile: "bun.lockb", install: "bun install", run: "bun run" } },
		{ lockfile: "bun.lock", info: { name: "bun", lockfile: "bun.lock", install: "bun install", run: "bun run" } },
		{
			lockfile: "pnpm-lock.yaml",
			info: { name: "pnpm", lockfile: "pnpm-lock.yaml", install: "pnpm install", run: "pnpm" },
		},
		{ lockfile: "yarn.lock", info: { name: "yarn", lockfile: "yarn.lock", install: "yarn install", run: "yarn" } },
		{
			lockfile: "package-lock.json",
			info: { name: "npm", lockfile: "package-lock.json", install: "npm install", run: "npm run" },
		},
	];
	for (const candidate of candidates) {
		if (existsSync(join(root, candidate.lockfile))) {
			return candidate.info;
		}
	}
	return { name: "npm", lockfile: "(none detected)", install: "npm install", run: "npm run" };
}

/**
 * Read the scripts map from a package.json at the repo root.
 * Returns an empty object on any error (missing file, invalid JSON), so callers
 * degrade gracefully instead of throwing.
 */
function readScripts(root: string): Record<string, string> {
	try {
		const raw = readFileSync(join(root, "package.json"), "utf-8");
		const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
		const scripts = parsed.scripts ?? {};
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(scripts)) {
			if (typeof value === "string") {
				out[key] = value;
			}
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Pick the first script name present from a list of common aliases.
 * Used to map "build"/"test"/"lint" intents onto the project's actual scripts.
 */
function pickScript(scripts: Record<string, string>, candidates: string[]): string | undefined {
	for (const name of candidates) {
		if (name in scripts) {
			return name;
		}
	}
	return undefined;
}

/** Render the AGENTS.md body from detected package manager + scripts. */
function buildAgentsMarkdown(pm: PackageManagerInfo, scripts: Record<string, string>): string {
	const buildScript = pickScript(scripts, ["build", "compile"]);
	const testScript = pickScript(scripts, ["test", "tests"]);
	const lintScript = pickScript(scripts, ["lint", "check", "format"]);

	const cmd = (script: string | undefined): string => (script ? `\`${pm.run} ${script}\`` : "(not detected)");

	const lines: string[] = [];
	lines.push("# AGENTS.md");
	lines.push("");
	lines.push("Generated by `/agents-init` (deterministic: from package.json + lockfile).");
	lines.push("");
	lines.push("## Package manager");
	lines.push("");
	lines.push(`- Detected: **${pm.name}** (lockfile: ${pm.lockfile})`);
	lines.push(`- Install: \`${pm.install}\``);
	lines.push("");
	lines.push("## Commands");
	lines.push("");
	lines.push(`- Build: ${cmd(buildScript)}`);
	lines.push(`- Test: ${cmd(testScript)}`);
	lines.push(`- Lint / check: ${cmd(lintScript)}`);
	lines.push("");
	lines.push("## Gotchas");
	lines.push("");
	lines.push("<!-- TODO: document project-specific gotchas, env vars, and non-obvious workflows here. -->");
	lines.push("");
	return lines.join("\n");
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function productivityExtension(pi: ExtensionAPI) {
	// One shared memory handle for /dream. Construction is cheap (no I/O beyond
	// ensuring the notes directory exists); init() is intentionally skipped
	// because /dream only needs deterministic notes listing/reading.
	const memory = new SigmaMemory();

	// ------------------------------------------------------------------------
	// /title
	// ------------------------------------------------------------------------
	pi.registerCommand("title", {
		description: "Derive a session title + kebab-case branch name from the first user message (deterministic, no LLM).",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			try {
				const source = firstUserMessageText(ctx);
				if (source.length === 0) {
					ctx.ui.notify("No user message yet: send a first message, then run `/title`.", "warning");
					return;
				}

				const words = cleanWords(source);
				if (words.length < TITLE_MIN_WORDS) {
					ctx.ui.notify(
						`First message has too few usable words (${words.length}) to derive a meaningful title.`,
						"warning",
					);
					return;
				}

				const title = deriveTitle(words);
				const branch = deriveBranchSlug(words);
				if (!title || !branch) {
					ctx.ui.notify("Could not derive a title/branch from the first message.", "warning");
					return;
				}

				// Best-effort: set the session name when the host supports it.
				let applied = false;
				try {
					if (typeof pi.setSessionName === "function") {
						pi.setSessionName(title);
						applied = true;
					}
				} catch {
					// Naming is best-effort; fall back to proposing only.
					applied = false;
				}

				const status = applied
					? "Session name set to the title below."
					: "Session naming API unavailable: proposed values only.";
				ctx.ui.notify(
					`**Title:** ${title}\n**Branch:** \`${branch}\`\n\n${status}\n` +
						`Create the branch with: \`git checkout -b ${branch}\``,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`/title error: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// ------------------------------------------------------------------------
	// /dream
	// ------------------------------------------------------------------------
	pi.registerCommand("dream", {
		description: "Deterministic memory consolidation: report exact-duplicate notes that could be merged (no deletion).",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			try {
				const files = memory.notes.list();
				if (files.length === 0) {
					ctx.ui.notify("Memory is empty: no notes to consolidate.", "info");
					return;
				}

				const groups = findExactDuplicateGroups(memory);
				if (groups.length === 0) {
					ctx.ui.notify(
						`Scanned ${files.length} note(s): no exact duplicates found. Memory is already consolidated.`,
						"info",
					);
					return;
				}

				const shown = groups.slice(0, DREAM_MAX_GROUPS);
				const duplicateCount = groups.reduce((sum, g) => sum + (g.names.length - 1), 0);

				let out = `**/dream consolidation report**\n\n`;
				out += `Scanned ${files.length} note(s). Found ${groups.length} group(s) of exact duplicates `;
				out += `(${duplicateCount} redundant copy/copies).\n\n`;
				for (let i = 0; i < shown.length; i++) {
					const group = shown[i];
					const [keep, ...rest] = group.names;
					out += `${i + 1}. Keep \`${keep}\`, redundant: ${rest.map((n) => `\`${n}\``).join(", ")}\n`;
				}
				if (groups.length > shown.length) {
					out += `\n… and ${groups.length - shown.length} more group(s).\n`;
				}
				out += `\nNothing was deleted. Review the redundant files above and remove the copies you confirm `;
				out += `with your editor or git. (Non-deletion is enforced: /dream only reports.)`;

				ctx.ui.notify(out, "info");
			} catch (err) {
				ctx.ui.notify(`/dream error: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});

	// ------------------------------------------------------------------------
	// /agents-init
	// ------------------------------------------------------------------------
	pi.registerCommand("agents-init", {
		description: "Write a minimal AGENTS.md (build/test/lint + package manager) at the repo root if none exists.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			try {
				const root = ctx.cwd;
				const agentsPath = join(root, "AGENTS.md");
				const pm = detectPackageManager(root);
				const scripts = readScripts(root);
				const markdown = buildAgentsMarkdown(pm, scripts);

				if (existsSync(agentsPath)) {
					// Never overwrite an existing AGENTS.md. Propose the generated
					// content instead and tell the user exactly where it lives.
					ctx.ui.notify(
						`AGENTS.md already exists at \`${agentsPath}\`. It was NOT modified.\n\n` +
							`Proposed content (copy in manually if you want it):\n\n${markdown}`,
						"warning",
					);
					return;
				}

				try {
					writeFileSync(agentsPath, markdown, "utf-8");
				} catch (writeErr) {
					ctx.ui.notify(
						`Failed to write AGENTS.md: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`,
						"error",
					);
					return;
				}

				ctx.ui.notify(
					`Wrote AGENTS.md to \`${agentsPath}\` (package manager: ${pm.name}). ` +
						`Edit the Gotchas section to add project-specific notes.`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(`/agents-init error: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
