/**
 * Commit Extension - /commit command for deterministic, LLM-free git commits.
 *
 * Inspired by examples/extensions/auto-commit-on-exit.ts, but exposed as an
 * explicit user command and hardened with a strict safety protocol. There is
 * NO model call anywhere in this file: the commit message is derived purely
 * from git state and the local session, so the result is fully reproducible
 * and never depends on a flaky structured-output proxy.
 *
 * Usage:
 *   /commit                  : commit what is already staged (no auto-staging)
 *   /commit <message>        : commit already-staged changes with that message
 *   /commit --all            : stage everything (git add -A) then commit
 *   /commit --all <message>  : stage everything then commit with that message
 *
 * Message format: always prefixed with "[phi] ". When the user passes a
 * message it is used verbatim after the prefix. Otherwise the message is
 * derived deterministically from the staged files (git diff --staged --stat /
 * git status) plus the first line of the last assistant message when present.
 *
 * Safety protocol (strict):
 *   - Refuses to commit if a sensitive file is staged (.env, *.pem, *secret*,
 *     id_rsa). The user is warned and nothing is committed.
 *   - Never uses --amend.
 *   - Only stages with `git add -A` when --all is passed; otherwise it commits
 *     strictly what is already in the index.
 *   - The message is passed via a single pi.exec("git", ["commit", "-m", msg])
 *     call: no shell string interpolation, robust cross-OS.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "phi-code";

/** Max length of the derived subject line (without the "[phi] " prefix). */
const MAX_SUBJECT_LENGTH = 60;

/** Max number of file names listed in an auto-derived commit message. */
const MAX_LISTED_FILES = 3;

/**
 * Patterns for files that must never be committed by this command.
 * Matched against the path of each staged file (case-insensitive on basename).
 */
const SENSITIVE_PATTERNS: { label: string; test: (path: string) => boolean }[] = [
	{
		label: ".env file",
		test: (p) => {
			const base = basename(p).toLowerCase();
			return base === ".env" || base.startsWith(".env.");
		},
	},
	{ label: "PEM/key file", test: (p) => p.toLowerCase().endsWith(".pem") },
	{ label: "secret-named file", test: (p) => basename(p).toLowerCase().includes("secret") },
	{ label: "SSH private key", test: (p) => basename(p).toLowerCase() === "id_rsa" },
];

/** Return the last path segment, tolerating both / and \ separators. */
function basename(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const idx = normalized.lastIndexOf("/");
	return idx === -1 ? normalized : normalized.slice(idx + 1);
}

/**
 * Parse `git status --porcelain` output into staged file paths.
 *
 * Porcelain v1 lines are "XY <path>" where X is the index (staged) status.
 * A file is considered staged when X is not a space and not "?" (untracked).
 * Rename entries use "orig -> dest"; we keep the destination path.
 */
function parseStagedFiles(porcelain: string): string[] {
	const files: string[] = [];
	for (const rawLine of porcelain.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (line.length < 4) {
			continue;
		}
		const indexStatus = line[0];
		if (indexStatus === " " || indexStatus === "?") {
			continue;
		}
		let pathPart = line.slice(3).trim();
		const renameSep = pathPart.indexOf(" -> ");
		if (renameSep !== -1) {
			pathPart = pathPart.slice(renameSep + 4).trim();
		}
		// Porcelain quotes paths containing special chars; strip surrounding quotes.
		if (pathPart.startsWith('"') && pathPart.endsWith('"')) {
			pathPart = pathPart.slice(1, -1);
		}
		if (pathPart.length > 0) {
			files.push(pathPart);
		}
	}
	return files;
}

/** Find the first sensitive file among the staged paths, if any. */
function findSensitiveFile(stagedFiles: string[]): { path: string; label: string } | undefined {
	for (const path of stagedFiles) {
		for (const pattern of SENSITIVE_PATTERNS) {
			if (pattern.test(path)) {
				return { path, label: pattern.label };
			}
		}
	}
	return undefined;
}

/** Extract the first line of the last assistant message from the session. */
function lastAssistantFirstLine(ctx: ExtensionCommandContext): string {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}
		const content = entry.message.content;
		let text = "";
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			text = content
				.filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
				.map((c) => c.text)
				.join("\n");
		}
		const firstLine = text.split("\n").find((l) => l.trim().length > 0);
		return firstLine ? firstLine.trim() : "";
	}
	return "";
}

