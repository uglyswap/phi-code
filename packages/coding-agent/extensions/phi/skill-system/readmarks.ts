/**
 * Read-before-write marks (plan §C4.2, H33).
 *
 * The bundled `read` tool cannot be hooked, but `tool_call` exposes its
 * arguments BEFORE execution and `event.input` is readable in place. Marks are
 * tracked by RESOLVED path and reset at the start of every review. Outside a
 * review fork the guard never blocks: foreground edits must not require marks.
 */

import { resolve } from "node:path";
import { isReviewFork } from "./config.ts";

const readMarks = new Set<string>();

export function recordReadMark(filePath: string): void {
	readMarks.add(resolve(filePath));
}

export function resetReadMarks(): void {
	readMarks.clear();
}

export function hasReadMark(filePath: string): boolean {
	return readMarks.has(resolve(filePath));
}

/**
 * Guard message when a write targets an existing file that was not read during
 * this review; undefined when the write is allowed. Only enforced inside a
 * review fork.
 */
export function readMarkError(filePath: string): string | undefined {
	if (!isReviewFork()) return undefined;
	if (hasReadMark(filePath)) return undefined;
	return (
		`read-before-write: \`read\` the exact file first — \`read ${resolve(filePath)}\` — then retry. ` +
		"Quoted conversation content does not count."
	);
}

/** `tool_call` handler payload shape (subset). */
export function noteToolCall(event: { toolName?: unknown; input?: unknown }): void {
	if (!isReviewFork()) return;
	if (event.toolName !== "read") return;
	const input = event.input;
	if (!input || typeof input !== "object") return;
	const path = (input as { path?: unknown }).path;
	if (typeof path === "string" && path.trim() !== "") recordReadMark(path);
}
