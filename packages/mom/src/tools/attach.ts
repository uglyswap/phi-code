import { realpathSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { basename, resolve as resolvePath, sep as pathSep } from "path";
import type { AgentTool } from "phi-code-agent";

// This will be set by the agent before running
let uploadFn: ((filePath: string, title?: string) => Promise<void>) | null = null;

// Workspace root the attach tool is allowed to read from. Set by the agent
// wiring before running so the documented "/workspace/ only" restriction is
// actually enforced at this trust boundary (attach is reachable from untrusted
// Slack input). When unset, only paths under "/workspace/" are accepted.
let workspaceRoot: string | null = null;

export function setUploadFunction(fn: (filePath: string, title?: string) => Promise<void>): void {
	uploadFn = fn;
}

export function setWorkspaceRoot(root: string | null): void {
	workspaceRoot = root ? resolvePath(root) : null;
}

/**
 * Returns true when `target` is contained within `root` (or equal to it).
 */
function isWithinRoot(target: string, root: string): boolean {
	return target === root || target.startsWith(root + pathSep) || target.startsWith(root + "/");
}

/**
 * Resolve and validate that the requested path stays inside the allowed
 * workspace root. Rejects path-traversal and symlink escapes. Throws on
 * violation so a non-workspace path can never be uploaded.
 */
function assertInsideWorkspace(requestedPath: string): void {
	const resolved = resolvePath(requestedPath);

	if (workspaceRoot) {
		if (!isWithinRoot(resolved, workspaceRoot)) {
			throw new Error("attach: only files under the workspace can be attached");
		}
		// Defend against symlink escapes: re-check the real (canonical) path.
		try {
			const real = realpathSync(resolved);
			if (!isWithinRoot(real, workspaceRoot)) {
				throw new Error("attach: only files under the workspace can be attached");
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("attach:")) {
				throw error;
			}
			// File may not exist yet on this host (docker path); fall through and
			// let the upload function surface a clear read error.
		}
		return;
	}

	// No workspace root configured: conservative default. The model addresses
	// files through the container path "/workspace/...", so reject any other
	// absolute path (e.g. /etc/passwd, ~/.pi/mom/auth.json). Check the raw
	// requested path too, since path.resolve may rewrite a POSIX container path
	// on a Windows controller. Reject any ".." traversal regardless.
	const usesTraversal = requestedPath.split(/[/\\]/).includes("..");
	const underWorkspace =
		requestedPath === "/workspace" ||
		requestedPath.startsWith("/workspace/") ||
		resolved === "/workspace" ||
		resolved.startsWith("/workspace/");
	if (underWorkspace && !usesTraversal) {
		return;
	}
	throw new Error("attach: only files under /workspace/ can be attached");
}

const attachSchema = Type.Object({
	label: Type.String({ description: "Brief description of what you're sharing (shown to user)" }),
	path: Type.String({ description: "Path to the file to attach" }),
	title: Type.Optional(Type.String({ description: "Title for the file (defaults to filename)" })),
});

export const attachTool: AgentTool<typeof attachSchema> = {
	name: "attach",
	label: "attach",
	description:
		"Attach a file to your response. Use this to share files, images, or documents with the user. Only files from /workspace/ can be attached.",
	parameters: attachSchema,
	execute: async (
		_toolCallId: string,
		{ path, title }: { label: string; path: string; title?: string },
		signal?: AbortSignal,
	) => {
		if (!uploadFn) {
			throw new Error("Upload function not configured");
		}

		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		assertInsideWorkspace(path);

		const absolutePath = resolvePath(path);
		const fileName = title || basename(absolutePath);

		await uploadFn(absolutePath, fileName);

		return {
			content: [{ type: "text" as const, text: `Attached file: ${fileName}` }],
			details: undefined,
		};
	},
};
