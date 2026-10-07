/**
 * rpiv-todo — Pi extension. Registers the `todo` tool, `/todos` slash
 * command, and the persistent TodoOverlay widget.
 *
 * TUI chrome strings localize at render time via the i18n bridge. Strings are
 * registered with rpiv-i18n here, once, at module init — but only when the
 * SDK is actually installed. If `@juicesharp/rpiv-i18n` is missing (standalone
 * install of just this package), the dynamic-load shim no-ops and the bridge's
 * `t(key, fallback)` returns the inline English literal at every call site.
 * The extension stays online either way.
 *
 * Adding a locale: drop `locales/<code>.json` next to en.json (mirroring the
 * key set). No edit needed here — `registerLocalesFromDir` iterates
 * `SUPPORTED_LOCALES` from the SDK. See `@juicesharp/rpiv-i18n` README →
 * "Contributing translations" for the full convention.
 *
 * Extracted from rpiv-pi@7525a5d. Tool name "todo" and widget key
 * "rpiv-todos" preserved verbatim so existing session history replays
 * correctly after upgrade.
 */

import type { ExtensionAPI } from "phi-code";
import { I18N_NAMESPACE } from "./state/i18n-bridge.ts";
import {
	countInProgress,
	findStaleInProgress,
	formatAge,
	inProgressAgeMs,
	MAX_IN_PROGRESS,
} from "./state/invariants.ts";
import { replayFromBranch } from "./state/replay.ts";
import { getState, replaceState } from "./state/store.ts";
import { registerTodosCommand, registerTodoTool, TOOL_NAME } from "./todo.ts";
import { TodoOverlay } from "./todo-overlay.ts";

type I18nLoader = {
	registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => void;
};

// Dynamic import keeps `@juicesharp/rpiv-i18n` a soft optional peer: when the
// SDK is installed alongside this package the strings register and
// `/languages` flips them live; when it isn't, the import rejects here, we
// no-op, and the bridge's English-fallback shim keeps the extension online.
//
// The `/loader` subpath is used instead of the SDK entry so the i18n-ui +
// pi-tui modules are not pulled into our load graph just to register strings.
try {
	const i18nLoaderSpecifier: string = "@juicesharp/rpiv-i18n/loader";
	const sdk = (await import(i18nLoaderSpecifier)) as I18nLoader;
	sdk.registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, { label: "rpiv-todo" });
} catch {
	// SDK absent — extension still loads with English-only UI.
}

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring so genuine
// replay bugs still propagate instead of being silently swallowed.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

export default function (pi: ExtensionAPI) {
	// Todo overlay widget — constructed lazily at the first session_start with UI.
	let todoOverlay: TodoOverlay | undefined;

	registerTodoTool(pi);
	registerTodosCommand(pi);

	pi.on("session_start", async (_event, ctx) => {
		replaceState(replayFromBranch(ctx));
		if (ctx.hasUI) {
			todoOverlay ??= new TodoOverlay();
			todoOverlay.setUICtx(ctx.ui);
			todoOverlay.resetCompletedDisplayState();
			todoOverlay.update();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Auto-compaction races session disposal: pi-core invalidates the
		// extension runner while still emitting session_compact, so `ctx` may be
		// a dead proxy whose getters throw the stale error. The compacting session
		// is being discarded — the replacement session's session_start replays
		// state — so keep current state on a stale ctx. Other errors are real
		// replay bugs and must propagate.
		try {
			replaceState(replayFromBranch(ctx));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		todoOverlay?.resetCompletedDisplayState();
		todoOverlay?.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		try {
			replaceState(replayFromBranch(ctx));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		todoOverlay?.resetCompletedDisplayState();
		todoOverlay?.update();
	});

	pi.on("session_shutdown", async () => {
		todoOverlay?.dispose();
		todoOverlay = undefined;
	});

	// Reads getTodos() at render time; do NOT call replayFromBranch here
	// (branch is stale — message_end runs after tool_execution_end).
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		todoOverlay?.update();
	});

	pi.on("agent_start", async () => {
		todoOverlay?.hideCompletedTasksFromPreviousTurn();
	});

	// ---- Turn-end staleness reminder -----------------------------------------
	// The invariant is enforced in the reducer, but nothing there can see a task
	// that is merely LEFT open across a turn boundary — which is the failure that
	// actually happened. This is the net that catches the omission.
	let pendingStaleReminder: string | undefined;

	// agent_settled, NOT agent_end: agent_end can be followed by an automatic
	// retry or by queued follow-up messages, and acting there would advance the
	// chain while the retried turn is still to come.
	pi.on("agent_settled", async () => {
		const state = getState();
		const n = countInProgress(state.tasks);
		const stale = findStaleInProgress(state.tasks);
		if (n <= MAX_IN_PROGRESS && stale.length === 0) {
			pendingStaleReminder = undefined;
			return;
		}
		const parts: string[] = [];
		if (n > MAX_IN_PROGRESS) parts.push(`${n} tasks are in_progress; exactly one is allowed`);
		for (const t of stale) {
			const age = inProgressAgeMs(t);
			parts.push(
				`#${t.id} "${t.subject}" has been in_progress for ` +
					(age === undefined ? "an unknown time" : formatAge(age)),
			);
		}
		pendingStaleReminder =
			`[todo] ${parts.join("; ")}. Before starting new work, close it ` +
			`(status="completed") or park it (status="pending") with the todo tool.`;
	});

	// One-shot: consumed by the first turn that follows, then cleared. Never
	// triggers a turn itself (no sendUserMessage/sendMessage), so an idle session
	// is never nagged and never costs a model call.
	pi.on("before_agent_start", async (event) => {
		if (!pendingStaleReminder) return;
		const note = pendingStaleReminder;
		pendingStaleReminder = undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${note}` };
	});
}
