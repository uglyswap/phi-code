/**
 * Pure helpers for the /plan orchestrator. Kept separate from orchestrator.ts so
 * they can be unit-tested (orchestrator.ts itself wires the Pi extension runtime).
 *
 * Everything here is text/regex only: the orchestration pipeline is driven by
 * canonical text contracts in the .phi/plans/*.md handoff files, never by a
 * model's structured-output (the upstream proxy does not guarantee valid JSON).
 */

export type PhaseVerdict = "PASS" | "FAIL" | "BLOCKED" | "SKIP";

/**
 * Parse the canonical "VERDICT: PASS|FAIL|BLOCKED|SKIP" line a phase writes at the
 * top of its report. Tolerant of leading markdown hashes and surrounding markup.
 * Returns the first verdict found, or null when none is present.
 */
export function parsePhaseVerdict(content: string): PhaseVerdict | null {
	if (!content) return null;
	const m = content.match(/^\s{0,3}#{0,4}\s*\**\s*VERDICT\s*\**\s*:?\s*\**\s*(PASS|FAIL|BLOCKED|SKIP)\b/im);
	return m ? (m[1].toUpperCase() as PhaseVerdict) : null;
}

/**
 * Extract the body of a markdown section by heading name (e.g. "BLOCKING",
 * "HANDOFF"), up to the next heading or end of file. Returns "" if absent.
 */
export function extractSection(content: string, heading: string): string {
	if (!content) return "";
	const re = new RegExp(`#{1,6}\\s*\\**\\s*${heading}\\b[^\\n]*\\n([\\s\\S]*?)(?:\\n#{1,6}\\s|$)`, "i");
	const m = content.match(re);
	return m ? m[1].trim() : "";
}

export function extractBlockingFindings(content: string): string {
	return extractSection(content, "BLOCKING");
}

export function extractHandoff(content: string): string {
	return extractSection(content, "HANDOFF");
}

/**
 * Detect a TRANSIENT provider/proxy failure in a phase's messages (timeout, 5xx,
 * 429, connection reset, broken JSON tool call) that warrants a one-shot retry on
 * a fallback model. A genuine 401 auth failure is NOT transient (handled as fatal
 * by the caller) and is explicitly excluded.
 */
export function isTransientError(messages: readonly unknown[]): boolean {
	for (const m of messages || []) {
		const msg = (m ?? {}) as { content?: unknown };
		const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
		if (content.includes("401")) continue;
		if (/\b(429|500|502|503|504)\b/.test(content)) return true;
		if (
			/timed?\s?out|timeout|connection reset|ECONNRESET|ETIMEDOUT|socket hang ?up|overloaded|rate.?limit(ed)?|too many requests|invalid json|failed to parse|stream (error|interrupted|closed)|service unavailable|bad gateway|gateway timeout/i.test(
				content,
			)
		) {
			return true;
		}
	}
	return false;
}
