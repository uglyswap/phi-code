# phi-code evals

A small, honest measurement harness. It answers "does a strategy actually
produce working code?" with objective pass/fail verifiers, not vibes.

## What it measures

Each task in `tasks/*.json` has a `prompt` and a deterministic `verify` command
(exit 0 == success). The runner executes the prompt with a strategy in an
isolated temp dir, runs the verifier, and records pass/fail + wall-clock. The
scoring/aggregation lives in `lib.ts` and is unit-tested
(`test/evals-lib.test.ts`), so the reported numbers are trustworthy.

## Run it

Requires a configured provider (run `/setup` in phi first, or export an API
key). From `packages/coding-agent`:

```bash
npx tsx evals/run.ts --model opencode-go/glm-5.2
npx tsx evals/run.ts                      # phi's default model
npx tsx evals/run.ts --out evals/report.md
```

Example real run (2 tasks, opencode-go/glm-5.2): baseline 100% (2/2), mean 39.5s.
`report.md` is generated and git-ignored.

## Add a task

Drop a JSON file in `tasks/`:

```json
{
  "id": "unique-id",
  "description": "one line",
  "prompt": "what the agent must build",
  "verify": "node -e \"...assert the result... console.log('ok')\"",
  "timeoutSec": 240
}
```

Keep `verify` deterministic (no network, no clock) and tolerant of irrelevant
style choices — assert the behavior, not the export shape. (A real run here
caught a verifier that failed a correct solution only because the model used
`module.exports = fn` instead of `{ fn }`; the verifiers now accept both.)

## Baseline vs /plan — head-to-head

Both strategies are now runnable:

```bash
npx tsx evals/run.ts       --model opencode-go/glm-5.2   # baseline: one phi --print
npx tsx evals/run-plan.ts  --model opencode-go/glm-5.2   # /plan: the 5-phase orchestrator, headless
```

`/plan` chains its phases through UI events that `--print` does not pump, so it
is not scriptable as a subprocess. `run-plan.ts` drives it in-process via the
SDK (`createAgentSession`): it dispatches `/plan <task>` and polls the
orchestrator's `globalThis.__phiOrchestrationActive` flag until the run
completes, then verifies the result. It loads the orchestrator from the phi
install (`~/.phi/agent`), so keep `npm i -g @phi-code-admin/phi-code` in sync
with the code under test, or pass `--sdk <path-to-dist/index.js>`.

### Measured result (2026-07-10, opencode-go/glm-5.2, n=3)

| Strategy | Pass rate | Mean time |
|----------|-----------|-----------|
| baseline | 3/3 (100%) | 43s |
| /plan    | 3/3 (100%) | 605s |

On this small set — including `semver-parse`, written with strict edge cases to
favor the plan/test/review machinery — **`/plan` did not beat the baseline; it
tied at ~14× the wall-clock (and far more tokens).** Because both strategies
passed everything, this measures *cost*, not *quality*: a capable model already
solves these single-shot, so the extra phases add overhead with no observable
benefit. A quality difference can only appear on tasks where the baseline
actually fails — which these are not. That regime is what SWE-bench-lite
provides, and measuring it fairly needs the official per-instance Docker harness
(the repos do not build at an old commit on a bare Windows/Python-3.14 box) plus
a real token budget. Until that runs, the honest status of the /plan thesis is:
**unproven, with the preliminary evidence pointing the other way on anything a
good model handles in one shot.**

### What the head-to-head measures (and its limits)

This is a **small, honest** comparison, not the official SWE-bench-lite 300-set
(which needs per-instance Docker environments and a real budget — each `/plan`
run is five agentic phases, minutes and many tokens per task). It answers a
narrower question on a handful of tasks with objective verifiers: does the
extra explore→plan→code→test→review machinery produce a *better result* than a
single shot, and at what cost? Read the numbers as a directional signal on a
tiny sample, not a benchmark ranking. The honest expectation going in: `/plan`
costs multiples more time/tokens, so it only earns its keep on tasks where a
single shot actually fails — the trivial tasks are there precisely to show the
cost overhead when it does *not* help.
