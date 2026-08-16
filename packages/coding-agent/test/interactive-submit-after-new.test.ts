import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

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
	pendingUserInputs: string[];
	sessionTransitioning: boolean;
	flushPendingBashComponents: () => void;
	showWarning: (message: string) => void;
	showStatus: (message: string) => void;
	handleClearCommand: () => Promise<void>;
	handleDebugCommand: () => void;
	clearStatusIndicator: () => void;
	ui: { requestRender: () => void };
	updatePendingMessagesDisplay: () => void;
	// wired only in tests that exercise the real handleClearCommand
	runtimeHost?: { newSession: () => Promise<{ cancelled: boolean }> };
	statusContainer?: { clear: () => void };
	chatContainer?: { addChild: (child: unknown) => void };
	renderCurrentSessionState?: () => void;
	loadingAnimation?: undefined;
	handleFatalRuntimeError?: (message: string, error: unknown) => Promise<void>;
	getUserInput?: () => Promise<string>;
	drainPendingSubmissions?: () => void;
};

type Proto = { setupEditorSubmitHandler(this: SubmitContext): void };
// Tests reach private prototype methods on purpose (same pattern as the
// other interactive-mode tests).
const proto = InteractiveMode.prototype as any;
const typedProto = InteractiveMode.prototype as unknown as Proto;

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
		pendingUserInputs: [],
		sessionTransitioning: false,
		flushPendingBashComponents: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		handleClearCommand: vi.fn(async () => {}),
		handleDebugCommand: vi.fn(),
		// pi 0.84 clears the status indicator at the top of handleClearCommand.
		clearStatusIndicator: vi.fn(),
		ui: { requestRender: vi.fn() },
		updatePendingMessagesDisplay: vi.fn(),
		...overrides,
	};
}

describe("editor submit after /new (regression: message swallowed)", () => {
	it("plain prose reaches the input callback (the main loop)", async () => {
		const ctx = makeContext();
		typedProto.setupEditorSubmitHandler.call(ctx);
		const received: string[] = [];
		ctx.onInputCallback = (text) => received.push(text);

		await ctx.defaultEditor.onSubmit?.("hello world");

		expect(received).toEqual(["hello world"]);
	});

	it("/new runs the clear command, then the NEXT prose still reaches the callback", async () => {
		const ctx = makeContext();
		typedProto.setupEditorSubmitHandler.call(ctx);
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
		typedProto.setupEditorSubmitHandler.call(ctx);
		const received: string[] = [];
		ctx.onInputCallback = (text) => received.push(text);

		await ctx.defaultEditor.onSubmit?.("/fix the login crash");

		expect(received).toEqual(["/fix the login crash"]);
		expect(ctx.showWarning).not.toHaveBeenCalled();
	});

	it("bare builtin with args warns and keeps the text (no silent leak)", async () => {
		const ctx = makeContext();
		typedProto.setupEditorSubmitHandler.call(ctx);
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
		typedProto.setupEditorSubmitHandler.call(ctx);
		ctx.onInputCallback = () => {};

		await ctx.defaultEditor.onSubmit?.("un message normal sans slash");

		expect(getRegisteredCommands).not.toHaveBeenCalled();
	});
});

describe("queue + replay (message typed during a busy loop or a session rebuild)", () => {
	it("prose during a session transition is queued with feedback, not sent", async () => {
		const ctx = makeContext({ sessionTransitioning: true });
		typedProto.setupEditorSubmitHandler.call(ctx);
		const received: string[] = [];
		ctx.onInputCallback = (text) => received.push(text);

		await ctx.defaultEditor.onSubmit?.("message pendant transition");

		expect(received).toEqual([]);
		expect(ctx.pendingUserInputs).toEqual(["message pendant transition"]);
		expect(ctx.showStatus).toHaveBeenCalledOnce();
	});

	it("prose while the loop is busy (no callback armed) is queued and drained by getUserInput", async () => {
		const ctx = makeContext();
		ctx.getUserInput = proto.getUserInput;
		typedProto.setupEditorSubmitHandler.call(ctx);
		ctx.onInputCallback = undefined; // the loop is inside session.prompt()

		await ctx.defaultEditor.onSubmit?.("pendant le préflight");
		expect(ctx.pendingUserInputs).toEqual(["pendant le préflight"]);
		expect(ctx.showStatus).toHaveBeenCalledOnce();

		// The loop comes back around: the queued message is replayed first.
		const next = await ctx.getUserInput?.();
		expect(next).toBe("pendant le préflight");
		expect(ctx.pendingUserInputs).toEqual([]);
	});

	it("getUserInput does not drain during a transition; drain hands over once it ends", async () => {
		const ctx = makeContext({ sessionTransitioning: true, pendingUserInputs: ["queued message"] });
		ctx.getUserInput = proto.getUserInput;
		ctx.drainPendingSubmissions = proto.drainPendingSubmissions;

		let resolved: string | undefined;
		void ctx.getUserInput?.().then((text) => {
			resolved = text;
		});
		await new Promise((r) => setTimeout(r, 5));
		expect(resolved).toBeUndefined();
		expect(ctx.pendingUserInputs).toEqual(["queued message"]);

		ctx.sessionTransitioning = false;
		ctx.drainPendingSubmissions?.();
		await new Promise((r) => setTimeout(r, 0));
		expect(resolved).toBe("queued message");
		expect(ctx.pendingUserInputs).toEqual([]);
	});

	it("end to end: a message typed while /new rebuilds is replayed to the loop afterwards", async () => {
		const ctx = makeContext();
		ctx.getUserInput = proto.getUserInput;
		ctx.drainPendingSubmissions = proto.drainPendingSubmissions;
		typedProto.setupEditorSubmitHandler.call(ctx);

		// The main loop is at rest, waiting for input.
		const received: string[] = [];
		ctx.onInputCallback = (text) => {
			ctx.onInputCallback = undefined;
			received.push(text);
		};

		// /new whose runtime rebuild resolves later.
		let releaseNewSession!: () => void;
		ctx.runtimeHost = {
			newSession: () =>
				new Promise((resolve) => {
					releaseNewSession = () => resolve({ cancelled: false });
				}),
		};
		ctx.statusContainer = { clear: vi.fn() };
		ctx.chatContainer = { addChild: vi.fn() };
		ctx.renderCurrentSessionState = vi.fn();
		ctx.loadingAnimation = undefined;
		// The post-rebuild UI rendering may throw in the test environment (theme
		// not initialized); the queue/replay contract lives in the finally block,
		// which runs either way.
		ctx.handleFatalRuntimeError = vi.fn(async () => {});

		const clearPromise = proto.handleClearCommand.call(ctx) as Promise<void>;
		expect(ctx.sessionTransitioning).toBe(true);

		// The user types while the rebuild is in flight.
		await ctx.defaultEditor.onSubmit?.("bonjour après /new");
		expect(received).toEqual([]); // NOT sent into the half-torn-down session
		expect(ctx.pendingUserInputs).toEqual(["bonjour après /new"]);

		releaseNewSession();
		await clearPromise;

		expect(ctx.sessionTransitioning).toBe(false);
		expect(received).toEqual(["bonjour après /new"]); // replayed to the loop
		expect(ctx.pendingUserInputs).toEqual([]);
	});
});
