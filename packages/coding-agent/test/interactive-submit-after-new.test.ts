import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> };
	editor: { setText: (text: string) => void; addToHistory?: (text: string) => void };
	inputMode: string;
	session: {
		isBashRunning: boolean;
		isCompacting: boolean;
		isStreaming: boolean;
		extensionRunner: { getRegisteredCommands: () => Array<{ name: string; invocationName: string }> };
		prompt: (text: string, opts?: unknown) => Promise<void>;
	};
	onInputCallback?: (text: string) => void;
	flushPendingBashComponents: () => void;
	showWarning: (message: string) => void;
	handleClearCommand: () => Promise<void>;
	handleDebugCommand: () => void;
	ui: { requestRender: () => void };
	updatePendingMessagesDisplay: () => void;
};

type Proto = { setupEditorSubmitHandler(this: SubmitContext): void };
const proto = InteractiveMode.prototype as unknown as Proto;

function makeContext(overrides: Partial<SubmitContext> = {}): SubmitContext {
	return {
		defaultEditor: {},
		editor: { setText: vi.fn(), addToHistory: vi.fn() },
		inputMode: "normal",
		session: {
			isBashRunning: false,
			isCompacting: false,
			isStreaming: false,
			extensionRunner: { getRegisteredCommands: () => [] },
			prompt: vi.fn(async () => {}),
		},
		onInputCallback: undefined,
		flushPendingBashComponents: vi.fn(),
		showWarning: vi.fn(),
		handleClearCommand: vi.fn(async () => {}),
		handleDebugCommand: vi.fn(),
		ui: { requestRender: vi.fn() },
		updatePendingMessagesDisplay: vi.fn(),
		...overrides,
	};
}

describe("editor submit after /new (regression: message swallowed)", () => {
	it("plain prose reaches the input callback (the main loop)", async () => {
		const ctx = makeContext();
		proto.setupEditorSubmitHandler.call(ctx);
		const received: string[] = [];
		ctx.onInputCallback = (text) => received.push(text);

		await ctx.defaultEditor.onSubmit?.("hello world");

		expect(received).toEqual(["hello world"]);
	});

	it("/new runs the clear command, then the NEXT prose still reaches the callback", async () => {
		const ctx = makeContext();
		proto.setupEditorSubmitHandler.call(ctx);
		const received: string[] = [];
		ctx.onInputCallback = (text) => received.push(text);

		await ctx.defaultEditor.onSubmit?.("/new");
		expect(ctx.handleClearCommand).toHaveBeenCalledOnce();
		expect(received).toEqual([]);

		await ctx.defaultEditor.onSubmit?.("bonjour, peux-tu m'aider ?");
		expect(received).toEqual(["bonjour, peux-tu m'aider ?"]);
	});

	it("a slash message that is no command still reaches the callback (extension dispatch)", async () => {
		const ctx = makeContext();
		proto.setupEditorSubmitHandler.call(ctx);
		const received: string[] = [];
		ctx.onInputCallback = (text) => received.push(text);

		await ctx.defaultEditor.onSubmit?.("/fix the login crash");

		expect(received).toEqual(["/fix the login crash"]);
		expect(ctx.showWarning).not.toHaveBeenCalled();
	});

	it("bare builtin with args warns and keeps the text (no silent leak)", async () => {
		const ctx = makeContext();
		proto.setupEditorSubmitHandler.call(ctx);
		const received: string[] = [];
		ctx.onInputCallback = (text) => received.push(text);

		await ctx.defaultEditor.onSubmit?.("/new please");

		expect(received).toEqual([]);
		expect(ctx.showWarning).toHaveBeenCalledOnce();
		expect(ctx.editor.setText).toHaveBeenCalledWith("/new please");
	});

	it("prose does not touch the extension runner at all (no stale-context risk)", async () => {
		const getRegisteredCommands = vi.fn(() => []);
		const ctx = makeContext();
		ctx.session.extensionRunner = { getRegisteredCommands };
		proto.setupEditorSubmitHandler.call(ctx);
		ctx.onInputCallback = () => {};

		await ctx.defaultEditor.onSubmit?.("un message normal sans slash");

		expect(getRegisteredCommands).not.toHaveBeenCalled();
	});
});
