# Phi Code Extensions

11 TypeScript extensions automatically loaded at startup.

## Extensions

| Extension | File | Tools | Commands | Events |
|-----------|------|-------|----------|--------|
| **Memory** | `memory.ts` | `memory_search`, `memory_write`, `memory_read`, `memory_status` | — | `session_start` (auto-load AGENTS.md) |
| **Benchmark** | `benchmark.ts` | — | `/benchmark` | `session_start` (results count) |
| **Smart Router** | `smart-router.ts` | — | `/routing` | `input` (model suggestion), `session_start` |
| **Orchestrator** | `orchestrator.ts` | `orchestrate` | `/plan`, `/plans` | — |
| **Skill Loader** | `skill-loader.ts` | — | `/skills` | `input` (skill matching), `session_start` |
| **Web Search** | `web-search.ts` | `web_search` | `/search` | `session_start` (key detection) |
| **Agents** | `agents.ts` | — | `/agents` | `session_start` (agent count) |
| **Init** | `init.ts` | — | `/phi-init` | — |
| **Setup** | `setup.ts` | — | `/setup` | — |
| **Keys** | `keys.ts` | — | `/keys` | `session_start` (hot-reload watcher) |
| **Models** | `models.ts` | — | `/models` | `session_start` (background catalog refresh) |
| **Browser** | `browser.ts` | `browser_navigate`, `browser_extract`, `browser_screenshot`, `browser_search`, `browser_click`, `browser_type`, `browser_scroll`, `browser_snapshot`, `browser_close_tab`, `browser_list_tabs` | — | `session_shutdown` (kill Firefox) |

## Bundled browser engine (Camoufox)

The `browser.ts` extension exposes ten high-level tools backed by a
vendored snapshot of [Camoufox](https://github.com/daijro/camoufox) v135.0.1-beta.24
(anti-detect Firefox fork, MPL-2.0). It bypasses Cloudflare and most
bot-detection that plain `fetch` + cheerio can't.

  - Phi-code ships **its own copy** of the JS launcher and the OpenClaw
    automation server (`@phi-code-admin/camoufox-js`,
    `@phi-code-admin/camofox-browser`, `@phi-code-admin/browser`) so no
    third-party-maintained npm package sits on the critical path.
  - The Firefox binary itself is re-hosted on
    [uglyswap/phi-code releases](https://github.com/uglyswap/phi-code/releases/tag/binaries-v1.0.0)
    and downloaded once by the camoufox-js postinstall, cached under
    `~/.cache/phi-code/camoufox/v1.0.0/<platform>-<arch>/` (XDG / Library /
    LOCALAPPDATA respected). No runtime call to daijro/camoufox.
  - `PHI_BROWSER_DISABLED=1` turns the extension off without uninstalling.
  - `CAMOUFOX_BIN_DIR=/absolute/path` overrides the cache (air-gapped CI).
  - `CAMOUFOX_SKIP_DOWNLOAD=1` skips the postinstall download; useful when
    you want to ship pre-baked Docker images.

The web-search cascade (`web_search`, `/search`) is unchanged — Camoufox
is an additional capability, not a replacement.

## Live Model Catalogs

Every cloud provider (OpenAI, Anthropic, Google, OpenRouter, Groq, Alibaba
Coding Plan, OpenCode Go) and every local server (Ollama, LM Studio) is
queried against its `/v1/models` endpoint at runtime. Results are cached
in-memory for 1h and persisted to `~/.phi/agent/models.json`. When a
provider publishes a new model:

  - `/models refresh` re-fetches the catalog for every configured provider.
  - `/models refresh <id>` refreshes a single provider.
  - `/models` (or `/models list`) prints what is currently persisted.
  - On every `session_start`, the `models.ts` extension does a background
    refresh so a fresh phi-code launch already reflects upstream changes.

A static fallback (`providers/live-models.ts`) ships with each release so
the wizards still work offline.

## Benchmark Categories

The `/benchmark` command tests models across 6 weighted categories:

| Category | Weight | Test |
|----------|--------|------|
| Code Generation | ×2 | Write a TypeScript function from spec |
| Debugging | ×2 | Find and fix a mutation bug |
| Planning | ×2 | Create JWT auth implementation plan |
| Tool Calling | ×1 | Parse natural language to structured JSON |
| Speed | ×1 | Response latency (simple instruction following) |
| Orchestration | ×2 | Multi-step memory leak analysis |

Scoring: S (80+), A (65+), B (50+), C (35+), D (<35)

## Memory Auto-Recall

The memory extension adds prompt guidelines that instruct the model to:
1. Search memory before answering questions about prior work or decisions
2. Search memory when starting work on a topic
3. Write to memory after completing important work

This is not forced via code — it's a prompt guideline that well-trained models follow naturally.

## Setup Wizard Modes

`/phi-init` offers 3 configuration modes:

- **auto**: Assigns models based on public rankings and specializations (instant)
- **benchmark**: Tests available models with `/benchmark all`, then assigns best-per-category
- **manual**: Interactive prompts to choose each model assignment
