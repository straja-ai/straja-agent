# Straja Agent

Vault-first AI agent runtime with sandboxed execution and multi-channel gateway.

## About

Straja Agent is a personal AI assistant runtime that enforces strict security boundaries.
All code execution runs inside the [Straja Vault](https://github.com/straja-ai/straja-vault)
sandbox (nono kernel isolation) with no direct host filesystem or native process access.

This project is derived from [OpenClaw](https://github.com/openclaw/openclaw) and has been
modified substantially. See [NOTICE.md](./NOTICE.md) for full attribution.

## Architecture

```
Channels (WhatsApp / Telegram / Slack / Discord / etc.)
               |
               v
+-------------------------------+
|        Straja Agent           |
|      (gateway runtime)        |
|     ws://127.0.0.1:18789      |
+-------------------------------+
        |              |
        v              v
  vault_exec      vault_process
  (via Straja Vault HTTP API)
        |
        v
+-------------------------------+
|        Straja Vault           |
|  nono sandbox + SQLite store  |
|  --net-block (always)         |
+-------------------------------+
```

### Security boundaries (non-negotiable)

- **No native exec/process** -- removed unconditionally from the tools array
- **Vault-only execution** -- all commands run through `vault_exec` / `vault_process`
- **No host filesystem access** -- workspace is materialized from SQLite into the sandbox
- **Network always blocked** -- `--net-block` is passed unconditionally to nono
- **Separate components** -- agent runtime, vault, and gateway are independent repos

## Install

Runtime: **Node >= 22**.

```bash
npm install -g straja-agent@latest
# or: pnpm add -g straja-agent@latest

straja-agent onboard --install-daemon
```

The `openclaw` binary name is kept as an alias for backward compatibility.

## From source (development)

```bash
git clone https://github.com/straja-ai/straja-agent.git
cd straja-agent

pnpm install
pnpm ui:build
pnpm build

pnpm straja-agent onboard --install-daemon

# Dev loop (auto-reload on TS changes)
pnpm gateway:watch
```

## Quick start

```bash
straja-agent onboard --install-daemon

straja-agent gateway --port 18789 --verbose

# Talk to the assistant
straja-agent agent --message "Hello" --thinking high
```

## Related repositories

| Repo                                                          | Purpose                                            |
| ------------------------------------------------------------- | -------------------------------------------------- |
| [straja-vault](https://github.com/straja-ai/straja-vault)     | Sandbox execution server (nono + SQLite workspace) |
| [straja-gateway](https://github.com/straja-ai/straja-gateway) | Gateway configuration and deployment               |

## Models

Works with any LLM provider. Recommended: **Anthropic Pro/Max + Opus 4.6** for
long-context strength and prompt-injection resistance.

## Channels

WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage (BlueBubbles),
Microsoft Teams, Matrix, Zalo, WebChat, and more via extensions.

## License

MIT License. See [LICENSE](./LICENSE).

Original work copyright (c) 2025 Peter Steinberger.
Modifications copyright (c) 2025-2026 Straja contributors.
