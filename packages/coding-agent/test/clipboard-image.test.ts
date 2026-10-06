import { writeFileSync } from "fs";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
	return {
		command: vi.fn<(command: string, args: readonly string[], options?: unknown) => Promise<Buffer | undefined>>(),
		clipboard: {
			hasImage: vi.fn<() => boolean>(),
			getImageBinary: vi.fn<() => Promise<Uint8Array | null>>(),
		},
	};
});

// Clipboard tools run through the async helper (never spawnSync) so they cannot freeze the TUI.
vi.mock("../src/utils/clipboard-command.ts", () => {
	return {
		runClipboardCommand: mocks.command,
	};
});

vi.mock("../src/utils/clipboard-native.ts", () => {
	return {
		clipboard: mocks.clipboard,
	};
});

describe("readClipboardImage", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.command.mockReset();
		mocks.clipboard.hasImage.mockReset();
		mocks.clipboard.getImageBinary.mockReset();
	});

	test("Wayland: uses wl-paste and never calls clipboard", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called on Wayland");
		});

		mocks.command.mockImplementation(async (command, args, _options) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				return Buffer.from("text/plain\nimage/png\n", "utf-8");
			}
			if (command === "wl-paste" && args[0] === "--type") {
				return Buffer.from([1, 2, 3]);
			}
			throw new Error(`Unexpected clipboard command: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([1, 2, 3]);
	});

	test("Wayland: falls back to xclip when wl-paste is missing", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called on Wayland");
		});

		mocks.command.mockImplementation(async (command, args, _options) => {
			if (command === "wl-paste") {
				return undefined; // spawn ENOENT
			}

			if (command === "xclip" && args.includes("TARGETS")) {
				return Buffer.from("image/png\n", "utf-8");
			}

			if (command === "xclip" && args.includes("image/png")) {
				return Buffer.from([9, 8]);
			}

			return Buffer.alloc(0);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([9, 8]);
	});

	test("WSL: passes PowerShell path directly instead of through a custom env var", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called before PowerShell on WSL");
		});

		let tmpFile: string | undefined;
		mocks.command.mockImplementation(async (command, args, options) => {
			if (command === "wl-paste" || command === "xclip") {
				return Buffer.alloc(0);
			}

			if (command === "wslpath") {
				tmpFile = args[1];
				return Buffer.from("C:\\Users\\O'Hare\\clip.png\n", "utf-8");
			}

			if (command === "powershell.exe") {
				expect(options).not.toHaveProperty("env");
				expect(args[2]).toContain("$path = 'C:\\Users\\O''Hare\\clip.png'");
				if (!tmpFile) {
					throw new Error("wslpath should be called before powershell.exe");
				}
				writeFileSync(tmpFile, Buffer.from([4, 5, 6]));
				return Buffer.from("ok\n", "utf-8");
			}

			throw new Error(`Unexpected clipboard command: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([4, 5, 6]);
	});

	test("Non-Wayland: uses clipboard", async () => {
		mocks.command.mockImplementation(async () => {
			throw new Error(
				"clipboard commands should not run for non-Wayland sessions when native clipboard returns an image",
			);
		});

		mocks.clipboard.hasImage.mockReturnValue(true);
		mocks.clipboard.getImageBinary.mockResolvedValue(new Uint8Array([7]));

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: {} });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([7]);
	});

	test("Non-Wayland: falls back to xclip when clipboard has no image", async () => {
		mocks.command.mockImplementation(async (command, args, _options) => {
			if (command === "xclip" && args.includes("TARGETS")) {
				return Buffer.from("image/png\n", "utf-8");
			}
			if (command === "xclip" && args.includes("image/png")) {
				return Buffer.from([8, 9]);
			}
			throw new Error(`Unexpected clipboard command: ${command} ${args.join(" ")}`);
		});

		mocks.clipboard.hasImage.mockReturnValue(false);

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: {} });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([8, 9]);
	});
});
