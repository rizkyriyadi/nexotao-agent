# Nexotao Agents

A **local, single-user coding agent with a web UI** — like a browser-based coding assistant that runs entirely on your own machine and works on your own files. Powered by your [Nexotao](https://nexotao.com) API key.

No servers, no accounts, no cloud. Everything — including the local database — is bundled. Install it, run one command, and a workspace opens in your browser.

## Install

```bash
npm install -g nexotao
```

## Run

```bash
nexotao
```

That's it. The UI opens at `http://localhost:4319`. On first launch you'll be walked through a short onboarding:

1. **Connect** your Nexotao API key
2. **Pick a Claude model** (fetched live from your Nexotao account)
3. **Open a real folder** on your machine (or start fresh)
4. **Choose single- or multi-agent** — for multi-agent, an AI proposes a specialist team based on your project

## What you get

- **Chat** — a coding agent that reads, edits, and runs files in your project (with approval prompts for anything that changes files).
- **Runs** — a lead agent that splits a big task into specialist sub-agents running in parallel. Every run is durable: navigate away, refresh, or close the tab and come back — it keeps going and you can reopen its live progress any time.
- **Agents** — your specialist team on its own page; click any agent to see every task it has worked on.
- **Board** — a lightweight task board; run any task with an agent in one click.

## Where's my data?

Everything is stored locally in `~/.nexotao/nexotao.sqlite`. Nothing leaves your machine except the model calls to the Nexotao API.

The database uses SQLite through a Drizzle repository boundary. The packaged driver is the SQL.js embedded JavaScript build, which works on every supported Node platform without native compilation. Because this driver does not expose durable WAL mode, commits are serialized and the exported database is replaced atomically. The repository contract stays driver-independent so a native WAL driver can replace it after Linux, macOS, and Windows packaging smoke tests pass.

### Upgrading from JSON storage

On first boot, Nexotao detects the former JSON files, copies them to `~/.nexotao/backups/json-v1-<timestamp>/`, then imports them in one transaction. The migration records its completion in the database, so subsequent boots do not duplicate records. Identifiers, relationships, dependencies, sessions, tasks, and run history are preserved.

### Rolling back the JSON migration

1. Stop Nexotao.
2. Move `~/.nexotao/nexotao.sqlite` to a safe location; do not delete it until the rollback is verified.
3. Copy the JSON files from `~/.nexotao/backups/json-v1-<timestamp>/` back into `~/.nexotao/`.
4. Start the previous Nexotao version.

The backup represents state immediately before migration. Changes made after the SQLite upgrade remain in the moved database and are not visible to a JSON-only version.

## Requirements

- Node.js **18.18+**
- A Nexotao API key

## Documentation

Full operator and end-user documentation lives in [`docs/`](docs/README.md):

- [Privacy](docs/privacy.md) — what is collected/stored, what leaves your machine, retention, deletion.
- [Security](docs/security.md) — threat model, localhost binding, session auth, permissions, redaction.
- [Gateway data flow](docs/gateway-data-flow.md) — how a request travels to the Gateway and back.
- [Permissions & approvals](docs/permissions.md) — execution approvals, budgets, tool access.
- [Storage](docs/storage.md) — data directory, SQLite schema areas, backups, portability.
- [Platforms](docs/platforms.md) — supported OS and Node versions.
- [Updating & rollback](docs/update-rollback.md) — updating, rolling back, restoring from backup.
- [Reporting a vulnerability](docs/vulnerability-reporting.md) — how to report a security issue.
- [Staged rollout](docs/staged-rollout.md) — the public-beta rollout and rollback decision.
- [Accessibility](docs/accessibility.md) — the beta accessibility threshold and audit.
- [Telemetry](docs/telemetry.md) — opt-in, redacted, off by default.

See also [`SECURITY.md`](SECURITY.md).

## License

MIT
