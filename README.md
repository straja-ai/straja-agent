# Straja Agent

Vault-first AI agent runtime. All execution, file I/O, memory, session persistence, messaging, and browser automation are routed through the Straja Vault. The host filesystem is never touched.

## About

Straja Agent is a hard fork of [OpenClaw](https://github.com/openclaw/openclaw), rewritten substantially for vault-only operation. See [NOTICE.md](./NOTICE.md) for attribution.

The agent has full coding, execution, memory, browser, and messaging capabilities — but every operation is mediated by the vault. Zero direct disk access, zero direct network, zero native child processes.

## Architecture

```
+-------------------+
|    Agent (LLM)    |
+--------+----------+
         |  every tool call goes through HTTP (or MCP)
         v
+-------------------+         +---------------------------------+
|   Straja Vault    |-------->|   Encrypted SQLite              |
|   (HTTP + MCP)    |         |   (SQLCipher at rest)           |
+--------+----------+         |                                 |
         |                    |   _workspace   _memory          |
         |                    |   _sessions    _flows           |
         |                    |   _tasks       _cron            |
         |                    |   _notes       _media           |
         |                    |   _uploads     _screenshots     |
         |                    |   _gmail       _calendar        |
         |                    |   _contacts    _gdrive          |
         |                    |   _audit       _logs            |
         |                    |   ... (see Collections below)   |
         |                    +---------------------------------+
         | vault_exec only
         v
+-------------------+         +---------------------------------+
| Temp dir from     |-------->|   nono sandbox                  |
| _workspace files  |         |   (Seatbelt/Landlock)           |
+-------------------+         |   network blocked               |
         |                    |   fs restricted                 |
         v                    +---------------------------------+
  file changes captured
  back to SQLite

  Host filesystem:     NEVER accessed
  Native exec/process: REMOVED
  Native network:      REMOVED (agent reaches out only via vault tools)
```

Everything is stored in SQLite. The agent never sees the host filesystem.

## Vault collections

System collections are prefixed with `_` and are reserved. The default set seeded on install (`src/workspace-defaults.ts` in the vault repo) plus collections created on demand by extensions:

### Agent state

| Collection          | Purpose                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `_workspace`        | Working files (code, scripts, data) and bootstrap profiles (AGENTS.md)               |
| `_memory`           | Persistent knowledge, auto-embedded for vector search                                |
| `_sessions`         | Conversation transcripts (JSONL)                                                     |
| `_sessions_store`   | Session metadata / indexing                                                          |
| `_subagents`        | Subagent registry and state                                                          |
| `_bootstrap`        | First-run seed documents                                                             |
| `_editable`         | Documents the user can edit through the UI                                           |

### Automation

| Collection          | Purpose                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `_flows`            | Inbound-message automation rules (see [README.flows.md](./README.flows.md))          |
| `_flow_runs`        | Historical flow execution records                                                    |
| `_tasks`            | Task queue and state                                                                 |
| `_cron`             | Scheduled jobs                                                                       |
| `_orchestration`    | Orchestration router traces and decisions                                            |
| `_delivery_queue`   | Outbound message delivery queue                                                      |
| `_write_queue`      | Queued vault writes                                                                  |

### User content

| Collection          | Purpose                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `_notes`            | User / agent notes                                                                   |
| `_media`            | Media assets (images, video, audio)                                                  |
| `_screenshots`      | Browser screenshots captured by the runtime                                          |
| `_uploads`          | Staged uploads materialized into the browser / mail flows                            |

### Connectors (created on connect)

| Collection          | Purpose                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `_gmail`            | Gmail threads, drafts                                                                |
| `_calendar`         | Google Calendar events                                                               |
| `_contacts`         | Google Contacts                                                                      |
| `_gdrive`           | Google Drive files (indexed)                                                         |
| `_github`           | GitHub issues / PRs / repos                                                          |

### System / hidden

| Collection          | Purpose                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `_config`           | Vault-managed configuration                                                          |
| `_credentials` / `_auth_profiles` | Stored credentials and OAuth tokens                                    |
| `_audit`            | Immutable browser and policy audit log                                               |
| `_logs`             | Vault runtime logs                                                                   |

`_audit`, `_config`, `_credentials`, `_auth_profiles`, and related system collections are hidden from the agent and the search APIs. Raw writes to audit and upload collections are rejected.

## Vault tools

The agent calls vault tools instead of native primitives. Tools are grouped by capability; see [`src/shared/tool-catalog.ts`](./src/shared/tool-catalog.ts) for the full registry.

### Files & execution

| Tool                  | What it does                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `vault_read`          | Read a file from `_workspace`                                                                                 |
| `vault_write`         | Write a file to `_workspace`                                                                                  |
| `vault_edit`          | Edit a file in `_workspace`                                                                                   |
| `vault_apply_patch`   | Apply a diff/patch to a workspace file                                                                        |
| `vault_exec`          | Run a command inside the `nono` kernel sandbox. Workspace materialized to a temp dir, network blocked, changes diffed back. |
| `vault_process`       | Manage long-running processes: list, poll output, write to stdin, kill, cleanup                               |
| `vault_repo_exec`     | Run a command against a cloned repository                                                                     |
| `vault_repos_list`    | List cloned repositories                                                                                      |

### Search & retrieval

| Tool                  | What it does                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `vault_search`        | Hybrid search (lexical + vector + HyDE) across vault collections                                              |
| `vault_get`           | Retrieve full document content from any collection                                                            |
| `vault_multi_get`     | Batch retrieval by ids or paths                                                                               |
| `vault_status`        | Vault health: document counts, embedding queue, collection stats                                              |

### Persistent memory

| Tool                  | What it does                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `vault_memory_search` | Semantic search over `_memory`                                                                                |
| `vault_memory_get`    | Read a specific memory file with optional line slicing                                                        |
| `vault_memory_write`  | Write or append a memory file; auto-triggers vector embedding                                                 |

### Notes, collections, artifacts

| Tool                           | What it does                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `vault_note_create` / `vault_note_update`        | Create and update notes in user collections                                    |
| `vault_collection_write`       | Write a document into a named collection                                                         |
| `vault_agent_collection_*`     | Agent-owned collections (create, list, write)                                                    |
| `vault_spreadsheet_get` / `_match` / `_update`   | Read and update rows in spreadsheet collections                                |
| `vault_artifact_write` / `_list` / `_url`        | Build and share deliverables (reports, exports)                                |
| `vault_presentation_build`     | Render a presentation artifact                                                                   |
| `vault_report_build`           | Render a report artifact                                                                         |

### Browser (Playwright-MCP, policy-gated)

All browser actions are mediated by the Vault's browser security controller before reaching Playwright. See the vault's `CLAUDE.md` for the security model.

| Tool                             | What it does                                                   |
| -------------------------------- | -------------------------------------------------------------- |
| `vault_browser_start` / `_stop` / `_status` | Lifecycle                                           |
| `vault_browser_navigate`         | Navigate to an allowed domain                                  |
| `vault_browser_snapshot`         | Read the current DOM / accessibility tree                      |
| `vault_browser_click` / `_type` / `_fill` / `_select` / `_hover` / `_press_key` | Input |
| `vault_browser_screenshot` / `_pdf`         | Capture                                             |
| `vault_browser_tabs` / `_tab_list` / `_tab_new` / `_tab_close` | Tab management                   |
| `vault_browser_dialog`           | Handle JS dialogs                                              |
| `vault_browser_console` / `_wait` | Inspect console, wait for conditions                          |
| `vault_stage_media_upload` / `vault_browser_upload` | Staged upload via vault object ids only      |
| `vault_approve_domain`           | Request approval to navigate a new domain                      |
| `vault_web_fetch` / `vault_web_search_duckduckgo` | HTTP fetch + web search via the vault's proxy |

### Calendar, mail, and GitHub

| Tool                            | What it does                                      |
| ------------------------------- | ------------------------------------------------- |
| `vault_gcalendar_create_event` / `_update_event` / `_delete_event` | Google Calendar |
| `vault_gmail_create_draft` / `_update_draft`                        | Gmail drafts    |
| `vault_github_create_issue` / `_list_issues`                        | GitHub issues   |
| `vault_github_create_branch` / `_create_pr` / `_list_prs` / `_push` | GitHub PRs      |

### Sessions, subagents, cross-session

| Tool                          | What it does                                          |
| ----------------------------- | ----------------------------------------------------- |
| `vault_agents_list`           | List configured agents                                |
| `vault_sessions_list` / `_history` / `_status` | Session metadata and transcripts     |
| `vault_sessions_spawn`        | Start a new session (optionally with a subagent)      |
| `vault_sessions_send`         | Send a message into another session                   |
| `vault_subagents`             | Manage subagent lifecycles                            |

### Automation

| Tool         | What it does                                           |
| ------------ | ------------------------------------------------------ |
| `vault_cron` | Create and manage scheduled tasks (cron expressions)   |

## Execution sandbox

`vault_exec` never touches your filesystem directly. The vault's persistent storage is SQLite, so commands that need real files go through this cycle:

1. **Materialize** — workspace files copied from SQLite to a temp directory
2. **Sandbox** — [`nono`](https://github.com/nichochar/nono) restricts the process to that directory only (Seatbelt on macOS, Landlock on Linux)
3. **Execute** — command runs with network blocked and fs restricted
4. **Capture** — file changes diffed and written back to SQLite
5. **Cleanup** — temp directory deleted

Network is always blocked (`--net-block`). No exceptions. If `nono` is unavailable, `vault_exec` refuses to run — there is no fallback.

## Persistent memory

The vault replaces OpenClaw's native memory system with the `_memory` collection:

- **Writes**: Agent uses `vault_memory_write` to store knowledge. Supports append mode for incremental updates (e.g., pre-compaction memory flush).
- **Search**: `vault_memory_search` runs hybrid search (lexical + vector + HyDE). The system prompt instructs the agent to search memory before answering questions about prior work.
- **Session summaries**: On `/new`, a hook reads the session transcript from `_sessions`, formats a summary, and appends it to `_memory/memory/YYYY-MM-DD.md`.
- **Auto-embedding**: Every write to `_memory` triggers background vector embedding, making new content immediately searchable.

## Flows — inbound-message automation

Flows are JSON rules stored in `_flows` that shape how the agent handles inbound messages from channels. They match on channel / sender / conversation, inject context and instructions into the agent's turn, and support template variables. See [README.flows.md](./README.flows.md) for the full schema and matching rules.

## Channels

Agents can receive and reply on messaging channels. See [readme.channels.md](./readme.channels.md) for the pairing flow, DM/group policies, and per-channel details. Today the supported channels include:

- WhatsApp (Baileys)
- Telegram (grammY)
- Gmail, Google Calendar, Google Contacts, Google Drive (official APIs)

Additional channel extensions (Discord, Slack, Signal, iMessage, Matrix, and others) live under `extensions/` and are opt-in.

## Model providers

The agent runs on whichever provider(s) you configure. Supported:

- **Local** — Ollama (native streaming). `gemma4` is the recommended local fast-path / router model. Embeddings run locally through `node-llama-cpp` (`EmbeddingGemma-300M` by default).
- **Cloud** — Anthropic, OpenAI, Google Generative AI, AWS Bedrock, GitHub Copilot.

Selection is per-agent and can be overridden per-task by the orchestration router. Fallback chains are first-class.

## Security: no fallback, ever

This is a vault-only runtime. There are no fallbacks, no degraded modes, no development shortcuts:

- **Vault down** → agent cannot operate. File tools throw errors, not fall back to disk.
- **`nono` not installed** → execution fails. No unsandboxed fallback.
- **Plugin not loaded** → all file operations fail. No `fs/promises` fallback.
- **Native exec/process** → unconditionally removed from the tools array in `pi-tools.ts`. Cannot be re-enabled.
- **Config isolation** → `vault_write` goes through the vault HTTP API to SQLite. The agent cannot modify `~/.openclaw/openclaw.json` or any host file, even via prompt injection.
- **Encrypted at rest** → the vault stores its SQLite database under SQLCipher with a PIN-derived key held in the OS keychain.

Failing safe means failing closed.

## Related repositories

| Repo                                                          | Purpose                                                                |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [straja-vault](https://github.com/straja-ai/straja-vault)     | Vault server: SQLite store, search engine, sandbox execution, HTTP API |
| [straja-gateway](https://github.com/straja-ai/straja-gateway) | Gateway configuration and deployment                                   |
| [straja-intel-guard](https://github.com/straja-ai/straja-intel-guard) | Straja Guard models (prompt injection, jailbreak, PII)         |
| [nono](https://github.com/nichochar/nono)                     | Kernel sandbox (Seatbelt/Landlock) used by `vault_exec`                |

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

Contact: hello@straja.ai
