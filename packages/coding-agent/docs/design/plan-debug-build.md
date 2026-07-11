# Design: /plan, /debug, /build — composable, execution-grounded modes

Status: proposed (2026-07-11)
Informed by: the SWE-bench-lite head-to-head (ADR 0001/0002 and evals/), which
measured that a 5-phase, deliberation-heavy /plan ties or loses to a single shot
at 6–14× the cost on bug-fixing, and — decisively — that its TEST/REVIEW phases
approve wrong code because they grade the model's own reconstruction, not a real
run. Multi-model diversity did NOT fix this: a different family (deepseek)
independently endorsed the same wrong guard, because the error was a *shared
plausible misconception*, not a model-specific blind spot.

The one thing that would have caught it was running the real test. So this design
moves the burden of proof from the model to **execution**, and splits the work
into three composable commands.

## Principles (each is a measured lesson, not a preference)

1. **Execution is the only oracle.** Every accept/reject decision must be backed
   by running real code — the existing test suite, a reproduction, or the built
   app — not by a model reviewing its own output. Opinion (even adversarial,
   even multi-model) shares misconceptions; a red test run does not.
2. **Adversarial means executable.** "Challenge the fix" must produce a *failing
   run*, never a critique. A run is objective; prose is not.
3. **Pay complexity only when earned.** A one-line change must not trigger a
   five-phase pipeline. Depth adapts to task size/type, decided by cheap signals.
4. **Diversity proposes, the oracle disposes.** Multiple models are useful for
   generating *candidate fixes*, filtered by real execution — not for casting
   *review votes*, which correlate.
5. **/plan is for building; /debug is for fixing.** They are different jobs with
   different oracles. Do not conflate them; compose them.

## The three commands

| Command | Job | Oracle | Standalone use |
|---|---|---|---|
| `/plan <spec>` | Build from a description (decompose → implement) | Acceptance criteria derived from the spec + a smoke run | "Scaffold / build this feature" |
| `/debug <failing-state>` | Turn a real failure green | The failing state + the existing test suite, re-run | "This test/trace is broken, fix it" |
| `/build <spec>` | Build AND make it actually work | The full loop: run → red-team → debug → re-run | "Build this and don't stop until it runs" |

`/build` is the outer loop that composes the two primitives with **execution
between them**. All three remain usable alone.

---

## /plan — build from a spec

Phases (each may route to its own model via routing.json):

1. **EXPLORE** — map the existing code, conventions, entry points. Read-only.
2. **PLAN** — architecture + an ordered task list. Each task is a self-contained
   prompt (the prompt-architect skill: `[CONTEXT] → [TASK] → [FORMAT] →
   [CONSTRAINTS]`). This decomposition is /plan's core value on large,
   under-specified builds — the part a single shot cannot hold coherently.
3. **CODE** — implement the tasks in dependency order.
4. **SELF-CHECK** — the cheapest real signal available: it compiles / typechecks
   / lints, and a smoke run of the entry point does not crash. NOT a substitute
   for verification — just a floor.

**Input:** a natural-language spec.
**Output contract (machine-readable, consumed by /build):**
```
{
  runRecipe:  { build?: string, run: string, test?: string, readySignal?: string },
  acceptance: string[],   // testable criteria derived from the SPEC (not the code)
  changedFiles: string[],
  selfCheck:  "pass" | "fail" | "skipped"
}
```
The `acceptance` list is the contract: crisp, checkable statements traced to the
request ("POST /login returns 200 + a JWT for valid creds; 401 otherwise").
Deriving these from the *spec* — before and independent of the implementation —
is what keeps verification from becoming circular.

Deliberately NOT in /plan: heavy TEST and REVIEW. Verification belongs to the
execution loop (/build), where it can run for real. Standalone /plan stops at
SELF-CHECK and hands its output to the user (or to /build).

---

## /debug — turn a real failure green

The heart of the redesign. /debug never guesses what is wrong; it is *given* a
failure and reproduces it.

**Input contract — a concrete failing state (at least one):**
```
{
  failingTest?:  string,   // e.g. "pytest tests/x.py::test_y"
  trace?:        string,   // a stack trace / error output
  reproCommand?: string,   // a command that exhibits the bug
  expected?:     string,   // what should happen instead (from the user/spec)
  cwd:           string
}
```
If none is runnable, /debug does not fabricate one from imagination — it asks for
one, or emits `BLOCKED: no reproducible failing state`.

