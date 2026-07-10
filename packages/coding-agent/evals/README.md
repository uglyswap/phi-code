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
