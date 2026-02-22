# Straja Vault — OpenClaw Integration Changelog

All changes made to the OpenClaw codebase to integrate the Straja Vault as a sandboxed execution and memory environment for the agent.

---

## 1. Straja Vault Plugin (`extensions/straja-vault/`)

### Plugin Entry Point — `index.ts`

- Declares `kind: "memory"` to claim the memory plugin slot (replaces `memory-core`).
- Registers seven vault tools (`vault_search`, `vault_get`, `vault_status`, `vault_exec`, `vault_memory_search`, `vault_memory_get`, `vault_memory_write`) on plugin load.
- Registers the **session persistence patch** via a globalThis callback bridge — redirects all SessionManager I/O to the vault.
- Registers the **FS tools patch** via a second globalThis callback bridge — redirects the agent's `read`, `write`, `edit` tools through the vault HTTP API.
- Registers **vault-backed session-memory hook** (`command:new`) — replaces the native `session-memory` hook. On `/new`, saves session summary to the vault's `_memory` collection instead of writing to disk via `fs.writeFile()`.
- Uses triple-guard pattern (`sessionPatched`, `fsToolsPatched`, `hookRegistered`) to prevent re-registration.
- `baseUrl` configurable via plugin config, `STRAJA_VAULT_URL` env var, or defaults to `http://localhost:8181`.

### Session Persistence — `src/session-patch.ts`

- Monkey-patches `SessionManager.prototype` to route all session persistence through the vault's `/raw/_sessions/` endpoints.
- **Disk writes are fully suppressed** — the vault is the sole persistence layer.
- Uses synchronous `curl` to localhost for writes (ensures data is available before gateway broadcasts events to UI).
- Reads (`setSessionFile`) load exclusively from vault; if vault is empty or unreachable, a new empty session starts.
- Uses the globalThis callback bridge pattern to work around Jiti module isolation (Jiti-loaded plugin gets a different class instance than the bundle).
- Supports session branching (`createBranchedSession`) — mirrors branched state to vault.

### FS Tools Patch Bridge — `src/fs-tools-patch.ts`

- Defines `FS_TOOLS_PATCH_KEY` (`Symbol.for("openclaw.fsToolsPatchCallback")`) used as the globalThis bridge key.
- `registerFsToolsPatch(baseUrl)` stores a callback on globalThis that, when invoked with `workspaceRoot`, returns vault-backed `readOperations`, `writeOperations`, and `editOperations`.
- Consumed by `pi-tools.ts` in the main bundle at tool execution time (lazy resolution).

### Bootstrap Patch Bridge — `src/bootstrap-patch.ts`

- Defines `BOOTSTRAP_PATCH_KEY` (`Symbol.for("openclaw.bootstrapPatchCallback")`) used as the globalThis bridge key.
- `registerBootstrapPatch(baseUrl)` stores a callback on globalThis that, when invoked, returns a loader function `(filename: string) => Promise<string | null>`.
- Consumed by `workspace.ts` in the main bundle when loading bootstrap files (AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md, MEMORY.md).
- Also consumed by `heartbeat-runner.ts` when reading HEARTBEAT.md for the gate check.
- Uses TTL-based cache (60 seconds) per file to avoid hitting the vault on every bootstrap load.
- Fetches from vault `GET /raw/_bootstrap/{filename}`. Returns content on 200, null on 404, **throws on unreachable** (no disk fallback).
- When the bootstrap patch is active, `loadWorkspaceBootstrapFiles()` never touches the filesystem.

### Vault File Operations — `src/vault-fs-operations.ts`

- HTTP client that replaces `fs/promises` operations for the agent's file tools.
- All file I/O goes through `GET/PUT /raw/_workspace/{key}` on the vault HTTP API.
- `toVaultKey()` strips the workspace root prefix from absolute paths to get vault-relative keys (e.g., `/Users/stelo/project/src/main.ts` → `src/main.ts`).
- `mkdir` is a no-op (vault uses flat path keys, no directory hierarchy).
- Image MIME type detection is extension-based (no filesystem magic byte sniffing).
- Three factory functions: `createVaultReadOperations()`, `createVaultWriteOperations()`, `createVaultEditOperations()`.

### Vault Tools — `src/tools.ts`

- **`vault_search`** — Hybrid search (lexical + vector + HyDE) across vault collections. Returns title, file, score, snippet.
- **`vault_get`** — Fetches full document content from a collection by path.
- **`vault_status`** — Returns vault health and index status (total documents, pending embeddings, collections).
- **`vault_exec`** — Sandboxed command execution. POSTs to vault `/exec` endpoint. Params: `command` (required), `args`, `timeout` (1-300s), `cwd` (relative to workspace). Returns exit code, stdout, stderr, timed-out flag, and list of files changed.
- **`vault_memory_search`** — Hybrid search scoped to the `_memory` collection. Runs lex+vec+hyde sub-searches. Used for persistent memory recall (prior work, decisions, preferences, todos).
- **`vault_memory_get`** — Reads a specific memory file from `_memory` with optional from/lines slicing. Use after `vault_memory_search` to pull only the needed lines.
- **`vault_memory_write`** — Writes or appends to a memory file in `_memory`. Supports `append: true` for incremental updates (e.g., pre-compaction flush). Triggers auto-embedding after write.

