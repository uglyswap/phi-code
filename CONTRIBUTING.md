# Contributing to Phi Code

Thank you for your interest in contributing to Phi Code! 🎉

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
npx phi-code
```

## Development Setup

Phi Code is a monorepo managed with npm workspaces. The main packages are:

| Package | Description |
|---------|-------------|
| `phi-code` | Main coding agent (CLI entry point) |
| `phi-code-ai` | AI model providers and abstractions |
| `phi-code-agent` | Core agent runtime |
| `phi-code-tui` | Terminal UI components |
| `sigma-memory` | Persistent memory (QMD + Ontology + Notes) |
| `sigma-agents` | Sub-agent routing and management |

## Architecture Principles

1. **Minimal core modifications**: Phi Code is a fork of Pi. We keep Pi's core intact and add features via extensions and new packages.
2. **Extension-first**: New features should be extensions (in `packages/coding-agent/extensions/phi/`) when possible.
3. **No external dependencies**: Extensions should use only Node.js built-ins and `@sinclair/typebox`.
4. **Free models by default**: Everything works out of the box with Alibaba Coding Plan (free unlimited).

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

## Adding a Skill

1. Create a directory in `skills/<skill-name>/`
2. Add a `SKILL.md` with usage instructions
3. The skill-loader extension will automatically detect it

## Adding a Sub-Agent

1. Create a `.md` file in `agents/` with YAML frontmatter:

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

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
