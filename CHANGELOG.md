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
- Build break on main: explicit `TApi` generic in the Cloudflare AI Gateway provider (TS2353)
- `scripts/local-release.mjs` rebrand (phi-code-monorepo, `phi` launchers, `phi-*` archives, `npm run test` instead of missing `test.sh`)
- Missing `pi-test.ps1` invoked by `pi-test.bat` on Windows
- Release assets renamed `pi-*` → `phi-*` (source archive, binaries, install-lock artifacts)
- `ontology_batch_add`: batch graph writes (single locked append) replacing the single-item TODO in the orchestrator
- `mom` agent model configurable via `MOM_MODEL` env var

### Changed
- `README.md` synchronized with reality (19 packages, 17 extension modules, 7 memory tools)
