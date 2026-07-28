# Privacy

Nexotao Agents is **local-first**. It runs as a single-user application on your own machine, stores
its data on your own disk, and does not use accounts, sign-in, or a hosted backend. No data leaves
your machine except the network calls you initiate — described below.

## What is stored, and where

All application data lives under a single directory on your machine:

- Default: `~/.nexotao`
- Override: set the `NEXOTAO_DATA_DIR` environment variable to an absolute path.

Contents:

| File / directory | Purpose |
| --- | --- |
| `config.json` | Local configuration: your Nexotao API key, selected model, onboarding state, active project, an optional web-search key, and retention settings. Written with file mode `0600`. |
| `nexotao.sqlite` | The application database: projects, sessions, tasks, runs, agents, issues, approvals, cost events, and the redacted activity log. Written with file mode `0600`. |
| `graph/<projectId>/` | The project's work-history graph: tasks, runs, agents, and the links between them. |
| `worktrees/` | Throwaway git checkouts, one per run, so a run never edits your working tree directly. |
| `tools/` | The optional code-index CLI, if you chose to install it. |
| `backups/json-v1-<timestamp>/` | A one-time backup of legacy JSON files created during migration to SQLite (if applicable). |

The data directory is created with mode `0700` (owner-only). See [storage.md](storage.md) for schema
detail and portability.

**One exception.** If you install the optional code index, it stores a symbol-level map of your
source — function and class names, file and line ranges, and the call graph between them — in
`~/.cache/codebase-memory-mcp/`, which is outside the data directory and outside the `0700` regime
above. It stays on your machine and is never uploaded; it is used only to answer the agent's own
`graph_query` calls locally. It is removed when you delete the project, and the directory does not
exist at all if you never install the index. See
[storage.md](storage.md#one-directory-outside-the-data-directory).

## What leaves your machine

Nexotao makes outbound network requests only for operations you initiate:

1. **Model requests to the Nexotao Gateway** (`https://api.nexotao.com`). When you send a message or
   run a task, your conversation, the selected model, and the tool definitions are sent to the
   Gateway so it can produce a response. Your Nexotao API key is sent as an authentication header on
   these requests. This is the only outbound path that carries the content of your work.
2. **Web tools you invoke** (`web_search`, `web_fetch`). These run from your machine, using your IP.
   `web_fetch` retrieves a URL you or a run requests; `web_search` queries DuckDuckGo by default, or
   Tavily if you configure an optional search key.
3. **Update check.** The app periodically asks the public npm registry
   (`https://registry.npmjs.org/nexotao/latest`) whether a newer version exists. This request
   contains no account or usage data.
4. **Model catalog.** The onboarding flow fetches the list of models available to your account from
   the Gateway (`/models`).

Nexotao does **not** send analytics, usage statistics, conversation content, code, or file contents
to any third party by default. Optional crash/performance telemetry is **off by default** and, when
enabled, is redacted; see [telemetry.md](telemetry.md).

## What is sent to the Gateway

The Gateway receives what it needs to answer a request: your messages, the model you selected, tool
definitions, and any tool results that a run produces (for example the text of a file the agent
chose to read as part of your task). Because a coding agent reads and edits files in the project
folder you open, file contents relevant to your task may be included in these requests. Everything
sent to the Gateway is governed by your Nexotao account and the Gateway's own terms.

The API key itself is never echoed back into stored records or run events: persisted run events,
exports, and audit summaries are passed through the redactor (see
[security.md](security.md#secret-redaction)).

## Retention

Nexotao keeps your data until you delete it. Two categories of redacted records support an optional
retention window, configured in Settings and applied deterministically:

- **Run events** (`runEventDays`) — redacted per-run event history.
- **Audit / activity log** (`auditDays`) — the append-only activity feed.

A value of `null`, `0`, or absent means "keep forever" (the default). Budget threshold markers in the
activity log are retained regardless of age because other integrity checks depend on them.

## Deleting your data

You have two levels of deletion:

1. **Per-project deletion.** From the app, or via `POST /api/data` with `{ "action": "delete",
   "confirm": true }`, you can delete a project and its associated records. Deletion requires
   explicit confirmation and returns a report of exactly what was removed and what was retained. The
   append-only audit activity is intentionally retained as the durable record of what happened; all
   other project records — including redacted run events and document history — are removed. The
   project's graph directory and its code index are removed with it. Git worktrees are keyed by
   repository rather than by project, so they are left in place and the report says so.
2. **Full removal.** Stop the app and run `nexotao uninstall`. It shows exactly what it will
   remove, asks you to type `UNINSTALL`, and stops without deleting anything if a worktree still
   holds uncommitted work (`--force` overrides, `--dry-run` shows the plan and stops). It then
   releases every managed worktree back to the repository that owns it, deletes the data directory
   (`~/.nexotao` or your `NEXOTAO_DATA_DIR`) including the database, configuration, your API key,
   work graphs and backups, removes only the `nexotao-idx-*` files from
   `~/.cache/codebase-memory-mcp/`, and uninstalls the npm package. Your own code, commits and
   branches are not touched, and neither are code indexes in that cache that Nexotao did not create.

   Removing the data directory by hand is not equivalent. Nexotao registers Git worktrees inside
   your own repositories, and deleting those directories without releasing them first leaves each
   affected repository with a stranded worktree registry and dangling `nexotao/*` branches. If you
   do remove things manually, run `git worktree remove --force <path>`, `git worktree prune` and
   `git branch -D nexotao/…` in each repository first, and delete only the `nexotao-idx-*` files
   from the shared cache — anything else there belongs to your own tooling.

## Exporting your data

You can export a redacted copy of a project's data as JSON via `GET /api/data` (optionally
`?projectId=`). The bundle is passed through the redactor before it is returned, so no API key,
bearer token, or secret-shaped field is included.
