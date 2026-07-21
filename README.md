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

Everything is stored locally in `~/.nexotao/` as plain JSON — projects, sessions, tasks, and run history. Nothing leaves your machine except the model calls to the Nexotao API.

## Requirements

- Node.js **18.18+**
- A Nexotao API key

## License

MIT
