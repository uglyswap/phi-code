import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawnSync: vi.fn(() => {
		throw new Error("clipboard image reads must not use spawnSync");
	}),
	execFileSync: vi.fn(() => {
		throw new Error("clipboard image reads must not use execFileSync");
	}),
	command: vi.fn<(command: string, args: readonly string[], options?: unknown) => Promise<Buffer | undefined>>(),
	clipboard: {
		hasImage: vi.fn<() => boolean>(),
		getImageBinary: vi.fn<() => Promise<Uint8Array | null>>(),
	},
}));

vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("child_process")>()),
	spawnSync: mocks.spawnSync,
	execFileSync: mocks.execFileSync,
}));
vi.mock("../src/utils/clipboard-command.ts", () => ({ runClipboardCommand: mocks.command }));
vi.mock("../src/utils/clipboard-native.ts", () => ({ clipboard: mocks.clipboard }));

describe("fix2-core asynchronous clipboard image reads", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.spawnSync.mockClear();
		mocks.execFileSync.mockClear();
		mocks.command.mockReset();
		mocks.clipboard.hasImage.mockReset().mockReturnValue(false);
		mocks.clipboard.getImageBinary.mockReset();
	});

	test("a slow clipboard tool does not block the event loop", async () => {
		let releaseTargets: ((value: Buffer) => void) | undefined;
		mocks.command.mockImplementation((_command, args) => {
			if (args.includes("TARGETS")) {
				return new Promise<Buffer>((resolve) => {
					releaseTargets = resolve;
				});
			}
			return Promise.resolve(Buffer.from([1, 2]));
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const pending = readClipboardImage({ platform: "linux", env: {} });

		// While xclip is still running, other work (TUI rendering, input) keeps running.
		let tickRan = false;
		await new Promise<void>((resolve) =>
			setTimeout(() => {
				tickRan = true;
				resolve();
			}, 0),
		);
		expect(tickRan).toBe(true);
		expect(releaseTargets).toBeDefined();

		releaseTargets?.(Buffer.from("image/png\n"));
		const image = await pending;
		expect(image?.mimeType).toBe("image/png");
		expect(Array.from(image?.bytes ?? [])).toEqual([1, 2]);
		expect(mocks.spawnSync).not.toHaveBeenCalled();
		expect(mocks.execFileSync).not.toHaveBeenCalled();
	});

	test("WSL wl-paste, xclip and PowerShell paths go through the async helper with their timeouts", async () => {
		mocks.command.mockResolvedValue(undefined);
		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		expect(await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } })).toBeNull();
		expect(mocks.command.mock.calls.map(([command]) => command)).toEqual(["wl-paste", "xclip", "wslpath", "xclip"]);
		expect(mocks.command.mock.calls[0]?.[2]).toMatchObject({ timeoutMs: 1000 });
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});
});
