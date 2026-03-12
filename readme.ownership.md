# Ownership, Tools & Authorization

How the agent decides who the "owner" is, what tools are available per sender, and how the layered policy pipeline works.

## Owner-Only Tools

Three tools are restricted to owner senders. Non-owners never see them in the tool list and cannot execute them.

| Tool             | What it does                                                 |
| ---------------- | ------------------------------------------------------------ |
| `vault_cron`     | Cron job management — add, update, remove, list, run, wake   |
| `gateway`        | Gateway control — restart, config get/set/patch, self-update |
| `whatsapp_login` | WhatsApp QR linking — generate QR code, wait for scan        |

Each tool is guarded in two ways:

1. **Property flag**: `ownerOnly: true` on the tool definition
2. **Name fallback**: Hardcoded in `OWNER_ONLY_TOOL_NAME_FALLBACKS` — catches the tool even if the property is missing (belt-and-suspenders)

A tool is owner-only if either condition is true.

## How Ownership Is Determined

Ownership is resolved per-message in `resolveCommandAuthorization`. Two flags are computed:

| Flag                 | Purpose                                                    | Controls                             |
| -------------------- | ---------------------------------------------------------- | ------------------------------------ |
| `senderIsOwner`      | Strict identity match against the owner list               | Tool availability (owner-only tools) |
| `isOwnerForCommands` | Softer gate — considers whether enforcement is even active | Slash command access                 |

### The `ownerList` resolution cascade

The owner list is built with this priority:

1. **`commands.ownerAllowFrom`** (config) — if explicit entries exist, they ARE the owner list
2. **Context `OwnerAllowFrom`** (e.g. from pairing store) — used when no config owners
3. **Channel `allowFrom`** fallback — only when no explicit owners and `allowFrom` is not `"*"` or empty

