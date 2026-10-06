import type { SpawnSyncReturns } from "child_process";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawnSync: vi.fn<(command: string, args: string[], options: unknown) => SpawnSyncReturns<Buffer>>(),
	clipboard: {
		hasImage: vi.fn<() => boolean>(),
		getImageBinary: vi.fn<() => Promise<Uint8Array | null>>(),
	},
}));

vi.mock("child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("../src/utils/clipboard-native.ts", () => ({ clipboard: mocks.clipboard }));

function spawnResult(stdout: Buffer, status: number | null): SpawnSyncReturns<Buffer> {
	return {
		pid: 123,
		output: [Buffer.alloc(0), stdout, Buffer.alloc(0)],
		stdout,
		stderr: Buffer.alloc(0),
		status,
		signal: null,
	};
}

describe("fix-core #9786 X11 clipboard images", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.spawnSync.mockReset();
		mocks.clipboard.hasImage.mockReset().mockReturnValue(false);
		mocks.clipboard.getImageBinary.mockReset();
	});

	test("does not probe image types the clipboard does not advertise", async () => {
		mocks.spawnSync.mockImplementation((_command, args) =>
			args.includes("TARGETS")
				? spawnResult(Buffer.from("TARGETS\nUTF8_STRING\ntext/plain\n"), 0)
				: spawnResult(Buffer.from([1]), 0),
		);
		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		expect(await readClipboardImage({ platform: "linux", env: {} })).toBeNull();
		expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
	});

	test("does not probe any type when TARGETS fails", async () => {
		mocks.spawnSync.mockImplementation(() => spawnResult(Buffer.alloc(0), 1));
		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		expect(await readClipboardImage({ platform: "linux", env: {} })).toBeNull();
		expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
	});

	test("reads only the preferred advertised image type", async () => {
		mocks.spawnSync.mockImplementation((_command, args) =>
			args.includes("TARGETS")
				? spawnResult(Buffer.from("image/jpeg\ntext/plain\n"), 0)
				: spawnResult(Buffer.from([4, 2]), 0),
		);
		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const image = await readClipboardImage({ platform: "linux", env: {} });
		expect(image?.mimeType).toBe("image/jpeg");
		expect(mocks.spawnSync.mock.calls.map(([, args]) => args.join(" "))).toEqual([
			"-selection clipboard -t TARGETS -o",
			"-selection clipboard -t image/jpeg -o",
		]);
	});
});
