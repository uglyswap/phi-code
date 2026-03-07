# Phi Code Extensions

8 TypeScript extensions automatically loaded at startup.

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
