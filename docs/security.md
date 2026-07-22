# Security

Nexotao Agents is a local, single-user application that has permission to read, write, and execute
commands inside the project folders you open. This document describes the threat model and the
controls that constrain that power. To report a vulnerability, see
[vulnerability-reporting.md](vulnerability-reporting.md).

## Threat model

Nexotao is designed for one operator on one machine. Its security goals are:

- **Only you can reach the local server.** The server binds to loopback and requires a per-launch
  session token, so other users, other devices on your network, and web pages you visit cannot drive
  the app.
- **Secrets stay on disk with restrictive permissions** and never leak into stored records, exports,
  or logs.
- **File and command changes are gated** by an approval model so a run cannot silently modify your
  system.

Out of scope: a multi-tenant or shared-host deployment, protecting against an attacker who already
has your OS user account (they can read `~/.nexotao` directly), and the security of the remote
Gateway itself.

## Network exposure

- **Loopback binding.** The CLI starts the server bound to `127.0.0.1` on port `4319` (override with
  `PORT`). It does not listen on any external interface.
- **Host validation.** Every request must carry a `Host` header matching the expected host
  (`NEXOTAO_ALLOWED_HOST`, e.g. `127.0.0.1:4319`); mismatches are rejected with `403`.
- **Origin validation.** State-changing requests (non-GET/HEAD/OPTIONS) must present an `Origin`
  matching the local host, defending against cross-site request forgery from a browser tab.
- **Request-size limits.** State-changing requests must declare a `Content-Length`; requests without
  one are rejected (`411`) and requests over the limit (`NEXOTAO_MAX_REQUEST_BYTES`, default 8 MiB)
  are rejected (`413`).
- **Security headers.** Responses set `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and `Cache-Control: no-store`.

## Session-token authentication

- On each launch the CLI generates a random 256-bit session token (or uses
  `NEXOTAO_SESSION_TOKEN`, which must be at least 32 characters).
- The browser is opened with the token in the URL. The server verifies it, sets an
  `httpOnly`, `SameSite=Strict` cookie (`nexotao_session`) scoped to the local path with a
  12-hour lifetime, and strips the token from the URL via redirect.
- Requests without the matching cookie receive `401`. If the token is missing or too short, the
  server refuses to serve (`503`) rather than run unauthenticated.

Because the token is minted per launch and never persisted to disk, closing the app and starting it
again invalidates prior sessions.

## File permissions

All local state is owner-only:

- The data directory (`~/.nexotao` or `NEXOTAO_DATA_DIR`) and backup directories are created with
  mode `0700`.
- `config.json` (which holds your API key) and `nexotao.sqlite` are written with mode `0600`. The
  database is rewritten atomically via a temporary file that is also `0600` before being renamed
  into place.

Permissions are re-applied on write, so they are corrected if something loosens them.

## Secret redaction

A shared redactor is applied wherever data is persisted, exported, or surfaced:

- **Pattern-based:** strings matching common secret shapes (`sk-…`, `key-…`, `token-…`, `tvly-…`,
  `Bearer …`, and `api_key`/`access_token`/`authorization` assignments) are replaced with
  `[REDACTED]`.
- **Key-name-based:** object fields whose names look like `apiKey`, `token`, `authorization`,
  `secret`, or `password` are redacted regardless of value.
- **Known-secret substitution:** configured secrets (such as your API key) are removed from any text
  by direct substring replacement.

Redaction is applied to run events written to the database, to project exports, to audit summaries,
and to error messages returned by the API (internal errors are reduced to a generic message). API
responses expose only boolean presence flags for keys (for example `hasKey`), never the key itself.

## Local execution and the approval model

A run can use tools that read files, write files, and execute shell commands within the project root.
Two mechanisms constrain this:

- **Workspace confinement.** File paths are resolved relative to the opened project root and any path
  that escapes the project directory is rejected.
- **Execution approvals.** Under the default `ask` policy, read-only and control actions proceed
  automatically, but writes, edits, shell commands, and network tool calls require your approval.
  Commands matching a destructive pattern (for example `rm -rf`, `git reset --hard`, `mkfs`,
  `dd if=…`) are flagged high-risk. Each pending action is recorded as an approval row with a
  redacted preview and a 24-hour expiry, and every request/decision is written to the audit log.

See [permissions.md](permissions.md) for the full policy and budget model.

## Dependency audit gate

The release CI runs `npm audit --omit=dev --audit-level=high` and fails the build on any high or
critical finding in production dependencies. See [vulnerability-reporting.md](vulnerability-reporting.md)
for how residual, accepted lower-severity findings are documented.
