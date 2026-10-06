import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard, WINDOWS_SET_CLIPBOARD_SCRIPT } from "../src/utils/clipboard.ts";

const mocks = vi.hoisted(() => ({
	clipboard: {
		getText: vi.fn<() => Promise<string>>(),
		setText: vi.fn<(text: string) => Promise<void>>(),
	},
	command: vi.fn<(command: string, args: readonly string[], options?: unknown) => Promise<Buffer | undefined>>(),
	platform: vi.fn<() => NodeJS.Platform>(),
}));

vi.mock("../src/utils/clipboard-native.ts", () => ({ clipboard: mocks.clipboard }));
vi.mock("../src/utils/clipboard-command.ts", () => ({ runClipboardCommand: mocks.command }));
vi.mock("os", async (importOriginal) => ({
	...(await importOriginal<typeof import("os")>()),
	platform: mocks.platform,
}));

const ACCENTED = "Déjà vu : àçôœ € 日本語 😀\nligne 2";

describe("fix2-core Windows clipboard text encoding", () => {
	beforeEach(() => {
		for (const key of ["SSH_CONNECTION", "SSH_CLIENT", "MOSH_CONNECTION"]) vi.stubEnv(key, "");
		mocks.clipboard.setText.mockReset().mockRejectedValue(new Error("native addon unavailable"));
		mocks.command.mockReset().mockResolvedValue(undefined);
		mocks.platform.mockReset().mockReturnValue("win32");
	});

	test("uses PowerShell Set-Clipboard fed through stdin before clip.exe", async () => {
		mocks.command.mockImplementation(async (command) => (command === "powershell.exe" ? Buffer.alloc(0) : undefined));
		await copyToClipboard(ACCENTED);

		expect(mocks.command).toHaveBeenCalledTimes(1);
		const [command, args, options] = mocks.command.mock.calls[0] ?? [];
		expect(command).toBe("powershell.exe");
		expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SET_CLIPBOARD_SCRIPT]);
		// The text goes through stdin only, never through the command line.
		expect(args?.join(" ")).not.toContain("Déjà");
		expect(options).toMatchObject({ input: ACCENTED });
	});

	test("falls back to clip.exe when PowerShell fails", async () => {
		mocks.command.mockImplementation(async (command) => (command === "clip" ? Buffer.alloc(0) : undefined));
		await copyToClipboard("");
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["powershell.exe", "clip"]);
	});

	test.runIf(process.platform === "win32")(
		"the PowerShell script decodes UTF-8 stdin losslessly",
		() => {
			// Same decoding path as the real script, echoing to stdout instead of touching the clipboard.
			const script = WINDOWS_SET_CLIPBOARD_SCRIPT.replace(
				"Set-Clipboard -Value ([Console]::In.ReadToEnd())",
				"[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; [Console]::Out.Write([Console]::In.ReadToEnd())",
			);
			expect(script).not.toBe(WINDOWS_SET_CLIPBOARD_SCRIPT);
			const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
				input: ACCENTED,
				windowsHide: true,
				timeout: 30_000,
			});
			expect(result.status).toBe(0);
			expect(result.stdout.toString("utf8")).toBe(ACCENTED);
		},
		40_000,
	);
});
