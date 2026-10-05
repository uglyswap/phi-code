# Changelog

## [Unreleased] - Phi Code Fork

### Added
- **Rebranding**: Pi → Phi Code (CLI `phi`, config `~/.phi/`)
- **Alibaba Coding Plan**: 8 free models integrated by default
- **17 extension modules** under `packages/coding-agent/extensions/phi/`: memory, smart-router, orchestrator, skill-loader, web-search, benchmark, init, agents, commit, keys, models, setup, productivity, browser, mcp, goal, todo, btw, chrome
- **5 Sub-agents**: explore, plan, code, test, review
- **12 Bundled Skills**: github, devops, security, testing, database, etc.
- **sigma-memory package**: QMD vector search + Ontology JSONL + Markdown notes
- **sigma-agents package**: Smart routing + model profiling + sub-agent management
- **sigma-skills package**: Dynamic skill loading and matching
- **phi init wizard**: Interactive setup with 3 modes (auto/benchmark/manual)
- **CI workflow**: GitHub Actions for build/test
- **CONTRIBUTING.md**: Development guidelines

### Changed
- Default config directory: `~/.pi/` → `~/.phi/`
- CLI binary: `pi` → `phi`
- Package names: `@mariozechner/pi-*` → `phi-code-*`
> The authoritative release history lives in `packages/coding-agent/CHANGELOG.md`. This root file summarizes fork-level additions.

### Fixed
- Context windows: the footer, `/context` and `--list-models` showed an inferred guess instead of the upstream window whenever the model was also persisted in `models.json` (an entry replaces the provider catalog definition by id). `models.json` now carries only the upstream delta and is reconciled on every `session_start`.
- Build break on main: explicit `TApi` generic in the Cloudflare AI Gateway provider (TS2353)
- `scripts/local-release.mjs` rebrand (phi-code-monorepo, `phi` launchers, `phi-*` archives, `npm run test` instead of missing `test.sh`)
- Missing `pi-test.ps1` invoked by `pi-test.bat` on Windows
- Release assets renamed `pi-*` → `phi-*` (source archive, binaries, install-lock artifacts)
- `ontology_batch_add`: batch graph writes (single locked append) replacing the single-item TODO in the orchestrator
- `mom` agent model configurable via `MOM_MODEL` env var
- Published package could not start: `extensions/phi/agents.ts` and `orchestrator.ts` imported `../../src/core/parallel-agents.ts`, a specifier that exists only in the checkout (`package.json#files` ships no `src/`), so `phi` exited with code 1 on three extension load errors. Both now import through the loader alias `phi-code`.
- `ast_grep` never loaded: `@ast-grep/napi` is a declared dependency, but it was missing from the postinstall's `extensionDeps` and the alias map has no entry for it. Added to the list (the existing link logic already handles Windows).
- `ontology_batch_add` failed with `TypeError: addBatch is not a function` against the **published** `sigma-memory@0.2.9` — the repository's in-tree package has the method, the published one does not. The tool now composes over `findEntity`/`addEntity`/`addRelation` idempotently, and four further `memory.ts` defects go with it (vector-hit formatting, `ontology_query` path rendering, the `init()` race, and a success message that ignored indexing failures).

### Changed
- `README.md` synchronized with reality (19 packages, 17 extension modules, 7 memory tools)
