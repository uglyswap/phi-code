import { existsSync } from "node:fs";
import { spawn } from "child_process";
import type { AgentTool } from "phi-code-agent";
import { Container, Text, truncateToWidth } from "phi-code-tui";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.js";
import { theme } from "../../modes/interactive/theme/theme.js";
import { waitForChildProcess } from "../../utils/child-process.js";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { OutputAccumulator } from "./output-accumulator.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.js";

const bashSchema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export type BashToolInput = Static<typeof bashSchema>;

export interface DestructiveCommandResult {
	blocked: boolean;
	reason?: string;
}

/**
 * Deterministic, local (zero API call) safety gate for destructive bash commands.
 *
 * Pure function: given a raw command string (and optionally the workspace cwd),
 * returns whether the command should be blocked and a human readable reason.
 *
 * This is intentionally conservative: a false negative (a dangerous command slips
 * through) is preferred over a false positive (a safe command is blocked). Only
 * patterns that are very clearly destructive are matched. The gate is meant to be
 * applied only during autonomous orchestration, never in normal interactive use.
 */
export function isDestructiveCommand(cmd: string, cwd?: string): DestructiveCommandResult {
	if (typeof cmd !== "string" || cmd.length === 0) {
		return { blocked: false };
	}
	// Normalize for matching: collapse runs of whitespace to single spaces.
	// The original command is still used for path extraction below.
	const normalized = cmd.replace(/\s+/g, " ").trim();
	const lower = normalized.toLowerCase();

	// Fork bombs (classic shell fork bomb and common variants).
	// Compare against a whitespace-stripped form to catch spacing variants.
	const dense = normalized.replace(/\s+/g, "");
	if (/\(\)\{:?\|:?&?\};:/.test(dense) || /\w+\(\)\{\w+\|\w+&\};/.test(dense)) {
		return { blocked: true, reason: "Fork bomb pattern detected." };
	}

	// Pipe a remote download straight into a shell interpreter (curl|sh, wget|sh, etc.).
	if (/\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/.test(lower)) {
		return { blocked: true, reason: "Piping a remote download directly into a shell is blocked." };
	}

	// Dangerous permission bypass flag.
	if (/--dangerously-skip-permissions\b/.test(lower)) {
		return { blocked: true, reason: "Use of --dangerously-skip-permissions is blocked." };
	}

	// Filesystem creation (mkfs) and raw disk writes (dd of=/dev/...).
	if (/\bmkfs(?:\.\w+)?\b/.test(lower)) {
		return { blocked: true, reason: "Filesystem creation (mkfs) is blocked." };
	}
	if (/\bdd\b[^\n]*\bof=\/dev\//.test(lower)) {
		return { blocked: true, reason: "Raw disk write (dd of=/dev/...) is blocked." };
	}

	// SQL: dropping a database.
	if (/\bdrop\s+database\b/.test(lower)) {
		return { blocked: true, reason: "DROP DATABASE is blocked." };
	}

	// Git: force push, pushing to main/master, hard reset, aggressive clean.
	if (/\bgit\s+push\b/.test(lower)) {
		if (/\bgit\s+push\b[^\n]*(?:--force-with-lease\b|--force\b|\s-f\b)/.test(lower)) {
			return { blocked: true, reason: "git push --force / --force-with-lease is blocked." };
		}
		if (
			/\bgit\s+push\b[^\n]*\borigin\b[^\n]*\b(?:main|master)\b/.test(lower) ||
			/\bgit\s+push\b\s+(?:main|master)\b/.test(lower)
		) {
			return { blocked: true, reason: "git push to main/master is blocked." };
		}
	}
	if (/\bgit\s+reset\b[^\n]*--hard\b/.test(lower)) {
		return { blocked: true, reason: "git reset --hard is blocked." };
	}
	if (/\bgit\s+clean\b/.test(lower)) {
		// Match a single combined flag (e.g. -fdx, -xfd) containing f, d and x.
		const cleanFlag = lower.match(/\bgit\s+clean\b[^\n]*?(-[a-z]+)/);
		if (cleanFlag && /f/.test(cleanFlag[1]) && /d/.test(cleanFlag[1]) && /x/.test(cleanFlag[1])) {
			return { blocked: true, reason: "git clean -fdx is blocked." };
		}
		// Match separate flags (e.g. -f -d -x).
		if (/(?:^|\s)-[a-z]*f/.test(lower) && /(?:^|\s)-[a-z]*d/.test(lower) && /(?:^|\s)-[a-z]*x/.test(lower)) {
			return { blocked: true, reason: "git clean -fdx is blocked." };
		}
	}

	// rm -rf targeting paths outside the workspace cwd.
	// Split on common command separators and inspect each rm segment that
	// carries both recursive and force flags.
	const segments = normalized.split(/&&|\|\||[;&|]/);
	for (const segment of segments) {
		if (!/\brm\b/.test(segment)) continue;
		if (!hasRecursiveForceFlags(segment)) continue;
		const verdict = inspectRmTargets(segment, cwd);
		if (verdict.blocked) return verdict;
	}

	return { blocked: false };
}

