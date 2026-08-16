# Contributing to Phi Code

Thank you for your interest in contributing to Phi Code! 🎉

This guide exists to save both sides time.

## Philosophy

First things first: **the core is minimal**.

Phi Code is a fork of [Pi](https://github.com/badlogic/pi-mono) and inherits that philosophy. If your feature does not belong in the core, it should be an extension. PRs that bloat the core will likely be rejected.

The core exists to be minimal and to be extensible so that it can be influenced and manipulated by extensions. Even hook points for extensions however should be well considered and discussed to avoid adding unmaintainable bloat and complex interactions.

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed.

Using AI to write code is fine. Submitting AI-generated slop without understanding it is not.

If you use an agent, run it from the repository root directory so it picks up `AGENTS.md` automatically. Your agent must follow the rules and guidelines in that file.

## Quick Start

```bash
# Fork and clone
git clone https://github.com/YOUR_USERNAME/phi-code.git
cd phi-code

# Install dependencies
npm install

# Build
npm run build

# Run
npx phi
```

## Development Setup

Phi Code is a monorepo managed with npm workspaces. The main packages are:

| Package | Description |
|---------|-------------|
| `@phi-code-admin/phi-code` | Main coding agent (CLI entry point, binary `phi`) |
| `phi-code-ai` | AI model providers and abstractions |
| `phi-code-agent` | Core agent runtime |
| `phi-code-tui` | Terminal UI components |
| `phi-code-protocol` | Wire protocol shared by client and server |
| `phi-code-client` | Programmatic client for a running session |
| `phi-code-server` | Session server |
| `phi-code-telemetry` | Telemetry primitives |
| `sigma-memory` | Persistent memory (QMD + Ontology + Notes) |
| `sigma-agents` | Sub-agent routing and management |

## Architecture Principles

1. **Minimal core modifications**: Phi Code is a fork of Pi. We keep Pi's core intact and add features via extensions and new packages. Branding rules (what says "phi", what deliberately stays "pi" for clean upstream merges) are codified in [packages/coding-agent/docs/fork-policy.md](packages/coding-agent/docs/fork-policy.md) — read it before touching any pi/phi naming.
2. **Extension-first**: New features should be extensions (in `packages/coding-agent/extensions/phi/`) when possible.
3. **No external dependencies**: Extensions should use only Node.js built-ins and `@sinclair/typebox`.
4. **Free models by default**: Everything works out of the box with Alibaba Coding Plan (free unlimited).
5. **Single source of truth**: bundled agents/skills/config live in `packages/coding-agent/{agents,skills,config}` only (the published package). Routing defaults come from `SmartRouter.defaultConfig()`; `config/routing.example.json` is documentation kept in sync by `test/routing-config.test.ts`. Agent `.md` parsing goes through `extensions/phi/providers/agent-def.ts`.

## Adding an Extension

1. Create a new `.ts` file in `packages/coding-agent/extensions/phi/`
2. Follow the extension pattern:

```typescript
import type { ExtensionAPI } from "phi-code";

export default function myExtension(pi: ExtensionAPI) {
  // Register tools, commands, and event listeners
}
```

3. Update `packages/coding-agent/extensions/phi/README.md`
4. Test with `phi --extension ./path/to/extension.ts`

See [packages/coding-agent/docs/extensions.md](packages/coding-agent/docs/extensions.md) for the full extension API.

## Adding a Skill

1. Create a directory in `packages/coding-agent/skills/<skill-name>/`
2. Add a `SKILL.md` with usage instructions
3. The skill-loader extension will automatically detect it

## Adding a Sub-Agent

1. Create a `.md` file in `packages/coding-agent/agents/` with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, write, bash
model: qwen3.5-plus
---

System prompt for the agent goes here.
```

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation
- `chore:` — Maintenance
- `refactor:` — Code refactoring
- `test:` — Tests
- `perf:` — Performance

## Contribution Gate

All issues and PRs from new contributors are auto-closed by default.

Issues submitted Friday through Sunday are not guaranteed to be reviewed. If something is urgent, ask on the Pi community Discord: https://discord.com/invite/3cU7Bz4UPx

Maintainers review auto-closed issues daily and reopen worthwhile ones. Issues that do not meet the quality bar below will not be reopened or receive a reply.

Approval happens through maintainer replies on issues:

- `lgtmi`: your future issues will not be auto-closed
- `lgtm`: your future issues and PRs will not be auto-closed

The command must be at the start of the reply (optionally after one or more `@username` mentions) or at the end. `lgtmi` does not grant rights to submit PRs. Only `lgtm` grants rights to submit PRs.

## Quality Bar For Issues

If you open an issue, you must use one of the GitHub issue templates.

If you open an issue, keep it short, concrete, and worth reading.

- Keep it concise. If it does not fit on one screen, it is too long.
- Write in your own voice (do not use an LLM to generate text, if you must, follow up with a clearly AI labeled comment).
- State the bug or request clearly.
- Explain why it matters.
- If you want to implement the change yourself, say so.

If the issue is real and written well, a maintainer may reopen it or reply with `lgtmi` or `lgtm` in the command position described above.

## Blocking

If you ignore this document twice, or if you spam the tracker with agent-generated issues, your GitHub account will be permanently blocked.

If you send a large volume of issues through automation, your GitHub account will be permanently blocked. No taksies backsies.

## Before Submitting a PR

Do not open a PR unless you have already been approved by a maintainer using `lgtm` in the command position described above.

Before submitting a PR:

```bash
npm run check
npm test
```

Both must pass.

Do not edit `CHANGELOG.md`. Changelog entries are added by maintainers.

If you are adding a new provider to `packages/ai`, see `AGENTS.md` for required tests.

## Pull Request Process

1. Create a feature branch: `git checkout -b feat/my-feature`
2. Make focused, atomic commits
3. Ensure everything builds: `npm run build`
4. Push and create a PR with a clear description
5. Wait for review

## Code Style

- TypeScript strict mode
- Named exports preferred
- JSDoc comments on public APIs
- Error handling: never swallow exceptions
- No magic numbers

## Reporting Issues

Use [GitHub Issues](https://github.com/uglyswap/phi-code/issues) with:
- Clear title
- Steps to reproduce
- Expected vs actual behavior
- Environment (OS, Node.js version, model used)

## Questions?

Open a [GitHub Discussion or Issue](https://github.com/uglyswap/phi-code/issues), or ask on the Pi community [Discord](https://discord.com/invite/3cU7Bz4UPx).

## FAQ

### Why are new issues and PRs auto-closed?

The project receives more issues than the maintainers can responsibly review in real time. Many reports do not meet the quality bar in this guide or do not follow CONTRIBUTING.md. Some are slung at the repository mindlessly via an agent instead of being reviewed and shaped by the person submitting them. Auto-closing creates a buffer so maintainers can review the tracker on their own schedule and reopen the issues that meet the quality bar.

### Why are weekend issues lower priority?

We triage the tracker during working hours. That means more issues can accumulate over the weekend. Anything submitted Friday through Sunday may be missed or given lower priority in the Monday review queue. If a problem is urgent, ask on Discord and include the short version, a repro, and the relevant logs.

### Why do some issues get no reply?

A reply is maintenance work too. Low-signal issues, unclear reports, duplicates, and issues that do not follow this guide may be closed without discussion. This keeps time available for reproducible bugs, thoughtful requests, and contributors who have done the work to make their report actionable.

### Why not let AI triage everything?

AI can help group duplicates, summarize reports, and spot missing information. It is not trusted to make final maintainer decisions. Polished AI-generated issues can still be wrong, misleading, or expensive to investigate. Human review remains the final gate.

### Is this hostile to contributors?

No. It is a guardrail against burnout and tracker spam. Short, concrete, reproducible issues are welcome. Thoughtful contributions are welcome. Automated slop, entitlement, and large volumes of low-effort reports are not.

## Where can I learn about upstream plans?

Upstream (Earendil) uses RFCs to discuss larger changes. Not all of them are public, but
quite a few are. They can be found at [rfc.earendil.com](https://rfc.earendil.com/keyword/pi/).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
