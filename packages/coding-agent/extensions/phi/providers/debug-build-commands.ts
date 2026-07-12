/**
 * Instruction builders for the /debug and /build phase pipelines.
 *
 * These are PURE text builders (no fs, no Pi) so the exact protocol each phase
 * agent receives is unit-testable. They encode the contracts from
 * docs/design/plan-debug-build.md: /debug turns a REAL failure green through
 * REPRODUCE → LOCALIZE → FIX → VERIFY with execution as the only oracle; /build
 * adds an execution-grounded verify (run recipe + acceptance + executable
 * red-team) that routes real failures back to the /debug protocol.
 */

import type { FailingState } from "./debug-contract.js";

/** Render a failing state as a compact, unambiguous block for an instruction. */
export function formatFailingState(state: FailingState): string {
	const lines: string[] = [];
	if (state.failingTest?.trim()) lines.push(`- Failing test: \`${state.failingTest.trim()}\``);
	if (state.reproCommand?.trim()) lines.push(`- Repro command: \`${state.reproCommand.trim()}\``);
	if (state.expected?.trim()) lines.push(`- Expected behaviour: ${state.expected.trim()}`);
	if (state.trace?.trim()) lines.push(`- Trace / error:\n\`\`\`\n${state.trace.trim()}\n\`\`\``);
	if (state.cwd?.trim()) lines.push(`- Working directory: \`${state.cwd.trim()}\``);
	return lines.length ? lines.join("\n") : "- (no structured failing state supplied)";
}

export interface DebugInstructions {
	reproduce: string;
	localize: string;
	fix: string;
	verify: string;
}

const DEBUG_RULES = `
---
## /debug operating rules (non-negotiable)
- **Execution is the only oracle.** No verdict without a real run whose output you paste. Never write FIXED because the code "looks right".
- **Use the \`sandbox_run\` tool for every oracle run** (reproduction, suite, acceptance). It runs in the project's guaranteed environment and returns the REAL exit code — a PASS means \`sandbox_run\` returned exit 0, nothing less.
- **No fabricated PASS.** If \`sandbox_run\` reports \`SANDBOX UNAVAILABLE\` (or you otherwise cannot run the reproduction), emit \`BLOCKED: no executable environment\` — do NOT reconstruct a mock and grade your own reconstruction.
- **Minimal fix wins.** Prefer the smallest change; every added guard/condition is a liability that can hide the bug (an over-clever guard is exactly how these fixes go wrong).
- **Root cause, not workaround.** No skipped tests, no \`--no-verify\`, no mock that hides the failure.
- The user does NOT answer during these phases. Act autonomously; do not end with a question.`;

