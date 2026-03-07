---
description: "Code quality standards, naming conventions, and best practices"
---
# Coding Standards Skill

## When to use
When writing, reviewing, or refactoring code in any language.

## TypeScript/JavaScript
- Use `const` by default, `let` when reassignment needed, never `var`
- Prefer `async/await` over raw Promises
- Use TypeScript strict mode
- Naming: `camelCase` variables/functions, `PascalCase` types/classes, `UPPER_SNAKE` constants
- Prefer named exports over default exports
- Handle errors: never swallow exceptions silently
- Validate inputs at API boundaries

## Python
- Follow PEP 8
- Type hints on all functions
- Use dataclasses or Pydantic for structured data
- `with` statements for resource management
- List comprehensions over map/filter where readable

## General Principles
- DRY but don't over-abstract (Rule of Three)
- Functions: single responsibility, <30 lines ideally
- Comments: explain WHY, not WHAT
- No magic numbers: use named constants
- Fail fast: validate early, return early
- Prefer composition over inheritance

## Code Review Checklist
- [ ] Types are correct and complete
- [ ] Error handling is proper
- [ ] No security vulnerabilities (injection, XSS, etc.)
- [ ] Tests cover the changes
- [ ] No unnecessary complexity
- [ ] Names are clear and descriptive
- [ ] No hardcoded secrets or credentials