---

## 2. Core OpenClaw Change — `src/agents/pi-tools.ts`

### Lazy Vault Operations in `createOpenClawCodingTools()`

The file tools (`read`, `write`, `edit`) from `@mariozechner/pi-coding-agent` accept a custom `operations` object. We pass lazy wrappers that resolve the vault callback at execution time rather than at tool creation time.

**Why lazy?** Plugins load inside `createOpenClawTools()`, which runs after the tool `flatMap` in `createOpenClawCodingTools()`. If we checked for the vault callback eagerly, it wouldn't exist yet.

- Added `FS_TOOLS_PATCH_KEY` Symbol lookup and `resolveVaultOps()` with caching (`_resolvedVaultOps`).
- Created `lazyReadOperations` — delegates to vault `readFile`/`access`/`detectImageMimeType` if available, throws error if vault patch not loaded (no disk fallback).
- Created `lazyWriteOperations` — delegates to vault `writeFile`/`mkdir` if available, throws error if vault patch not loaded (no disk fallback).
- Created `lazyEditOperations` — combines lazy read and write operations.
- Passed lazy operations to `createReadTool()`, `createWriteTool()`, `createEditTool()`.

### Tool Renaming

When the vault FS patch is active, tools are renamed to make it explicit they go through the vault:

- `read` → `vault_read`
- `write` → `vault_write`
- `edit` → `vault_edit`

This happens after `createOpenClawTools()` loads plugins (so the vault callback is available), but before the tool policy pipeline filters tools by name. The config uses `alsoAllow` with the `vault_` prefixed names.

### Bootstrap File Loading — `src/agents/workspace.ts`

- `loadWorkspaceBootstrapFiles()` now checks for the `BOOTSTRAP_PATCH_KEY` callback on globalThis before reading files.
- When the vault bootstrap patch is active, ALL bootstrap file reads (AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md, MEMORY.md) go through the vault's `_bootstrap` collection.
- No disk access occurs — `readFileWithCache()` and `resolveMemoryBootstrapEntries()` are bypassed entirely.
- When the vault patch is NOT active (plugin not loaded), original disk behavior is preserved.

### Heartbeat Gate Check — `src/infra/heartbeat-runner.ts`

- The heartbeat runner reads HEARTBEAT.md for a gate check (skip if empty). This read now also checks for the vault bootstrap patch callback.
- When vault is active: reads HEARTBEAT.md from `_bootstrap` collection (via cache).
- When vault is NOT active: reads from disk (original behavior).

---

## 3. Agent Configuration — `~/.openclaw/openclaw.json`

- Uses `"profile": "minimal"` — starts with only `session_status`. No implicit permissions.
- Every tool is explicitly listed in `"alsoAllow"`:
  - `vault_read`, `vault_write`, `vault_edit` — file tools routed through vault
  - `vault_search`, `vault_get`, `vault_status` — vault plugin tools
  - `vault_exec` — sandboxed command execution through vault
  - `vault_memory_search`, `vault_memory_get`, `vault_memory_write` — persistent memory through vault
- `plugins.slots.memory = "straja-vault"` — claims the memory slot, auto-disables native `memory-core`.
- `hooks.internal.entries.session-memory.enabled = false` — disables the native session-memory hook (replaced by vault-backed hook registered in the plugin).
- `compaction.memoryFlush.prompt` customized to instruct the agent to use `vault_memory_write` with `append: true`.
- No `deny` list needed — nothing unwanted is granted by the minimal profile.
- Net effect: agent has file + exec + memory capabilities but every operation is sandboxed through the vault. No direct disk or shell access.

---

## 4. Vault Server Changes (`straja-vault/`)

These changes are in the Straja Vault server, not in OpenClaw itself, but they support the integration.

### Raw-Only Collection Discovery — `src/store.ts`

- `getStatus()` now discovers collections that exist only in the `documents` table (no YAML config entry).
- This makes `_workspace` and `_sessions` (created via `/raw/` endpoints by the agent) visible in the vault UI and status API.

### Collection File Listing Fallback — `src/mcp.ts`

- `GET /collections/:name/files` now falls back to a database check when `getCollection()` returns null.
- Allows listing files for raw-only collections like `_workspace` and `_sessions`.

### Sandboxed Execution — `src/exec-backend.ts` + `POST /exec` in `src/mcp.ts`

