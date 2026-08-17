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
3. **postinstall** script (`scripts/postinstall.js`) **disabled**: this
   package makes no network call during `npm install`. The browser binary
   is fetched by `@phi-code-admin/camoufox-js`'s own postinstall from the
   `uglyswap/phi-code` GitHub Release into a versioned cache
   (`~/.cache/phi-code/camoufox/v1.0.0/<platform>-<arch>/`, or the
   platform equivalent). That download never fails the install; retry it
   with `npx @phi-code-admin/camoufox-js fetch`, point at an existing
   build with `CAMOUFOX_EXECUTABLE`, or skip it with
   `CAMOUFOX_SKIP_DOWNLOAD=1`.
4. **playwright-core is bounded** to `>=1.58.0 <1.61.0`. Camoufox is a
   Firefox fork driven over juggler, a protocol versioned with playwright
   itself: from 1.61.0 playwright sends a `Browser.setDefaultViewport`
   field this Firefox 135 build rejects, and the first `newPage()` fails
   with `Found property "<root>.viewport.isMobile"`. Upstream left the
   dependency unbounded, so a fresh install picked the newest playwright
   and the browser could not open a page.
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
