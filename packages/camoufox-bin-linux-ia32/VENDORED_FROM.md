# Vendored binary: Camoufox 135.0.1-beta.24

| Field | Value |
|---|---|
| Upstream repo | https://github.com/daijro/camoufox |
| Upstream release | v135.0.1-beta.24 |
| Upstream asset | `camoufox-135.0.1-beta.24-lin.i686.zip` |
| Vendored date | 2026-05-16 |
| License | MPL-2.0 |
| Local version | 1.0.0 |
| Layout | Extracted tree under `camoufox-bin/`, no recompilation |

The Camoufox binary is unmodified. We only repackaged the upstream asset
as an npm tarball so it can be resolved offline through
`optionalDependencies` without a postinstall network roundtrip.

To re-sync from upstream, run:

```bash
gh release download v135.0.1-beta.24 -R daijro/camoufox \
    --pattern 'camoufox-135.0.1-beta.24-lin.i686.zip' \
    --output .binaries-cache/camoufox-135.0.1-beta.24-lin.i686.zip
node scripts/build-camoufox-bin-packages.mjs linux-ia32
```
