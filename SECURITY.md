# Security

Nexotao is a local application with permission to read, write, and execute inside user-selected workspaces. The production CLI binds only to `127.0.0.1`, creates a random authenticated browser session for each launch, validates Host and Origin, limits request sizes, and asks before every write or command in single-agent, multi-agent, issue-worker, and integration runs.

Secrets under `~/.nexotao` are stored with directory mode `0700` and file mode `0600`. API responses expose only boolean key-presence fields. Run events and persisted records apply secret redaction; package contents are restricted by the package `files` allowlist.

## Dependency risk

`unpdf` was upgraded to remove the vulnerable `canvas` / `node-pre-gyp` / `tar` chain, eliminating all high and critical production audit findings. As of 2026-07-21, `npm audit --omit=dev` reports two moderate findings in Next.js's bundled PostCSS. No patched Next.js 16 stable release is identified by npm's advisory metadata; `npm audit` incorrectly proposes a downgrade to Next.js 9.3.3. The risk is accepted for the private beta because CSS is repository-authored at build time and untrusted users cannot supply CSS to the compiler. CI fails if a high or critical production finding returns.
