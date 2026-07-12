<p align="center"><strong>φ phi-code</strong></p>
<p align="center">
  <a href="https://www.npmjs.com/package/@phi-code-admin/phi-code"><img alt="npm" src="https://img.shields.io/npm/v/@phi-code-admin/phi-code?style=flat-square" /></a>
  <a href="https://github.com/uglyswap/phi-code"><img alt="GitHub" src="https://img.shields.io/badge/github-uglyswap%2Fphi--code-181717?style=flat-square&logo=github" /></a>
</p>

---

phi-code is a terminal coding harness with persistent memory, sub-agents, intelligent model routing, and a five-phase plan orchestrator — built as a fork of [Pi](https://github.com/earendil-works/pi-mono) (see [docs/fork-policy.md](docs/fork-policy.md)). Adapt phi to your workflows, not the other way around. Extend it with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes). Put your extensions, skills, prompt templates, and themes in [Phi Packages](#phi-packages) and share them with others via npm or git.

Where upstream Pi deliberately skips sub agents and plan mode, phi-code ships them out of the box: `/plan` runs a five-phase explore → plan → code → test → review pipeline with per-phase models from `~/.phi/agent/routing.json`, a local vector memory (`memory_search`/`memory_write`), and a knowledge-graph ontology.

phi-code runs in four modes: interactive, print or JSON, RPC for process integration, and an SDK for embedding in your own apps.

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Execution-Grounded Modes (/plan, /debug, /build, /sandbox)](#execution-grounded-modes)
- [Interactive Mode](#interactive-mode)
  - [Editor](#editor)
  - [Commands](#commands)
  - [Keyboard Shortcuts](#keyboard-shortcuts)
  - [Message Queue](#message-queue)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Phi Packages](#phi-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

```bash
npm install -g @phi-code-admin/phi-code
```

Authenticate with an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
phi
```

Or use your existing subscription:

```bash
phi
/login  # Then select provider
```

Run `/setup` to configure providers (OpenCode Zen/Go, Alibaba Coding Plan, OpenAI, Anthropic, Google, OpenRouter, Groq, local Ollama/LM Studio) and assign per-phase models, or `/phi-init` for the guided first-run wizard.

Then just talk to phi. By default, phi gives the model four tools: `read`, `write`, `edit`, and `bash`. The model uses these to fulfill your requests. Add capabilities via [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [phi packages](#phi-packages).

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Providers & Models

For each built-in provider, phi maintains a list of tool-capable models, updated with every release. Authenticate via subscription (`/login`) or API key, then select any model from that provider via `/model` (or Ctrl+L).

**Subscriptions:**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

**API keys:**
- Anthropic
- OpenAI
- Azure OpenAI
- DeepSeek
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Together AI
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)
- Alibaba Cloud Coding Plan (`qwen3.7-plus`, GLM, Kimi, MiniMax — subscription quota)

See [docs/providers.md](docs/providers.md) for detailed setup instructions.

**One-command setup for known providers:** `/keys set alibaba-codingplan sk-sp-…` (or `opencode-go <key>`) bootstraps the full provider entry — endpoint, protocol, model list — from just the API key, then validates it with `/keys test <id>`. The live catalog refreshes on session start.

**Custom providers & models:** Add providers via `~/.phi/agent/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Execution-Grounded Modes

Phi's multi-phase modes share one principle, learned the hard way on SWE-bench:
**execution is the only oracle**. A verdict must come from running real code —
never from a model reviewing its own output (which we measured approving wrong
code, even across model families). Full design:
[docs/design/plan-debug-build.md](docs/design/plan-debug-build.md).

| Command | Job | Pipeline |
|---|---|---|
| `/fix <failing test \| repro \| description>` | Fix at single-shot cost, verified | SINGLE SHOT → sandbox oracle → green: done / red: escalate to /debug |
| `/plan <spec>` | Plan AND build a project | EXPLORE → PLAN → CODE → TEST → REVIEW |
| `/debug <…> [--candidates N]` | Turn a REAL failure green | REPRODUCE → LOCALIZE → FIX (×N diverse models) → real-run arbitration / VERIFY |
| `/build <spec>` | Build until it runs | EXPLORE → PLAN → CODE → BUILD-VERIFY (run recipe + acceptance + executable red-team) |
| `/sandbox [status\|prepare\|run <cmd>]` | Inspect the guaranteed environment | — |

**The execution sandbox.** Every oracle run goes through the `sandbox_run` tool:
a per-project Docker container (toolchain auto-detected — node/python/go/rust/ruby
or your `Dockerfile`; override anything in `.phi/sandbox.json`) that returns the
REAL exit code. No Docker and nothing to containerize → runs fall back to the
host; if an environment is demanded but unavailable, phases report `BLOCKED`
rather than fabricate a pass.

**Honesty guarantees** (each one exists because we measured its absence losing):
- `/debug` refuses to "fix" a failure it cannot reproduce — and a BLOCKED verdict
  gets one second chance on a different model family before the halt.
- VERIFY requires the reproduction to pass AND the suite not to regress; a
  TIMEOUT counts as a regression (a fix that hangs the suite is worse than none).
- `/build` reports `SUCCESS` only when a real run meets the acceptance criteria,
  otherwise an honest `PARTIAL` listing what still fails.

**Per-phase model routing.** Each phase can run on its own model via
`~/.phi/agent/routing.json` (e.g. code on `alibaba-codingplan/qwen3.7-plus`,
verification on a different family so it does not share the coder's blind spot),
with automatic fallback on transient provider errors.

**Measured, honestly:** on a 13-instance SWE-bench-lite slice (official harness),
a strong single-shot baseline resolved 7/13 vs `/debug` 6/13 at ~2.5× the time —
with `/debug` producing smaller patches and zero toxic ones. `/fix` is the
composition that measurement demanded: by construction never worse than the
single shot, escalating exactly where a real red run proves the shot failed.
Every run appends a telemetry line to `.phi/runs.jsonl` (phases, models,
verdicts, sandbox executions, duration) so behaviour is measured continuously.

---

## Interactive Mode

<p align="center"><img src="docs/images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface from top to bottom:

- **Startup header** - Shows shortcuts (`/hotkeys` for all), loaded AGENTS.md files, prompt templates, skills, and extensions
- **Messages** - Your messages, assistant responses, tool calls and results, notifications, errors, and extension UI
- **Editor** - Where you type; border color indicates thinking level
- **Footer** - Working directory, session name, total token/cache usage, cost, context usage, current model

The editor can be temporarily replaced by other UI, like built-in `/settings` or custom UI from extensions (e.g., a Q&A tool that lets the user answer model questions in a structured format). [Extensions](#extensions) can also replace the editor, add widgets above/below it, a status line, custom footer, or overlays.

### Editor

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Tab to complete paths |
| Multi-line | Shift+Enter (or Ctrl+Enter on Windows Terminal) |
| Images | Ctrl+V to paste (Alt+V on Windows), or drag onto terminal |
| Bash commands | `!command` runs and sends output to LLM, `!!command` runs without sending |

Standard editing keybindings for delete word, undo, etc. See [docs/keybindings.md](docs/keybindings.md).

### Commands

Type `/` in the editor to trigger commands. [Extensions](#extensions) can register custom commands, [skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | OAuth authentication |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session info (file, ID, messages, tokens, cost) |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optional custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML file |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files (themes hot-reload automatically) |
| `/hotkeys` | Show all keyboard shortcuts |
| `/changelog` | Display version history |
| `/quit` | Quit phi |

### Keyboard Shortcuts

See `/hotkeys` for the full list. Customize via `~/.phi/agent/keybindings.json`. See [docs/keybindings.md](docs/keybindings.md).

**Commonly used:**

| Key | Action |
|-----|--------|
| Ctrl+C | Clear editor |
| Ctrl+C twice | Quit |
| Escape | Cancel/abort |
| Escape twice | Open `/tree` |
| Ctrl+L | Open model selector |
| Ctrl+P / Shift+Ctrl+P | Cycle scoped models forward/backward |
| Shift+Tab | Cycle thinking level |
| Ctrl+O | Collapse/expand tool output |
| Ctrl+T | Collapse/expand thinking blocks |

### Message Queue

Submit messages while the agent is working:

- **Enter** queues a *steering* message, delivered after the current assistant turn finishes executing its tool calls
- **Alt+Enter** queues a *follow-up* message, delivered only after the agent finishes all work
- **Escape** aborts and restores queued messages to editor
- **Alt+Up** retrieves queued messages back to editor

On Windows Terminal, `Alt+Enter` is fullscreen by default. Remap it in [docs/terminal-setup.md](docs/terminal-setup.md) so phi can receive the follow-up shortcut.

Configure delivery in [settings](docs/settings.md): `steeringMode` and `followUpMode` can be `"one-at-a-time"` (default, waits for response) or `"all"` (delivers all queued at once). `transport` selects provider transport preference (`"sse"`, `"websocket"`, or `"auto"`) for providers that support multiple transports.

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session-format.md](docs/session-format.md) for file format.

### Management

Sessions auto-save to `~/.phi/agent/sessions/` organized by working directory.

```bash
phi -c                  # Continue most recent session
phi -r                  # Browse and select from past sessions
phi --no-session        # Ephemeral mode (don't save)
phi --session <path|id> # Use specific session file or ID
phi --fork <path|id>    # Fork specific session file or ID into a new session
```

Use `/session` in interactive mode to see the current session ID before reusing it with `--session <id>` or `--fork <id>`.

### Branching

**`/tree`** - Navigate the session tree in-place. Select any previous point, continue from there, and switch between branches. All history preserved in a single file.

<p align="center"><img src="docs/images/tree-view.png" alt="Tree View" width="600"></p>

- Search by typing, fold/unfold and jump between branches with Ctrl+←/Ctrl+→ or Alt+←/Alt+→, page with ←/→
- Filter modes (Ctrl+O): default → no-tools → user-only → labeled-only → all
- Press Shift+L to label entries as bookmarks and Shift+T to toggle label timestamps

**`/fork`** - Create a new session file from a previous user message on the active branch. Opens a selector, copies the active path up to that point, and places the selected prompt in the editor for modification.

**`/clone`** - Duplicate the current active branch into a new session file at the current position. The new session keeps the full active-path history and opens with an empty editor.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** `/compact` or `/compact <custom instructions>`

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure via `/settings` or `settings.json`.

Compaction is lossy. The full history remains in the JSONL file; use `/tree` to revisit. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Settings

Use `/settings` to modify common options, or edit JSON files directly:

| Location | Scope |
|----------|-------|
| `~/.phi/agent/settings.json` | Global (all projects) |
| `.phi/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

### Telemetry and update checks

phi has two separate startup features:

- **Update check:** fetches `https://registry.npmjs.org/@phi-code-admin/phi-code/latest` to check whether a newer phi-code version exists. Disable it with `PI_SKIP_VERSION_CHECK=1`. Disabling update checks only turns off this check.
- **Install/update telemetry:** none. phi-code sends no telemetry pings (the inherited upstream ping to `pi.dev` was removed).

Use `--offline` or `PI_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

---

## Context Files

phi loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.phi/agent/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

Use for project instructions, conventions, common commands. All matching files are concatenated.

Disable context file loading with `--no-context-files` (or `-nc`).

### System Prompt

Replace the default system prompt with `.phi/SYSTEM.md` (project) or `~/.phi/agent/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Type `/name` to expand.

```markdown
<!-- ~/.phi/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.phi/agent/prompts/`, `.phi/prompts/`, or a [phi package](#phi-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name` or let the agent load them automatically.

```markdown
<!-- ~/.phi/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `~/.phi/agent/skills/`, `~/.agents/skills/`, `.phi/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [phi package](#phi-packages) to share with others. See [docs/skills.md](docs/skills.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend phi with custom tools, commands, keyboard shortcuts, event handlers, and UI components.

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

The default export can also be `async`. phi waits for async extension factories before startup continues, which is useful for one-time initialization such as fetching remote model lists before calling `pi.registerProvider()`.

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Sub-agents and plan mode
- Custom compaction and summarization
- Permission gates and path protection
- Custom editors and UI components
- Status lines, headers, footers
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- Make phi look like Claude Code
- Games while waiting (yes, Doom runs)
- ...anything you can dream up

Place in `~/.phi/agent/extensions/`, `.phi/extensions/`, or a [phi package](#phi-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and phi immediately applies changes.

Place in `~/.phi/agent/themes/`, `.phi/themes/`, or a [phi package](#phi-packages) to share with others. See [docs/themes.md](docs/themes.md).

### Phi Packages

Bundle and share extensions, skills, prompts, and themes via npm or git. Find packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) or [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628).

> **Security:** phi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
phi install npm:@foo/pi-tools
phi install npm:@foo/pi-tools@1.2.3      # pinned version
phi install git:github.com/user/repo
phi install git:github.com/user/repo@v1  # tag or commit
phi install git:git@github.com:user/repo
phi install git:git@github.com:user/repo@v1  # tag or commit
phi install https://github.com/user/repo
phi install https://github.com/user/repo@v1      # tag or commit
phi install ssh://git@github.com/user/repo
phi install ssh://git@github.com/user/repo@v1    # tag or commit
phi remove npm:@foo/pi-tools
phi uninstall npm:@foo/pi-tools          # alias for remove
phi list
phi update                               # update phi and packages (skips pinned packages)
phi update --extensions                  # update packages only
phi update --self                        # update phi only
phi update --self --force                # reinstall phi even if current
phi update npm:@foo/pi-tools             # update one package
phi config                               # enable/disable extensions, skills, prompts, themes
```

Packages install to `~/.phi/agent/git/` (git) or global npm. Use `-l` for project-local installs (`.phi/git/`, `.phi/npm/`). Git packages install dependencies with `npm install --omit=dev` by default, so runtime deps must be listed under `dependencies`; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers. If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding a `pi` key to `package.json`:

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `pi` manifest, phi auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager } from "@phi-code-admin/phi-code";

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage,
  modelRegistry,
});

await session.prompt("What files are in the current directory?");
```

For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
phi --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## Philosophy

phi is aggressively extensible so it doesn't have to dictate your workflow. Features that other tools bake in can be built with [extensions](#extensions), [skills](#skills), or installed from third-party [phi packages](#phi-packages). This keeps the core minimal while letting you shape phi to fit how you work.

**No MCP.** Build CLI tools with READMEs (see [Skills](#skills)), or build an extension that adds MCP support. [Why?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**No sub-agents.** There's many ways to do this. Spawn phi instances via tmux, or build your own with [extensions](#extensions), or install a package that does it your way.

**No permission popups.** Run in a container, or build your own confirmation flow with [extensions](#extensions) inline with your environment and security requirements.

**No plan mode.** Write plans to files, or build it with [extensions](#extensions), or install a package.

**No built-in to-dos.** They confuse models. Use a TODO.md file, or build your own with [extensions](#extensions).

**No background bash.** Use tmux. Full observability, direct interaction.

Read the [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) for the full rationale.

---

## CLI Reference

```bash
phi [options] [@files...] [messages...]
```

### Package Commands

```bash
phi install <source> [-l]     # Install package, -l for project-local
phi remove <source> [-l]      # Remove package
phi uninstall <source> [-l]   # Alias for remove
phi update [source|self]   # Update phi and packages (skips pinned packages)
phi update --extensions       # Update packages only
phi update --self             # Update phi only
phi update --self --force     # Reinstall phi even if current
phi update --extension <src>  # Update one package
phi list                      # List installed packages
phi config                    # Enable/disable package resources
```

### Modes

| Flag | Description |
|------|-------------|
| (default) | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, phi also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | phi -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Browse and select session |
| `--session <path\|id>` | Use specific session file or partial UUID |
| `--fork <path\|id>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific tool names across built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools by default but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools by default |

Available built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable AGENTS.md and CLAUDE.md context file discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
pi @prompt.md "Answer this"
phi -p @screenshot.png "What's in this image?"
pi @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
phi "List all .ts files in src/"

# Non-interactive
phi -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | phi -p "Summarize this text"

# Different model
phi --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
phi --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
phi --model sonnet:high "Solve this complex problem"

# Limit model cycling
phi --models "claude-*,gpt-4o"

# Read-only mode
phi --tools read,grep,find,ls -p "Review the code"

# High thinking level
phi --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PHI_CODING_AGENT_DIR` | Override config directory (default: `~/.phi/agent`) |
| `PHI_CODING_AGENT_SESSION_DIR` | Override session storage directory (overridden by `--session-dir`) |
| `PI_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `PI_OFFLINE` | Disable startup network operations, including update checks, package update checks, and install/update telemetry |
| `PI_SKIP_VERSION_CHECK` | Skip the phi-code version update check at startup. This prevents the npm registry latest-version request |
| `PI_TELEMETRY` | Override install/update telemetry. Use `1`/`true`/`yes` to enable or `0`/`false`/`no` to disable. This does not disable update checks |
| `PI_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |

---

## Contributing & Development

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines and [docs/development.md](docs/development.md) for setup, forking, and debugging.

---

## License

MIT

## See Also

- [@earendil-works/pi-ai](https://www.npmjs.com/package/@earendil-works/pi-ai): Core LLM toolkit
- [@earendil-works/pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core): Agent framework
- [@earendil-works/pi-tui](https://www.npmjs.com/package/@earendil-works/pi-tui): Terminal UI components
