# Nexotao Agents — Documentation

Operator and end-user documentation for **Nexotao Agents** (npm package `nexotao`, version 0.2.0),
a local, single-user coding-agent orchestrator with a Next.js web UI, powered by your Nexotao API
key (the "Nexotao Gateway").

Nexotao runs entirely on your own machine: it binds to `127.0.0.1`, stores its data under
`~/.nexotao`, and makes outbound network calls only when you initiate work that requires them.

## Contents

| Document | Description |
| --- | --- |
| [privacy.md](privacy.md) | What data is collected and stored, the local-first model, what is sent to the Gateway, retention, and how to delete your data. |
| [security.md](security.md) | Threat model for a local single-user app: localhost binding, session-token auth, file permissions, secret redaction, and the execution/approval model. |
| [gateway-data-flow.md](gateway-data-flow.md) | Step-by-step data flow (with diagram) from browser to local server to the Nexotao Gateway and back, including what is sent, redacted, and stored. |
| [permissions.md](permissions.md) | The permission and approval model — execution approvals, budgets, tool permissions — and the network/filesystem access the app requires. |
| [storage.md](storage.md) | Where data lives (`~/.nexotao` / `NEXOTAO_DATA_DIR`), the SQLite schema areas, backups, file permissions, and portability. |
| [platforms.md](platforms.md) | Supported-platform matrix: operating systems, Node.js versions, tested combinations, and known constraints. |
| [update-rollback.md](update-rollback.md) | How to update and roll back, forward database migration, and restoring from a backup. |
| [vulnerability-reporting.md](vulnerability-reporting.md) | How to report a security vulnerability, expected response, and scope. |
| [staged-rollout.md](staged-rollout.md) | The staged-rollout and rollback decision for the public beta: phases, success/abort criteria, and the go/rollback recommendation. |
| [accessibility.md](accessibility.md) | The accessibility threshold for beta (WCAG 2.1 AA target), the automated checks that gate the build, and how to run the audit. |
| [telemetry.md](telemetry.md) | The opt-in, redacted crash/performance telemetry policy: off by default, what is collected when enabled, and how to opt in or out. |

## Quick reference

- **Install:** `npm install -g nexotao`
- **Run:** `nexotao` (opens `http://localhost:4319`)
- **Data directory:** `~/.nexotao` (override with `NEXOTAO_DATA_DIR`)
- **Database:** `~/.nexotao/nexotao.sqlite`
- **Bind address:** `127.0.0.1` only