- **`ExecBackend` interface**: Pluggable backend abstraction — `name`, `available()`, `execute(opts)`.
- **`NonoBackend`**: Wraps `nono run` CLI for kernel-enforced sandboxing (Seatbelt on macOS, Landlock on Linux). Resolves binary via `which` + well-known paths (`~/.cargo/bin/nono`, `/usr/local/bin/nono`, `/opt/homebrew/bin/nono`). Enforces timeout with SIGTERM → SIGKILL grace period. Truncates output at `maxOutputSize`.
- **`resolveBackend()`**: Returns NonoBackend. Throws if nono is not installed — **no fallback to unsandboxed execution**.
- **`POST /exec` endpoint** orchestrates the full execution cycle:
  1. **Materialize**: Bulk-queries all active docs from `_workspace` (or custom collection), writes them to a temp directory preserving path structure.
  2. **Execute**: Runs command via `nono run --silent --allow <tempDir> --allow-cwd --net-block -- <cmd> <args>`.
  3. **Capture**: Walks temp dir post-execution, hashes each file, compares to originals. New files → `insertDocument`. Modified files → `updateDocument`. Deleted files → `deactivateDocument`.
  4. **Cleanup**: Removes temp dir in `finally` block (even on error).
- Returns: `{ exitCode, stdout, stderr, timedOut, filesChanged: [{path, action}], backend }`.

### Vault GUI — `gui/`

- **Widget ID collision fix** (`gui/widgets/file_panel.py`): Changed widget IDs from 6-character hash prefix (caused collisions) to enumeration index.
- **Refresh button** (`gui/widgets/collection_panel.py`, `gui/screens/main.py`): Added `⟳ Refresh` button to reload collections and files while the vault is running.

---

## Architecture: How the Sandbox Works

```
Agent (LLM)
  │
  ├── vault_read("src/main.ts")  ── lazyReadOperations ── vault HTTP GET /raw/_workspace/src/main.ts
  ├── vault_write("src/main.ts") ── lazyWriteOperations ── vault HTTP PUT /raw/_workspace/src/main.ts
  ├── vault_edit("src/main.ts")  ── lazyEditOperations ── vault HTTP GET + PUT /raw/_workspace/src/main.ts
  │
  ├── vault_exec("python3", ["script.py"]) ── plugin tool ── vault HTTP POST /exec
  │     └── vault materializes _workspace → temp dir → nono sandbox → captures changed files back
  │
  ├── vault_memory_search(query) ── plugin tool ── vault HTTP POST /query (collections: ["_memory"])
  ├── vault_memory_get(path)     ── plugin tool ── vault HTTP GET /raw/_memory/{path}
  ├── vault_memory_write(path)   ── plugin tool ── vault HTTP PUT|POST /raw/_memory/{path} → auto-embed
  │
  ├── session persistence  ─── session-patch ───────── vault HTTP /raw/_sessions/{session-id}
  ├── session-memory hook  ─── command:new ─────────── vault HTTP POST /raw/_memory/memory/YYYY-MM-DD.md
  │
  ├── bootstrap files  ──── bootstrap-patch ────────── vault HTTP GET /raw/_bootstrap/{AGENTS,SOUL,TOOLS,...}.md
  ├── heartbeat gate   ──── bootstrap-patch ────────── vault HTTP GET /raw/_bootstrap/HEARTBEAT.md
  │
  ├── vault_search(query)  ─── plugin tool ──────────── vault HTTP /search
  ├── vault_get(coll, path) ── plugin tool ──────────── vault HTTP /collections/:name/files/:path
  └── vault_status()  ──────── plugin tool ──────────── vault HTTP /status

  exec / process / apply_patch → NOT granted (minimal profile, explicit allowlist only)
  Direct filesystem → NEVER touched (all routed through vault)
```

The vault stores everything in SQLite. The agent has full coding + execution + memory capabilities but zero direct disk access.

---

## Persistent Memory: `_memory` Collection

The vault replaces OpenClaw's native memory system (`memory-core` plugin + local SQLite index) with a vault-backed `_memory` collection.

**Three vault collections:**

| Collection   | Purpose                                                                                        | Created by                                     |
| ------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `_workspace` | Agent's working files (code, scripts, data) AND bootstrap .md files (AGENTS.md, SOUL.md, etc.) | `vault_write` / `vault_exec` / bootstrap patch |
| `_sessions`  | Conversation transcripts                                                                       | Session persistence patch                      |
| `_memory`    | Persistent knowledge across sessions                                                           | `vault_memory_write` / session-memory hook     |

**How memory works:**

1. **Memory writes**: The agent uses `vault_memory_write` to store knowledge in `_memory`. Supports overwrite and append modes. The pre-compaction memory flush prompt instructs the agent to use `vault_memory_write(path: "memory/YYYY-MM-DD.md", append: true)`.

