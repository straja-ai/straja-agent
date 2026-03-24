# Straja Prompt Construction Notes

This document captures how prompts are built today in `straja-agent`, what is passed to the model on each turn, how tool guidance is injected, and how matched flows alter the turn context.

It is intentionally practical. The goal is to make the current prompt-based runtime inspectable before moving to a native graph engine.

## Core Model

Straja does not use one static prompt saved forever per agent.

On every turn, it rebuilds the effective prompt from:

1. The agent profile
2. The allowed tool set for that agent
3. Runtime metadata such as channel/capabilities
4. Injected workspace files like `AGENTS.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`
5. Optional matched flow context for the current inbound message

The system prompt and the turn body are separate layers:

- System prompt: built from agent identity, tool surface, runtime, workspace context
- Turn body: inbound message plus trusted flow context, session hints, untrusted metadata, and thread context

## Main Builder

The main system prompt is built in:

- `src/agents/system-prompt.ts`

Primary call sites:

- `src/agents/pi-embedded-runner/system-prompt.ts`
- `src/auto-reply/reply/commands-system-prompt.ts`
- `src/agents/cli-runner/helpers.ts`

The core exported builder is:

- `buildAgentSystemPrompt(...)`

## What Gets Rebuilt Every Turn

Every turn rebuilds the system prompt from the current runtime state.

This matters because prompt quality depends directly on:

- which tools are actually allowed
- whether the builder places those tools in the correct sections
- whether absent tools are avoided in guidance text

If the builder is wrong, every turn gets the wrong prompt.

## Tool Injection Rules

Tool guidance is now grouped by family and only rendered when those tools actually exist in the current tool set.

Examples:

- `vault_memory_search`, `vault_memory_get`, `vault_memory_write`
  appear under memory-related sections
- `vault_search`, `vault_get`, `vault_multi_get`, `vault_status`
  appear under vault knowledge sections
- `vault_web_search_duckduckgo`, `vault_web_fetch`
  appear under web research
- `vault_browser_*`, `vault_approve_domain`
  appear under browser/domain-approval guidance
- `vault_repo_exec`, `vault_repos_list`, `vault_process`, GitHub tools
  appear under repo-engineering guidance for engineer-like agents

## Important Bug That Was Fixed

One real regression was:

- `vault_search` existed in the agent tool set
- but the guidance for using it was accidentally gated behind memory-tool logic
- so the agent had the tool, but was not instructed to use it

That is now fixed.

Another real regression was:

- custom prompts could mention `sessions_send`, `subagents`, or `session_status`
  even when those tools were not present

That is also fixed.

## Actual Prompt Shape By Agent Type

Below are representative prompt shapes taken from the real prompt builder.

These are examples of the actual compiled prompt structure, not fictional summaries.

### Chief of Staff

Chief of Staff is vault-heavy and conversation-heavy.

Representative sections:

- `## Tooling`
  - `### Core`
  - `### Sessions & Delegation`
  - `### Vault Knowledge`
  - `### Vault Memory`
  - `### Notes & Collections`
  - `### Spreadsheets`
  - `### Artifacts & Deliverables`
  - `### Calendar & Mail`
  - `### Web & Browser`
- `## Memory Recall`
- `## Memory Persistence`
- `## Gmail Drafts`
- `## Vault Knowledge Search`
- `## Vault Notes & Collections`
- `## Vault Artifacts`
- `## Vault Spreadsheets`
- `## Vault Calendar`
- `## Vault Automation`
- `## Vault Browser & Domain Approval`
- `## Deliverables`
- `## Web Research`
- `## Messaging`

Chief of Staff prompt behavior:

- search memory first when appropriate
- fall back to vault search if memory has no answer
- use spreadsheet tools for spreadsheet-backed data
- use vault collection/note/artifact tools instead of fake filesystem assumptions
- use `message` and sessions tools for messaging behavior

### Software Engineer

Software Engineer is repo-oriented, not vault-knowledge-oriented by default.

Representative sections:

- `## Tooling`
  - `### Core`
  - `### Sessions & Delegation`
  - `### Developer & GitHub`
- `## Repo Engineering`
- `## Messaging`

Representative real content:

- `Use vault_repos_list first when you need to discover which attached repositories are available.`
- `Use vault_repo_exec for repository-local coding work such as searching code, reading project files, running git, installing dependencies, building, and testing.`
- `Use vault_process to monitor, poll, or manage background repo execution sessions started through the vault.`
- `Use GitHub tools for repository hosting actions like issues, branches, pull requests, and pushes instead of merely describing those actions.`

Engineer prompt intentionally does not inject:

- `## Vault Knowledge Search`
- `## Memory Recall`
- `## Web Research`

unless those tool families are actually present.

