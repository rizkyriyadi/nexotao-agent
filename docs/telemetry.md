# Telemetry

Nexotao Agents is local-first and privacy-preserving. Telemetry is **off by default**: unless you
explicitly opt in, Nexotao collects and transmits **no** crash or performance telemetry. This
document describes the opt-in telemetry policy, exactly what is and is not collected when enabled, and
how to turn it on or off.

## Default: off

With telemetry off (the default), no telemetry payloads are produced or sent. The only network calls
the app makes are the ones described in [privacy.md](privacy.md#what-leaves-your-machine) (model
requests you initiate, web tools you invoke, the model catalog, and the npm update check).

## What is collected when you opt in

If you enable telemetry, the app may send **redacted crash and performance** data only:

- **Redacted error messages** — the text of an error that caused a crash or failed operation, passed
  through the redactor first.
- **Timing and performance counters** — durations and coarse performance metrics (for example how
  long an operation took).

## What is never collected

Telemetry **never** includes, whether enabled or not:

- Your messages or conversation content.
- Source code or file contents from your project.
- API keys, tokens, or other secrets.
- File paths' contents, personal data, or other PII.

Every telemetry payload is passed through the same redactor used across the app before it could be
transmitted, so secret-shaped values become `[REDACTED]`. See
[security.md](security.md#secret-redaction). Redaction is a backstop; the collected fields are limited
to redacted error text and performance counters by design.

## Opting in and out

Telemetry is controlled two ways, both defaulting to off:

- **Settings toggle.** A telemetry switch in the app's Settings screen; leave it off to disable,
  turn it on to opt in.
- **Environment variable.** `NEXOTAO_TELEMETRY` — set it to `1` to opt in, or leave it unset / set it
  to `0` to keep telemetry disabled.

If either control indicates opt-out, no telemetry is collected or sent. Turning telemetry off stops
further collection immediately.

## Summary

| | Default (off) | Opted in |
| --- | --- | --- |
| Crash/error text | Not collected | Redacted only |
| Performance counters | Not collected | Collected |
| Conversation content | Never | Never |
| Code / file contents | Never | Never |
| Keys / secrets / PII | Never | Never |