2. **Memory search**: `vault_memory_search` runs hybrid search (lex+vec+hyde) scoped to `_memory`. The system prompt's "Memory Recall" section instructs the agent to search memory before answering questions about prior work, decisions, or preferences.

3. **Memory get**: `vault_memory_get` reads a specific memory file with optional line slicing. Used after search to pull only the needed lines.

4. **Session-memory hook**: On `/new` command, the vault-backed hook reads the session transcript from `_sessions`, formats a markdown summary, and appends it to `_memory/memory/YYYY-MM-DD.md`. This replaces the native `session-memory` hook which wrote to disk via `fs.writeFile()`.

5. **Auto-embedding**: After any write to `_memory` (via `vault_memory_write` or the hook), the vault server automatically triggers `POST /embed` in the background. This ensures new memory content is immediately searchable via vector similarity — no manual embedding step needed.

**What's disabled:**

- `memory-core` plugin — auto-disabled via `plugins.slots.memory = "straja-vault"`
- Native `session-memory` hook — disabled via `hooks.internal.entries.session-memory.enabled = false`
- Local SQLite memory index — never created (no `memory-core` plugin to create it)

---

## Execution Lifecycle: Temp Directory vs Kernel Sandbox

The `vault_exec` flow uses two ephemeral layers that serve different purposes:

**The temp directory is the workspace. The kernel sandbox is the fence around it.**

The vault's permanent storage is SQLite — not a filesystem. A command like `python3 hello.py` can't read from SQLite, it needs actual files on disk. So the vault materializes workspace files into a temp directory before each execution.

The kernel sandbox (nono → Seatbelt on macOS, Landlock on Linux) tells the OS kernel: "this process can only access the temp directory and runtime paths. Block everything else." The kernel itself refuses syscalls that try to escape.

Without the temp dir, there's nothing for the sandbox to protect — the command would have no files. Without the sandbox, the temp dir is meaningless as a security boundary — the command could read `~/.ssh` or anything else on disk. They're complementary.

```
SQLite (_workspace)
    │
    │  materialize (query docs, write real files)
    ▼
/tmp/vault-exec-XXXXXX/       ← the workspace (ephemeral data)
    ├── hello.py
    ├── src/main.ts
    └── data/input.txt
    │
    │  kernel sandbox (Seatbelt) ← the fence (ephemeral policy)
    │  "you can ONLY see inside this directory"
    ▼
python3 hello.py               ← runs inside the fence
    │
    │  after exit: diff files, capture changes back
    ▼
SQLite (_workspace)            ← new/modified files written back
    │
    │  rm -rf temp dir + verify removal
    ▼
gone
```

**Cleanup guarantees:**

- **Kernel sandbox**: Destroyed automatically when the process exits. The OS handles this — there's nothing to clean up.
- **Temp directory**: Removed in a `finally` block (runs even on errors). Removal is verified via `stat()` — if the directory still exists after `rm`, the vault logs a warning. If `rm` itself fails, the error is logged.
- **Sandbox path in response**: Every `/exec` response includes `"sandbox": "/tmp/vault-exec-XXXXXX"` so you can verify the path no longer exists.
- **Stray detection**: `ls /tmp/vault-exec-*` (or `$TMPDIR/vault-exec-*`) should always return empty. Any matches indicate a cleanup failure.

---

## Security: No Disk Fallback

The lazy file operations in `pi-tools.ts` have **no `fs/promises` fallback**. If the vault plugin is not loaded, every file operation throws an error instead of silently falling through to the host filesystem. This is a hard security boundary:

- **Tool rename layer**: Tools are named `vault_read`/`vault_write`/`vault_edit` — they can only pass the policy pipeline if explicitly allowed. The `group:fs` expansion uses `read`/`write`/`edit` which won't match the renamed tools.
- **Operations layer**: Even if a tool somehow passes policy, the lazy wrappers refuse disk I/O. No vault patch → error, not fallback.
- **Config isolation**: The agent's `vault_write` goes through the vault HTTP API to the `_workspace` collection in SQLite — it cannot modify `~/.openclaw/openclaw.json` or any file on the host filesystem, even via prompt injection.

---

## Core Principle: No Fallback, Ever

This OpenClaw configuration is a **secure, vault-only mode**. It works ONLY with Straja Vault. There are no fallbacks, no degraded modes, no "development shortcuts":

- **If the vault is down → the agent cannot operate.** File tools throw errors, not fall back to disk.
- **If the sandbox backend (nono) is not installed → execution does not work.** No unsandboxed fallback.
- **If the vault plugin is not loaded → all file operations fail.** No `fs/promises` fallback.

This is by design. The vault is the enforcement authority. If any part of the security chain is missing, the agent is non-functional rather than insecure. **Never add fallback paths that bypass the vault or sandbox.** Failing safe means failing closed.
