/**
 * Pure decision core of the /plan orchestrator's phase state machine.
 *
 * orchestrator.ts owns the I/O (UI notifications, queue mutation, checkpoint
 * files, model switching); everything DECIDABLE from a finished phase's
 * messages and report lives here so the exact transition behavior is unit
 * tested — including what happens when a model deviates from the text
 * contracts (missing report, unparseable verdict, zero tool calls).
 *
 * Behavior contract (mirrors the agent_end hook, in priority order):
 *   user abort > auth error (401) > transient retry (once, fallback model)
 *   > BLOCKED pause > review-FAIL fix cycle (once, unless looping)
 *   > continue (with diagnostics).
 */

import { isTransientError, type PhaseVerdict } from "./orchestrator-helpers.js";

export interface PhaseEndAnalysis {
	userAborted: boolean;
	hasAuthError: boolean;
	transient: boolean;
	toolCallCount: number;
	filesWritten: string[];
	filesEdited: string[];
	errorsHit: string[];
	testResults: string[];
	calledMemorySearch: boolean;
	calledMemoryWrite: boolean;
}

interface LooseMessage {
	role?: string;
	content?: unknown;
	name?: string;
	toolName?: string;
	isError?: boolean;
	stopReason?: string;
}

function messageText(msg: LooseMessage): string {
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content.map((c: { text?: string }) => c?.text || "").join("");
	}
	return JSON.stringify(msg.content ?? "");
}

/**
 * Analyze a finished phase's message list into the facts the transition
 * decision needs. Pure: no I/O, no state.
 */
export function analyzePhaseMessages(rawMessages: readonly unknown[]): PhaseEndAnalysis {
	const messages = (rawMessages || []) as LooseMessage[];

	const userAborted = messages.some((m) => m.role === "assistant" && m.stopReason === "aborted");

	const hasAuthError = messages.some((m) => {
		const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
		return (
			content.includes("401") &&
			(content.includes("invalid access token") ||
				content.includes("token expired") ||
				content.includes("Unauthorized"))
		);
	});

	const filesWritten: string[] = [];
	const filesEdited: string[] = [];
	const errorsHit: string[] = [];
	const testResults: string[] = [];
	let toolCallCount = 0;
	const toolNames: string[] = [];

	for (const msg of messages) {
		// Pi uses role: "toolResult" instead of "tool"
		if (msg.role !== "tool" && msg.role !== "function" && msg.role !== "toolResult") continue;
		toolCallCount++;
		const content = messageText(msg);
		const name = msg.name || msg.toolName || "";
		toolNames.push(name);

		// Track writes
		if (name === "write" && content.includes("Successfully wrote")) {
			const match = content.match(/wrote \d+ bytes to (.+)/);
			if (match) filesWritten.push(match[1]);
		}
		// Track edits — the edit tool returns "Successfully replaced N block(s) in <path>."
		// Anchor the path capture so it does not over-capture unrelated text.
		if (name === "edit" && !content.includes("ERR") && !msg.isError) {
			const match = content.match(/replaced \d+ block\(s\) in (.+?)\.?$/m);
			if (match) filesEdited.push(match[1]);
		}
		// Track errors — but filter out edit retries (old_text mismatch = normal retry, not error)
		if (
			(content.includes("ERR:") || content.includes("Error:") || content.includes("FAIL")) &&
			!content.includes("old text must match") &&
			!content.includes("The old text") &&
			!content.includes("oldText not found") &&
			!content.includes("old_text not found")
		) {
			const preview = content.slice(0, 150).replace(/\n/g, " ");
			errorsHit.push(`${name}: ${preview}`);
		}
		// Track test results
		if (content.includes("PASS") || content.includes("✅") || content.includes("✗") || content.includes("❌")) {
			const lines = content.split("\n").filter((l: string) => /PASS|FAIL|✅|❌|✗/.test(l));
			testResults.push(...lines.slice(0, 10));
		}
	}

	return {
		userAborted,
		hasAuthError,
		transient: isTransientError(rawMessages),
		toolCallCount,
		filesWritten,
		filesEdited,
		errorsHit,
		testResults,
		calledMemorySearch: toolNames.includes("memory_search"),
		calledMemoryWrite: toolNames.includes("memory_write"),
	};
}

