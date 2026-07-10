---
description: "Continuous learning from errors, corrections, and discoveries"
---
# Self-Improving Agent Skill

## When to use
After any error, correction, or learning moment. Also before major tasks to review past learnings.

## Protocol

### On Error
1. Document the error in `~/.phi/memory/learnings.md`
2. Note: what happened, why, how to prevent it
3. If it's a recurring pattern, create a rule

### On Correction
When the user corrects you:
1. Acknowledge the correction
2. Write to memory: what was wrong, what's right
3. Apply immediately

### On Success
When a complex task succeeds:
1. Note the approach that worked
2. If novel, document for future reference

### Before Major Tasks
1. Read `~/.phi/memory/learnings.md`
2. Check for relevant past mistakes
3. Apply learned rules

## Memory Format
```markdown
## YYYY-MM-DD — Learning
**Context:** What was happening
**Error/Insight:** What went wrong or what was learned
**Rule:** What to do differently
**Category:** [code|config|workflow|communication]
```
