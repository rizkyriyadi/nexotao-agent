# Security

Nexotao is a local application with permission to read, write, and execute inside user-selected workspaces. The production CLI binds only to `127.0.0.1`, creates a random authenticated browser session for each launch, validates Host and Origin, limits request sizes, and asks before every write or command in single-agent, multi-agent, issue-worker, and integration runs.

Secrets under `~/.nexotao` are stored with directory mode `0700` and file mode `0600`. API responses expose only boolean key-presence fields. Run events and persisted records apply secret redaction; package contents are restricted by the package `files` allowlist.

For the full threat model and controls, see [`docs/security.md`](docs/security.md).

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** — do not open a public issue. Use the
repository's private security advisory form, and include the affected version, OS, Node.js version,
and reproduction steps. The full process, expected response, and scope are documented in
[`docs/vulnerability-reporting.md`](docs/vulnerability-reporting.md).

## Dependency audit gate

We do not claim the absence of all vulnerabilities. Instead, the supported-version audit gate must
pass for a release to ship: CI runs `npm audit --omit=dev --audit-level=high` and fails the build on
any **high or critical** finding in production dependencies.

`unpdf` was upgraded to remove the vulnerable `canvas` / `node-pre-gyp` / `tar` chain. Any residual
lower-severity findings are documented here with an explicit risk rationale rather than silently
accepted. As of this writing, `npm audit --omit=dev` reports two moderate findings in Next.js's
bundled PostCSS; no patched stable Next.js release is identified by npm's advisory metadata, and
`npm audit`'s proposed downgrade to Next.js 9.3.3 is not applicable. The risk is accepted for the
beta because CSS is repository-authored at build time and untrusted users cannot supply CSS to the
compiler. This acceptance is revisited whenever the audit surface changes.