/** Build the heuristic summary injected into the next phase's instruction. */
export function buildPhaseSummary(analysis: PhaseEndAnalysis, maxToolCallsPerPhase: number): string {
	const parts: string[] = [];
	parts.push(`Tool calls: ${analysis.toolCallCount}`);
	if (analysis.toolCallCount > maxToolCallsPerPhase) {
		parts.push(
			`⚠️ WARNING: Phase used ${analysis.toolCallCount} tool calls (limit: ${maxToolCallsPerPhase}). Possible loop detected.`,
		);
	}
	if (analysis.filesWritten.length > 0) parts.push(`Files created/written: ${analysis.filesWritten.join(", ")}`);
	if (analysis.filesEdited.length > 0) parts.push(`Files edited: ${analysis.filesEdited.join(", ")}`);
	if (analysis.testResults.length > 0) parts.push(`Test results:\n${analysis.testResults.join("\n")}`);
	if (analysis.errorsHit.length > 0)
		parts.push(`Errors encountered: ${analysis.errorsHit.length}\n${analysis.errorsHit.slice(0, 5).join("\n")}`);
	if (!analysis.calledMemorySearch) parts.push(`⚠️ Phase did NOT call memory_search (mandatory)`);
	if (!analysis.calledMemoryWrite) parts.push(`⚠️ Phase did NOT call memory_write (mandatory)`);
	return parts.join("\n");
}

/**
 * Prefer the phase's canonical "## HANDOFF" block over the heuristic summary;
 * fall back to the heuristic when the model did not write one.
 */
export function buildNextBrief(
	analysis: PhaseEndAnalysis,
	handoff: string,
	phaseLabel: string,
	maxToolCallsPerPhase: number,
): string {
	return handoff
		? `Tool calls: ${analysis.toolCallCount}\n## HANDOFF (from ${phaseLabel})\n${handoff}`
		: buildPhaseSummary(analysis, maxToolCallsPerPhase);
}

export type PhaseDecision =
	| { action: "stop"; reason: "user-abort" | "auth-error" }
	| { action: "retry-fallback" }
	| { action: "pause-blocked" }
	| { action: "review-fix-cycle" }
	| {
			action: "continue";
			/** The phase answered with prose only — warn and nudge the next phase. */
			zeroToolCalls: boolean;
			/**
			 * The phase was expected to write a "VERDICT:" line but none parsed —
			 * a model deviated from the text contract. Surface it instead of
			 * silently treating the phase as passed.
			 */
			missingVerdict: boolean;
	  };

export interface PhaseDecisionInput {
	analysis: PhaseEndAnalysis;
	/** Currently executing phase, or null when the queue raced. */
	phase: { key: string; retried?: boolean } | null;
	/** Verdict parsed from the phase's report file (null = absent/unparseable). */
	verdict: PhaseVerdict | null;
	/** Whether a report file existed at all for this phase. */
	hasReport: boolean;
	/** Completed review-fix cycles so far (bounded to one). */
	reviewFixRounds: number;
	maxToolCallsPerPhase: number;
}

/** Phases whose contract REQUIRES a leading "VERDICT:" line in their report. */
const VERDICT_PHASES = new Set(["test", "review"]);

/**
 * Decide the transition after a phase's agent loop completed. Pure — the
 * caller interprets the decision (notifications, queue edits, checkpoints).
 */
export function decidePhaseTransition(input: PhaseDecisionInput): PhaseDecision {
	const { analysis, phase, verdict, hasReport, reviewFixRounds, maxToolCallsPerPhase } = input;

	if (analysis.userAborted) return { action: "stop", reason: "user-abort" };
	if (analysis.hasAuthError) return { action: "stop", reason: "auth-error" };

	// Transient provider/proxy failure: retry the SAME phase once on the
	// fallback model (a different family often gets through).
	if (phase && !phase.retried && analysis.transient) {
		return { action: "retry-fallback" };
	}

	if (verdict === "BLOCKED" && phase) return { action: "pause-blocked" };

	const looped = analysis.toolCallCount > maxToolCallsPerPhase;
	if (phase?.key === "review" && verdict === "FAIL" && reviewFixRounds < 1 && !looped) {
		return { action: "review-fix-cycle" };
	}

	return {
		action: "continue",
		zeroToolCalls: analysis.toolCallCount === 0,
		missingVerdict: phase !== null && VERDICT_PHASES.has(phase.key) && hasReport && verdict === null,
	};
}
