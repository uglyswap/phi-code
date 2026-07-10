---
description: "Git branching, commits, merges, and collaboration workflows"
---
# Git Workflow Skill

## When to use
Any git operations: branching, committing, merging, rebasing.

## Branch Strategy
- `main` — Production, always stable
- `feat/<name>` — New features
- `fix/<name>` — Bug fixes
- `chore/<name>` — Maintenance tasks

## Conventional Commits
```
feat: add user authentication
fix: resolve memory leak in cache
docs: update API documentation
chore: upgrade dependencies
refactor: simplify error handling
test: add integration tests for auth
perf: optimize database queries
ci: add GitHub Actions workflow
```

## Workflow
1. `git checkout -b feat/<name>` from main
2. Make focused, atomic commits
3. `git push origin feat/<name>`
4. Create PR with description
5. Review, approve, squash merge into main
6. Delete feature branch

## Recovery
- Undo last commit (keep changes): `git reset --soft HEAD~1`
- Undo last commit (discard): `git reset --hard HEAD~1`
- Stash changes: `git stash` / `git stash pop`
- Cherry-pick: `git cherry-pick <hash>`
- Interactive rebase: `git rebase -i HEAD~N`
