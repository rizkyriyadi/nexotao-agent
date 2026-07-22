# Gateway Data Flow

This document traces how a request travels from the browser, through the local server, to the
Nexotao Gateway (the model API at `https://api.nexotao.com`) and back, and what is included,
redacted, and stored at each step.

## Diagram

```
 ┌──────────────┐        ┌─────────────────────────────────────────────┐        ┌──────────────────┐
 │   Browser    │        │        Local server (127.0.0.1:4319)         │        │  Nexotao Gateway │
 │  (your UI)   │        │              Next.js + Node.js               │        │ api.nexotao.com  │
 └──────┬───────┘        └───────────────────┬─────────────────────────┘        └────────┬─────────┘
        │  1. request (message/run)           │                                           │
        │  cookie: nexotao_session ──────────►│  2. auth: host + origin + token + size    │
        │                                     │                                           │
        │                                     │  3. build model request:                  │
        │                                     │     messages + selected model +           │
        │                                     │     tool definitions                      │
        │                                     │  4. attach API key (x-api-key) ──────────►│  5. model
        │                                     │                                           │     runs
        │  6. streamed tokens ◄───────────────│◄────────── streamed response ─────────────│
        │                                     │                                           │
        │                                     │  7. tool call? → approval (if required)   │
        │  8. approve/deny ──────────────────►│     → execute tool locally (fs/bash/web)  │
        │                                     │     → send tool result back ─────────────►│ (loop 5–7)
        │                                     │                                           │
        │                                     │  9. persist redacted run events +         │
        │                                     │     session messages + cost events        │
        │  10. final summary ◄────────────────│     to ~/.nexotao/nexotao.sqlite          │
        └─────────────────────────────────────┴───────────────────────────────────────────┘
```

## Step by step

1. **Browser → local server.** You send a chat message or start a run from the UI. The request
   carries the `nexotao_session` cookie set at launch. All traffic is on loopback; nothing is exposed
   to your network.

2. **Authentication and validation.** The local server verifies the `Host` header, checks the session
   cookie, validates the `Origin` on state-changing requests, and enforces the request-size limit.
   Failures are rejected before any work is done (see [security.md](security.md)).

3. **Request construction.** The server assembles the model request: the conversation messages, the
   model you selected during onboarding, and the tool definitions (`list_dir`, `read_file`,
   `write_file`, `edit_file`, `bash`, `grep`, `web_search`, `web_fetch`, and delegation tools for
   multi-agent runs). A short system instruction identifies the local project root.

4. **API key attachment.** The request is sent to the Gateway with your Nexotao API key as the
   `x-api-key` authentication header. The Gateway exposes a standard `/v1/messages` HTTP endpoint;
   the local server is the only component that holds and sends your key.

5. **Model execution.** The Gateway runs the selected model and streams a response.

6. **Streaming back.** Tokens stream back through the local server to the browser as they arrive, so
   you see progress live. Token usage counts are captured for the cost ledger.

7. **Tool calls and approvals.** If the model requests a tool, the local server evaluates it against
   the execution policy. Read-only and control actions run automatically; writes, edits, shell
   commands, and network calls require your approval under the default `ask` policy. A pending
   approval carries a redacted preview.

8. **Local tool execution.** Approved tools run **on your machine**: filesystem tools operate inside
   the project root (paths that escape it are refused), `bash` runs in the project root with a
   timeout, and `web_search`/`web_fetch` make outbound requests from your machine. The tool result is
   returned to the Gateway to continue the loop (back to step 5) until the run finishes.

9. **Persistence.** Run events, session messages, and cost events are written to
   `~/.nexotao/nexotao.sqlite`. Run events and audit records are passed through the redactor before
   they are stored, so secrets do not land on disk.

10. **Completion.** The final summary is shown in the UI. The durable run record lets you navigate
    away, refresh, or reopen a run and see its history.

## What is included in Gateway requests

- Your conversation messages for the session or run.
- The selected model identifier and tool definitions.
- Tool results produced during the run — which, for a coding task, can include the contents of files
  the agent read or wrote in your project folder.
- Your Nexotao API key, as an authentication header only.

## What is redacted or kept local

- **Never sent to the Gateway:** your local database, configuration file, and any file the run did
  not read as part of your task.
- **Redacted before storage:** run events, audit summaries, exports, and error messages — secrets and
  secret-shaped fields become `[REDACTED]`.
- **Never returned in API responses:** the API key value. Endpoints report only boolean presence
  flags (for example `hasKey`).

## Other outbound calls

Separate from model requests, the app may contact the npm registry to check for updates and the
Gateway's `/models` endpoint to list available models. Web tools contact the sites you or a run
target. See [privacy.md](privacy.md#what-leaves-your-machine).
