<p align="center">
  <h1 align="center">Φ Phi Code</h1>
  <p align="center"><strong>The Ultimate Open-Source Coding Agent</strong></p>
  <p align="center">Built on <a href="https://github.com/badlogic/pi-mono">Pi</a> — supercharged with memory, sub-agents, orchestration, and smart routing.</p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@phi-code-admin/phi-code"><img alt="npm" src="https://img.shields.io/npm/v/@phi-code-admin/phi-code?style=flat-square&label=npm" /></a>
  <a href="https://github.com/uglyswap/phi-code"><img alt="GitHub" src="https://img.shields.io/badge/github-phi--code-181717?style=flat-square&logo=github" /></a>
  <a href="https://github.com/uglyswap/phi-code/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" /></a>
</p>

---

## What is Phi Code?

Phi Code is a **production-grade** coding agent for the terminal. It extends [Pi](https://github.com/badlogic/pi-mono) (the minimal terminal coding harness) with everything you need for serious development work:

- 🧠 **Persistent Memory** — Notes, ontology, and vector search across sessions
- 🤖 **5 Sub-Agents** — Specialized agents for code, exploration, planning, review, and testing
- 🎯 **Smart Routing** — Automatically assigns the right model to the right task
- 📋 **Orchestrator** — Plan complex projects, execute with parallel sub-agents
- 🔍 **Web Search** — Brave API integration for real-time research
- ⚡ **Benchmark** — Test your models and find the best ones for each role
- 🧩 **12 Built-in Skills** — API design, security, testing, DevOps, and more
- 🔌 **Provider-Neutral** — Works with any OpenAI-compatible API

**Phi Code works with any LLM provider:** Alibaba Cloud, OpenAI, Anthropic, Google, OpenRouter, Groq, Ollama, LM Studio, and more.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Setup Wizard](#setup-wizard)
- [API Key Management](#api-key-management)
- [Providers & Models](#providers--models)
- [Commands](#commands)
- [Sub-Agents](#sub-agents)
- [Orchestrator](#orchestrator)
- [Memory System](#memory-system)
- [Smart Routing](#smart-routing)
- [Benchmark](#benchmark)
- [Skills](#skills)
- [Extensions](#extensions)
- [Configuration Files](#configuration-files)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Sessions](#sessions)
- [CLI Reference](#cli-reference)
- [Philosophy](#philosophy)
- [Credits](#credits)

---

## Quick Start

### Install

```bash
npm install -g @phi-code-admin/phi-code
```

The installer automatically sets up:
- 9 extensions → `~/.phi/agent/extensions/`
- 5 sub-agent definitions → `~/.phi/agent/agents/`
- 12 skills → `~/.phi/agent/skills/`

### First Run

```bash
phi
```

Then run the setup wizard:

```
/phi-init
```

The wizard will:
1. Ask you to **choose a provider** (numbered list)
2. Ask you to **paste your API key**
3. **Save everything** to `~/.phi/agent/models.json` (persistent)
4. Let you **choose models** for each role

That's it. No environment variables, no JSON editing, no command line flags.

### Example

```bash
$ phi
> /phi-init
⚠️ No API keys detected. Let's set one up!

Available providers:
  1. Alibaba Coding Plan
  2. OpenAI
  3. Anthropic
  4. Google
  ...

Choose provider (number): 1
Enter your Alibaba Coding Plan API key: sk-sp-xxxxx

✅ API key saved to ~/.phi/agent/models.json
⚠️ Restart phi for models to load.
```

Restart `phi`, run `/phi-init` again → models are detected → pick a setup mode → done.

---

## Setup Wizard

The `/phi-init` wizard has **3 modes**:

| Mode | What it does | Time |
|------|-------------|------|
| **auto** | Assigns optimal defaults based on available models | Instant |
| **benchmark** | Tests each model with real coding tasks, assigns by score | 10-15 min |
| **manual** | You choose the model for each role interactively | 2-5 min |

The wizard creates:
- `~/.phi/agent/routing.json` — Model assignments per task type
- `~/.phi/agent/agents/` — Sub-agent definitions
- `~/.phi/memory/AGENTS.md` — Your project instructions template

---

## API Key Management

### Option 1: Interactive Setup (recommended)

Run `/phi-init` — it asks for your provider and key, saves automatically.

### Option 2: In-Session Command

```
/api-key set alibaba sk-sp-your-key-here
/api-key set openai sk-your-key-here
/api-key set anthropic sk-ant-your-key-here
```

This **saves to `~/.phi/agent/models.json`** (persistent across sessions).
Restart `phi` for new models to load.

### Option 3: View Configured Keys

```
/api-key list       # Show configured keys (masked)
/api-key providers  # List all supported providers
```

### Option 4: Environment Variables

For CI/CD or scripting, you can still use environment variables:

```bash
# Linux/Mac
export ALIBABA_CODING_PLAN_KEY="sk-sp-xxx"
export OPENAI_API_KEY="sk-xxx"
export ANTHROPIC_API_KEY="sk-ant-xxx"

# Windows (persistent)
setx ALIBABA_CODING_PLAN_KEY "sk-sp-xxx"
setx OPENAI_API_KEY "sk-xxx"
```

### Option 5: models.json (Direct Edit)

Edit `~/.phi/agent/models.json` directly for advanced configurations:

```json
{
  "providers": {
    "my-provider": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "your-key-here",
      "models": [
        {
          "id": "model-name",
          "name": "Display Name",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 131072,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

The `apiKey` field supports:
- **Direct value**: `"sk-xxx"` — uses as-is
- **Environment variable name**: `"OPENAI_API_KEY"` — resolved at runtime
- **Shell command**: `"!cat ~/.secrets/key"` — executed and output used

---

## Providers & Models

### Supported Providers

| Provider | API Key Env Var | Notes |
|----------|----------------|-------|
| Alibaba Cloud | `ALIBABA_CODING_PLAN_KEY` | DashScope (Qwen, Kimi, GLM, MiniMax) |
| OpenAI | `OPENAI_API_KEY` | GPT-4o, o1, o3, etc. |
| Anthropic | `ANTHROPIC_API_KEY` | Claude Sonnet, Opus, Haiku |
| Google | `GOOGLE_API_KEY` | Gemini Pro, Flash, Ultra |
| OpenRouter | `OPENROUTER_API_KEY` | 200+ models from all providers |
| Groq | `GROQ_API_KEY` | Ultra-fast inference |
| Ollama | — | Local, `ollama serve` on port 11434 |
| LM Studio | — | Local, start server on port 1234 |

Plus all Pi built-in providers: Azure OpenAI, Google Vertex, Amazon Bedrock, Mistral, Cerebras, xAI, Hugging Face, and more.

### Switching Models

- **Ctrl+L** — Open model selector (pick from list)
- **Ctrl+P** — Cycle through scoped models
- `/model <name>` — Switch by name

---

## Commands

Phi Code adds these commands on top of Pi's built-in commands:

| Command | Description |
|---------|-------------|
| `/phi-init` | Interactive setup wizard — configure providers, keys, and models |
| `/api-key` | Manage API keys (`set`, `list`, `providers`, `help`) |
| `/plan` | Full orchestration — analyze project, create spec, execute with sub-agents |
| `/run` | Execute a todo.md plan with parallel sub-agents |
| `/agents` | List available sub-agents and their capabilities |
| `/benchmark` | Test model performance (`/benchmark all`, `/benchmark code-gen`) |
| `/search` | Web search via Brave API |
| `/crawl` | Fetch and extract content from a URL |

### Pi Built-in Commands

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | OAuth authentication |
| `/model` | Switch models |
| `/settings` | Thinking level, theme, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/tree` | Navigate session history |
| `/compact` | Manually compact context |
| `/copy` | Copy last response to clipboard |
| `/export` | Export session to HTML |
| `/reload` | Reload extensions, skills, prompts |

---

## Sub-Agents

Phi Code ships with **5 specialized sub-agents**, each with its own system prompt and tool set:

| Agent | Role | Tools |
|-------|------|-------|
| **code** | Write and edit code, run commands | `read`, `write`, `edit`, `bash` |
| **explore** | Investigate codebases, read-only analysis | `read`, `bash` |
| **plan** | Architecture, design, technical planning | `read`, `bash` |
| **review** | Code review, security audit, best practices | `read`, `bash` |
| **test** | Write tests, fix tests, run test suites | `read`, `write`, `edit`, `bash` |

View agents: `/agents`
View details: `/agents code`

Agent definitions are Markdown files with YAML frontmatter in `~/.phi/agent/agents/`. You can customize them or add your own.

---

## Orchestrator

The `/plan` command is a **full-cycle project orchestrator**:

```
/plan Build a REST API with authentication and tests
```

This single command:
1. **Analyzes** your project structure
2. **Creates** a detailed spec (`spec.md`)
3. **Generates** a task list with dependencies (`todo.md`)
4. **Executes** all tasks with parallel sub-agents
5. **Reports** progress in real-time (`progress.md`)

### How It Works

- Tasks are organized into **waves** based on dependencies
- Independent tasks run **in parallel** via `Promise.all`
- Each sub-agent receives **shared context**: project description, spec summary, and results from completed dependency tasks
- Failed tasks are skipped; dependents are also skipped with a clear report
- All files are written to `.phi/plans/<timestamp>/`

### Step-by-Step Mode

Use `/run` to execute an existing plan:

```
/run .phi/plans/2026-03-07T21-00-00/todo.md
```

---

## Memory System

Phi Code remembers across sessions via **sigma-memory**:

### Components

| Component | What it stores | Location |
|-----------|---------------|----------|
| **Notes** | Free-form text notes | `~/.phi/memory/notes/` |
| **Ontology** | Structured knowledge graph (entities + relations) | `~/.phi/memory/ontology/` |
| **QMD** | Vector embeddings for semantic search | `~/.phi/memory/qmd/` |
| **AGENTS.md** | Global project instructions | `~/.phi/memory/AGENTS.md` |

### Auto-Recall

Memory is automatically searched before every response. When you ask "how did we implement the auth system?", Phi Code searches its memory and includes relevant context.

### Manual Commands

Memory tools are available to the LLM:
- `memory_search` — Semantic search across all memory
- `memory_note` — Save a note for future sessions
- `memory_entity` / `memory_relation` — Build the knowledge graph

---

## Smart Routing

The smart router automatically assigns the best model to each task based on your `routing.json` configuration:

| Task Type | Best For |
|-----------|----------|
| **code-generation** | Writing new code, refactoring |
| **debugging** | Finding and fixing bugs |
| **planning** | Architecture, design decisions |
| **tool-calling** | File operations, bash commands |
| **orchestration** | Managing sub-agents, complex workflows |
| **default** | Everything else |

Configuration: `~/.phi/agent/routing.json`

```json
{
  "code-generation": { "preferred": "qwen3.5-plus", "fallback": "default" },
  "debugging": { "preferred": "kimi-k2.5", "fallback": "default" },
  "default": { "preferred": "default", "fallback": "default" }
}
```

Set models to `"default"` to use whatever model is currently active.

---

## Benchmark

Test your models with real coding tasks:

```
/benchmark all              # Test all available models
/benchmark code-gen         # Test only code generation
/benchmark debug            # Test only debugging
```

### Categories

| Category | Weight | What it tests |
|----------|--------|---------------|
| code-gen | ×2 | Write a function from spec |
| debug | ×2 | Find and fix a bug |
| planning | ×2 | Design an architecture |
| tool-calling | ×1 | Structured tool use |
| speed | ×1 | Response latency |
| orchestration | ×2 | Multi-step task planning |

### Scoring

Models are scored 0-100 and ranked into tiers:

| Tier | Score | Meaning |
|------|-------|---------|
| **S** | 80+ | Elite — best for critical tasks |
| **A** | 65+ | Strong — reliable for most work |
| **B** | 50+ | Decent — good for simple tasks |
| **C** | 35+ | Weak — use as fallback only |
| **D** | <35 | Avoid — not recommended |

---

## Skills

Phi Code ships with **12 built-in skills**:

| Skill | Description |
|-------|-------------|
| api-design | REST API patterns, versioning, error handling |
| coding-standards | Code quality, naming conventions, best practices |
| database | Database design, queries, migrations, optimization |
| devops | CI/CD pipelines, deployment, monitoring |
| docker-ops | Docker containers, Compose, orchestration |
| git-workflow | Branching, commits, merges, collaboration |
| github | GitHub Actions, PRs, issues, releases |
| performance | Profiling, optimization, caching |
| prompt-architect | Crafting structured prompts for AI systems |
| security | Vulnerability scanning, hardening |
| self-improving | Learning from errors and corrections |
| testing | Test strategy, unit/integration tests |

Skills are loaded automatically when relevant. Invoke manually with `/skill:name`.

Add your own skills in `~/.phi/agent/skills/` or `.phi/skills/`.

---

## Extensions

Phi Code ships with **9 extensions**:

| Extension | What it adds |
|-----------|-------------|
| **init** | `/phi-init` wizard + `/api-key` management |
| **orchestrator** | `/plan` and `/run` commands with parallel sub-agents |
| **memory** | Persistent memory (notes, ontology, QMD search) |
| **smart-router** | Automatic model routing by task type |
| **skill-loader** | Dynamic skill scanning and loading |
| **benchmark** | `/benchmark` for model testing |
| **web-search** | `/search` and `/crawl` commands via Brave API |
| **agents** | `/agents` command to list sub-agents |

Extensions are TypeScript files loaded at runtime by [jiti](https://github.com/unjs/jiti). Add your own in `~/.phi/agent/extensions/`.

---

## Configuration Files

All configuration lives in `~/.phi/agent/`:

| File | Purpose |
|------|---------|
| `models.json` | **API keys & custom providers** (created by `/phi-init` or `/api-key`) |
| `routing.json` | Model assignments per task type |
| `settings.json` | Pi settings (thinking level, compaction, etc.) |
| `agents/*.md` | Sub-agent definitions |
| `skills/*/SKILL.md` | Skill definitions |
| `extensions/*.ts` | Extension files |
| `AGENTS.md` | Global project instructions |
| `keybindings.json` | Custom keyboard shortcuts |

Memory lives in `~/.phi/memory/`:

| Path | Content |
|------|---------|
| `AGENTS.md` | Global memory / instructions |
| `notes/` | Saved notes |
| `ontology/` | Knowledge graph |
| `qmd/` | Vector search index |

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **Ctrl+L** | Open model selector |
| **Ctrl+P** | Cycle models forward |
| **Shift+Ctrl+P** | Cycle models backward |
| **Shift+Tab** | Cycle thinking level |
| **Ctrl+O** | Collapse/expand tool output |
| **Ctrl+T** | Collapse/expand thinking |
| **Ctrl+G** | Open external editor |
| **Escape** | Cancel/abort |
| **Ctrl+C** | Clear editor |
| **Ctrl+C twice** | Quit |
| **Alt+Enter** | Queue follow-up message |

Full list: `/hotkeys`

---

## Sessions

Sessions auto-save to `~/.phi/agent/sessions/` as JSONL files with a tree structure.

```bash
phi -c                  # Continue last session
phi -r                  # Browse past sessions
phi --no-session        # Ephemeral mode
```

**Branching:** Use `/tree` to navigate history and branch from any point.
**Compaction:** Automatic context management when approaching limits.
**Export:** `/export file.html` or `--export` flag.
**Debug log:** `~/.phi/agent/phi-debug.log` (toggle with Ctrl+D).

---

## CLI Reference

```bash
phi [options] [@files...] [messages...]
```

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider name |
| `--model <pattern>` | Model pattern or ID |
| `--api-key <key>` | API key (session only) |
| `--thinking <level>` | off, minimal, low, medium, high, xhigh |
| `-c`, `--continue` | Continue last session |
| `-r`, `--resume` | Browse sessions |
| `-p`, `--print` | Print mode (non-interactive) |
| `--no-session` | Don't save session |
| `--verbose` | Verbose startup |
| `-v`, `--version` | Show version |

Platform notes: [Windows](docs/windows.md) | [Termux](docs/termux.md) | [tmux](docs/tmux.md)

---

## Philosophy

Phi Code follows Pi's philosophy of **aggressive extensibility** while adding the features serious developers need out of the box:

- **Memory matters.** Context across sessions shouldn't require manual copy-paste.
- **Sub-agents work.** The right agent for the right task, running in parallel.
- **Routing saves money.** Don't use your most expensive model for `ls`.
- **Setup should be easy.** `/phi-init` → pick provider → paste key → done.
- **Provider-neutral.** Your choice of LLM. No vendor lock-in.

Built on [Pi](https://github.com/badlogic/pi-mono) by [Mario Zechner](https://github.com/badlogic). Everything Phi adds is through Pi's extension system — 2 lines changed in core.

---

## Credits

- **[Pi](https://github.com/badlogic/pi-mono)** by Mario Zechner — the foundation
- **[sigma-memory](https://www.npmjs.com/package/sigma-memory)** — persistent memory system
- **[sigma-agents](https://www.npmjs.com/package/sigma-agents)** — sub-agent routing
- **[sigma-skills](https://www.npmjs.com/package/sigma-skills)** — skill scanning and loading

---

## License

MIT
