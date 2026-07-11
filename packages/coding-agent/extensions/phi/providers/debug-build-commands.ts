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
2. Paste the exact command and its full output.
3. Decide from what \`sandbox_run\` returned:
   - If it FAILS as reported → capture the precise symptom (assertion, exception, exit code) and hand off to LOCALIZE.
   - If it PASSES → STOP. Write \`BLOCKED: cannot reproduce — passes on current code\` with the run pasted. Do not invent a bug.
   - If \`sandbox_run\` reports \`SANDBOX UNAVAILABLE\` → STOP. Write \`BLOCKED: no executable environment\`.
4. Do NOT edit any source yet. This phase only observes.
5. **Last action:** call \`phase_result\` — \`verdict: PASS\` if it reproduced (proceed to LOCALIZE), or \`verdict: BLOCKED\` with the reason if you stopped.` +
			DEBUG_RULES,

		localize: `You are the LOCALIZE agent (phase 2 of /debug). Drive from the REAL symptom the previous phase captured.

**The failing state:**
${failing}

**Do exactly this:**
1. Read the traceback / error from the reproduction. Follow it to the exact frame.
2. Read the implicated source and the symbols it touches (grep the nearby/changed identifiers).
3. Name the fault site precisely — file:line and the wrong assumption. Localization, not more review, is the lever here.
4. Hand off a crisp fault description; do NOT fix yet.${DEBUG_RULES}`,

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
4. Write the final verdict block, then call \`phase_result\` with \`verdict: PASS\` (FIXED) or \`verdict: BLOCKED\`, plus a one-line handoff:
\`\`\`
VERDICT: FIXED | BLOCKED
Evidence: reproBefore=fail reproAfter=pass suite=green|skipped
Reason: <only when BLOCKED>
\`\`\`${DEBUG_RULES}`,
	};
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
