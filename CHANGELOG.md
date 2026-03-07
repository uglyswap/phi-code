# Changelog

## [Unreleased] - Phi Code Fork

### Added
- **Rebranding**: Pi → Phi Code (CLI `phi`, config `~/.phi/`)
- **Alibaba Coding Plan**: 8 free models integrated by default
- **6 Extensions**: memory, smart-router, orchestrator, skill-loader, web-search, benchmark
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