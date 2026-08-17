# Changelog

## [Unreleased]

### Changed

- Renamed to `@phi-code-admin/pods`; the binary is `phi-pods` (it was `pi-pods`,
  which collided with the upstream pi tooling). The published package was
  previously named `@mariozechner/pi`, a scope this fork does not own.
- Help text and error messages point at `phi-pods`, not `pi pods` — the binary
  they named was never the one installed.

### Fixed

- `agent` talks to the coding agent again. It was building a command line with
  `--base-url` / `--api`, flags the agent CLI stopped accepting (an endpoint is
  a provider entry in models.json now), then throwing and printing the failure
  as if the remote model had errored.

  The command now declares the pod under a `pod-<name>` provider and launches
  the agent against it. The endpoint is written per model, so a pod serving
  several models — each vLLM instance on its own port — keeps them apart; a
  provider-level endpoint would have sent every model to whichever port was
  started last. Re-running with an unchanged endpoint does not touch the file.

- No credential is written to disk. The key reaches the agent through
  `--api-key`, a runtime overlay it keeps in memory, so a key passed to a pod
  never lands in models.json next to the other providers' keys.

- The agent starts on Windows. Node refuses to spawn the `.cmd` shim npm
  installs (EINVAL, from the CVE-2024-27980 fix) and a shell cannot carry the
  multi-line system prompt, so the shim's target script is resolved and run
  under the current node binary instead.

- An unexpected failure in `agent` exits non-zero. The handler reported success,
  which hid the failure from scripts and CI.
