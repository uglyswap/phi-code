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

- `PHI_API_KEY` works for every command. `pods setup` and `start` only read
  `PI_API_KEY`, so a `PHI_API_KEY`-only setup failed and `start` exported the
  literal string `undefined` as the vLLM key. `start` now refuses to run without
  a key, and leaves `HF_TOKEN` out (with a warning) instead of exporting
  `undefined`.
- Values exported for the model process (`HF_TOKEN`, the API key, per-model
  env) are shell-quoted, so a quote in a token cannot break the remote command.
- `pods setup` no longer writes `HF_TOKEN` / the API key in clear into the pod's
  `~/.bashrc`; `start` passes them to the model process only. Interactive shells
  on the pod no longer have them exported.
- The `vllm>=0.10.0` constraint in `pod_setup.sh` is quoted: unquoted, `>` was a
  redirection and the minimum version was silently dropped.
- The pod host is extracted correctly when the SSH command has options before
  the destination (`ssh -p 22 root@h`, `ssh -i key root@h`), and `scpFile` keeps
  the identity file and `-o` options instead of only the port.
- The API key is no longer printed after `start`; the output refers to
  `$PHI_API_KEY` instead.
- Remaining `pi ...` hints in `start`/`list`/`logs` output now name `phi-pods`.
