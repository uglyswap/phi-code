import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	command: vi.fn<(command: string, args: readonly string[], options?: unknown) => Promise<Buffer | undefined>>(),
	clipboard: {
		hasImage: vi.fn<() => boolean>(),
		getImageBinary: vi.fn<() => Promise<Uint8Array | null>>(),
	},
}));

// Clipboard tools run through the async helper; undefined is a failed command.
vi.mock("../src/utils/clipboard-command.ts", () => ({ runClipboardCommand: mocks.command }));
vi.mock("../src/utils/clipboard-native.ts", () => ({ clipboard: mocks.clipboard }));

describe("fix-core #9786 X11 clipboard images", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.command.mockReset();
		mocks.clipboard.hasImage.mockReset().mockReturnValue(false);
		mocks.clipboard.getImageBinary.mockReset();
	});

	test("does not probe image types the clipboard does not advertise", async () => {
		mocks.command.mockImplementation(async (_command, args) =>
			args.includes("TARGETS") ? Buffer.from("TARGETS\nUTF8_STRING\ntext/plain\n") : Buffer.from([1]),
		);
		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		expect(await readClipboardImage({ platform: "linux", env: {} })).toBeNull();
		expect(mocks.command).toHaveBeenCalledTimes(1);
	});

	test("does not probe any type when TARGETS fails", async () => {
		mocks.command.mockResolvedValue(undefined);
		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		expect(await readClipboardImage({ platform: "linux", env: {} })).toBeNull();
		expect(mocks.command).toHaveBeenCalledTimes(1);
	});

	test("reads only the preferred advertised image type", async () => {
		mocks.command.mockImplementation(async (_command, args) =>
			args.includes("TARGETS") ? Buffer.from("image/jpeg\ntext/plain\n") : Buffer.from([4, 2]),
		);
		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const image = await readClipboardImage({ platform: "linux", env: {} });
		expect(image?.mimeType).toBe("image/jpeg");
		expect(mocks.command.mock.calls.map(([, args]) => args.join(" "))).toEqual([
			"-selection clipboard -t TARGETS -o",
			"-selection clipboard -t image/jpeg -o",
		]);
	});
});
