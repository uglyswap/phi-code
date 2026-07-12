import { APP_NAME } from "../config.js";
import type { SourceInfo } from "./source-info.js";

export type SlashCommandSource = "extension" | "prompt" | "skill";

export interface SlashCommandInfo {
	name: string;
	description?: string;
	source: SlashCommandSource;
	sourceInfo: SourceInfo;
}

export interface BuiltinSlashCommand {
	name: string;
	description: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path: .html/.jsonl)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous user message" },
	{ name: "clone", description: "Duplicate the current session at the current position" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
];

/**
 * Built-in interactive commands that take NO arguments. `/new please` used to
 * fall through the exact-match ladder and get sent to the model as prose —
 * silent and surprising. matchBareBuiltinWithArgs detects that shape so the
 * TUI can surface a usage warning instead.
 *
 * Commands that DO take arguments (/model, /export, /import, /name, /compact)
 * are not listed. Neither is /debug: an extension (the debug orchestrator)
 * legitimately owns "/debug <text>".
 */
export const BARE_BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set([
	"settings",
	"scoped-models",
	"share",
	"copy",
	"session",
	"changelog",
	"hotkeys",
	"fork",
	"clone",
	"tree",
	"login",
	"logout",
	"new",
	"reload",
	"resume",
	"quit",
]);

/** Return the command name when `text` is `/bare-builtin <extra args>`, else null. */
export function matchBareBuiltinWithArgs(text: string): string | null {
	if (!text.startsWith("/")) return null;
	const spaceIdx = text.indexOf(" ");
	if (spaceIdx === -1) return null;
	const name = text.slice(1, spaceIdx);
	return BARE_BUILTIN_COMMAND_NAMES.has(name) ? name : null;
}
