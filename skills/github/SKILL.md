# GitHub Workflow Skill

## When to use
When working with GitHub repositories: creating repos, managing branches, pull requests, issues, releases, and GitHub Actions.

## Best Practices
- Always create feature branches: `git checkout -b feat/<name>`
- Use conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`
- Write descriptive PR titles and bodies
- Link issues in PR descriptions: `Closes #123`
- Use GitHub Actions for CI/CD
- Keep commits atomic and focused
- Squash merge for cleaner history

## PR Template
```markdown
## What
Brief description of changes

## Why
Motivation and context

## How
Implementation approach

## Testing
How this was tested

## Checklist
- [ ] Tests pass
- [ ] Documentation updated
- [ ] No breaking changes
```
