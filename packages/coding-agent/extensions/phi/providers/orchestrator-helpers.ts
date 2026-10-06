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
 * Extract the body of a section by name (e.g. "BLOCKING", "HANDOFF"), up to the
 * next section header or end of file. Returns "" if absent.
 *
 * Tolerant of the three header shapes models actually emit for the same
 * section: a markdown heading (`## HANDOFF`), a standalone bold label
 * (`**HANDOFF**`), or a plain label line (`HANDOFF:`). Termination stops at the
 * next markdown heading or the next standalone bold/plain label line, so a
 * report written entirely with bold labels still splits into sections instead
 * of the first one swallowing the rest.
 */
export function extractSection(content: string, heading: string): string {
	if (!content) return "";
	// Header line, in one of three shapes, anchored to line start:
	//   `## HANDOFF ...`  (markdown heading — trailing text allowed)
	//   `**HANDOFF**`     (bold label — closing stars, then only trailing space)
	//   `HANDOFF:` / `HANDOFF` (plain label — must be the whole line or end in ":")
	// The plain form requires ":" or end-of-line after the name so a prose line
	// like "Blocking issues remain: 2" is not mistaken for a "BLOCKING" header.
	const start = new RegExp(
		`(?:^|\\n)[ \\t]{0,3}(?:` +
			`#{1,6}[ \\t]*\\*{0,2}[ \\t]*${heading}\\b[^\\n]*` + // heading
			`|\\*{2}[ \\t]*${heading}[ \\t]*\\*{2}[ \\t]*` + // bold label
			`|${heading}[ \\t]*:?[ \\t]*` + // plain label (bare or "name:")
			`)\\n`,
		"i",
	);
	const m = start.exec(content);
	if (!m) return "";
	const rest = content.slice(m.index + m[0].length);
	// Next section boundary: a markdown heading line, or a line that is ONLY a
	// bold label (`**LABEL**`) — not inline bold inside a bullet, which would
	// truncate the body.
	const end = rest.search(/\n[ \t]{0,3}(?:#{1,6}[ \t]|\*{2}[A-Za-z][^\n]*\*{2}[ \t]*(?:\n|$))/);
	return (end === -1 ? rest : rest.slice(0, end)).trim();
}

export function extractBlockingFindings(content: string): string {
	return extractSection(content, "BLOCKING");
}

export function extractHandoff(content: string): string {
	return extractSection(content, "HANDOFF");
}

/**
 * Text of the provider errors in a phase: only assistant turns that ENDED in an
 * error count. The phase prompt (which itself mentions "timeout"), tool output
 * (test runners print "timed out", curl prints "503"...) and normal replies are
 * not provider failures; scanning them made every TEST/VERIFY phase retry.
 */
export function providerErrorTexts(messages: readonly unknown[]): string[] {
	const texts: string[] = [];
	for (const m of messages || []) {
		const msg = (m ?? {}) as { role?: unknown; stopReason?: unknown; errorMessage?: unknown; content?: unknown };
		if (msg.role !== "assistant" || msg.stopReason !== "error") continue;
		const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
		texts.push(`${typeof msg.errorMessage === "string" ? msg.errorMessage : ""}\n${content}`);
	}
	return texts;
}

/**
 * Detect a TRANSIENT provider/proxy failure in a phase's messages (timeout, 5xx,
 * 429, connection reset, broken JSON tool call) that warrants a one-shot retry on
 * a fallback model. A genuine 401 auth failure is NOT transient (handled as fatal
 * by the caller) and is explicitly excluded.
 */
export function isTransientError(messages: readonly unknown[]): boolean {
	for (const content of providerErrorTexts(messages)) {
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

/** Minimal model shape needed to resolve a routing.json reference. */
export interface ModelRefCandidate {
	id: string;
	provider: string;
}

/**
 * Resolve a routing.json model reference to an available model.
 * Accepts a provider-qualified "provider/id" reference (so the same model id
 * offered by several providers can be disambiguated) and falls back to a bare
 * "id" for legacy configs. Splits on the FIRST slash only, since some model
 * ids themselves contain slashes (e.g. OpenRouter "anthropic/claude-...").
 * Shared by the orchestrator and the smart router (routing.json is written
 * with "provider/id" refs by /setup and /plan-models).
 */
export function resolveModelRef<T extends ModelRefCandidate>(available: readonly T[], ref: string): T | undefined {
	if (!ref) return undefined;
	const slash = ref.indexOf("/");
	if (slash > 0) {
		const provider = ref.slice(0, slash);
		const id = ref.slice(slash + 1);
		const qualified = available.find((m) => m.provider === provider && m.id === id);
		if (qualified) return qualified;
	}
	return available.find((m) => m.id === ref);
}

/**
 * System prompt for an orchestration phase: the session's assembled base
 * prompt (project context files, skills, tool guidelines, cwd/date) followed
 * by the phase agent's persona. before_agent_start's `systemPrompt` result
 * REPLACES the prompt for the turn, so the persona must be composed with the
 * base instead of returned alone.
 */
export function composePhaseSystemPrompt(basePrompt: string | undefined, persona: string): string {
	const base = typeof basePrompt === "string" ? basePrompt.trimEnd() : "";
	const section = `# Orchestration phase agent\n\nFor this phase you act as the agent below. Its instructions take precedence over the general guidance above when they conflict.\n\n${persona.trim()}`;
	return base ? `${base}\n\n${section}` : section;
}