/** Collapse whitespace and clamp to MAX_SUBJECT_LENGTH with an ellipsis. */
function clampSubject(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= MAX_SUBJECT_LENGTH) {
		return collapsed;
	}
	return `${collapsed.slice(0, MAX_SUBJECT_LENGTH - 3)}...`;
}

/**
 * Build a deterministic subject derived from the staged files plus the first
 * line of the last assistant message. No LLM involved.
 */
function deriveSubject(stagedFiles: string[], assistantHint: string): string {
	const names = stagedFiles.map(basename);
	let filesPart: string;
	if (names.length === 0) {
		filesPart = "changes";
	} else if (names.length <= MAX_LISTED_FILES) {
		filesPart = names.join(", ");
	} else {
		const shown = names.slice(0, MAX_LISTED_FILES).join(", ");
		filesPart = `${shown} (+${names.length - MAX_LISTED_FILES} more)`;
	}

	const hint = assistantHint.trim();
	const subject = hint.length > 0 ? `update ${filesPart}: ${hint}` : `update ${filesPart}`;
	return clampSubject(subject);
}

export default function commitExtension(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Deterministically commit staged changes ([phi] prefix, no LLM). Use --all to stage everything first.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			try {
				// 1. Parse args: extract the --all flag, keep the rest as the message.
				const tokens = args.trim().split(/\s+/).filter(Boolean);
				const stageAll = tokens.includes("--all");
				const userMessage = tokens.filter((t) => t !== "--all").join(" ").trim();

				// 2. Confirm we are inside a git repo with changes.
				const status = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });
				if (status.code !== 0) {
					ctx.ui.notify(
						"Not a git repository (or git unavailable). Nothing to commit.",
						"warning",
					);
					return;
				}
				if (status.stdout.trim().length === 0) {
					ctx.ui.notify("Working tree clean: nothing to commit.", "info");
					return;
				}

				// 3. Optionally stage everything (only when explicitly requested).
				if (stageAll) {
					const add = await pi.exec("git", ["add", "-A"], { cwd: ctx.cwd });
					if (add.code !== 0) {
						ctx.ui.notify(`git add -A failed: ${add.stderr.trim() || "unknown error"}`, "error");
						return;
					}
				}

				// 4. Re-read status to know exactly what is staged after any add.
				const afterStatus = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd });
				const stagedFiles = parseStagedFiles(afterStatus.stdout);
				if (stagedFiles.length === 0) {
					ctx.ui.notify(
						"No staged changes to commit. Stage files first, or run `/commit --all`.",
						"warning",
					);
					return;
				}

				// 5. Safety protocol: refuse if a sensitive file is staged.
				const sensitive = findSensitiveFile(stagedFiles);
				if (sensitive) {
					ctx.ui.notify(
						`Refusing to commit: sensitive ${sensitive.label} is staged (\`${sensitive.path}\`). ` +
							`Unstage it with \`git restore --staged ${sensitive.path}\` before committing.`,
						"error",
					);
					return;
				}

				// 6. Build the deterministic message.
				let subject: string;
				if (userMessage.length > 0) {
					subject = userMessage;
				} else {
					const hint = lastAssistantFirstLine(ctx);
					subject = deriveSubject(stagedFiles, hint);
				}
				const message = `[phi] ${subject}`;

				// 7. Commit via a single exec call (no shell, no --amend).
				const commit = await pi.exec("git", ["commit", "-m", message], { cwd: ctx.cwd });
				if (commit.code !== 0) {
					ctx.ui.notify(
						`git commit failed: ${commit.stderr.trim() || commit.stdout.trim() || "unknown error"}`,
						"error",
					);
					return;
				}

				// 8. Report the result with the short hash.
				const rev = await pi.exec("git", ["rev-parse", "--short", "HEAD"], { cwd: ctx.cwd });
				const shortHash = rev.code === 0 ? rev.stdout.trim() : "(unknown)";
				ctx.ui.notify(
					`Committed ${shortHash}: ${message} (${stagedFiles.length} file${stagedFiles.length === 1 ? "" : "s"}).`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(
					`/commit error: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});
}
