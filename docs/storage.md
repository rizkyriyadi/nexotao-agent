# Storage

Nexotao Agents stores all of its state locally. This document describes where data lives, the
database, backups, file permissions, and portability.

## Location

All state lives under a single data directory:

- **Default:** `~/.nexotao`
- **Override:** set `NEXOTAO_DATA_DIR` to an absolute path.

The directory is created with mode `0700` (owner-only) and re-chmodded on write.

| Path | Contents |
| --- | --- |
| `config.json` | Local configuration: API key, selected model, onboarding state, active project, optional search key, retention settings. Mode `0600`. |
| `nexotao.sqlite` | The application database (SQLite). Mode `0600`. |
| `backups/json-v1-<timestamp>/` | One-time backup of legacy JSON files taken during migration to SQLite (only present if you upgraded from a JSON-storage version). Mode `0700`, files `0600`. |

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
- **Agents** — `agents`, `agent_config_revisions`.
- **Issues & work** — `issues`, `issue_dependencies`, `issue_comments`, `issue_documents`,
  `documents`, `document_revisions`, `issue_mutation_requests`.
- **Git workspaces** — `git_workspaces` and workspace columns on issues/runs, for isolated branches.
- **Governance & cost** — `approvals`, `cost_events`, `activity_log` (append-only audit), and
  `legacy_json_migrations`.

Migrations are additive and each runs inside a transaction; a failed migration rolls back and aborts
startup rather than leaving a partial schema.

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
