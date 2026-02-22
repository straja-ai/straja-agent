# Straja Agent

Vault-first AI agent runtime. All execution, file I/O, memory, and session persistence are routed through the Straja Vault. The host filesystem is never touched.

## About

Straja Agent is a hard fork of [OpenClaw](https://github.com/openclaw/openclaw), modified substantially for vault-only operation. See [NOTICE.md](./NOTICE.md) for attribution.

The agent has full coding, execution, and memory capabilities — but every operation is sandboxed through the vault. Zero direct disk access.

## Architecture

```
+-------------------+
|    Agent (LLM)    |
+--------+----------+
         |  every tool call goes through HTTP
         v
+-------------------+         +---------------------+
|   Straja Vault    |-------->|    SQLite store      |
|   (HTTP server)   |         |  _workspace (files)  |
+--------+----------+         |  _sessions (logs)    |
         |                    |  _memory (knowledge)  |
         |                    +---------------------+
         | vault_exec only
         v
+-------------------+         +---------------------+
| Temp dir from     |-------->|   nono sandbox       |
| _workspace files  |         |   (Seatbelt/Landlock)|
+-------------------+         |   network blocked    |
         |                    |   fs restricted      |
         v                    +---------------------+
  file changes captured
  back to SQLite

  Host filesystem: NEVER accessed
  Native exec/process: REMOVED
```

Everything is stored in SQLite. The agent never sees the host filesystem.

## Three vault collections

| Collection   | Purpose                                                                              | Written by                                                |
| ------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `_workspace` | Working files (code, scripts, data) + bootstrap .md files (AGENTS.md, SOUL.md, etc.) | `vault_write`, `vault_exec` file capture, bootstrap patch |
| `_sessions`  | Conversation transcripts (JSONL)                                                     | Session persistence patch                                 |
| `_memory`    | Persistent knowledge across sessions                                                 | `vault_memory_write`, session-memory hook                 |

## Vault tools

| Tool                  | What it does                                                                                                                                                                                       |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault_read`          | Read a file from `_workspace` (replaces native `read`)                                                                                                                                             |
| `vault_write`         | Write a file to `_workspace` (replaces native `write`)                                                                                                                                             |
| `vault_edit`          | Edit a file in `_workspace` (replaces native `edit`)                                                                                                                                               |
| `vault_exec`          | Execute a command inside a kernel sandbox (nono). Workspace is materialized from SQLite to a temp dir, command runs with filesystem and network blocked, file changes are captured back to SQLite. |
| `vault_process`       | Manage long-running processes: list, poll output, write to stdin, kill, cleanup                                                                                                                    |
| `vault_search`        | Hybrid search (lexical + vector + HyDE) across vault collections                                                                                                                                   |
| `vault_get`           | Retrieve full document content from any collection                                                                                                                                                 |
| `vault_status`        | Vault health: total documents, pending embeddings, collection stats                                                                                                                                |
| `vault_memory_search` | Semantic search over persistent memory (`_memory` collection)                                                                                                                                      |
| `vault_memory_get`    | Read a specific memory file with optional line slicing                                                                                                                                             |
| `vault_memory_write`  | Write or append to a memory file. Auto-triggers vector embedding.                                                                                                                                  |

## Execution sandbox

The vault's permanent storage is SQLite. Commands need real files, so the vault materializes workspace files into a temp directory before each execution. The kernel sandbox (nono: Seatbelt on macOS, Landlock on Linux) restricts the process to only that temp directory. After exit, file changes are diffed and captured back to SQLite. The temp directory is deleted.

1. **Materialize** — workspace files copied from SQLite to a temp directory
2. **Sandbox** — nono restricts the process to that directory only (network blocked)
3. **Execute** — command runs inside the sandbox
4. **Capture** — file changes diffed and written back to SQLite
5. **Cleanup** — temp directory deleted

Network is always blocked (`--net-block`). No exceptions.

## Persistent memory

The vault replaces OpenClaw's native memory system with the `_memory` collection:

- **Writes**: Agent uses `vault_memory_write` to store knowledge. Supports append mode for incremental updates (e.g., pre-compaction memory flush).
- **Search**: `vault_memory_search` runs hybrid search (lexical + vector + HyDE). The system prompt instructs the agent to search memory before answering questions about prior work.
- **Session summaries**: On `/new`, a hook reads the session transcript from `_sessions`, formats a summary, and appends it to `_memory/memory/YYYY-MM-DD.md`.
- **Auto-embedding**: Every write to `_memory` triggers background vector embedding, making new content immediately searchable.

## Security: no fallback, ever

This is a vault-only runtime. There are no fallbacks, no degraded modes, no development shortcuts:

- **Vault down** -> agent cannot operate. File tools throw errors, not fall back to disk.
- **nono not installed** -> execution fails. No unsandboxed fallback.
- **Plugin not loaded** -> all file operations fail. No `fs/promises` fallback.
- **Native exec/process** -> unconditionally removed from the tools array in `pi-tools.ts`. Cannot be re-enabled.
- **Config isolation** -> `vault_write` goes through the vault HTTP API to SQLite. The agent cannot modify `~/.openclaw/openclaw.json` or any host file, even via prompt injection.

Failing safe means failing closed.

## Related repositories

| Repo                                                          | Purpose                                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [straja-vault](https://github.com/straja-ai/straja-vault)     | Vault server: SQLite store, search engine, sandbox execution, HTTP API |
| [straja-gateway](https://github.com/straja-ai/straja-gateway) | Gateway configuration and deployment                                   |
| [nono](https://github.com/nichochar/nono)                     | Kernel sandbox (Seatbelt/Landlock) used by vault_exec                  |

## Install (from source)

Runtime: **Node >= 22**, **pnpm**.

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

## License

MIT License. See [LICENSE](./LICENSE).

Original work copyright (c) 2025 Peter Steinberger.
Modifications copyright (c) 2025-2026 Sorin Manole.
