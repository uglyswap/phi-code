# ADR 0002 — Independent adversarial review as a release gate

Status: accepted (2026-07-10)

## Context

phi-code is largely built by a single author, who is also the only reviewer.
Self-review misses the bugs the author's mental model is blind to — the code
does what the author *thinks* it does, and they test that. There is no external
human reviewer on hand for every change.

## Decision

Before shipping a non-trivial change to a load-bearing subsystem (the /plan
orchestrator, the model/provider layer, compaction, the extension runtime), run
an **independent adversarial review**: a reviewer with fresh context that did
not write the code, prompted to *refute* — to find state leaks, races, contract
mismatches, and edge cases — not to approve.

Findings are triaged (verify each against the code, discard false positives),
the real ones are fixed, and each fix is pinned with a regression test before
the change ships.

## Evidence this works

The structured-phase-contract change (ADR 0001) passed the author's own unit
and integration tests. An independent review of that change then found four
real defects the author's tests missed:

- a structured result leaking from one `/plan` run into the next (a stale
  BLOCKED verdict could abort a fresh run at phase 1);
- a second `phase_result` call erasing fields set by the first;
- no phase-identity guard against a late tool call landing after a transition;
- the text HANDOFF fallback being dead for two phases due to a report-file name
  mismatch.

All four are now fixed and covered by regression tests
(`orchestrator-integration.test.ts`, `phase-machine.test.ts`).

## Consequences

- "Green tests" is necessary but not sufficient for a load-bearing change; an
  independent refutation pass is part of the definition of done.
- The reviewer need not be human to be useful — it needs to be *independent of
  the authoring context* and prompted adversarially. This is not a substitute
  for real external users, whose absence remains an honest limitation of the
  project's validation.
