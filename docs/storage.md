# Storage

Nexotao Agents stores all of its state locally. This document describes where data lives, the
database, backups, file permissions, and portability.

## Location

Almost all state lives under a single data directory:

- **Default:** `~/.nexotao`
- **Override:** set `NEXOTAO_DATA_DIR` to an absolute path.

The directory is created with mode `0700` (owner-only) and re-chmodded on write.

| Path | Contents |
| --- | --- |
| `config.json` | Local configuration: API key, selected model, onboarding state, active project, optional search key, retention settings. Mode `0600`. |
| `nexotao.sqlite` | The application database (SQLite). Mode `0600`. |
| `graph/<projectId>/work.json` | The project's work-history graph — tasks, runs, agents and the links between them. Rebuilt on demand and removed when the project is deleted. |
| `tmp/index-<runId>-<pid>` | A throwaway git index, held only for the length of one plumbing command. It exists so that recording a snapshot never writes your real `.git/index` and never disturbs what you have staged. Removed immediately; a leftover is inert. |
| `worktrees/<repoHash>/<run>/` | **Legacy.** Throwaway git worktrees, one per run, from before 0.18 — nothing writes here any more. Present only if you ran an older version, and released by `nexotao uninstall`. |
| `tools/` | The optional code-index CLI, if you installed it from the graph page. Nothing else is ever installed here. |
| `backups/json-v1-<timestamp>/` | One-time backup of legacy JSON files taken during migration to SQLite (only present if you upgraded from a JSON-storage version). Mode `0700`, files `0600`. |

### One thing stored inside your own repository

Runs edit your project folder directly, so the undo has to be taken before the run starts. It is
stored where the files are, not under the data directory:

| Path | Contents |
| --- | --- |
| `<project>/.git/refs/nexotao/snapshots/<runId>` | A dangling commit recording the folder exactly as it stood before that run — committed, staged, modified and untracked alike. One per run. |

