import { platform } from "os";
import { runClipboardCommand } from "./clipboard-command.ts";
import { isWaylandSession } from "./clipboard-image.ts";
import { clipboard } from "./clipboard-native.ts";

const MAX_OSC52_ENCODED_LENGTH = 100_000;
const CLIPBOARD_COMMAND_TIMEOUT_MS = 5000;

function isRemoteSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION);
}

function emitOsc52(text: string): boolean {
	const encoded = Buffer.from(text).toString("base64");
	if (encoded.length > MAX_OSC52_ENCODED_LENGTH) {
		return false;
	}
	process.stdout.write(`\x1b]52;c;${encoded}\x07`);
	return true;
}

/** Read plain text from the system clipboard. */
export async function readClipboardText(): Promise<string | null> {
	if (platform() === "linux" && isWaylandSession() && process.env.WAYLAND_DISPLAY) {
		// Asynchronous so a slow or hung wl-paste never blocks the TUI event loop.
		const bytes = await runClipboardCommand("wl-paste", ["--no-newline", "--type", "text"], {
			timeoutMs: CLIPBOARD_COMMAND_TIMEOUT_MS,
		});
		if (bytes !== undefined) {
			return bytes.toString("utf8") || null;
		}
	}

	if (!clipboard) {
		return null;
	}

	try {
		const text = await clipboard.getText();
		return text || null;
	} catch {
		return null;
	}
}

/**
 * Windows writer: `clip.exe` decodes stdin with the console code page, so UTF-8 accents
 * arrive corrupted, and UTF-16LE input either keeps its BOM in the clipboard or is
 * misdetected without one (CJK). PowerShell reads stdin as UTF-8 and calls Set-Clipboard;
 * the text never touches the command line, so nothing is interpolated or escaped.
 */
export const WINDOWS_SET_CLIPBOARD_SCRIPT =
	"$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false; Set-Clipboard -Value ([Console]::In.ReadToEnd())";

/** Platform clipboard writers, in preference order. */
function getClipboardWriteCommands(p: NodeJS.Platform, env: NodeJS.ProcessEnv): Array<[string, string[]]> {
	if (p === "darwin") return [["pbcopy", []]];
	if (p === "win32") {
		// clip stays as the fallback: it handles ASCII and the empty string, which Set-Clipboard rejects.
		return [
			["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SET_CLIPBOARD_SCRIPT]],
			["clip", []],
		];
	}

	const commands: Array<[string, string[]]> = [];
	if (env.TERMUX_VERSION) commands.push(["termux-clipboard-set", []]);
	if (isWaylandSession(env) && env.WAYLAND_DISPLAY) commands.push(["wl-copy", []]);
	if (env.DISPLAY) {
		commands.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
	}
	return commands;
}

function getClipboardFailureMessage(p: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
	if (p === "linux") {
		if (env.TERMUX_VERSION) {
			return "Failed to copy to clipboard: install the Termux:API app and the `termux-api` package";
		}
		if (env.WAYLAND_DISPLAY) {
			return "Failed to copy to clipboard: install `wl-clipboard` (`wl-copy`) or check Wayland access";
		}
		if (env.DISPLAY) {
			return "Failed to copy to clipboard: install `xclip` or `xsel`, or check X11 access";
		}
	}
	return "Failed to copy to clipboard";
}

export async function copyToClipboard(text: string): Promise<void> {
	let copied = false;

	const p = platform();
	const env = process.env;

	// Prefer direct clipboard writes. Emitting OSC 52 first can make terminals
	// write the same native clipboard concurrently with the addon, and very large
	// OSC 52 payloads can desynchronize terminal rendering.
	//
	// On Linux, skip the native addon. The underlying `clipboard-rs` crate is
	// X11-only and does not retain selection ownership after `set_text`
	// resolves, so on Wayland-only compositors (Hyprland, Niri, ...) and even
	// some X11 sessions the call resolves successfully without populating the
	// clipboard. The platform tools below (wl-copy, xclip, xsel) properly
	// daemonize and keep ownership.
	try {
		if (clipboard && p !== "linux") {
			await clipboard.setText(text);
			copied = true;
		}
	} catch {
		// Fall through to platform-specific clipboard tools.
	}

	const remote = isRemoteSession(env);
	if (copied && !remote) {
		return;
	}

	if (!copied) {
		// Spawned asynchronously (no execSync): a hung clipboard tool must not freeze the TUI.
		for (const [command, args] of getClipboardWriteCommands(p, env)) {
			const result = await runClipboardCommand(command, args, {
				input: text,
				timeoutMs: CLIPBOARD_COMMAND_TIMEOUT_MS,
			});
			if (result !== undefined) {
				copied = true;
				break;
			}
		}
	}

	// OSC 52 cannot be verified, so a local desktop session reports the failure instead of
	// a false success (#9618). Remote sessions always emit it to reach the client clipboard,
	// and display-less Linux (containers, WSL without WSLg) has no other clipboard route.
	const headless = p === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY && !env.TERMUX_VERSION;
	let oversized = false;
	if (remote || (!copied && headless)) {
		if (emitOsc52(text)) copied = true;
		else oversized = true;
	}

	if (copied) return;
	if (oversized) throw new Error("Failed to copy to clipboard: text exceeds the OSC 52 size limit");
	throw new Error(getClipboardFailureMessage(p, env));
}
