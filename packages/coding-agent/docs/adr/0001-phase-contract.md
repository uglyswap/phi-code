# ADR 0001 — Structured-primary phase contract for /plan

Status: accepted (2026-07-10)

## Context

The /plan orchestrator chains five agent phases (explore → plan → code → test
→ review). Each phase must report two things the orchestrator acts on:

- a **verdict** (TEST/REVIEW): PASS / FAIL / BLOCKED / SKIP, and
- a **handoff** (+ BLOCKING findings for REVIEW) carried to the next phase.

Originally this was communicated **only** as markdown the model wrote to
`.phi/plans/<phase>-<ts>.md`, which the orchestrator scraped with regexes
(`## VERDICT:`, `## HANDOFF`, `## BLOCKING`). That is fragile: models phrase
headers inconsistently (`**HANDOFF**`, `HANDOFF:`, mid-sentence "verdict"), and
a mis-scrape silently degrades control flow — a missed REVIEW FAIL skips the fix
cycle; a missed BLOCKED keeps a doomed run going. The original justification for
text-only was that the upstream proxy did not guarantee valid structured tool
output.

## Decision

Keep the markdown report (it is the human-readable artifact) but make the
**machine-read path structured and primary**:

- The orchestrator registers a `phase_result` tool. TEST and REVIEW phases are
  instructed to call it with `{verdict, blocking, handoff}`; any phase may call
  it to hand off.
- `resolvePhaseOutcome(structured, reportText)` (pure, unit-tested) merges the
  two sources **field by field**, preferring the structured value and falling
  back to the regex-scraped report per field. When the model calls the tool the
  outcome is exact; when it does not, behavior is byte-for-byte the pre-existing
  text path.
- The text parser was hardened anyway (`extractSection` accepts heading, bold,
  and plain-label forms) so the fallback is as robust as possible.

## Why not go structured-only

Two reasons the text path stays as a fallback rather than being removed:

1. **Provider variance.** Not every provider/proxy reliably emits tool calls on
   every turn; a model that writes a good report but forgets the tool call must
   still drive the pipeline correctly.
2. **Zero-regression migration.** Making structured additive means the change
   cannot make any existing run worse — the worst case equals the old behavior.

## Consequences

- Robustness of control flow (verdict/BLOCKED/fix-cycle) now depends on a
  structured emission when available, not on regex luck.
- Two code paths must stay in sync; `resolvePhaseOutcome` centralizes the merge
  and is covered by unit tests, and `orchestrator-integration.test.ts` drives
  the whole chain via the structured path.
- Follow-up (not done here): once telemetry shows the structured path is taken
  reliably across the providers phi ships, the text fallback can be demoted to a
  warning-only safety net.
