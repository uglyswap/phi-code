# Third-Party Licenses (phi-code)

phi-code embeds three vendored projects to provide the bundled browser
engine. Each project remains under its original license; this file
collects the attributions required by those licenses and acts as a single
discovery point for downstream consumers.

The full upstream `LICENSE` / `LICENSE.md` file is preserved verbatim in
the corresponding `packages/<name>/` directory.

---

## 1. Camoufox (anti-detect Firefox build + JS launcher)

| Field | Value |
|---|---|
| Upstream repo | https://github.com/daijro/camoufox |
| Vendored binary version | v135.0.1-beta.24 |
| Vendored launcher | `apify/camoufox-js@562117321be3a8c3d6c0be5b3ddfa1c34bd4c474` |
| Vendored path | `packages/camoufox-js/` |
| Re-hosted binaries | https://github.com/uglyswap/phi-code/releases/tag/binaries-v1.0.0 |
| License | **MPL-2.0** (Mozilla Public License 2.0) |
| Verbatim LICENSE | `packages/camoufox-js/LICENSE.md` |
| Modification markers | grep `PHI-VENDOR:` (per MPL §3.3) |

**Modifications versus upstream** (see `packages/camoufox-js/VENDORED_FROM.md`):

- Package renamed to `@phi-code-admin/camoufox-js` (NPM scope), version
  restarted at 1.0.0.
- `CamoufoxFetcher` now targets the re-hosted release on
  `uglyswap/phi-code` by default. The original `daijro/camoufox` source
  remains reachable via `CAMOUFOX_ALLOW_GITHUB_FETCH=1`.
- Added a versioned cache discovery path
  (`~/.cache/phi-code/camoufox/v1.0.0/<platform>-<arch>/`) populated by a
  postinstall script. The script is non-fatal: install never fails on
  network errors.

**Camoufox itself is an anti-detect fork of Mozilla Firefox**, which is
also MPL-2.0 (with portions under the Apache 2.0, BSD 3-Clause, MIT and
Public Domain licenses). The Firefox source tree is not redistributed in
this package; only the compiled binary appears in the npm tarball /
GitHub Release. Their license headers are preserved inside the binary
build, and full source is available at
<https://hg.mozilla.org/mozilla-central> and
<https://github.com/daijro/camoufox>.

## 2. camofox-browser (HTTP automation server + OpenClaw plugin)

| Field | Value |
|---|---|
| Upstream repo | https://github.com/jo-inc/camofox-browser |
| Vendored commit | `c9a90dafc76d2dfa0eb5d74fa36ef28f3ba98b29` (was v1.10.1) |
| Vendored path | `packages/camofox-browser/` |
| License | **MIT** |
| Verbatim LICENSE | `packages/camofox-browser/LICENSE` |
| Modification markers | grep `PHI-VENDOR:` |

**Modifications versus upstream**
(see `packages/camofox-browser/VENDORED_FROM.md`):

- Package renamed to `@phi-code-admin/camofox-browser`, dep `camoufox-js`
  repointed to `@phi-code-admin/camoufox-js`.
- `scripts/postinstall.js` reduced to a `process.exit(0)` no-op — no
  network call during `npm install`.
- `lib/reporter.js` crash-telemetry endpoint defaulted to empty string;
  `sendToRelay()` short-circuits unless `CAMOFOX_CRASH_REPORT_URL` is
  explicitly set. The original endpoint
  (`https://camofox-telemetry.askjo.workers.dev`) is documented but no
  longer contacted by default.

## 3. playwright-core (transitive dependency)

| Field | Value |
|---|---|
| Upstream repo | https://github.com/microsoft/playwright |
| Version | as resolved by the camoufox-js peer dependency |
| License | **Apache 2.0** |
| Vendoring | **Not vendored.** Pulled fresh from npm at install time. |

playwright-core is a Microsoft-maintained package on a stable release
cadence. Per the vendoring spec (Phase 0 audit, item 4), it is treated as
a normal npm dependency rather than re-hosted — we don't vendor Microsoft.

## 4. phi-code itself

| Field | Value |
|---|---|
| Package | `@phi-code-admin/phi-code` |
| License | **MIT** (see root `LICENSE`) |

---

## Compliance summary

- **MPL-2.0** (Camoufox, camoufox-js, Firefox upstream): each modified
  Source Code file retains its original license header and a
  `PHI-VENDOR:` marker describing the change. Per MPL §3.3, no MPL file
  has been silently relicensed; the modified files are still MPL.
- **MIT** (camofox-browser): full LICENSE text preserved, author of the
  original code (`Jo Inc <oss@askjo.ai>`) is listed in `contributors` of
  the vendored package.json.
- **No re-licensing**, **no removal of attribution**, **no silent
  modification of MPL-2.0 source files**.

If you spot a license issue in this vendoring, please open an issue at
<https://github.com/uglyswap/phi-code/issues>.
