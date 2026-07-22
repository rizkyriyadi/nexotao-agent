# Supported Platforms

Nexotao Agents is a Node.js application packaged for npm. It uses the SQL.js embedded database build,
which requires no native compilation, so it runs on any platform with a supported Node.js runtime.

## Node.js versions

The package declares `engines.node` `>=18.18`. Supported versions:

| Node.js | Status |
| --- | --- |
| 18.18+ | Supported (minimum) |
| 20 (LTS) | Supported — exercised by release CI |
| 22 | Supported |

Node versions below 18.18 are not supported. Release CI runs on **Node 20**, which validates the
build, tests, dependency audit, and a packaged install/launch/health smoke test on each change; 18.18+
and 22 are supported per the engines range.

## Operating systems

| OS | Status | Notes |
| --- | --- | --- |
| Linux | Supported | Primary CI platform (`ubuntu-latest`). |
| macOS | Supported | Browser is opened with `open`. |
| Windows | Supported | Browser is opened via `cmd /c start`; the CLI resolves `nexotao.cmd`. |

The CLI opens your default browser automatically. If it cannot, it prints the local URL for you to
open manually (or set `NEXOTAO_NO_OPEN=1` to disable auto-open).

## Tested combinations

| OS | Node | Coverage |
| --- | --- | --- |
| Linux (`ubuntu-latest`) | 20 | Full CI: lint, tests, build, `npm audit --omit=dev --audit-level=high`, and a pack/install/launch/health/shutdown smoke test. |

Other supported OS/Node combinations run the same code path (the database driver is pure JavaScript
and the CLI branches only on `process.platform` for browser-opening). They are supported per the
engines range and the cross-platform smoke test, and are the recommended targets for manual
verification before a release.

## Known constraints

- **Loopback only.** The server binds to `127.0.0.1`; it is not intended to be exposed on a network
  interface or run as a shared multi-user service.
- **Default port `4319`.** Override with the `PORT` environment variable (must be `1`–`65535`).
- **Single instance per data directory.** Writes are serialized within one process; running two
  instances against the same `NEXOTAO_DATA_DIR` is not supported.
- **No durable WAL mode.** The embedded driver persists by atomic file replacement rather than WAL;
  this is intentional and transparent to users. See [storage.md](storage.md#database).
- **A Nexotao API key is required** to do any model work.
