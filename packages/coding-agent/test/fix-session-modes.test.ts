import type { AssistantMessage, AssistantMessageEvent } from "phi-code-ai";
import { Container, type TUI } from "phi-code-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntimeDiagnostic } from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import type { StatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import {
	computeMessageCostUsd,
	GitDirtyCache,
	type GitPorcelainRunner,
} from "../src/modes/interactive/components/status-segments.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import type { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { toJsonEvent } from "../src/modes/json-event.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness } from "./suite/harness.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const busyMessage = "Wait for the current compaction or tree navigation to finish before navigating the session tree.";

function emptyUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("fix-session: modes", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	// #7925
	it("includes the tool call id and name in toolcall_start JSON events", () => {
		const partial: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "m",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 1,
		};
		const assistantMessageEvent: AssistantMessageEvent = { type: "toolcall_start", contentIndex: 0, partial };
		const event = { type: "message_update", message: partial, assistantMessageEvent } as AgentSessionEvent;

		const json = toJsonEvent(event);

		expect(json).toMatchObject({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "read" },
		});
		expect("partial" in (json as { assistantMessageEvent: object }).assistantMessageEvent).toBe(false);
	});

	// #8552
	it("lists skills when bash is the only tool able to read them", () => {
		const skill = {
			name: "deploy",
			description: "Deploy the app",
			filePath: "/skills/deploy/SKILL.md",
			baseDir: "/skills/deploy",
			source: "user",
			disableModelInvocation: false,
		} as unknown as NonNullable<Parameters<typeof buildSystemPrompt>[0]["skills"]>[number];

		const bashOnly = buildSystemPrompt({ cwd: "/repo", selectedTools: ["bash"], skills: [skill] });
		expect(bashOnly).toContain("<available_skills>");
		expect(bashOnly).toContain("Use bash to load a skill's file");
		expect(bashOnly).not.toContain("Use the read tool to load a skill's file");

		const custom = buildSystemPrompt({
			cwd: "/repo",
			customPrompt: "Custom.",
			selectedTools: ["bash"],
			skills: [skill],
		});
		expect(custom).toContain("Use bash to load a skill's file");

		const withRead = buildSystemPrompt({ cwd: "/repo", selectedTools: ["read", "bash"], skills: [skill] });
		expect(withRead).toContain("Use the read tool to load a skill's file");

		const noReader = buildSystemPrompt({ cwd: "/repo", selectedTools: ["edit"], skills: [skill] });
		expect(noReader).not.toContain("<available_skills>");
	});

	it("imposes the memory rules only when the memory tools are active", () => {
		const without = buildSystemPrompt({ cwd: "/repo", selectedTools: ["read", "bash"] });
		expect(without).not.toContain("memory_search");
		expect(without).not.toContain("<critical_rule");

		const searchOnly = buildSystemPrompt({ cwd: "/repo", selectedTools: ["read", "memory_search"] });
		expect(searchOnly).toContain("you MUST first call `memory_search`");
		expect(searchOnly).not.toContain("memory_write");

		const both = buildSystemPrompt({ cwd: "/repo", selectedTools: ["read", "memory_search", "memory_write"] });
		expect(both.startsWith('<critical_rule priority="absolute">')).toBe(true);
		expect(both).toContain("you MUST call `memory_write`");
	});

	// Status bar: git status must not block the render path
	it("refreshes the git dirty state asynchronously without blocking", async () => {
		let resolveRun: (value: string | null) => void = () => {};
		let calls = 0;
		const runner: GitPorcelainRunner = () => {
			calls++;
			return new Promise((resolve) => {
				resolveRun = resolve;
			});
		};
		let now = 0;
		const onUpdate = vi.fn();
		const cache = new GitDirtyCache(runner, () => now, onUpdate);

		expect(cache.isDirty("/repo")).toBeNull();
		expect(cache.isDirty("/repo")).toBeNull();
		expect(calls).toBe(1);

		resolveRun(" M file.ts\n");
		await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
		expect(cache.isDirty("/repo")).toBe(true);

		// Stale value is served while the next refresh runs.
		now += 3000;
		expect(cache.isDirty("/repo")).toBe(true);
		expect(calls).toBe(2);
		resolveRun("");
		await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
		expect(cache.isDirty("/repo")).toBe(false);
	});

	it("ignores a refresh that completes after invalidate()", async () => {
		let resolveRun: (value: string | null) => void = () => {};
		const cache = new GitDirtyCache(
			() =>
				new Promise((resolve) => {
					resolveRun = resolve;
				}),
		);
		expect(cache.isDirty("/repo")).toBeNull();
		const staleResolve = resolveRun;
		cache.invalidate();
		staleResolve(" M stale");
		await Promise.resolve();
		await Promise.resolve();
		expect(cache.isDirty("/repo")).toBeNull();
	});

	// Status bar: cost per message at the producing model's rates
	it("prices each message with the rates of the model that produced it", () => {
		const usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
		const cheap = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
		const expensive = { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 };
		expect(computeMessageCostUsd(usage, cheap) + computeMessageCostUsd(usage, expensive)).toBe(11);
		expect(computeMessageCostUsd({ ...usage, cost: { total: 0.5 } }, expensive)).toBe(0.5);
		expect(computeMessageCostUsd(usage)).toBe(0);
	});

	// #8611
	it("toggles thinking visibility without dropping running bash output", () => {
		const ui = { requestRender: vi.fn() } as unknown as TUI;
		const chatContainer = new Container();
		const component = new ToolExecutionComponent(
			"bash",
			"tool-8611",
			{ command: "echo first; sleep 10" },
			{ showImages: false },
			undefined,
			ui,
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "first" }], isError: false }, true);
		chatContainer.addChild(component);

		const proto = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
		const fakeThis = {
			hideThinkingBlock: false,
			settingsManager: { setHideThinkingBlock: vi.fn() },
			chatContainer,
			ui,
			updateThinkingBlockVisibility() {
				proto.updateThinkingBlockVisibility.call(this);
			},
			showStatus: vi.fn(),
		};

		proto.toggleThinkingBlockVisibility.call(fakeThis);

		expect(fakeThis.settingsManager.setHideThinkingBlock).toHaveBeenCalledWith(true);
		expect(chatContainer.children).toContain(component);
		expect(stripAnsi(chatContainer.render(120).join("\n"))).toContain("first");
	});

	// #9340
	it("routes interactive response aborts through AgentSession", () => {
		const abort = vi.fn(async () => {});
		const ui = {
			clearAllQueues: () => ({ steering: [], followUp: [] }),
			updatePendingMessagesDisplay: vi.fn(),
			session: { abort },
		};
		const restore = Reflect.get(InteractiveMode.prototype, "restoreQueuedMessagesToEditor") as (
			this: typeof ui,
			options?: { abort?: boolean },
		) => number;

		restore.call(ui, { abort: true });

		expect(abort).toHaveBeenCalledOnce();
	});

	// #9178 (TUI side)
	it.each(["Summarize", "No summary"])(
		"keeps the active operation UI when a compaction starts while choosing %s",
		async (choice) => {
			const sessionManager = SessionManager.inMemory();
			const targetId = sessionManager.appendMessage(userMsg("first"));
			sessionManager.appendMessage(assistantMsg("reply"));
			let selector: TreeSelectorComponent | undefined;
			const onEscape = vi.fn();
			const ui = {
				sessionManager,
				settingsManager: SettingsManager.inMemory(),
				session: {
					isStreaming: false,
					isCompacting: false,
					abort: vi.fn(async () => {}),
					abortBranchSummary: vi.fn(),
					navigateTree: vi.fn(async () => ({ cancelled: false })),
				},
				defaultEditor: { onEscape },
				editor: { getText: () => "", setText: vi.fn() },
				chatContainer: new Container(),
				ui: { terminal: { rows: 24, setProgress: vi.fn() }, requestRender: vi.fn() },
				showSelector: (create: (done: () => void) => { component: TreeSelectorComponent }) => {
					selector = create(vi.fn()).component;
				},
				showExtensionSelector: vi.fn(async () => {
					ui.session.isCompacting = true;
					return choice;
				}),
				showExtensionEditor: vi.fn(async () => undefined),
				showStatusIndicator: vi.fn((indicator: StatusIndicator) => indicator.dispose()),
				clearStatusIndicator: vi.fn(),
				restoreQueuedMessagesToEditor: vi.fn(),
				renderInitialMessages: vi.fn(),
				showStatus: vi.fn(),
				showError: vi.fn(),
				flushCompactionQueue: vi.fn(async () => {}),
			};
			const showTreeSelector = Reflect.get(InteractiveMode.prototype, "showTreeSelector") as (
				this: typeof ui,
			) => void;
			showTreeSelector.call(ui);
			expect(selector).toBeDefined();

			await selector!.getTreeList().onSelect!(targetId);

			expect(ui.showError).toHaveBeenCalledWith(busyMessage);
			expect(ui.showStatusIndicator).not.toHaveBeenCalled();
			expect(ui.defaultEditor.onEscape).toBe(onEscape);
			expect(ui.session.navigateTree).not.toHaveBeenCalled();
		},
	);

	// #7829
	it("renders startup diagnostics inside the transcript", async () => {
		vi.stubEnv("PHI_SKIP_VERSION_CHECK", "1");
		vi.stubEnv("PI_OFFLINE", "1");
		const harness = await createHarness();
		try {
			const chatContainer = new Container();
			const startupDiagnostics: AgentSessionRuntimeDiagnostic[] = [
				{ type: "warning", message: "Invalid settings file /tmp/settings.json: malformed JSON" },
			];
			const proto = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
			const context = {
				init: vi.fn(async () => {}),
				options: { startupDiagnostics },
				chatContainer,
				outputPad: 1,
				ui: { requestRender: vi.fn() },
				version: "test",
				isInitialized: false,
				showWarning: proto.showWarning,
				showError: proto.showError,
				showStatus: vi.fn(),
				session: harness.session,
				checkForPackageUpdates: vi.fn().mockResolvedValue([]),
				checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
				maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
				getUserInput: vi.fn(() => new Promise<string>(() => {})),
			};

			void (proto.run as (this: typeof context) => Promise<void>).call(context).catch(() => {});

			await vi.waitFor(() => {
				const rendered = chatContainer.children.flatMap((child) => child.render(120)).join("\n");
				expect(stripAnsi(rendered)).toContain("Invalid settings file /tmp/settings.json: malformed JSON");
			});
		} finally {
			harness.cleanup();
		}
	});
});