Phases:

1. **REPRODUCE** — run the failing state, confirm it fails, capture the exact
   symptom. If it does NOT fail on the current code, stop: `BLOCKED: cannot
   reproduce`. (This alone kills the class of "fixes" for non-bugs.)
2. **LOCALIZE** — drive from the real symptom: read the traceback, grep the
   changed/nearby symbols, narrow to the fault site. Localization, not more
   review, is the underrated lever.
3. **FIX (generate N candidates)** — produce several minimal candidate patches
   (different models and/or temperatures). Prefer the smallest; every added
   guard/condition is a liability (the 3362 failure was an over-clever guard).
4. **VERIFY (the oracle)** — for EACH candidate, run: (a) the reproduced failure
   → must now pass, and (b) the existing test suite → must not regress. Select
   the **minimal candidate that passes both** via `candidate-select.ts`. If none
   passes, emit `BLOCKED` with the closest diagnostic — do NOT ship the least-bad.

**Output contract:**
```
{ verdict: "FIXED" | "BLOCKED",
  patch?: string,                 // minimal, verified
  evidence: { reproBefore: "fail", reproAfter: "pass", suite: "green" },
  reason?: string }               // when BLOCKED
```
`FIXED` is only ever emitted with a real before/after run pasted. There is no
path to a green verdict without execution.

---

## /build — build until it runs

`/build` = `/plan` then a bounded loop that closes the build→run→fix cycle with
execution as the glue.

```
plan = /plan(spec)                      # code + runRecipe + acceptance[]
for round in 1..MAX_ROUNDS (budgeted):
    run = execute(plan.runRecipe)       # ORACLE #1: does it run + meet acceptance?
    unmet = acceptance criteria not satisfied by `run`
    redTeam = red_team(plan, acceptance)   # ORACLE #2: can an adversary break it? (below)
    failures = unmet ∪ redTeam.breakingCases
    if failures is empty: return SUCCESS(plan)
    /debug({ from each failure: failingTest/trace/reproCommand, expected })  # fix REAL failures
    # /debug mutates the working tree; loop re-runs from the top
return PARTIAL(plan, remaining failures)   # honest: what still fails, not a false PASS
```

Key properties:
- The `execute` step is the oracle that /plan alone lacked. A criterion is met
  only if the running program demonstrates it.
- Each `/debug` call is grounded in a **real** failure (a failed acceptance run
  or a red-team breaking case), never in self-review.
- The loop is **budgeted** and returns `PARTIAL` honestly when it cannot close —
  listing the still-failing criteria — instead of a confident-wrong `PASS`.

---

## The executable red-team protocol

This replaces the current REVIEW phase (which we measured as a rubber stamp). The
adversary's deliverable is a **failing run**, not an opinion.

```
red_team(code, acceptance, changedFiles):
    dry = 0
    while dry < K and within budget:
        # An adversary agent (ideally a different model family than the coder —
        # different break intuitions) targets the BOUNDARY the change touches.
        attempt = adversary.write_breaking_case(
            focus = changedFiles,                     # not the whole app
            regimes = enumerate_input_regimes(changedFiles),  # e.g. buffered vs streaming,
                                                              # empty, null, boundary, wrong-type
            goal = "make an acceptance criterion or an invariant FALSE, as a runnable test")
        result = execute(attempt)                     # RUN it — this is the whole point
        if result.green:
            dry += 1                                  # could not break it this round
        else:
            dry = 0
            record breakingCase(attempt, result.symptom)   # a concrete red run
    return breakingCases
```

Why this works where adversarial *prose* failed (3362): the guard survived a
different model's careful written review because the reviewer shared the
misconception. It would NOT have survived `r.raw = io.BytesIO(...);
assert all(isinstance(c, str) for c in r.iter_content(decode_unicode=True))`
being *run* — that assertion is red regardless of what any model believes.
The rule that turns "adversarial" from theatre into signal: **the adversary
must attack the specific input regime the diff changed, and must express the
attack as an executed test, not a claim.**

---

## Execution grounding (the non-negotiable prerequisite)

