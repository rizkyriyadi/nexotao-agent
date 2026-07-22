# Permissions & Approvals

Nexotao Agents runs tools on your machine on your behalf. This document describes the permission and
approval model that controls those tools, the budget controls that bound spend, and the
network/filesystem access the application requires.

## Execution policy

Each run operates under an execution policy with three values:

| Policy | Effect |
| --- | --- |
| `ask` (default) | Read-only and control actions run automatically; write, edit, shell, and network actions require your approval. |
| `allow` | All actions run without asking. |
| `deny` | Actions requiring approval are refused. |

Actions are classified by the tool being called:

| Action class | Tools | Default under `ask` |
| --- | --- | --- |
| `read` | `list_dir`, `read_file`, `grep` | Auto-allowed |
| `control` | `spawn_agents`, `delegate` | Auto-allowed |
| `write` | `write_file`, `edit_file` | Requires approval |
| `exec` | `bash` | Requires approval |
| `network` | `web_search`, `web_fetch` | Requires approval |
| `destructive` | `bash` commands matching a destructive pattern | Requires approval, flagged high-risk |

Destructive commands (for example `rm -rf`, `git reset --hard`, `git clean -f`, `shutdown`, `reboot`,
`mkfs`, `fdisk`, `dd if=…`, `kill -9`) are detected and marked high-risk in the approval request.

## The approval lifecycle

When a run needs approval:

1. A pending approval is recorded with the action class, target, risk level, and a **redacted
   preview** of the command or change.
2. The run pauses and the UI surfaces the request.
3. You approve or deny. The decision, including an optional note, is written to the append-only audit
   log, and the run resumes or the tool is skipped.
4. Approvals expire after 24 hours, or when the run is no longer waiting (finished or cancelled). An
   expired approval is recorded as such and does not execute.

Approvals are persisted, so a request survives a page refresh and can be resolved when you return.
Each `(run, tool call)` pair maps to at most one approval, so retries do not re-ask or
double-execute.

## Filesystem access

- The agent's file tools are confined to the **project root** you open. Any path that resolves
  outside the project directory is rejected.
- `bash` commands run with the project root as the working directory and a per-command timeout.
- Common noise directories (`node_modules`, `.git`, `.next`, `dist`, `build`, `.cache`) are skipped
  by directory listing and search tools.
- Application state is written only under the data directory (`~/.nexotao` or `NEXOTAO_DATA_DIR`),
  owner-only. See [storage.md](storage.md).

## Network access

Outbound network access is limited to:

- **The Nexotao Gateway** (`https://api.nexotao.com`) for model requests and the model catalog.
- **Web tools** you or a run invoke: `web_fetch` (arbitrary URL requested) and `web_search`
  (DuckDuckGo by default, or Tavily with an optional key). These require approval under `ask`.
- **The npm registry** for update checks.

There is no inbound network access beyond the loopback server; see [security.md](security.md).

## Budget controls

Runs are metered against a cost ledger so spend is bounded:

- Each model turn's cost is computed from input/output token counts and per-model pricing, and
  recorded as a cost event.
- An agent can carry a budget limit. As spend crosses **50%, 80%, and 90%** of the limit, a one-shot
  warning is emitted (each threshold fires exactly once). Reaching the limit marks the budget
  **exhausted** and triggers a hard stop.
- A `null` or non-positive limit means "no budget configured" and never blocks.

Budget threshold markers in the audit log are integrity-required: they are retained regardless of any
retention window so a crossed threshold cannot silently re-fire.
