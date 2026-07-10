<!-- What does this change and why? Keep it tight. -->

## Summary

## Discipline checklist

<!-- CI enforces these; the checklist is so you don't discover it after pushing. -->

- [ ] `npm run check` passes locally (biome + types + browser smoke)
- [ ] `npm test` passes locally
- [ ] New/changed behavior has a test (logic in `extensions/phi/providers/*`
      and `sigma-*` is unit-testable — put it there, not only in the runtime hook)
- [ ] No new duplicate source of truth (bundled assets live only in
      `packages/coding-agent/{agents,skills,config}`; routing defaults come from
      `SmartRouter.defaultConfig()`)
- [ ] Any pi→phi rename respects [docs/fork-policy.md](../packages/coding-agent/docs/fork-policy.md)
      (outputs are rebranded; identifiers, `PI_*` env vars and upstream links stay)
- [ ] `packages/ai/src/*.generated.ts` was NOT hand-edited (regenerate with
      `npm run generate --workspace=packages/ai` and bump `packages/ai`)
- [ ] Version bumped + CHANGELOG entry if this ships to npm
