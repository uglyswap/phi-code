# Fork policy — staying mergeable with upstream Pi

phi-code is a fork of [pi-mono](https://github.com/earendil-works/pi-mono)
(`packages/coding-agent` = upstream's coding agent). This document defines
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
| Telemetry | **removed** — phi-code sends no install pings |
| TUI messages, `--help`, docs examples | `phi` commands, `~/.phi/` paths |
| npm README / CHANGELOG | phi-code |

## Deliberately kept as-is (do NOT rename)

| Item | Why |
|---|---|
| `PI_*` env vars (`PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, …) | Backwards compat + documented everywhere; renaming breaks users and every upstream merge. `PHI_*` additions are fine as aliases. |
| Internal identifiers (`getPiUserAgent`, `piConfig`, `pi-user-agent.ts`, type names, comments) | Pure code-level names; renaming guarantees merge conflicts for zero user value. |
| `pi.dev/session/` share viewer (`DEFAULT_SHARE_VIEWER_URL`) | `/share` uploads a gist; the upstream viewer renders any pi-format session. Overridable via `PI_SHARE_VIEWER_URL`. |
| pi-mono links in `src/migrations.ts` | Historical migration guides that only exist upstream. |
| `examples/` referencing pi | Upstream examples; kept verbatim to merge cleanly. |
| `@mariozechner/*` deps (web-ui, jiti) | Upstream packages consumed as-is. |

## Merging upstream

1. `git remote add upstream https://github.com/earendil-works/pi-mono.git && git fetch upstream`
2. Merge/cherry-pick into a branch. Conflicts should concentrate in the few
   rebranded files listed above — everything else is untouched by design.
3. After merging, run the guard-rails: `npm run check && npm test`. The test
   suite pins the phi behaviors (registry-based update check, `phi/` UA,
   phi-code attribution headers, routing example sync), so an upstream change
   that silently reverts a rebrand point fails CI instead of shipping.

## Fork-owned additions (no upstream counterpart)

`extensions/phi/**` (orchestrator, models refresh, setup, memory, skills…),
`agents/`, `skills/`, `config/`, the `sigma-*` packages, and the browser and
camoufox packages are phi-code territory: normal engineering rules apply,
no merge constraints.