/**
 * Return true when an rm segment carries both a recursive flag (-r / -R) and a
 * force flag (-f), either combined (-rf, -fr) or as separate tokens.
 */
function hasRecursiveForceFlags(segment: string): boolean {
	const flagTokens = segment.split(/\s+/).filter((t) => t.startsWith("-") && !t.startsWith("--"));
	let recursive = false;
	let force = false;
	for (const flag of flagTokens) {
		if (/[rR]/.test(flag)) recursive = true;
		if (/f/.test(flag)) force = true;
	}
	if (/--recursive\b/.test(segment)) recursive = true;
	if (/--force\b/.test(segment)) force = true;
	return recursive && force;
}

/**
 * Inspect the path arguments of an `rm -rf` segment and block targets that
 * clearly escape the workspace cwd (root, home, parent traversal, absolute
 * paths outside cwd, or broad wildcards). Relative paths that stay inside the
 * workspace are allowed.
 */
function inspectRmTargets(rmSegment: string, cwd?: string): DestructiveCommandResult {
	// Strip the leading `rm` and its flag tokens, keep the operands.
	const withoutRm = rmSegment.replace(/^.*?\brm\b/i, "");
	const tokens = withoutRm.split(/\s+/).filter((t) => t.length > 0 && !t.startsWith("-"));
	for (const rawToken of tokens) {
		// Unquote a leading/trailing quote pair for inspection.
		const token = rawToken.replace(/^['"]/, "").replace(/['"]$/, "");
		if (token.length === 0) continue;
		// Root or near-root absolute targets.
		if (token === "/" || /^\/\*?$/.test(token)) {
			return { blocked: true, reason: "rm -rf targeting the filesystem root is blocked." };
		}
		// Home directory targets.
		if (token === "~" || token.startsWith("~/") || token === "$HOME" || token.startsWith("$HOME/")) {
			return { blocked: true, reason: "rm -rf targeting the home directory is blocked." };
		}
		// Parent-directory traversal escapes the workspace.
		if (token === ".." || token.startsWith("../") || token.includes("/../")) {
			return { blocked: true, reason: "rm -rf with parent-directory traversal (..) is blocked." };
		}
		// Absolute path: allow only if it stays inside the workspace cwd.
		if (token.startsWith("/")) {
			const target = token.replace(/\*+$/, "");
			if (cwd) {
				const normalizedCwd = cwd.replace(/[\\/]+$/, "");
				if (target === normalizedCwd || target.startsWith(`${normalizedCwd}/`)) {
					continue;
				}
			}
			return { blocked: true, reason: "rm -rf targeting an absolute path outside the workspace is blocked." };
		}
	}
	return { blocked: false };
}

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) => {
			return new Promise((resolve, reject) => {
				const { shell, args } = getShellConfig(options?.shellPath);
				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
					return;
				}
				const child = spawn(shell, [...args, command], {
					cwd,
					detached: process.platform !== "win32",
					env: env ?? getShellEnv(),
					stdio: ["ignore", "pipe", "pipe"],
					// Avoid spawning a visible console window on Windows for the shell process.
					windowsHide: true,
				});
				if (child.pid) trackDetachedChildPid(child.pid);
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				// Set timeout if provided.
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				waitForChildProcess(child)
					.then((code) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						if (signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						if (timedOut) {
							reject(new Error(`timeout:${timeout}`));
							return;
						}
						resolve({ exitCode: code });
					})
					.catch((err) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						reject(err);
					});
			});
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 5;
const BASH_UPDATE_THROTTLE_MS = 100;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};

class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();

	const output = getTextOutput(result as any, showImages).trim();

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint =
							theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
							` ${keyHint("app.tools.expand", "to expand")})`;
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds. When the command is shown in the TUI or logs, describe it in a concise active voice imperative ("List files", "Run the build", "Install dependencies"), not "Lists..." or "This command...".`,
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		parameters: bashSchema,
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			// Deterministic local safety gate: only active during autonomous
			// orchestration. In normal interactive use nothing is blocked.
			if ((globalThis as any).__phiOrchestrationActive === true) {
				const verdict = isDestructiveCommand(command, cwd);
				if (verdict.blocked) {
					throw new Error(
						`Command blocked by safety gate: ${verdict.reason ?? "destructive command"}\n` +
							"This guard is active only during autonomous orchestration.",
					);
				}
			}

			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
