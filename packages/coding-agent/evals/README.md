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

## Baseline vs /plan — the honest status

The runner currently measures the **baseline** strategy: a single `phi --print`
call. The reason the /plan-vs-baseline head-to-head is not yet a single number
is that `/plan` runs inside the interactive orchestrator (it registers a command
and drives phases via UI events), which is not scriptable through `--print`. The
harness is built so a `plan` strategy plugs into `run.ts` alongside `baseline`
once /plan is drivable headlessly (e.g. via RPC mode); `lib.ts` already
aggregates and compares multiple strategies (see the `summarize` tests). Until
then this measures the floor, and claims about /plan beating the baseline stay
unproven rather than asserted.
