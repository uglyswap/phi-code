import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME } from "../../config.ts";

export interface ExternalEditorOptions {
	command: string;
	content: string;
}

export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed" };

/**
 * Split an editor command into executable + arguments, honouring quotes.
 *
 * A plain `command.split(" ")` breaks every Windows editor installed under a path
 * with a space — `C:\Program Files\Microsoft VS Code\Code.exe --wait` launched
 * `C:\Program` and failed silently. Quoting the executable is the portable way to
 * express that, so both `"C:\Program Files\...\Code.exe" --wait` and
 * `'/usr/bin/my editor' -w` now work, and `\"` escapes a literal quote.
 */
export function parseEditorCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let started = false;

	for (let index = 0; index < command.length; index++) {
		const char = command[index];

		if (char === "\\" && quote === '"' && command[index + 1] === '"') {
			current += '"';
			index++;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
			continue;
		}
		if (char === " " || char === "\t") {
			if (started) tokens.push(current);
			current = "";
			started = false;
			continue;
		}
		current += char;
		started = true;
	}

	if (started) tokens.push(current);
	return tokens;
}

export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), `${APP_NAME}-editor-`));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		const [editor, ...editorArgs] = parseEditorCommand(options.command);
		if (!editor) {
			return { status: "failed" };
		}
		process.stdout.write(
			`Launching external editor: ${options.command}\n${APP_NAME} will resume when the editor exits.\n`,
		);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		const exitCode = await new Promise<number | null>((resolve) => {
			const useShell = process.platform === "win32";
			// With shell:true the arguments are concatenated into a command line, so a
			// path containing a space has to carry its own quotes to survive.
			const quoteForShell = (value: string) => (useShell && /[\s&|<>^]/.test(value) ? `"${value}"` : value);
			const child = spawn(quoteForShell(editor), [...editorArgs, filePath].map(quoteForShell), {
				stdio: "inherit",
				shell: useShell,
			});
			child.on("error", () => resolve(null));
			child.on("close", (code) => resolve(code));
		});

		if (exitCode !== 0) {
			return { status: "failed" };
		}

		return { status: "complete", content: readFileSync(filePath, "utf-8").replace(/\n$/, "") };
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}