### Custom Agent

Custom agents are strictly tool-shaped.

Example custom tool set:

- `vault_search`
- `vault_get`
- `vault_status`
- `vault_cron`
- `message`

The resulting prompt shape is:

- `## Tooling`
  - `### Core`
  - `### Vault Knowledge`
- `## Vault Knowledge Search`
- `## Vault Automation`
- `## Messaging`

And it should not mention absent tools like:

- `sessions_send`
- `subagents`
- `session_status`
- repo engineering guidance
- memory guidance
- browser guidance

unless those tools are actually available.

## Flow-Matched Turns

Flows do not replace the normal system prompt.

Instead:

- the normal agent system prompt is still built as usual
- matched flows are compiled into trusted operational context
- that trusted flow context is prepended to the current turn body

Flow compilation entry point:

- `extensions/straja-vault/src/flows.ts`

Body injection entry points:

- `src/auto-reply/reply/flow-context.ts`
- `src/auto-reply/reply/get-reply-run.ts`

### Actual Flow Context Shape

Matched flows are compiled into blocks like:

```text
<flow id="elevi/prezenta" name="Parinti raporteaza prezenta">

This is trusted operational flow context for the current inbound message.

Apply it only when the message semantically matches the flow instruction. If it does not match, ignore this flow and continue normally.

Follow this flow graph for the current inbound message.
- Trigger on inbound whatsapp messages.
- ...

</flow>
```

Then the turn body becomes something like:

```text
Trusted flow context for this inbound message:

<flow id="elevi/prezenta" name="Parinti raporteaza prezenta">
This is trusted operational flow context for the current inbound message.
Apply it only when the message semantically matches the flow instruction. If it does not match, ignore this flow and continue normally.
Follow this flow graph for the current inbound message.
- Trigger on inbound whatsapp messages.
- Before continuing, read the collection document elevi/Parinti_info.json and determine whether the sender is mapped there.
- ...
</flow>

Conversation info (untrusted metadata):
{
  "sender_id": "491746734836",
  "sender": "491746734836"
}

Maine Iuliana nu vine la scoala.
```

So the effective model input is:

1. System prompt
2. User/body prompt with trusted flow context prepended

This is why the current flow runtime should be understood as:

- graph-shaped prompt compilation

not:

- native node-by-node execution

## What The Model Sees During A Flow Turn

Conceptually:

```text
[SYSTEM PROMPT]
...agent identity...
...tooling...
...vault guidance...
...messaging guidance...

[CURRENT TURN BODY]
Trusted flow context for this inbound message:

<flow ...>
...compiled flow instruction...
</flow>

Conversation info (untrusted metadata):
...

Actual inbound user message
```

That distinction matters:

- the system prompt stays agent-level
- the flow is a trusted per-turn instruction block

## Why Prompt Transparency Matters

Because the current runtime is prompt-based:

- the graph is not the final executable artifact
- the compiled prompt is the real artifact the model executes against

That is why the UI direction of exposing:

- node-level compiled prompt fragments
- flow-level compiled prompt
- auto / append / override modes

is correct for the current architecture.

## Limits Of The Current Prompt-Based Flow Runtime

Even with good prompt construction, the current flow system is still probabilistic.

Examples of what this means:

- a node does not execute itself in code
- a flow says "update spreadsheet", but the model must still decide to call the correct tool
- branching is suggested by prompt text rather than enforced by a runtime state machine
- step results are reconstructed from tool activity after the fact

So this architecture is best described as:

- structured prompt orchestration

not:

- deterministic workflow execution

## Current Regression Coverage

Prompt-shape regression tests now exist for:

- vault-focused prompts
- software-engineer prompts
- representative custom prompts

Relevant tests:

- `src/agents/system-prompt.vault.test.ts`
- `src/agents/system-prompt.profiles.test.ts`

These tests verify that:

- relevant sections are included when the corresponding tools exist
- irrelevant sections are not injected when those tools are absent
- tool-family guidance is aligned with the actual tool surface

## Practical Takeaway

Today, when debugging agent behavior, always separate:

1. System prompt construction
2. Per-turn flow/body injection
3. Actual tool usage chosen by the model

If an agent does not use a tool, the failure can come from:

- tool not allowed
- tool allowed but not described in the prompt
- flow context missing or malformed
- the model still choosing a weaker alternative despite correct prompt guidance

All four must be checked.

## Files Worth Inspecting

- `src/agents/system-prompt.ts`
- `src/agents/system-prompt.vault.test.ts`
- `src/agents/system-prompt.profiles.test.ts`
- `extensions/straja-vault/src/flows.ts`
- `src/auto-reply/reply/flow-context.ts`
- `src/auto-reply/reply/get-reply-run.ts`
