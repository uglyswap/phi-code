# Skill System

The `skill-system` extension turns phi's skill directory into a managed,
self-improving library: an agent-facing authoring tool (`skill_manage`), a
`/learn` distiller, a throttled background review, a curator with reversible
archiving, an approval gate, content-addressed backups and a security scan.

Everything lives in the bundled extension
`packages/coding-agent/extensions/phi/skill-system/` and writes only under the
global skills root (`~/.phi/agent/skills/`), never into other extensions.

## What it manages

| Piece | Where | Notes |
|---|---|---|
| Skills | `~/.phi/agent/skills/<category>/<name>/SKILL.md` | Scanned by both the core loader and sigma-skills |
| State | `~/.phi/agent/skills/.state/` | Ledger, usage, pending, blobs, backups, scans — dot-prefixed, invisible to both loaders |
| Archive | `~/.phi/agent/skills/.archive/<name>/` | Reversible: nothing is ever deleted permanently |
| Locks | `~/.phi/agent/skills/.locks/` | Per-skill file locks (sorted acquisition, stale reclaim) |

## Commands

`/skill-system` is the only administrative surface (`/skills` belongs to the
bundled skill-loader; a second registration would only create `/skills:2`).

| Command | Effect |
|---|---|
| `/skill-system` (or `list`) | Skills on disk, pending count, pinned count |
| `/skill-system status` | Curator state, last run summary, LRU |
| `/skill-system run [--dry-run] [--consolidate]` | Manual curator pass (`--dry-run` mutates nothing) |
| `/skill-system pin <name>` / `unpin <name>` | Pinning (pinned skills are never archived) |
| `/skill-system archive <name>` / `restore <name>` | Manual reversible archive |
| `/skill-system prune [--days N]` | Bulk-archive curator-managed skills older than N days |
| `/skill-system ledger [--skill <name>] [--limit N]` | Audit ledger entries |
| `/skill-system rollback <entry-id>` | Undo one isolated mutation |
| `/skill-system backup [--list] [--reason <text>]` | Snapshots (hand-written tar.gz) |
| `/skill-system pending` / `diff <id>` / `approve <id\|all>` / `reject <id\|all>` | Approval gate |
| `/skill-system doctor [--extensions] [--fix-descriptions]` | Integrity checks + suggestions |

`/learn <source>` distills a reusable skill from a folder, URL, conversation or
pasted notes: it builds a standards-laden prompt (source hygiene, authoring
standards, knowledge-base layout) and triggers one turn that saves via
`skill_manage`.

The bundled `learn` tool (singular lesson capture) is **observed**, not
overridden: when it writes a skill, the extension lints the result and appends
the deviations to the tool output in the same turn.

## `skill_manage`

One tool, atomic batches: `{ operations: [...] }` (1–20 ops). Any failure rolls
the whole batch back; nothing is half-applied.

| Op | Notes |
|---|---|
| `create` | Full `SKILL.md` with frontmatter; must precede the skill's other ops |
| `patch` | Targeted `old_string`/`new_string` (preferred) or `content` for a full rewrite |
| `write_file` / `remove_file` | Support files under `references/`, `templates/`, `scripts/`, `assets/` |
| `delete` | Single op of its batch; ARCHIVES the skill (never permanent) |

Guarantees:

- **Clobber guard** — a destructive op on a file already touched by the same
  batch is refused; chained targeted patches stay allowed.
- **Snapshots** — every touched skill is snapshotted before the batch; rollback
  restores it. If restoration itself fails, the half-applied state is put back
  and the snapshot directory is kept for manual recovery.
- **Read-before-write** (background review only) — patching an existing file
  requires reading it first in that review; the refusal names the file.
- **Blocking lint** — `prompt-injection` and `unicode-smuggling` refuse the
  write (disable with `lint.blockOnInjection: false`).

## Configuration

`~/.phi/agent/settings.json`:

```json
{
  "skillSystem": {
    "enabled": true,
    "createDir": null,
    "writeApproval": false,
    "security": { "scanOnWrite": false, "quarantineProjectSkills": true },
    "lint": { "enabled": true, "blockOnInjection": true },
    "learn": {},
    "review": {
      "enabled": true,
      "nudgeInterval": 10,
      "minIntervalSeconds": 300,
      "maxIterations": 12,
      "timeoutSeconds": 180,
      "maxDigestChars": 120000,
      "dailyBudgetUSD": 0.5,
      "model": null,
      "notify": "on"
    },
    "curator": {
      "enabled": true,
      "intervalHours": 168,
      "minIdleHours": 2,
      "staleAfterDays": 14,
      "archiveAfterDays": 30,
      "consolidate": false,
      "pruneBundled": false,
      "maxArchivePerRun": 10,
      "backup": { "enabled": true, "keep": 2 }
    },
    "ledger": { "enabled": true, "maxBytes": 5242880, "blobGraceSeconds": 3600 }
  }
}
```

`writeApproval: true` stages every skill write as ONE pending record per batch;
nothing is applied until `/skill-system approve`. Staging is best-effort: on a
disk failure the record is still reported but nothing is committed.

## Environment variables

| Variable | Effect |
|---|---|
| `PHI_SKILL_SYSTEM_DISABLE=1` | Do not load the extension at all |
| `PHI_SKILL_SYSTEM_REVIEW=1` | Mark the process as a review fork (disables review scheduling inside it) |
| `PHI_SKILL_SYSTEM_ALLOW_WRITE=1` | Bypass a `prompt` permission gate for skill writes |
| `PHI_SKILL_SYSTEM_DEBUG=1` | Verbose logs on stderr |

Legacy `PI_SKILL_SYSTEM_*` names are accepted as a fallback.

## Safety model

- **Never deletes permanently.** `delete` archives to `.archive/`; restore is
  one command. The curator only archives, with a per-run cap.
- **Autonomous deletes are gated.** In review/curator context, a delete is
  refused when the skill is pinned, essential (`self-improving`), in an external
  directory, a protected built-in, hub-installed, bundled, or not
  curator-managed — and fails CLOSED when the provenance registry is unreadable.
- **Provenance is opt-in, not authorship.** `created_by: "agent"` means "the
  review wrote this and the curator may manage it"; foreground creations are
  `"learn"` and are never curated.
- **Untrusted project skills** (`.phi/skills/` in a cloned repo) are scanned for
  prompt injection at session start; a blocked skill is quarantined and refused
  by name.
- **Backups** are hand-written tar.gz snapshots (no external tools) that exclude
  `.state/`, `.archive/` and `.locks/`; a restore takes a `pre-rollback`
  snapshot first, so it is itself reversible.
- **Review budget** — one fork at a time (memory + lock file), never recursive,
  capped by `dailyBudgetUSD` and `timeoutSeconds`, cancelled on shutdown.

## Troubleshooting

- `/skill-system doctor` — unparsable frontmatter, name/directory mismatch,
  dangling `references/`, orphan locks, ledger entries pointing at missing
  skills, oversized descriptions (`--fix-descriptions` suggests rewrites).
- `/skill-system doctor --extensions` — duplicate load paths (a bundled
  extension also present in `~/.phi/agent/extensions/`).
- Review does not run? Check `review.enabled`, `nudgeInterval` tool calls,
  `minIntervalSeconds`, the daily budget and `/skill-system status`.
- A skill is missing? `/skill-system list`, then check `.archive/` via
  `/skill-system restore <name>`.
