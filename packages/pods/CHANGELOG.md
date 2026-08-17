# Changelog

## [Unreleased]

### Changed

- Renamed to `@phi-code-admin/pods`; the binary is `phi-pods` (it was `pi-pods`,
  which collided with the upstream pi tooling). The published package was
  previously named `@mariozechner/pi`, a scope this fork does not own.
- Help text and error messages point at `phi-pods`, not `pi pods` — the binary
  they named was never the one installed.

### Fixed

- `prompt` no longer reports `Agent error: Not implemented`. It was building an
  agent command line with `--base-url` / `--api`, flags the agent CLI stopped
  accepting (an endpoint is a provider entry in models.json now), then throwing
  and printing the failure as if the remote model had errored. It now says what
  is missing and prints the exact provider entry and command to use instead.

  Wiring the command back to the agent is a separate piece of work.
