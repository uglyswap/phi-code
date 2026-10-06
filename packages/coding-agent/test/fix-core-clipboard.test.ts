import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard, readClipboardText } from "../src/utils/clipboard.ts";

const mocks = vi.hoisted(() => ({
	clipboard: {
		getText: vi.fn<() => Promise<string>>(),
		setText: vi.fn<(text: string) => Promise<void>>(),
	},
	command: vi.fn<(command: string, args: readonly string[], options?: unknown) => Promise<Buffer | undefined>>(),
	platform: vi.fn<() => NodeJS.Platform>(),
	isWaylandSession: vi.fn<(env?: NodeJS.ProcessEnv) => boolean>(),
}));

vi.mock("../src/utils/clipboard-native.ts", () => ({ clipboard: mocks.clipboard }));
vi.mock("../src/utils/clipboard-command.ts", () => ({ runClipboardCommand: mocks.command }));
vi.mock("os", () => ({ platform: mocks.platform }));
vi.mock("../src/utils/clipboard-image.ts", () => ({ isWaylandSession: mocks.isWaylandSession }));

let originalWrite: typeof process.stdout.write;
let osc52Writes: string[];

beforeEach(() => {
	vi.unstubAllEnvs();
	for (const key of [
		"SSH_CONNECTION",
		"SSH_CLIENT",
		"MOSH_CONNECTION",
		"DISPLAY",
		"WAYLAND_DISPLAY",
		"TERMUX_VERSION",
	]) {
		vi.stubEnv(key, "");
	}
	osc52Writes = [];
	mocks.clipboard.getText.mockReset().mockResolvedValue("");
	mocks.clipboard.setText.mockReset().mockResolvedValue(undefined);
	mocks.command.mockReset().mockResolvedValue(undefined);
	mocks.platform.mockReset().mockReturnValue("darwin");
	mocks.isWaylandSession.mockReset().mockImplementation((env = process.env) => Boolean(env.WAYLAND_DISPLAY));
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
		const [chunk] = args;
		if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) {
			osc52Writes.push(chunk);
			return true;
		}
		return originalWrite(...args);
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
	vi.unstubAllEnvs();
});

describe("fix-core clipboard writes (#9618, async commands)", () => {
	test("a local desktop failure is reported instead of an unverified OSC 52 success", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		await expect(copyToClipboard("hello")).rejects.toThrow("Failed to copy to clipboard");
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["pbcopy"]);
		expect(osc52Writes).toHaveLength(0);
	});

	test("local Linux with X11 reports a missing xclip/xsel", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("DISPLAY", ":0");
		await expect(copyToClipboard("hello")).rejects.toThrow("install `xclip` or `xsel`");
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["xclip", "xsel"]);
		expect(osc52Writes).toHaveLength(0);
	});

	test("Wayland tries wl-copy then the X11 tools, through the async helper", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		vi.stubEnv("DISPLAY", ":0");
		mocks.command.mockImplementation(async (command) => (command === "xclip" ? Buffer.alloc(0) : undefined));
		await copyToClipboard("hello");
		expect(mocks.command.mock.calls.map(([name]) => name)).toEqual(["wl-copy", "xclip"]);
		expect(mocks.command.mock.calls[0]?.[2]).toMatchObject({ input: "hello" });
		expect(osc52Writes).toHaveLength(0);
	});

	test("display-less Linux still falls back to OSC 52", async () => {
		mocks.platform.mockReturnValue("linux");
		await copyToClipboard("hello");
		expect(osc52Writes).toHaveLength(1);
	});

	test("remote sessions emit OSC 52 even after a native write", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		await copyToClipboard("hello");
		expect(mocks.clipboard.setText).toHaveBeenCalledWith("hello");
		expect(osc52Writes).toHaveLength(1);
	});

	test("remote sessions report oversized OSC 52 payloads when nothing else copied", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow("exceeds the OSC 52 size limit");
		expect(osc52Writes).toHaveLength(0);
	});

	test("a successful local command skips OSC 52", async () => {
		mocks.clipboard.setText.mockRejectedValue(new Error("native failed"));
		mocks.command.mockResolvedValue(Buffer.alloc(0));
		await copyToClipboard("hello");
		expect(mocks.command).toHaveBeenCalledWith("pbcopy", [], { input: "hello", timeoutMs: 5000 });
		expect(osc52Writes).toHaveLength(0);
	});
});

describe("fix-core clipboard reads", () => {
	test("reads Wayland text asynchronously and falls back to the native clipboard on failure", async () => {
		mocks.platform.mockReturnValue("linux");
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0");
		mocks.command.mockResolvedValueOnce(Buffer.from("wayland text"));
		expect(await readClipboardText()).toBe("wayland text");

		mocks.command.mockResolvedValueOnce(undefined);
		mocks.clipboard.getText.mockResolvedValue("native text");
		expect(await readClipboardText()).toBe("native text");
	});
});