/** The four /debug phase instructions, specialised to the concrete failing state. */
export function debugPhaseInstructions(state: FailingState): DebugInstructions {
	const failing = formatFailingState(state);
	const repro = state.failingTest?.trim() || state.reproCommand?.trim() || "(the reproduction command)";

	return {
		reproduce:
			`You are the REPRODUCE agent (phase 1 of /debug). Your only job is to CONFIRM the failure is real.

**The reported failing state:**
${failing}

**Do exactly this:**
1. Run the reproduction on the CURRENT, unmodified code with the \`sandbox_run\` tool: \`sandbox_run ${repro}\`.
   - If you must CONSTRUCT the reproduction (only a description was given): build it **literally from the issue** — copy the exact code snippets, inputs and expected values QUOTED in the issue text into a runnable script/test. Do NOT paraphrase the issue into your own interpretation; a reproduction of your interpretation validates your interpretation, not the bug (measured failure mode).
2. Paste the exact command and its full output.
3. Decide from what \`sandbox_run\` returned:
   - If it FAILS as reported → capture the precise symptom (assertion, exception, exit code) and hand off to LOCALIZE.
   - If it PASSES → STOP. Write \`BLOCKED: cannot reproduce — passes on current code\` with the run pasted. Do not invent a bug.
   - If \`sandbox_run\` reports \`SANDBOX UNAVAILABLE\` → STOP. Write \`BLOCKED: no executable environment\`.
4. Do NOT edit any source yet. This phase only observes.
5. **BLOCKED is a last resort, not a first reaction.** If a run fails for an infrastructure-looking reason (tool error, missing file you guessed wrong, transient failure), adjust and retry at least once — e.g. locate the real test paths, try an alternative reproduction — before concluding. Only report BLOCKED after a genuine attempt showed the state is not reproducible or not runnable.
6. **Last action:** call \`phase_result\` — \`verdict: PASS\` if it reproduced (proceed to LOCALIZE), or \`verdict: BLOCKED\` with the reason if you stopped. Your handoff MUST contain a line with the EXACT command that reproduces the failure, in this machine-readable form (the orchestrator re-runs it to arbitrate candidate fixes):
\`\`\`
REPRO-CMD: <the exact command, e.g. python /testbed/repro_issue.py>
\`\`\`` + DEBUG_RULES,

		localize: `You are the LOCALIZE agent (phase 2 of /debug). Drive from the REAL symptom the previous phase captured.

**The failing state:**
${failing}

**Do exactly this:**
1. Call \`memory_search\` with the failing symbol/module names — a previous run may have already localized this area or a related failure.
2. Read the traceback / error from the reproduction. Follow it to the exact frame.
3. Read the implicated source and the symbols it touches (grep the nearby/changed identifiers).
4. Name the fault site precisely — file:line and the wrong assumption. Localization, not more review, is the lever here.
5. Hand off a crisp fault description; do NOT fix yet. Call \`memory_write\` with the fault site so future runs on this project start ahead.${DEBUG_RULES}`,

		fix:
			`You are the FIX agent (phase 3 of /debug). Produce the MINIMAL change that addresses the located root cause.

**The failing state:**
${failing}

**Do exactly this:**
1. Write the smallest patch that fixes the root cause at the fault site LOCALIZE named.
2. If two approaches are plausible, prefer the one that adds the least surface (fewest new branches/guards).
3. Do NOT run the suite to "confirm" here by eye — VERIFY re-runs everything. Just make the change and state precisely what you changed and why it addresses the cause.` +
			DEBUG_RULES,

		verify: `You are the VERIFY agent (phase 4 of /debug) — the oracle. A green verdict requires TWO real runs.

**The failing state:**
${failing}

**Do exactly this, pasting every command's output:**
1. Re-run the reproduction with \`sandbox_run ${repro}\`. It MUST now return exit 0.
2. Run the existing test suite with \`sandbox_run <test command>\`. It MUST NOT regress.
3. Verdict (from what \`sandbox_run\` returned, not from inspection):
   - Both green → \`FIXED\`, and paste the before(fail)/after(pass) reproduction runs and the green suite as evidence.
   - Reproduction still fails, or the suite regresses → \`BLOCKED\` with the closest diagnostic. Do NOT ship the least-bad patch; a wrong fix is worse than an honest BLOCKED.
   - **A TIMEOUT counts as a FAILURE.** If the reproduction or the suite TIMES OUT with the fix applied (\`sandbox_run\` verdict TIMEOUT), the fix has introduced a massive slowdown or an infinite loop — that IS a regression (measured: a fix that passed its repro but made the real test suite hang for 900s). Verdict \`BLOCKED\`, never \`FIXED\`. Compare rough durations before/after: a check that got dramatically slower is a red flag even below the timeout.
4. Write the final verdict block, then call \`phase_result\` with \`verdict: PASS\` (FIXED) or \`verdict: BLOCKED\`, plus a one-line handoff:
\`\`\`
VERDICT: FIXED | BLOCKED
Evidence: reproBefore=fail reproAfter=pass suite=green|skipped
Reason: <only when BLOCKED>
\`\`\`${DEBUG_RULES}`,
	};
}

/**
 * The REPRO-AUDIT phase — red-team the reproduction ITSELF (the twice-measured
 * failure: requests-2148 and flask-4992 both had a reproduction that validated
 * the agent's interpretation while the project's real tests failed). A
 * DIFFERENT model family answers one question — "which case stated in the
 * issue is NOT covered by this reproduction?" — and extends it. Only used when
 * the reproduction was CONSTRUCTED from prose; a user-supplied failing test is
 * already ground truth.
 */
export function reproAuditInstruction(state: FailingState): string {
	const failing = formatFailingState(state);
	return `You are the REPRO-AUDIT agent (adversary). The previous phase CONSTRUCTED a reproduction from the issue text. Your single question: **which case stated in the issue is NOT covered by that reproduction?**

**The issue / failing state:**
${failing}

**Do exactly this:**
1. Read the reproduction script/command the previous phase reported (see its handoff and the repro file in the working tree).
2. Compare it against the issue LITERALLY: every quoted snippet, input, expected value, and edge case named in the issue text. List what the reproduction does NOT exercise.
3. If gaps exist: EXTEND the reproduction (edit the repro file — this is the one file you may edit) to cover them, then run it with \`sandbox_run\` — it must still FAIL on the current code for the same root cause.
4. If the reproduction only passes because it mirrors an interpretation, not the issue: rewrite it from the issue's own examples and re-run.
5. **Last action:** call \`phase_result\` with \`verdict: PASS\` (audited — gaps closed or none found) or \`verdict: BLOCKED\` (the issue cannot be reproduced as stated), and a handoff that MUST restate the final command on a machine-readable line:
\`\`\`
REPRO-CMD: <the exact, possibly updated, command>
\`\`\`${DEBUG_RULES}`;
}

