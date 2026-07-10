---
description: "Crafting production-grade structured prompts for AI systems"
---
# Prompt Architect Skill

## When to use
Crafting structured prompts for LLMs, especially for sub-agents and automated workflows.

## Prompt Structure
```
[ROLE] Who the model should be
[CONTEXT] Background information
[TASK] What to do (specific, measurable)
[FORMAT] Expected output format
[CONSTRAINTS] Rules and limitations
[EXAMPLES] Few-shot examples if needed
```

## Best Practices
- Be specific: "Write a TypeScript function" > "Write code"
- Set constraints: max length, format, language
- Use delimiters: `---`, `###`, XML tags for sections
- Chain of thought: "Think step by step" for complex reasoning
- Few-shot: provide 2-3 examples for consistent output
- Negative examples: "Do NOT include..." for clarity

## For Sub-Agents
When creating prompts for sub-agent tasks:
- Include ALL necessary context (the sub-agent has no memory)
- Specify the exact output format expected
- Set clear success criteria
- Include relevant file paths and code snippets
- Limit scope: one clear task per sub-agent

## Anti-Patterns
- ❌ Vague instructions ("make it better")
- ❌ Missing context (assuming the model knows your codebase)
- ❌ No output format (getting inconsistent results)
- ❌ Too many tasks in one prompt (losing focus)
- ❌ Contradictory instructions
