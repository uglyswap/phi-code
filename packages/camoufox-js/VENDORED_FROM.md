# Vendored from apify/camoufox-js

This package is a **snapshot fork** of [apify/camoufox-js](https://github.com/apify/camoufox-js)
maintained inside the [uglyswap/phi-code](https://github.com/uglyswap/phi-code)
monorepo. Upstream remains the source of truth; this fork exists so that
`@phi-code-admin/phi-code` can ship a fully self-hosted browser stack with
**zero dependency on third-party maintained npm packages or remote URLs**.

## Snapshot info

| Field | Value |
|---|---|
| Upstream repo | https://github.com/apify/camoufox-js |
| Upstream branch | `master` |
| Upstream commit | `562117321be3a8c3d6c0be5b3ddfa1c34bd4c474` |
| Upstream version | `0.10.2` (per upstream `package.json`) |
| Vendored date | 2026-05-15 |
| Vendored by | uglyswap (phi-code maintainer) |
| Local version | `1.0.0` (independent of upstream — restarts at 1.0.0) |
| License | MPL-2.0 (preserved — see `LICENSE.md`) |

## Modifications versus upstream

This snapshot is intentionally close to upstream. The diffs are tracked in
`uglyswap/phi-code` git history; the high-level changes are:

1. **Renamed package** to `@phi-code-admin/camoufox-js`. The original name
   `camoufox-js` is preserved as a `keyword` for discoverability.
2. **Binary lookup** (`src/pkgman.ts`): the `CamoufoxFetcher` class no
   longer hits `https://api.github.com/repos/daijro/camoufox/releases`.
   The binary is downloaded by `scripts/postinstall.mjs` from the
   `uglyswap/phi-code` GitHub Release into a versioned cache
   (`~/.cache/phi-code/camoufox/v1.0.0/<platform>-<arch>/camoufox-bin`, or
   the platform equivalent), checksum-verified, and looked up there first —
   `CAMOUFOX_BIN_DIR` and `CAMOUFOX_EXECUTABLE` override it. The download
   never fails an install: on failure it prints how to retry
   (`npx @phi-code-admin/camoufox-js fetch`) and exits 0. The legacy
   GitHub-fetch code path is preserved as `LEGACY_GITHUB_FETCH` and only
   kicks in when `CAMOUFOX_ALLOW_GITHUB_FETCH=1` is set.
3. **playwright-core is bounded** to `>=1.58.0 <1.61.0`, and a guard in
   `NewBrowser` refuses anything outside that range with an actionable
   message. Camoufox is driven over juggler, a protocol versioned with
   playwright itself: from 1.61.0 playwright sends a
   `Browser.setDefaultViewport` field this Firefox 135 build rejects, and
   the first `newPage()` failed with
   `Found property "<root>.viewport.isMobile"` — a message that says
   nothing about versions. Measured: 1.58.1, 1.59.1 and 1.60.0 work;
   1.61.0, 1.61.1, 1.62.0 and 1.62.1 do not.
4. **Telemetry / analytics / update checks** are no-ops. See the audit
   header at the top of each modified file (look for `// PHI-VENDOR:`
   comment markers).
5. **Auto-update disabled**: `AUTO_UPDATE = false` is enforced at module
   scope.

## License compliance (MPL-2.0)

Per MPL-2.0 §3.3, modified Source Code files retain their original
copyright notices and add a notice describing the modifications. Look for
`// PHI-VENDOR:` markers above each modified region. The full upstream
`LICENSE.md` is preserved in this directory.

## How to re-sync from upstream

```bash
# Inside the phi-code monorepo root:
git clone --depth 1 --branch master https://github.com/apify/camoufox-js.git /tmp/upstream-camoufox-js
diff -ruN packages/camoufox-js /tmp/upstream-camoufox-js   # inspect drift
# Apply selected upstream changes by hand, preserving PHI-VENDOR markers.
```
