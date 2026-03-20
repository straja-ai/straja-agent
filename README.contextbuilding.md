# Context Building in Straja Agent

This document summarizes what the agent reads from Vault, what becomes system prompt context, what becomes prompt-prepended context, and what changes between a fresh session and a normal prompt.

## Scope

This description is based on the current Vault-backed integration in the `straja-vault` plugin and the embedded agent runner.

Key files:

- `extensions/straja-vault/index.ts`
- `extensions/straja-vault/src/bootstrap-patch.ts`
- `extensions/straja-vault/src/memory-context.ts`
- `extensions/straja-vault/src/memory-injection.ts`
- `src/agents/workspace.ts`
- `src/agents/bootstrap-files.ts`
- `src/agents/system-prompt.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/auto-reply/reply/session-reset-prompt.ts`

## High-Level Model

For each run, the final model input is built from three distinct layers:

1. System prompt
2. Session history messages
3. Current user prompt

Vault contributes to all three, but in different ways:

- `_workspace` files are loaded into the system prompt
- `_sessions` transcript history becomes the session messages
- `_memory` can be prepended to the current prompt, depending on settings

## Startup Behavior

When the `straja-vault` plugin registers:

1. It normalizes the Vault base URL.
2. It verifies Vault reachability with a probe against `_workspace`.
3. It installs runtime patches so workspace/bootstrap/session/file operations use Vault instead of disk.

Important consequence:

- in Vault mode, `_workspace`, `_memory`, `_sessions`, and related system collections are the source of truth
- the agent should not fall back to local disk for these files

## What Is Read on Every Prompt

### 1. Workspace Bootstrap Files from `_workspace`

For each run, the agent loads bootstrap files via the Vault bootstrap patch.

Files read from `_workspace`:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`

These reads happen through the workspace/bootstrap flow, not through prompt-injection hooks.

Behavior:

- each file is fetched from Vault
- missing files are represented as missing context entries
- large files are truncated to stay within prompt budget
- for subagent and cron sessions, bootstrap may be reduced to a smaller allowlist

### 2. Session Transcript from `_sessions`

The active session transcript is loaded through the Vault-backed session manager.

This provides:

- prior user messages
- prior assistant messages
- prior tool-call transcript content as reconstructed session history

This history becomes the `messages` array passed to the model runtime.

It is not merged into the system prompt.

### 3. Optional Prompt-Level Memory Injection from `_memory`

The Vault plugin can prepend persistent memory to the current user prompt.

When enabled, it reads:

- `_memory/MEMORY.md`
- `_memory/memory/YYYY-MM-DD.md` for the 2 newest daily files

Implementation details:

- the plugin first lists `_memory` files
- it selects the two newest `memory/YYYY-MM-DD.md` entries
- it fetches those files individually
- it formats the result into a `<persistent_memory>...</persistent_memory>` block

This block is prepended to the current prompt, not injected into the system prompt.

## What Becomes the System Prompt

The system prompt is rebuilt for each run and includes:

1. The core built-in OpenClaw/Straja instructions
2. Tooling guidance
3. Memory usage policy
4. Messaging/reply behavior
5. Runtime metadata
6. Workspace context files loaded from `_workspace`

The `_workspace` files are rendered under the project context section as embedded file content, for example:

- `## AGENTS.md`
- `## SOUL.md`
- `## USER.md`

Important distinction:

- `_workspace` files are system-prompt context
- `_memory` injection is prompt-prepended context

## What Becomes the Current Prompt

The current prompt starts as the inbound user message.

Then the `before_prompt_build` hook may prepend Vault memory content.

Final prompt shape when memory injection is active:

```text
<persistent_memory>
... MEMORY.md + recent daily memory ...
</persistent_memory>

<actual user message>
```

If memory injection is off, only the user message is used.

## Memory Injection Modes

The Vault plugin currently supports three modes:

- `off`
- `new_sessions`
- `always`

### `off`

No `_memory` content is automatically prepended to prompts.

The agent must rely on tools such as:

