# Vendored from jo-inc/camofox-browser

This package is a **snapshot fork** of [jo-inc/camofox-browser](https://github.com/jo-inc/camofox-browser)
maintained inside the [uglyswap/phi-code](https://github.com/uglyswap/phi-code)
monorepo.

## Snapshot info

| Field | Value |
|---|---|
| Upstream repo | https://github.com/jo-inc/camofox-browser |
| Upstream branch | `master` |
| Upstream commit | `c9a90dafc76d2dfa0eb5d74fa36ef28f3ba98b29` |
| Upstream version | `1.10.1` |
| Vendored date | 2026-05-15 |
| Vendored by | uglyswap (phi-code maintainer) |
| Local version | `1.0.0` |
| License | MIT (preserved — see `LICENSE`) |

## Modifications versus upstream

1. **Renamed package** to `@phi-code-admin/camofox-browser` (was
   `@askjo/camofox-browser`).
2. **camoufox-js dependency** pinned to `@phi-code-admin/camoufox-js`
   (workspace protocol).
3. **postinstall** script (`scripts/postinstall.js`) **disabled**: no
   network calls during `npm install`. The binary is provided by the
   `@phi-code-admin/camoufox-bin-<os>-<arch>` package via npm
   `optionalDependencies`.
4. **Express server** decoupled: the 10 OpenClaw tools are exposed as
   programmatic ES module exports (`lib/api.js`) in addition to the
   existing REST surface. The legacy HTTP server is still available via
   `camofox-browser serve` for users who want it.
5. **Telemetry / analytics / update checks** disabled (search for
   `// PHI-VENDOR:` markers).

## License compliance (MIT)

The original MIT `LICENSE` file is preserved verbatim. Copyright notice
of the original author is kept in every file we modified.

## How to re-sync from upstream

```bash
git clone --depth 1 --branch master https://github.com/jo-inc/camofox-browser.git /tmp/upstream-camofox-browser
diff -ruN packages/camofox-browser /tmp/upstream-camofox-browser
```
