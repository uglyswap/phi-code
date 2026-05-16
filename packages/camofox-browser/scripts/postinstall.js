#!/usr/bin/env node
// PHI-VENDOR: original upstream postinstall is preserved at
// `scripts/postinstall.upstream.js` for reference. The Camoufox binary
// is now provided by the @phi-code-admin/camoufox-bin-<platform>-<arch>
// npm package via @phi-code-admin/camoufox-js#optionalDependencies, so
// this postinstall is a deliberate no-op.
//
// Rationale (per uglyswap/phi-code vendoring spec, Phase 4):
//   * No network calls during `npm install` — works behind firewalls.
//   * No fetch from `daijro/camoufox` releases — no dependency on third
//     parties at install time.
//   * Always exits 0 to avoid breaking the user's install when this is a
//     transitive dependency.
//
// To re-enable the upstream fetcher (e.g. for development against a newer
// daijro/camoufox release that hasn't been re-vendored yet), set
// `CAMOUFOX_ALLOW_GITHUB_FETCH=1` and run
// `npx @phi-code-admin/camoufox-js fetch` manually.

process.exit(0);
