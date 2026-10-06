import { platform } from "os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard, readClipboardText } from "../src/utils/clipboard.ts";

const mocks = vi.hoisted(() => {
	return {
		clipboard: {
			getText: vi.fn<() => Promise<string>>(),
			setText: vi.fn<(text: string) => Promise<void>>(),
		},
		command:
			vi.fn<
				(
					command: string,
					args: readonly string[],
					options?: { input?: string; timeoutMs?: number; maxBufferBytes?: number },
				) => Promise<Buffer | undefined>
			>(),
		platform: vi.fn<() => NodeJS.Platform>(),
		isWaylandSession: vi.fn<() => boolean>(),
	};
});

vi.mock("../src/utils/clipboard-native.ts", () => {
	return {
		clipboard: mocks.clipboard,
	};
});

vi.mock("../src/utils/clipboard-command.ts", () => {
	return {
		runClipboardCommand: mocks.command,
	};
});

vi.mock("os", () => {
	return {
		platform: mocks.platform,
	};
});

vi.mock("../src/utils/clipboard-image.ts", () => {
	return {
		isWaylandSession: mocks.isWaylandSession,
	};
});

const mockedPlatform = vi.mocked(platform);

let originalWrite: typeof process.stdout.write;
let stdoutWrites: string[];
let nativeResolved = false;

function osc52Writes(): string[] {
	return stdoutWrites.filter((write) => write.startsWith("\x1b]52;c;"));
}

function commandNames(): string[] {
	return mocks.command.mock.calls.map(([name]) => name);
}

beforeEach(() => {
	vi.unstubAllEnvs();
	for (const name of [
		"SSH_CONNECTION",
		"SSH_CLIENT",
		"MOSH_CONNECTION",
		"WAYLAND_DISPLAY",
		"DISPLAY",
		"TERMUX_VERSION",
	]) {
		vi.stubEnv(name, "");
	}
	stdoutWrites = [];
	nativeResolved = false;
	mocks.clipboard.getText.mockReset();
	mocks.clipboard.setText.mockReset();
	mocks.command.mockReset();
	mocks.platform.mockReset();
	mocks.isWaylandSession.mockReset();
	mockedPlatform.mockReturnValue("darwin");
	mocks.isWaylandSession.mockReturnValue(false);
	mocks.clipboard.getText.mockResolvedValue("");
	mocks.clipboard.setText.mockImplementation(async () => {
		await new Promise((resolve) => setTimeout(resolve, 1));
		nativeResolved = true;
	});
	mocks.command.mockResolvedValue(Buffer.alloc(0));
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
		const [chunk] = args;
		if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) {
			stdoutWrites.push(chunk);
			return true;
		}
		return originalWrite(...args);
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
	vi.unstubAllEnvs();
});

describe("readClipboardText", () => {
	test("returns native clipboard text", async () => {
		mocks.clipboard.getText.mockResolvedValue("clipboard text");

		await expect(readClipboardText()).resolves.toBe("clipboard text");
		expect(mocks.command).not.toHaveBeenCalled();
	});

	test("reads the Wayland clipboard before the stale native X11 clipboard", async () => {
		// Regression test for #7248.
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mocks.command.mockResolvedValue(Buffer.from("Wayland text"));
		mocks.clipboard.getText.mockResolvedValue("stale X11 text");

		await expect(readClipboardText()).resolves.toBe("Wayland text");
		expect(mocks.command).toHaveBeenCalledWith("wl-paste", ["--no-newline", "--type", "text"], {
			timeoutMs: 5000,
		});
		expect(mocks.clipboard.getText).not.toHaveBeenCalled();
	});

	test("does not fall back to stale X11 text when the Wayland clipboard is empty", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mocks.command.mockResolvedValue(Buffer.alloc(0));
		mocks.clipboard.getText.mockResolvedValue("stale X11 text");

		await expect(readClipboardText()).resolves.toBeNull();
		expect(mocks.clipboard.getText).not.toHaveBeenCalled();
	});

	test("falls back to the native clipboard when wl-paste is unavailable", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mocks.command.mockResolvedValue(undefined);
		mocks.clipboard.getText.mockResolvedValue("X11 fallback text");

		await expect(readClipboardText()).resolves.toBe("X11 fallback text");
	});

	test("returns null for empty or unavailable clipboard text", async () => {
		await expect(readClipboardText()).resolves.toBeNull();

		mocks.clipboard.getText.mockRejectedValue(new Error("clipboard unavailable"));
		await expect(readClipboardText()).resolves.toBeNull();
	});
});