Every oracle above requires running real code with the project's real
dependencies. On a host that cannot run the target (e.g. an old library under a
too-new Python — exactly what defeated the 3362 measurement), the modes must:
- run inside a sandbox/container that has the project's real environment, or
- when no such environment is available, DOWNGRADE honestly: /debug and /build
  emit `BLOCKED: no executable environment` (or a low-confidence draft clearly
  labelled unverified) — never a fabricated-reconstruction `PASS`.

Reusing phi's `run` / `verify` skills for local projects is the first target;
a per-project container is the general solution.

**Status (2026-07-11): implemented.** `providers/sandbox-plan.ts` (pure: toolchain
detection → recipe → backend decision → `docker run` argv) and `providers/sandbox.ts`
(the `Sandbox` IO shell: `docker` | `local` | `unavailable`) provide the guaranteed
environment. The `sandbox_run` tool exposes it to the /debug and /build phase agents
— the reproduction, the suite, and acceptance/red-team checks now run in a real
container and return its true exit code, so a PASS cannot be asserted, only earned.
When Docker is absent and nothing is containerizable, the backend is `unavailable`
and every `sandbox_run` returns `SANDBOX UNAVAILABLE`, which the phase instructions
turn into `BLOCKED` — never a fabricated pass. The `/sandbox` command
(`status` | `prepare` | `run`) inspects and provisions it. A `.phi/sandbox.json`
overrides detection (image, setup, test, backend, resource caps).

---

## Triage / adaptive depth (cost discipline)

Cheap up-front classification decides the mode and the depth:

| Signal | Route |
|---|---|
| Small edit, a known failing test/trace | `/debug` (skip planning entirely) |
| Small self-contained feature, single shot + verify passes | ship the single shot; skip the loop |
| Large, multi-file, under-specified build | `/build` (full loop) |
| A single shot's output already meets acceptance on a real run | done — do not deliberate further |

Measured rationale: the 6–14× overhead is only worth paying when a single shot
*fails the real oracle*. Otherwise the cheapest passing candidate wins.

---

## Model routing

Per-phase model assignment stays (routing.json). Corrected use, per the
measurements:
- **Candidate generation** (CODE, /debug FIX): diversity helps — different
  models/temperatures produce different candidates, and the oracle filters.
- **Red-team adversary**: a different family than the coder helps (different
  break intuitions) — but its output is a *run*, so it is robust even to shared
  misconceptions.
- **Review-by-opinion**: removed. We measured it as correlated and unreliable;
  execution replaces it.

---

## What is reused vs new

Reused from today's orchestrator: the phase engine, per-phase model switching,
the pure phase state machine (`phase-machine.ts`), the structured `phase_result`
contract, the fix-cycle, `candidate-select.ts` (minimality selection).

New work: (1) extract the fix-cycle into a standalone `/debug` with the input
contract above; (2) make `acceptance[]` + `runRecipe` first-class /plan outputs;
(3) the `/build` loop; (4) the executable red-team; (5) the execution sandbox and
the real-run verify path. Items 1–4 are prompt/orchestration changes on existing
machinery; item 5 is the real infrastructure investment.

Status: (1)–(4) shipped in 0.89.0; (5) the execution sandbox shipped in 0.90.0
(`providers/sandbox*.ts`, the `sandbox_run` tool, `/sandbox`). What remains is the
*measurement*: running /debug against a containerized SWE-bench-lite with the
sandbox as the oracle, to get the number.

## How we will know it worked (this must be measured, not shipped on faith)

- `/debug`: on SWE-bench-lite (bug-fixing), with a real executable environment,
  resolved-rate vs the single-shot baseline. The hypothesis is that real-run
  verification + candidate selection beats single-shot; if it does not, the
  premise is wrong and we stop.
- `/build`: on a *build* task set (multi-file features with runnable acceptance
  criteria — the eval /plan actually deserves, which SWE-bench does not provide),
  scored on acceptance-met + does-it-run + coherence, single-shot vs /build.

No mode ships to npm before its number beats the baseline it claims to improve.

## Non-goals / honest caveats

- This does not add "more specialized agents" for its own sake. The measured
  lesson is the opposite: minimal + execution beats elaborate + deliberation.
- It does not claim /build will beat single-shot — it makes /build *measurable*
  and gives it the one ingredient (execution) that could make it win.
- Without the execution sandbox, this is just a reorganization; the sandbox is
  where the value is, and it is real work.
