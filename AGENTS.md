# Phi Code — AGENTS.md

> This file is automatically loaded at session start. It provides context about the project.

## What is Phi Code?

Phi Code (Φ Code) is an open-source coding agent forked from [Pi](https://github.com/badlogic/pi-mono). It enhances Pi with:

- **Persistent Memory** — QMD vector search + Ontology graph + Markdown notes
- **Typed Sub-Agents** — explore, plan, code, test, review — each routed to the optimal model
- **Intelligent Routing** — Automatically selects the best model for each task
- **Orchestrator** — Converts high-level descriptions into specs → todo → parallel execution
- **Dynamic Skills** — Loads coding skills on demand based on context
- **Built-in Benchmark** — Tests your models and assigns them to agent roles

## Architecture

Phi Code is designed as a set of **extensions** and **new packages** on top of Pi's core.
Only 2 lines of Pi's original code are modified — everything else is additive.

## Key Directories

- `agents/` — Sub-agent definitions (explore, plan, code, test, review)
- `skills/` — Bundled coding skills (12 skills)
- `config/` — Default routing and model configuration
- `packages/coding-agent/extensions/phi/` — Core Phi Code extensions

## Models (Alibaba Coding Plan — Free)

| Model | Best For | Agent Role |
|---|---|---|
| qwen3.5-plus | General, versatile | Default, Review |
| qwen3-max | Complex reasoning | Plan, Debug |
| qwen3-coder-plus | Code generation | Code |
| qwen3-coder-next | Code optimization | Code (alt) |
| kimi-k2.5 | Fast tasks | Explore, Test |
| glm-5 | General | Fallback |
| glm-4.7 | Lightweight | Fast fallback |
| MiniMax-M2.5 | Efficient | Fallback |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