describe("copyToClipboard", () => {
	test("local native success skips OSC 52 and commands", async () => {
		await copyToClipboard("hello");

		expect(osc52Writes()).toHaveLength(0);
		expect(mocks.command).not.toHaveBeenCalled();
	});

	test("remote native success emits OSC 52 after native write", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.clipboard.setText.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			expect(osc52Writes()).toHaveLength(0);
			nativeResolved = true;
		});

		await copyToClipboard("hello");

		expect(nativeResolved).toBe(true);
		expect(osc52Writes()).toHaveLength(1);
		expect(mocks.command).not.toHaveBeenCalled();
	});

	test("a rejected native write falls back to pbcopy without OSC 52", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));

		await copyToClipboard("hello");

		expect(mocks.command).toHaveBeenCalledWith("pbcopy", [], { input: "hello", timeoutMs: 5000 });
		expect(osc52Writes()).toHaveLength(0);
	});

	test("Linux skips the native writer", async () => {
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("DISPLAY", ":0");

		await copyToClipboard("hello");

		expect(mocks.clipboard.setText).not.toHaveBeenCalled();
		expect(mocks.command).toHaveBeenCalledWith("xclip", ["-selection", "clipboard"], {
			input: "hello",
			timeoutMs: 5000,
		});
		expect(osc52Writes()).toHaveLength(0);
	});

	test("tries xclip and xsel after wl-copy fails", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", ":0");
		mocks.command.mockImplementation(async (name) => (name === "xsel" ? Buffer.alloc(0) : undefined));

		await copyToClipboard("hello");

		expect(commandNames()).toEqual(["wl-copy", "xclip", "xsel"]);
		expect(osc52Writes()).toHaveLength(0);
	});

	test("local failure does not report an unverified OSC 52 write as success", async () => {
		// Regression test for #9618.
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mocks.command.mockResolvedValue(undefined);

		await expect(copyToClipboard("hello")).rejects.toThrow("Failed to copy to clipboard");
		expect(osc52Writes()).toHaveLength(0);
	});

	test("local Linux failure reports the missing X11 tools", async () => {
		// Regression test for #9618.
		mockedPlatform.mockReturnValue("linux");
		vi.stubEnv("DISPLAY", ":0");
		mocks.command.mockResolvedValue(undefined);

		await expect(copyToClipboard("hello")).rejects.toThrow(
			"Failed to copy to clipboard: install `xclip` or `xsel`, or check X11 access",
		);
		expect(commandNames()).toEqual(["xclip", "xsel"]);
		expect(osc52Writes()).toHaveLength(0);
	});

	test("reports the Wayland clipboard tool instead of the X11 fallback", async () => {
		mockedPlatform.mockReturnValue("linux");
		mocks.isWaylandSession.mockReturnValue(true);
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", ":0");
		mocks.command.mockResolvedValue(undefined);

		await expect(copyToClipboard("hello")).rejects.toThrow(
			"Failed to copy to clipboard: install `wl-clipboard` (`wl-copy`) or check Wayland access",
		);
		expect(commandNames()).toEqual(["wl-copy", "xclip", "xsel"]);
	});

	test("display-less Linux falls back to OSC 52", async () => {
		mockedPlatform.mockReturnValue("linux");

		await copyToClipboard("hello");

		expect(mocks.command).not.toHaveBeenCalled();
		expect(osc52Writes()).toHaveLength(1);
	});

	test("uses OSC 52 when native and command writes fail in a remote session", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mocks.command.mockResolvedValue(undefined);

		await copyToClipboard("hello");

		expect(osc52Writes()).toHaveLength(1);
	});

	test("does not emit oversized OSC 52 payloads", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mocks.command.mockResolvedValue(undefined);

		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow(
			"Failed to copy to clipboard: text exceeds the OSC 52 size limit",
		);
		expect(osc52Writes()).toHaveLength(0);
	});
});