/**
 * The /fix single-shot phase — the measured-cheapest first attempt. One agent
 * fixes directly (baseline cost); the DRIVER then oracle-checks the result
 * deterministically (sandbox repro + suite) and escalates to the full /debug
 * pipeline only if a real run is red. Measured rationale: the single shot
 * resolved 7/13 vs the full pipeline's 6/13 at ~2.5× the time — so pay the
 * pipeline only when a real run proves the shot failed.
 */
export function singleShotInstruction(state: FailingState): string {
	const failing = formatFailingState(state);
	return `You are the FIX agent (single shot — /fix phase 1). Fix the problem directly, with the MINIMAL change.

**The problem:**
${failing}

**You must ACT in this turn — call the read/edit/write tools and actually change the code. A textual plan or analysis with no edits counts as a FAILED shot (measured failure mode) and forfeits your attempt to the full pipeline.**

**Do exactly this:**
1. Read the relevant code and locate the root cause.
2. Make the smallest change that addresses it. Do NOT edit tests. Every added guard/branch is a liability.
3. If NO runnable check was provided above, WRITE a minimal reproduction script derived **literally from the issue** (copy its exact snippets/expected values — not your paraphrase) into an untracked file (e.g. \`repro_issue.py\`), and confirm with \`sandbox_run\` that it fails before your change / passes after.
4. You MAY use \`sandbox_run\` to check your work at any point (the project's real environment).
5. After your change, the orchestrator re-runs the reproduction (and the suite when known) in the sandbox itself: your work is judged by those REAL runs, not by your confidence. If they are red, a full diagnostic pipeline takes over from your change.
6. **Last action:** call \`phase_result\` with \`verdict: PASS\` and a handoff describing what you changed — and, when you wrote a reproduction, its exact command on a machine-readable line:
\`\`\`
REPRO-CMD: <the exact command, e.g. python repro_issue.py>
\`\`\`${DEBUG_RULES}`;
}

/**
 * The /build execution-grounded verify phase: run the recipe, check acceptance,
 * red-team the boundary the change touched, and route real failures to /debug.
 */
export function buildVerifyInstruction(spec: string): string {
	return `You are the BUILD-VERIFY agent — the execution oracle for /build. The code has been written; now PROVE it runs and meets the spec, or report honestly what still fails.

**Original spec:** ${spec}

**Every run below goes through the \`sandbox_run\` tool** (the project's guaranteed environment). If it reports \`SANDBOX UNAVAILABLE\`, do not fabricate results — mark the affected criteria ❔ and say the environment was unavailable.

**Do exactly this, pasting every command's output:**
1. **Run recipe.** From the brief's \`## Run Recipe\` (or package.json / Makefile / Dockerfile), build and start the app via \`sandbox_run\`. Distinguish a real failure from a stale launch recipe.
2. **Acceptance.** For each acceptance criterion derived from the SPEC (not the code), \`sandbox_run\` a concrete check that exits 0 iff it holds. Mark each ✅ (sandbox_run returned 0), ❌ (non-zero), or ❔ (could not be executed — NEVER count ❔ as passing).
3. **Executable red-team.** Attack the specific input regimes the change touched (empty, null, boundary, wrong-type, and buffered-vs-streaming / malformed / auth as relevant). Each attack must be a RUNNABLE test \`sandbox_run\` can execute and that goes RED if it breaks the code — an opinion is not a finding.
4. **Route real failures.** For every ❌ criterion and every red-team break, treat it as a concrete failing state (failing test / repro command / expected) and fix it with the /debug protocol: REPRODUCE → LOCALIZE → minimal FIX → VERIFY (re-run the reproduction AND the suite).
5. **Honest verdict.** When all checkable criteria pass and the red-team finds no break, write \`BUILD: SUCCESS\`. If rounds/budget run out with failures open, write \`BUILD: PARTIAL\` and LIST exactly which criteria still fail — never a confident-wrong SUCCESS. Then call \`phase_result\` with \`verdict: PASS\` (SUCCESS) or \`verdict: FAIL\`/\`BLOCKED\` and the handoff.
\`\`\`
VERDICT: PASS | FAIL | BLOCKED
Handoff:
State: <what runs and is proven by a real run>
Open Risks: <criteria still ❔ unverified or ❌ failing>
Next: <the single most important remaining action>
\`\`\`${DEBUG_RULES}`;
}
