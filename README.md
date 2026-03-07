# Φ Phi Code

**The open-source coding agent with persistent memory, sub-agents, and intelligent routing.**

A fork of [Pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/badlogic) — enhanced with memory, orchestration, and 8 free AI models.

```
npm install -g @phi-code-admin/phi-code
phi
```

---

## Table of Contents

- [Why Phi Code](#why-phi-code)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [Extensions](#extensions)
- [Skills](#skills)
- [Sub-Agents](#sub-agents)
- [Intelligent Routing](#intelligent-routing)
- [Memory System](#memory-system)
- [Models & Providers](#models--providers)
- [Local Models (Ollama, LM Studio)](#local-models-ollama-lm-studio)
- [Commands](#commands)
- [Configuration](#configuration)
- [Build from Source](#build-from-source)
- [Credits](#credits)
- [License](#license)

---

## Why Phi Code

Phi Code takes Pi's brilliant minimal architecture and adds what's missing for serious projects:

| | Pi | Phi Code |
|---|---|---|
| **Memory** | None (session-only) | Persistent across sessions (notes + ontology + vector search) |
| **Sub-agents** | Single agent | 5 specialized agents with parallel execution |
| **Model routing** | Manual selection | Automatic task→model matching |
| **Orchestration** | Manual | `/plan` command generates spec.md + todo.md |
| **Skills** | Community | 12 bundled coding skills loaded on demand |
| **Free models** | BYO key | 8 Alibaba Coding Plan models at $0 |
| **Web search** | None | Brave API + DuckDuckGo fallback |

Pi's core is untouched — only 2 lines modified out of 500+ files. Everything is additive: extensions, skills, and new packages. Upstream Pi updates merge in minutes.

---

## Quick Start

### Install

```bash
# Install globally
npm install -g @phi-code-admin/phi-code

# Or run directly without installing
npx @phi-code-admin/phi-code
```

### First Run

```bash
# Start Phi Code in the current directory
phi

# Initialize with the setup wizard (optional)
phi
# Then type: /phi-init
```

The setup wizard detects your API keys, configures routing, and creates sub-agent definitions.

### Requirements

- **Node.js** 18+ (tested on 22.x)
- **Operating systems**: Linux, macOS, Windows (via Git Bash, WSL, or native)
- **API key** (optional): Alibaba Coding Plan key for free models, or any OpenAI-compatible key

---

## Architecture

Phi Code is a monorepo with 7 packages:

```
phi-code/
├── packages/
│   ├── ai/                  # phi-code-ai — Provider abstraction (20+ providers)
│   ├── agent-core/          # phi-code-agent — Core agent loop, tools, context
│   ├── tui/                 # phi-code-tui — Terminal UI (Ink-based)
│   ├── coding-agent/        # @phi-code-admin/phi-code — Main CLI entry point
│   │   ├── extensions/phi/  # 8 TypeScript extensions (auto-loaded)
│   │   └── skills/          # 12 bundled coding skills (loaded on demand)
│   ├── sigma-memory/        # sigma-memory — Memory subsystem (notes + ontology + QMD)
│   ├── sigma-agents/        # sigma-agents — Sub-agent routing and profiles
│   └── sigma-skills/        # sigma-skills — Skill scanner and loader
├── agents/                  # 5 sub-agent definitions (.md with YAML frontmatter)
├── skills/                  # Source skills (copied to coding-agent/skills/)
└── config/                  # Default routing configuration
```

### How it loads at startup

1. **Extensions**: The loader scans 3 locations in order:
   - `.phi/extensions/` in the current project directory
   - `~/.phi/agent/extensions/` (global user extensions)
   - Bundled extensions shipped with the package (8 extensions)
   
2. **Skills**: Listed in the system prompt as name + description only. The model reads the full skill content via the `read` tool only when relevant. Zero context overhead for unused skills.

3. **Memory**: The `memory.ts` extension auto-loads `AGENTS.md` from `~/.phi/memory/` at session start if it exists.

4. **Routing**: The `smart-router.ts` extension loads `~/.phi/agent/routing.json` and analyzes each user input to suggest the optimal model.

---

## Extensions

Phi Code includes 8 TypeScript extensions that are automatically loaded at startup. Each registers tools, commands, or event handlers.

### Memory Extension (`memory.ts`)

Persistent memory powered by the `sigma-memory` package. Three layers:

| Layer | Storage | Use case |
|-------|---------|----------|
| **Notes** | Markdown files in `~/.phi/memory/` | Daily notes, learnings, decisions |
| **Ontology** | JSONL graph in `~/.phi/memory/ontology/graph.jsonl` | Entities, relations, project architecture |
| **QMD** | SQLite + GGUF vectors (if QMD binary available) | Semantic search across all documents |

**Tools registered:**

| Tool | Description |
|------|-------------|
| `memory_search` | Unified search across notes, ontology, and QMD. Returns ranked results from all three layers. |
| `memory_write` | Write content to a memory file. Defaults to today's date if no filename given. |
| `memory_read` | Read a specific memory file, or list all available files. |
| `memory_status` | Show status of all memory subsystems (file counts, QMD availability, ontology stats). |

**Auto-Recall:** The memory extension adds prompt guidelines that instruct the model to:
- Search memory before answering questions about prior work, architecture, or decisions
- Search memory when starting work on a topic (to find existing notes and learnings)
- Write to memory after completing important work or learning something new

This is not forced via code — it's a prompt guideline that well-trained models follow naturally, keeping the system prompt lightweight.

**Session Start:** Looks for `AGENTS.md` in three locations (project root, `.phi/`, `~/.phi/memory/`) and loads it as persistent instructions.

### Smart Router Extension (`smart-router.ts`)

Analyzes user input keywords and suggests the best model for the task.

**Routing categories:**

| Category | Keywords | Preferred Model | Agent |
|----------|----------|----------------|-------|
| `code` | implement, create, build, refactor, write, add, modify | `qwen3-coder-plus` | code |
| `debug` | fix, bug, error, debug, crash, broken, failing | `qwen3-max-2026-01-23` | code |
| `explore` | read, analyze, explain, understand, find, search | `kimi-k2.5` | explore |
| `plan` | plan, design, architect, spec, structure, organize | `qwen3-max-2026-01-23` | plan |
| `test` | test, verify, validate, check, assert, coverage | `kimi-k2.5` | test |
| `review` | review, audit, quality, security, improve, optimize | `qwen3.5-plus` | review |

**Configuration:** Override defaults in `~/.phi/agent/routing.json`. Full schema in `config/routing.json`.

**Command:** `/routing` — show current routing configuration and model assignments.

### Orchestrator Extension (`orchestrator.ts`)

Breaks down complex project descriptions into structured plans.

**Tool:**

| Tool | Description |
|------|-------------|
| `orchestrate` | Takes a project description, generates `spec.md` (requirements) and `todo.md` (actionable tasks). Files saved in `.phi/plans/` |

**Commands:**
- `/plan` — Interactive: describe your project, get a structured plan with spec + todo
- `/plans` — List all existing plans in `.phi/plans/`

**Philosophy:** Plans are stored on disk, not in LLM context. This respects Pi's minimalist approach — the system prompt stays at ~200 tokens. The agent reads plan files via the `read` tool when needed.

### Skill Loader Extension (`skill-loader.ts`)

Dynamically discovers and loads skills from:
- `~/.phi/agent/skills/` (global user skills)
- `.phi/skills/` (project-local skills)
- Bundled skills (12 shipped with the package)

**How it works:**
1. At session start, scans all skill directories
2. Injects skill name + description into the system prompt (lightweight)
3. On each user input, matches keywords against skill descriptions
4. If a skill matches, notifies the model that relevant skills are available
5. The model uses the `read` tool to load the full skill content only when needed

**Command:** `/skills` — List all discovered skills with their sources and descriptions.

### Web Search Extension (`web-search.ts`)

Adds internet search capabilities with two providers:

| Provider | Activation | Features |
|----------|-----------|----------|
| **Brave Search** | Set `BRAVE_API_KEY` environment variable | Rich results with descriptions, URLs |
| **DuckDuckGo** | Automatic fallback (no key needed) | Basic search results via HTML scraping |

**Tool:**

| Tool | Description |
|------|-------------|
| `web_search` | Search the web. Uses Brave if API key available, falls back to DuckDuckGo. Returns titles, URLs, and descriptions. |

**Command:** `/search <query>` — Quick search from the command line.

### Benchmark Extension (`benchmark.ts`)

Production-grade model testing across 6 categories with real API calls.

**Categories (weighted):**

| Category | Weight | Test Description |
|----------|--------|------------------|
| Code Generation | ×2 | Write a TypeScript function from a detailed spec |
| Debugging | ×2 | Find and fix a mutation bug in array handling code |
| Planning | ×2 | Create a JWT auth implementation plan for Express.js |
| Tool Calling | ×1 | Parse natural language to structured JSON (schema validation) |
| Speed | ×1 | Response latency measurement (instruction following) |
| Orchestration | ×2 | Multi-step Node.js memory leak analysis |

**Scoring:** S (80+), A (65+), B (50+), C (35+), D (<35)

**Results saved:** `~/.phi/benchmark/results.json` — persistent, used by `/phi-init benchmark` mode.

**Commands:**
- `/benchmark` — Run on current model
- `/benchmark all` — Run on ALL available models (may take 10-15 min)
- `/benchmark <model-id>` — Run on a specific model
- `/benchmark results` — Show saved results with leaderboard
- `/benchmark compare` — Side-by-side model comparison
- `/benchmark clear` — Clear all results
- `/benchmark help` — Full usage guide

### Agents Extension (`agents.ts`)

Sub-agent management and visibility.

**Command:**
- `/agents` — List all configured sub-agents with their model assignments and sources
- `/agents <name>` — Show detailed info for a specific agent (prompt, tools, model)

**Discovery:** Scans three locations:
1. `.phi/agents/` (project-local)
2. `~/.phi/agent/agents/` (global)
3. Bundled agents (5 shipped with Phi Code)

### Init Extension (`init.ts`)

Interactive setup wizard with **3 fully functional modes**.

**Command:** `/phi-init`

**Modes:**

| Mode | Description | Time |
|------|-------------|------|
| **auto** | Uses optimal defaults based on public rankings and model specializations | Instant |
| **benchmark** | Tests models with `/benchmark all`, assigns best-per-category | 10-15 min |
| **manual** | Interactive prompts — choose model for each of 6 task roles + fallbacks | 2-3 min |

**Steps:**
1. Detects available API keys (Alibaba, OpenAI, Anthropic, Google, OpenRouter, Groq)
2. Lists available models per provider
3. Asks for configuration mode
4. **auto**: Assigns models based on specialization (coder→code, reasoning→debug/plan, fast→explore/test)
5. **benchmark**: Checks for existing `/benchmark` results, assigns best model per category
6. **manual**: Prompts user for each role (code, debug, plan, explore, test, review) with model list
7. Creates `~/.phi/` directory structure (agent, memory, ontology)
8. Copies bundled sub-agent definitions
9. Creates AGENTS.md template for persistent instructions
10. Writes routing configuration

---

## Skills

Skills are specialized knowledge files that the model loads on demand. Each skill is a directory containing a `SKILL.md` file with instructions for a specific domain.

### 12 Bundled Skills

| Skill | Description |
|-------|-------------|
| **api-design** | REST API conventions, endpoint naming, status codes, pagination, versioning |
| **coding-standards** | TypeScript/JavaScript best practices, naming conventions, async patterns |
| **database** | Schema design, SQL optimization, migrations, indexing strategies |
| **devops** | Docker, CI/CD, deployment, monitoring, infrastructure automation |
| **docker-ops** | Dockerfiles, docker-compose, multi-stage builds, health checks |
| **git-workflow** | Branch strategy, conventional commits, merge vs rebase, conflict resolution |
| **github** | Repository management, PRs, issues, Actions workflows, releases |
| **performance** | Profiling, caching, lazy loading, memory optimization, Amdahl's Law |
| **prompt-architect** | Structured LLM prompts, role/context/task patterns, few-shot examples |
| **security** | OWASP Top 10, input validation, auth patterns, secrets management |
| **self-improving** | Error documentation, learning protocols, continuous improvement |
| **testing** | Test pyramid, unit/integration/E2E, TDD, mocking, coverage strategies |

### How Skills Work (Zero Context Overhead)

Skills are **not** loaded into context at startup. Only their names and one-line descriptions appear in the system prompt:

```xml
<available_skills>
  <skill>
    <name>database</name>
    <description>SQL queries, schema design, migrations, query optimization.</description>
    <location>/path/to/skills/database/SKILL.md</location>
  </skill>
  ...
</available_skills>
```

The model uses the `read` tool to load the full SKILL.md content only when the task matches. This means 12 skills cost ~20 lines of prompt, not thousands.

### Adding Your Own Skills

Create a directory with a `SKILL.md` file:

```
~/.phi/agent/skills/my-skill/
└── SKILL.md
```

SKILL.md format:
```markdown
---
name: my-skill
description: What this skill helps with (one line).
---

# My Skill

## When to use
Describe when the model should load this skill.

## Instructions
Your specialized knowledge and patterns here.
```

Project-local skills go in `.phi/skills/` in your project directory.

---

## Sub-Agents

Phi Code defines 5 specialized sub-agents, each optimized for a specific task type with its own model assignment.

| Agent | Model | Tools | Role |
|-------|-------|-------|------|
| **explore** | `kimi-k2.5` | read, grep, find, ls, bash | Fast codebase analysis. Returns structured context for other agents. |
| **plan** | `qwen3-max-2026-01-23` | read, grep, find, ls | Creates detailed implementation plans. Read-only — never modifies files. |
| **code** | `qwen3-coder-plus` | read, write, edit, bash, grep, find, ls | Writes and modifies code. Full tool access for implementation. |
| **test** | `kimi-k2.5` | read, bash, grep, find, ls | Runs tests, validates changes. Read-only except for test execution. |
| **review** | `qwen3.5-plus` | read, grep, find, ls, bash | Senior code reviewer. Checks quality, security, maintainability. |

Each agent has a structured output format defined in its `.md` file (in the `agents/` directory). This ensures consistent, parseable results.

### Agent Definitions

Agent definitions are Markdown files with YAML frontmatter:

```markdown
---
name: code
description: Writes and modifies code. Full tool access.
tools: read, write, edit, bash, grep, find, ls
model: qwen3-coder-plus
---

You are a coding specialist. You receive a task and implement it.
[... detailed instructions ...]
```

Customize agents by editing files in `~/.phi/agent/agents/` or `.phi/agents/` in your project.

---

## Intelligent Routing

The smart router analyzes each message and suggests the best model based on task type.

### How It Works

1. **Input analysis**: Keywords in your message are matched against routing categories
2. **Model recommendation**: The router suggests the preferred model for that category
3. **Fallback**: If the preferred model is unavailable, the fallback model is used
4. **Notification**: A subtle notification shows which model is recommended (non-blocking)

### Default Routes

```json
{
  "code":    { "model": "qwen3-coder-plus",      "fallback": "qwen3.5-plus" },
  "debug":   { "model": "qwen3-max-2026-01-23",  "fallback": "qwen3.5-plus" },
  "explore": { "model": "kimi-k2.5",             "fallback": "glm-4.7" },
  "plan":    { "model": "qwen3-max-2026-01-23",  "fallback": "qwen3.5-plus" },
  "test":    { "model": "kimi-k2.5",             "fallback": "glm-4.7" },
  "review":  { "model": "qwen3.5-plus",          "fallback": "qwen3-max-2026-01-23" }
}
```

### Custom Routing

Edit `~/.phi/agent/routing.json`:

```json
{
  "routes": {
    "code": {
      "keywords": ["implement", "create", "build", "refactor"],
      "preferredModel": "your-preferred-model",
      "fallback": "your-fallback-model",
      "agent": "code"
    }
  },
  "default": {
    "model": "qwen3.5-plus"
  }
}
```

---

## Memory System

The `sigma-memory` package provides three integrated memory layers.

### Notes (Markdown Files)

Simple, human-readable, version-controllable.

```
~/.phi/memory/
├── AGENTS.md          # Persistent instructions (auto-loaded at session start)
├── 2026-03-07.md      # Daily notes
├── learnings.md       # Error documentation
└── project-notes.md   # Custom files
```

**Operations:** write, read, list, search (grep-based), get recent, append.

### Ontology (Knowledge Graph)

JSONL append-only graph for structured relationships.

```
~/.phi/memory/ontology/graph.jsonl
```

Each line is a JSON object — either an entity or a relation:

```json
{"type":"entity","id":"my-api","kind":"Project","name":"My API","properties":{"language":"TypeScript"}}
{"type":"relation","source":"my-api","target":"postgres-db","kind":"uses","properties":{}}
```

**Operations:** add entity, add relation, query by kind, BFS pathfinding between entities, stats, export.

### QMD (Vector Search)

Optional integration with [QMD](https://github.com/tobilu/qmd) for semantic search across all documents.

- Requires the `qmd` binary to be installed separately
- Uses SQLite + GGUF local embeddings (no API needed)
- Searches notes, ontology, and any indexed documents
- Falls back gracefully if QMD is not available

### Unified Search

`memory_search` queries all three layers simultaneously and returns results sorted by relevance score:

```
memory_search("authentication flow")
→ Notes results (grep match in notes/auth.md)
→ Ontology results (entities matching "auth")
→ QMD results (semantic similarity across all documents)
```

---

## Models & Providers

### Built-in: Alibaba Coding Plan (Free)

Phi Code ships with 8 pre-configured models from [Alibaba Cloud Coding Plan](https://help.aliyun.com/zh/model-studio/developer-reference/tongyi-qianwen-coding-plan) — all at **$0 cost**:

| Model | Reasoning | Best for |
|-------|-----------|----------|
| **Qwen 3.5 Plus** | ✅ | General tasks, code review, complex reasoning |
| **Qwen 3 Max** | ✅ | Planning, architecture, debugging |
| **Qwen 3 Coder Plus** | — | Code generation, refactoring |
| **Qwen 3 Coder Next** | — | Code generation (newer version) |
| **Kimi K2.5** | ✅ | Exploration, testing, long-context analysis |
| **GLM 5** | — | General tasks |
| **GLM 4.7** | — | Fast general tasks |
| **MiniMax M2.5** | — | Efficient task execution |

All models have 131K context window and 16K max output tokens.

**Setup:** Get a free Coding Plan API key from [Alibaba Cloud](https://help.aliyun.com/zh/model-studio/) and set:
```bash
export ALIBABA_CODING_PLAN_KEY="sk-..."
```

### Pi's Built-in Providers (20+)

Phi Code inherits all of Pi's providers:

| Provider | Auth | Models |
|----------|------|--------|
| Anthropic | API key | Claude 3.5, 4, Opus |
| OpenAI | API key or OAuth (Codex) | GPT-4o, o1, o3 |
| Google | API key or OAuth (Gemini CLI) | Gemini 2.5 Pro, Flash |
| Groq | API key | Llama, Mixtral |
| xAI | API key | Grok |
| OpenRouter | API key | 300+ models |
| Mistral | API key | Mistral Large, Codestral |
| GitHub Copilot | OAuth | GPT-4o, Claude |
| AWS Bedrock | AWS credentials | Claude, Llama |
| Google Vertex | GCP credentials | Gemini |
| Kimi | API key | Moonshot models |
| MiniMax | API key | MiniMax models |
| ... and more | | |

---

## Local Models (Ollama, LM Studio)

Phi Code supports any OpenAI-compatible API, which includes local model servers.

### Ollama

1. Install [Ollama](https://ollama.ai) and pull a model:
   ```bash
   ollama pull qwen2.5-coder:32b
   ```

2. Add to `~/.phi/agent/models.json`:
   ```json
   {
     "providers": {
       "ollama": {
         "baseUrl": "http://localhost:11434/v1",
         "api": "openai-completions",
         "apiKey": "ollama",
         "models": [
           {
             "id": "qwen2.5-coder:32b",
             "name": "Qwen 2.5 Coder 32B (local)",
             "reasoning": false,
             "input": ["text"],
             "contextWindow": 32768,
             "maxTokens": 4096,
             "cost": { "input": 0, "output": 0 }
           }
         ]
       }
     }
   }
   ```

3. Start Phi Code and select the model.

### LM Studio

1. Start LM Studio server (default port 1234)

2. Add to `~/.phi/agent/models.json`:
   ```json
   {
     "providers": {
       "lm-studio": {
         "baseUrl": "http://localhost:1234/v1",
         "api": "openai-completions",
         "apiKey": "lm-studio",
         "models": [
           {
             "id": "your-model-name",
             "name": "Your Local Model",
             "contextWindow": 32768,
             "maxTokens": 4096,
             "cost": { "input": 0, "output": 0 }
           }
         ]
       }
     }
   }
   ```

### Any OpenAI-Compatible Server

The same approach works for vLLM, text-generation-inference, LocalAI, or any server exposing an OpenAI-compatible `/v1/chat/completions` endpoint.

---

## Commands

Commands are typed in the Phi Code terminal with a `/` prefix.

| Command | Extension | Description |
|---------|-----------|-------------|
| `/phi-init` | init | Interactive setup wizard — 3 modes: auto, benchmark, manual |
| `/benchmark` | benchmark | Test models across 6 categories (code-gen, debug, planning, tool-calling, speed, orchestration) |
| `/benchmark all` | benchmark | Run benchmark on ALL available models |
| `/benchmark results` | benchmark | Show saved results with leaderboard and category breakdown |
| `/agents` | agents | List all configured sub-agents with model assignments |
| `/agents <name>` | agents | Show detailed info for a specific agent |
| `/plan` | orchestrator | Describe a project → generates `spec.md` + `todo.md` in `.phi/plans/` |
| `/plans` | orchestrator | List all existing plans |
| `/skills` | skill-loader | List all discovered skills with sources and descriptions |
| `/routing` | smart-router | Show current routing configuration and model assignments |
| `/search <query>` | web-search | Quick web search from the terminal |

Plus all of Pi's built-in commands: `/help`, `/model`, `/models`, `/tree`, `/fork`, `/compact`, `/changelog`, etc.

---

## Configuration

### Directory Structure

```
~/.phi/
├── agent/
│   ├── settings.json       # Pi settings (provider, model, theme, etc.)
│   ├── models.json          # Custom models and providers
│   ├── routing.json         # Task→model routing rules
│   ├── extensions/          # Global extensions (auto-discovered)
│   ├── skills/              # Global skills (auto-discovered)
│   └── agents/              # Sub-agent definitions
└── memory/
    ├── AGENTS.md            # Persistent instructions (auto-injected)
    ├── ontology/
    │   └── graph.jsonl      # Knowledge graph
    └── *.md                 # Notes files
```

### settings.json

Standard Pi settings. Key fields:

```json
{
  "defaultProvider": "alibaba-codingplan",
  "defaultModel": "qwen3.5-plus",
  "extensions": ["/path/to/custom/extension.ts"],
  "skills": ["/path/to/custom/skills/"],
  "hideThinkingBlock": true,
  "compaction": {
    "enabled": true,
    "threshold": 80
  }
}
```

### models.json

Add custom providers (merged with built-in models):

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "MY_API_KEY_ENV_VAR",
      "models": [
        {
          "id": "model-name",
          "name": "Display Name",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 200000,
          "maxTokens": 8192,
          "cost": { "input": 0.003, "output": 0.015 }
        }
      ]
    }
  }
}
```

The `apiKey` field accepts either a literal key or an environment variable name (looked up at runtime).

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ALIBABA_CODING_PLAN_KEY` | Alibaba Coding Plan API key (free models) |
| `BRAVE_API_KEY` | Brave Search API key (for web search) |
| `OPENAI_API_KEY` | OpenAI models |
| `ANTHROPIC_API_KEY` | Anthropic/Claude models |
| `GOOGLE_API_KEY` | Google/Gemini models |
| `OPENROUTER_API_KEY` | OpenRouter (300+ models) |
| `GROQ_API_KEY` | Groq (fast inference) |

---

## Build from Source

```bash
git clone https://github.com/uglyswap/phi-code.git
cd phi-code
npm install

# Build all packages (order matters)
cd packages/tui && npx tsc -p tsconfig.build.json && cd ../..
cd packages/ai && npx tsc -p tsconfig.build.json && cd ../..
cd packages/agent-core && npx tsc -p tsconfig.build.json && cd ../..
cd packages/coding-agent && npx tsc -p tsconfig.build.json && cd ../..

# Run locally
node packages/coding-agent/dist/cli.js
```

### Monorepo Structure

| Package | npm Name | Description |
|---------|----------|-------------|
| `packages/tui` | `phi-code-tui` | Terminal UI (Ink-based rendering) |
| `packages/ai` | `phi-code-ai` | Provider abstraction layer (20+ providers) |
| `packages/agent-core` | `phi-code-agent` | Core agent: tools, context, extension API |
| `packages/coding-agent` | `@phi-code-admin/phi-code` | CLI entry point, extensions, skills |
| `packages/sigma-memory` | `sigma-memory` | Memory subsystem (notes + ontology + QMD) |
| `packages/sigma-agents` | `sigma-agents` | Sub-agent routing and model profiles |
| `packages/sigma-skills` | `sigma-skills` | Skill scanner and loader |

---

## Credits & Acknowledgments

Phi Code is a fork of **[Pi](https://github.com/badlogic/pi-mono)**, created by **[Mario Zechner](https://github.com/badlogic)** ([@badlogicgames](https://x.com/badlogicgames)).

Pi is exceptional. Its minimalist philosophy — a 200-token system prompt, 4 base tools, zero bloat — is a masterclass in agent design. Pi's extension system, multi-provider architecture, and clean TypeScript codebase make it one of the best coding agents ever built.

**What Phi Code adds on top of Pi:**
- Persistent memory across sessions (notes + ontology + vector search)
- 5 typed sub-agents with intelligent model routing
- Orchestration for complex multi-step projects
- 12 bundled coding skills loaded on demand
- 8 free Alibaba Coding Plan models pre-configured
- Web search integration

**What we didn't touch:**
- Pi's core agent loop
- Pi's tool system (read, write, edit, bash)
- Pi's provider architecture (20+ providers)
- Pi's TUI and rendering
- Pi's extension API

Only 2 lines modified in Pi's source — the config directory name (`.pi` → `.phi`) and the CLI binary name. Everything else is extensions and new packages.

### Thank You

- **[Mario Zechner](https://github.com/badlogic)** — For creating Pi and releasing it under MIT. If you like Phi Code, go star [Pi](https://github.com/badlogic/pi-mono). ⭐
- **[Alibaba Cloud](https://www.alibabacloud.com/)** — For the Coding Plan providing free access to powerful models
- **The Pi community** — For the extension ecosystem and provider integrations

---

## License

MIT License — same as Pi. See [LICENSE](LICENSE).

Original Pi copyright: © 2025 Mario Zechner

---

```bash
npm install -g @phi-code-admin/phi-code
phi
```

**[GitHub](https://github.com/uglyswap/phi-code)** · **[Pi (upstream)](https://github.com/badlogic/pi-mono)** · **[Issues](https://github.com/uglyswap/phi-code/issues)** · **[npm](https://www.npmjs.com/package/@phi-code-admin/phi-code)**