- `vault_memory_search`
- `vault_memory_get`
- `vault_search`

### `new_sessions`

Behavior:

- inject `_memory/MEMORY.md` plus the two newest daily memory files only on the first prompt of a session
- do not inject again on later prompts in the same session

This keeps startup memory available without paying the token cost on every turn.

### `always`

Inject the persistent memory block on every prompt.

This is the current default.

This gives the model maximum passive recall, but increases token usage and repeats the same memory context frequently.

## What Changes on a New Session

A new session affects prompt building in two ways.

### 1. Session History Is Reset

The `messages` array is empty or newly initialized.

So there is little or no prior conversation history in the model input.

### 2. Bare `/new` and `/reset` Use a Special Prompt

If the session starts via a bare `/new` or `/reset`, the user prompt is replaced with a special session-start instruction:

- greet the user
- use the configured persona
- keep it short
- ask what they want to do

This text is defined in `src/auto-reply/reply/session-reset-prompt.ts`.

### 3. Memory Injection Uses the Configured Mode

With the current default `always` mode:

- the first prompt of the new session gets `_memory/MEMORY.md` plus the 2 latest daily memory files prepended
- later prompts in the same session also get that injected block again

So a fresh session typically contains:

- system prompt with `_workspace` bootstrap context
- empty or reset session history
- current prompt prefixed with persistent memory

## What Does Not Get Auto-Loaded

The following are not automatically inserted into prompt context:

- arbitrary Vault collections
- notes outside the loaded workspace bootstrap files
- imported emails and documents
- task outputs
- task activity
- old daily memory files beyond the newest two
- arbitrary `_memory` search results

Those require explicit tool usage.

## Caching Behavior

There are two relevant short-lived caches:

### Bootstrap Cache

Workspace bootstrap file reads use a per-process TTL cache.

Effect:

- repeated reads of `AGENTS.md`, `SOUL.md`, etc. do not always hit Vault immediately
- changes may take a short time to be naturally re-read unless cache invalidation occurs

### Memory Injection Cache

The formatted persistent memory block also has a per-process TTL cache.

Effect:

- repeated prompts do not always re-read `_memory` immediately
- writes to `MEMORY.md` or `memory/...` invalidate that cache

## Write Paths Related to Context

### `_workspace`

Gateway file operations for workspace files are routed to `_workspace`.

Relevant files include:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`

### `_memory`

Memory files are routed to `_memory`.

Relevant files include:

- `MEMORY.md`
- `memory/YYYY-MM-DD.md`

### Session-Memory Writeback on `/new`

There is also a Vault-backed session memory hook:

- on `/new`, the plugin reads the recent session transcript from `_sessions`
- it builds a summary block
- it appends that block to `_memory/memory/YYYY-MM-DD.md`

This is writeback behavior, not prompt assembly.

## Practical Prompt Shape Summary

### Normal prompt in an existing session

Usually:

1. System prompt
   - built-in instructions
   - workspace file context from `_workspace`
2. Session history
   - from `_sessions`
3. Current user prompt
   - with `_memory` prepended again when mode is `always`

### First prompt in a fresh session

Usually:

1. System prompt
   - built-in instructions
   - workspace file context from `_workspace`
2. Session history
   - empty or minimal
3. Current prompt
   - bare session reset prompt or user prompt
   - plus `_memory/MEMORY.md` and the 2 newest daily memory files when injection mode is `always` or `new_sessions`

## Current Design Split

The intended split is:

- `_workspace` = stable agent bootstrap and identity files used as system context
- `_memory` = durable memory used for recall and optional prompt injection
- `_sessions` = conversational history

That split is correct and should remain in place.

## Open Questions / Follow-Ups

Areas that may still deserve clarification or improvements:

- whether bootstrap cache invalidation should be more aggressive after workspace writes
- whether `new_sessions` should mean "first model turn only" or "first prompt after any reset boundary"
- whether more than 2 daily memory files should be injectable in special modes
- whether the system prompt report should be surfaced in Vault for easier debugging
