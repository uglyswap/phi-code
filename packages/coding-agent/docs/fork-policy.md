# Fork policy — staying mergeable with upstream Pi

phi-code is a fork of [pi](https://github.com/earendil-works/pi) (formerly
`badlogic/pi-mono`; `packages/coding-agent` = upstream's coding agent). This document defines
exactly **what is rebranded and what deliberately stays "pi"**, so upstream
updates can be merged with minimal conflicts and nobody "finishes" a rename
that would make every future merge painful.

## The one rule

> Rebrand **outputs** (what users see), keep **identifiers** (what code sees).

All branding flows from `packages/coding-agent/src/config.ts`, driven by
`package.json`'s `piConfig` block:

```json
"piConfig": { "name": "phi", "configDir": ".phi" }
```

which resolves to `APP_NAME = "phi"`, `APP_TITLE`, `CONFIG_DIR_NAME = ".phi"`,
`PACKAGE_NAME = "@phi-code-admin/phi-code"`. **New user-facing strings must
use these constants, never a hardcoded "pi" or "phi".**

## Rebranded (must say phi)

| Surface | Where |
|---|---|
| Binary, config dir | `phi`, `~/.phi/` (via `piConfig`) |
| Update check + `phi update` | npm registry `@phi-code-admin/phi-code` (`src/utils/version-check.ts`, `src/package-manager-cli.ts`) |
| Update notifications, changelog link | `uglyswap/phi-code` changelog (`interactive-mode.ts`) |
| HTTP User-Agent | `phi/<version>` — `APP_NAME`-driven (`src/utils/pi-user-agent.ts`) |
| OpenRouter attribution headers | `phi-code` (`src/core/sdk.ts`) |
| Telemetry | **removed**: phi-code sends no install/update ping. `enableInstallTelemetry` / `PHI_TELEMETRY` only toggle the provider attribution headers (OpenRouter, Cloudflare, NVIDIA NIM; `src/core/provider-attribution.ts`) |
| TUI messages, `--help`, docs examples | `phi` commands, `~/.phi/` paths |
| npm README / CHANGELOG | phi-code |

## Deliberately kept as-is (do NOT rename)

| Item | Why |
|---|---|
| `PI_*` env var names (`PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, …) | Still accepted as a fallback. The canonical names are the branded `PHI_*` ones (`src/core/env-vars.ts`: `readBrandedEnv` reads `PHI_<X>` then `PI_<X>`, `setBrandedEnv` sets both for child processes). New code reads through `readBrandedEnv`, never `process.env.PI_*` directly. |
| Internal identifiers (`getPiUserAgent`, `piConfig`, `pi-user-agent.ts`, type names, comments) | Pure code-level names; renaming guarantees merge conflicts for zero user value. |
| `pi.dev/session/` share viewer (`DEFAULT_SHARE_VIEWER_URL`) | `/share` uploads a gist; the upstream viewer renders any pi-format session. Overridable via `PI_SHARE_VIEWER_URL`. |
| pi-mono links in `src/migrations.ts` | Historical migration guides that only exist upstream. |
| `examples/` | Upstream examples, NOT verbatim: their imports were rewritten to the phi package names (`@phi-code-admin/phi-code`, `phi-code-ai`, `phi-code-agent`, `phi-code-tui`), so expect textual conflicts on import lines when upstream edits them. |
| Third-party `@mariozechner/*` deps (`jiti`, `clipboard`, `mini-lit` in web-ui) | Consumed as-is. The upstream `@mariozechner/pi-*` packages are not: they are forked under phi names (`phi-code-*`, `@phi-code-admin/*`); the extension loader only keeps `@mariozechner/pi-*` import aliases so older extensions still load. |

## Merging upstream

1. `git remote add upstream https://github.com/earendil-works/pi.git && git fetch upstream`
2. Merge/cherry-pick into a branch. Expect real conflicts: phi modifies many
   upstream source files (rebranding, renamed package imports, Windows fixes,
   extension loading), not only the rebranded surfaces listed above. Previous
   merges ran a pi -> phi import codemod over the merge base and the upstream
   side first; that codemod is not versioned in this repository.
3. After merging, run the guard-rails: `npm run check && npm test`. The test
   suite pins the phi behaviors (registry-based update check, `phi/` UA,
   phi-code attribution headers, routing example sync), so an upstream change
   that silently reverts a rebrand point fails CI instead of shipping.

## Fork-owned additions (no upstream counterpart)

`extensions/phi/**` (orchestrator, models refresh, setup, memory, skills…),
`agents/`, `skills/`, `config/`, the `sigma-*` packages, and the browser and
camoufox packages are phi-code territory: normal engineering rules apply,
no merge constraints.

## Reproducible releases: the generated model catalog

The model catalog of `packages/ai` is **committed**: the per-provider shards
`src/providers/*.models.ts`, the provider data `src/providers/data/*.json`
(+ `.manifest.json`) and the aggregators `src/models.generated.ts` and
`src/image-models.generated.ts`.

There are two builds:

- `npm run build:offline` compiles the committed catalog (after
  `check:model-data`) and never touches the network. CI (`ci.yml`), the npm
  publication and the release binaries (`build-binaries.yml`), `prepublishOnly`
  and `scripts/release.mjs` use it, so what ships is exactly what is in git.
- `npm run build` (and `npm run build` inside `packages/ai`) first regenerates
  the catalog LIVE from the provider APIs with `--strict`, then runs the offline
  build. It needs network access, fails when a provider endpoint is down, and
  leaves catalog changes in the working tree.

Refreshing the catalog is a separate, explicit action:

- `npm run generate --workspace=packages/ai` regenerates it from the provider catalogs.
- The maintainer reviews the diff, commits it, and bumps `packages/ai`.
- `.github/workflows/refresh-models.yml` does this weekly and opens a PR, so the
  catalog never rots without a human in the loop. `scripts/release.mjs` also
  regenerates it before tagging a release.

CI checks that the build left the aggregators unchanged (`git diff
--exit-code` on `models.generated.ts` and `image-models.generated.ts`).