If `commands.ownerAllowFrom` contains `"*"`, the owner list is empty but `ownerAllowAll` is true — meaning everyone is treated as owner for commands (but `senderIsOwner` remains false since there's no identity match).

### Sender candidate matching

For each incoming message, sender candidates are built from `SenderId`, `SenderE164`, and `From`. Order depends on the channel:

- **WhatsApp**: E.164 phone number checked first, then JID
- **Other channels**: SenderId first, then E.164

Each candidate is normalized through the channel dock's `formatAllowFrom` (e.g., WhatsApp applies E.164 normalization). The first match against the owner list wins.

### Per-channel ownership behavior

| Channel                | Owner enforcement               | Owner identifier format                                |
| ---------------------- | ------------------------------- | ------------------------------------------------------ |
| WhatsApp               | `enforceOwnerForCommands: true` | E.164 phone number (e.g., `+491746734836`)             |
| Telegram               | No enforcement by default       | Numeric user ID (e.g., `8425169799`)                   |
| Discord                | No enforcement by default       | Numeric user ID, injected via `OwnerAllowFrom` context |
| CLI (`openclaw agent`) | Always owner                    | Hardcoded `senderIsOwner: true`                        |

WhatsApp is the only built-in channel that forces owner enforcement for commands. Without enforcement, all authenticated senders can use commands and see non-owner-only tools.

### Self-chat does NOT equal ownership

WhatsApp self-chat (messaging yourself) bypasses **access control** — the message is always accepted. But ownership is a separate check:

- Self-chat sender = your phone number (e.g., `+491746734836`)
- Owner list = entries from `commands.ownerAllowFrom`
- If your phone number is NOT in `ownerAllowFrom`, you are NOT the owner in self-chat
- Owner-only tools like `vault_cron` will be unavailable

This is a common gotcha. Self-chat grants message acceptance, not tool access.

## Configuration

### `commands.ownerAllowFrom`

The primary way to declare who is the owner. Accepts an array of strings or numbers.

```json5
{
  commands: {
    ownerAllowFrom: [
      "openclaw-control-ui", // vault UI sender ID
      "8425169799", // Telegram numeric user ID
      "+491746734836", // WhatsApp E.164 phone number
    ],
  },
}
```

Each entry must match the sender's identity format for the relevant channel. A single entry can be channel-prefixed:

```json5
ownerAllowFrom: [
  "whatsapp:+491746734836",    // only matches on WhatsApp
  "telegram:8425169799",       // only matches on Telegram
  "openclaw-control-ui"        // matches everywhere (no prefix)
]
```

Prefixed entries are filtered by channel — a `whatsapp:` entry is skipped when resolving ownership for a Telegram message.

### `commands.allowFrom`

Separate from ownership. Per-provider command authorization:

```json5
{
  commands: {
    allowFrom: {
      whatsapp: ["+15551234567"],
      telegram: [123456789],
      "*": ["some-global-id"], // fallback for all providers
    },
  },
}
```

When `commands.allowFrom` is configured, it fully overrides the channel allowFrom + owner logic for command authorization. It does NOT affect `senderIsOwner` — that always uses `ownerAllowFrom`.

### Tool Profiles

Profiles set a baseline of allowed tools:

| Profile     | Allowed tools                                                                             |
| ----------- | ----------------------------------------------------------------------------------------- |
| `minimal`   | `session_status` only                                                                     |
| `coding`    | `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`                    |
| `messaging` | `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status` |
| `full`      | No restrictions                                                                           |

Set per-agent:

```json5
{
  agents: {
    list: [
      {
        id: "vault",
        tools: {
          profile: "minimal",
          alsoAllow: ["vault_cron", "vault_read", "vault_write"],
        },
      },
    ],
  },
}
```

`alsoAllow` is additive — it merges into the profile's allowlist. Cannot be used together with `allow` in the same scope (schema rejects it). Use `allow` for full control, or `profile` + `alsoAllow` for additive.

### Tool Groups

Shorthand references for sets of tools:

| Group              | Tools                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group:memory`     | `memory_search`, `memory_get`, `vault_memory_search`, `vault_memory_get`                                                                          |
| `group:web`        | `web_search`, `web_fetch`, `vault_web_search_duckduckgo`, `vault_web_fetch`                                                                       |
| `group:fs`         | `read`, `write`, `edit`, `apply_patch`                                                                                                            |
| `group:runtime`    | `exec`, `process`, `vault_exec`, `vault_process`                                                                                                  |
| `group:sessions`   | `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `subagents`, `session_status`                                             |
| `group:ui`         | `browser`, `canvas`                                                                                                                               |
| `group:artifacts`  | `vault_artifact_write`, `vault_artifact_list`, `vault_presentation_build`, `vault_report_build`, `vault_artifact_url`, `vault_agent_collection_*` |
| `group:automation` | `vault_cron`, `gateway`                                                                                                                           |
| `group:messaging`  | `message`                                                                                                                                         |
| `group:nodes`      | `nodes`                                                                                                                                           |
| `group:openclaw`   | All native tools (excludes plugins)                                                                                                               |

Groups can be used in `allow`, `alsoAllow`, and `deny` lists.

## The Tool Policy Pipeline

Tools pass through a layered pipeline of allow/deny filters. Each step can narrow or gate the available tools.

### Pipeline steps (in order)

| #   | Step                                 | Source                                 |
| --- | ------------------------------------ | -------------------------------------- |
| 1   | `tools.profile`                      | Base profile allowlist                 |
| 2   | `tools.byProvider.profile`           | Provider-specific profile override     |
| 3   | `tools.allow`                        | Global explicit allow/deny             |
| 4   | `tools.byProvider.allow`             | Provider-specific global allow/deny    |
| 5   | `agents.<id>.tools.allow`            | Per-agent allow/deny                   |
| 6   | `agents.<id>.tools.byProvider.allow` | Per-agent provider-specific allow/deny |
| 7   | `group tools.allow`                  | Channel group tool policy              |
| 8   | `sandbox tools.allow`                | Sandbox tool restrictions              |
| 9   | `subagent tools.allow`               | Sub-agent deny lists                   |

### How filtering works

Each step applies `filterToolsByPolicy`:

- Deny patterns are checked first — deny wins over allow
- Then allow patterns filter — empty allow means allow all
- Tool names support glob matching

### Plugin-only allowlist safety

Each step runs a safety check (`stripPluginOnlyAllowlist`):

- Classifies allowlist entries as core tool, plugin tool, or unknown
- If the allowlist contains ONLY plugin/unknown entries (no core tools), the allowlist is **stripped** to prevent accidentally disabling all core tools
- Unknown entries trigger a warning log

## Execution Flow Summary

```
Incoming message
  |
  v
resolveCommandAuthorization()
  → builds ownerList from commands.ownerAllowFrom
  → matches sender against ownerList
  → sets senderIsOwner (true/false)
  |
  v
applyOwnerOnlyToolPolicy(tools, senderIsOwner)
  → if owner: wrap tools with passthrough guard, keep all
  → if NOT owner: wrap with throw guard AND filter out owner-only tools
  |
  v
applyToolPolicyPipeline(filteredTools, steps)
  → applies 7-9 layers of allow/deny filtering
  → validates allowlists, warns on unknown entries
  |
  v
Final tool set available to the LLM
```

## Known Issue: False "Unknown Entries" Warning

When a non-owner message is processed, owner-only tools are removed BEFORE the pipeline runs. This means:

1. `vault_cron` is removed from the tool list (non-owner)
2. Pipeline builds `coreToolNames` from the remaining tools — `vault_cron` is absent
3. Allowlist contains `vault_cron` (or `group:automation`)
4. `vault_cron` is not in core tools, not a plugin tool → classified as "unknown"
5. Warning fires: `"allowlist contains unknown entries (vault_cron)"`

This is a false positive. The tool exists and works for owner senders. The warning only appears when a non-owner triggers the pipeline. It does not affect functionality.

## Quick Checklist

To ensure owner-only tools work for a sender:

1. Add the sender's channel-native ID to `commands.ownerAllowFrom`:
   - WhatsApp: E.164 phone number (e.g., `"+491746734836"`)
   - Telegram: numeric user ID (e.g., `"8425169799"`)
   - Vault UI: `"openclaw-control-ui"`
2. Verify the agent's tool config includes the tool (e.g., `vault_cron` in `tools.alsoAllow`)
3. Restart the agent gateway for config changes to take effect
4. Verify with the `/tools` command or by asking the agent to use the tool