Written with git plumbing (`add -A` against the throwaway index above, `write-tree`, `commit-tree`,
`update-ref`), so nothing you can see moves: not your working tree, not your index, not `HEAD`, not
any branch. `git status`, `git branch` and `git log` are unchanged by it. It is visible in
`git for-each-ref refs/nexotao/` and is copied by `git push --mirror` — see
[privacy.md](privacy.md#what-is-stored-and-where).

`add -A` honours `.gitignore`, so ignored paths are neither recorded nor restorable. That is the
right trade — nobody wants `node_modules` in a snapshot tree — but it is a real limit, and the
Changes panel states it.

Collected by the app itself: a ref whose task is still waiting for your review is held, so Revert
stays available for as long as the decision is open; the rest are dropped once they are older than
14 days.

### One directory outside the data directory

The optional code index writes its SQLite databases to the CLI's own cache, **not** to your data
directory:

| Path | Contents |
| --- | --- |
| `~/.cache/codebase-memory-mcp/nexotao-idx-<projectId>.db` | A symbol-level index of the project's source: function and class names, their file and line ranges, and the call graph between them. Roughly 2–11 MB per repository. |

This location is fixed by the CLI and honours neither `NEXOTAO_DATA_DIR` nor the `0700` regime above,
so it is worth knowing three things about it:

- **It is not covered by the backup steps below.** Copying `~/.nexotao` does not copy it. That is
  usually fine — the index is derived data and rebuilds from your source in about a second.
- **The cache is shared.** Indexes you built yourself by running the CLI live in the same directory.
  Nexotao only ever creates and deletes files carrying its own `nexotao-idx-` prefix; yours are never
  touched.
- **It is removed when the project is deleted**, along with `graph/<projectId>/`.

If you never install the code index, this directory does not exist.

### Deleting a project

Deleting a project from Settings → Data removes its database rows, its `graph/<projectId>/`
directory, its `nexotao-idx-` code index, and the `refs/nexotao/` refs in its folder. It leaves the
append-only activity log (the durable audit trail), and it leaves the files themselves — everything
a run wrote into your folder is yours and stays exactly where it is. Legacy worktrees under
`worktrees/` are keyed by repository rather than by project and are left in place; `nexotao
uninstall` releases them, or `git worktree prune` does.

### Removing everything

`nexotao uninstall` is the complete removal. It prints what it will do, requires you to type
`UNINSTALL`, and then:

| step | what it touches |
|---|---|
| release legacy worktrees | `git worktree remove --force` + `prune` in each owning repository, then `git branch -D` for `nexotao/*` branches only. Nothing to do unless you ran a version before 0.18. |
| release the undo refs | `git update-ref -d` for every ref under `refs/nexotao/`, in each repository it can find — from the worktree scan above and from the `projects` table. Only that namespace; nothing under `refs/heads/`, no commits, no working tree. |
| delete the data directory | `~/.nexotao` (or `NEXOTAO_DATA_DIR`), plus `~/.nexotao/tools` when the data directory was moved elsewhere |
| sweep the code index | only `nexotao-idx-*` files in `~/.cache/codebase-memory-mcp/` — never the directory, never a file without that prefix |
| uninstall the package | `npm uninstall -g nexotao`. A root-owned global prefix makes this fail; the command prints the `sudo` line to finish it rather than escalating on its own. |

**The order matters and is the reason this is a command rather than a documented procedure.** What
Nexotao leaves inside your repositories is not in the data directory, and the database is the only
record of which repositories those are. Deleting it first strands the undo refs for good — and, on
an install that predates 0.18, pulls worktree directories out from under Git and leaves every
repository you have run against with a stranded registry and dangling branches.

Reading the `projects` table for that last step needs `node:sqlite`, which arrived in Node 22.5. On
an older Node the uninstall proceeds without it: everything else is removed, and the undo refs are
still cleaned from any repository the worktree scan found. Refs in a repository known only to the
database survive; the manual command in [privacy.md](privacy.md#deleting-your-data) clears them.

It stops before deleting anything if a legacy worktree still holds uncommitted work, naming the files.
`--force` proceeds anyway, `--dry-run` prints the plan and exits, `--keep-package` leaves the npm
package installed, and it refuses to run while the app is still serving on its port.

## Database

The database is a single SQLite file (`nexotao.sqlite`) accessed through a Drizzle repository
boundary. The packaged driver is the SQL.js embedded JavaScript build, which runs on every supported
platform without native compilation.

Because this driver does not expose durable WAL mode, writes are serialized and the database is
persisted by exporting it and replacing the file **atomically** via a temporary file that is renamed
into place. The temporary file is created with mode `0600`. The repository contract is
driver-independent, leaving room for a native driver later without changing callers.

### Schema areas

Schema is versioned in a `schema_migrations` table and applied forward on startup. The current schema
covers these areas:

- **Projects & sessions** — `projects`, `sessions` (chat history), `tasks`.
- **Runs & events** — `run_records`, `agent_runs`, `heartbeat_runs`, `run_events` (redacted per-run
  event history), `wakeup_requests`.
- **Agents** — `agents`.
- **Issues & board** — `issues`, `issue_dependencies`, `issue_comments`, `issue_documents`,
  `documents`, `document_revisions`, `issue_mutation_requests`, `workflow_states` (board columns).
- **Git workspaces** — `git_workspaces` and workspace columns on issues/runs, for isolated branches.
- **Governance & cost** — `approvals`, `cost_events`, `activity_log` (append-only audit), and
  `legacy_json_migrations`.

Each migration runs inside its own transaction; a failed one rolls back and aborts startup rather
than leaving a partial schema. Migrations are usually additive, but a retired feature is removed
rather than left behind — version 11 drops the multi-agent and work-management tables and columns,
and the data in them is not recoverable afterwards.

### Redacted-at-rest

Run events and audit records are passed through the redactor before being written, so secrets and
secret-shaped fields are stored as `[REDACTED]`. See [security.md](security.md#secret-redaction).

## Backups

The only backup the application creates automatically is the legacy-JSON migration backup described
above. To back up your data yourself:

1. Stop the app.
2. Copy the data directory (`~/.nexotao` or your `NEXOTAO_DATA_DIR`) to a safe location. Because the
   database is a single file replaced atomically, a copy taken while the app is stopped is
   consistent.

To restore, stop the app and copy the directory back.

## Portability

The database and configuration are plain files under one directory and are not tied to the installed
package location — updating or reinstalling `nexotao` never touches them. To move Nexotao to another
machine, copy the data directory (or the `nexotao.sqlite` and `config.json` files) to the same path,
or point `NEXOTAO_DATA_DIR` at it. The SQL.js format is portable across the supported operating
systems and Node versions listed in [platforms.md](platforms.md).

You can also take a redacted, portable JSON copy of a single project via `GET /api/data`; see
[privacy.md](privacy.md#exporting-your-data).
