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
| Local version | `1.1.0` |
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
   `// PHI-VENDOR:` markers). The crash relay defaults to no endpoint, so
   nothing is sent unless `CAMOFOX_CRASH_REPORT_URL` names a relay; the
   worker source is still shipped for anyone self-hosting one, but no
   workflow deploys it and the repo holds no Cloudflare credentials.
6. **Private-network guard is opt-in-able**: `validateUrl` still refuses
   loopback, link-local and RFC1918 hosts by default (SSRF), but
   `CAMOFOX_ALLOW_PRIVATE_HOSTS=1` or a `CAMOFOX_ALLOWED_HOSTS` list lets
   an operator reach an internal target on purpose. The scheme check runs
   first, so `file:`/`data:` stay refused either way.
7. **Windows fixes** upstream never needed on Linux: `plugin install`
   accepts a drive-letter or UNC path (it used to route them to
   `git clone`), and an external `CAMOUFOX_EXECUTABLE` bundle falls back
   to a hard link or copy when the OS refuses a file symlink (creating one
   requires Administrator or Developer Mode).

## License compliance (MIT)

The original MIT `LICENSE` file is preserved verbatim. Copyright notice
of the original author is kept in every file we modified.

## How to re-sync from upstream

```bash
git clone --depth 1 --branch master https://github.com/jo-inc/camofox-browser.git /tmp/upstream-camofox-browser
diff -ruN packages/camofox-browser /tmp/upstream-camofox-browser
```
